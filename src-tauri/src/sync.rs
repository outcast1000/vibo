use std::collections::HashSet;
use std::sync::Arc;

use crate::db::Database;
use crate::placeholder_names::{real_album_title, real_artist_name};
use crate::subsonic::SubsonicClient;

pub fn sync_collection(
    db: &Arc<Database>,
    client: &SubsonicClient,
    collection_id: i64,
    progress_callback: impl Fn(u64, u64) + Send,
) -> Result<u64, String> {
    let start = std::time::Instant::now();

    // Build set of all existing relative paths (track IDs) for this collection
    let existing_paths: HashSet<String> = db
        .get_track_paths_for_collection(collection_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

    let mut seen_paths: HashSet<String> = HashSet::new();

    // Paginate album list
    let page_size = 500u32;
    let mut offset = 0u32;
    let mut all_album_ids = Vec::new();

    loop {
        let albums = client
            .get_album_list(page_size, offset)
            .map_err(|e| e.to_string())?;
        if albums.is_empty() {
            break;
        }
        for album in &albums {
            all_album_ids.push(album.id.clone());
        }
        if (albums.len() as u32) < page_size {
            break;
        }
        offset += page_size;
    }

    let total = all_album_ids.len() as u64;
    let mut synced: u64 = 0;
    // Tracks whether any per-album fetch failed. A failed fetch means its tracks
    // never make it into `seen_paths`, which would make them look "removed on the
    // server" below. We only trust the seen/not-seen diff for pruning when the
    // server view was complete -- see the deletion phase.
    let mut fetch_failures: u64 = 0;

    for album_id in &all_album_ids {
        let (album, tracks) = match client.get_album(album_id) {
            Ok(result) => result,
            Err(e) => {
                log::warn!("Failed to fetch album {}: {}", album_id, e);
                fetch_failures += 1;
                synced += 1;
                if synced % 5 == 0 || synced == total {
                    progress_callback(synced, total);
                }
                continue;
            }
        };

        // OpenSubsonic's explicit albumArtist outranks the album-level artist
        // (which Navidrome already populates with the album artist anyway).
        //
        // Navidrome files untagged tracks under `[Unknown Album]` (one per
        // artist) and `[Unknown Artist]`. Those are read as no tag at all — no
        // album row, no artist row — exactly like a local file with no tag
        // (see `placeholder_names`). A re-sync converges an existing library:
        // the upsert overwrites `album_id` and `recompute_counts` below drops
        // the emptied rows.
        let artist_name = real_artist_name(album.album_artist.as_deref())
            .or(real_artist_name(album.artist.as_deref()));
        let artist_id = artist_name
            .and_then(|name| db.get_or_create_artist(name).ok());

        let db_album_id = real_album_title(Some(&album.name))
            .and_then(|title| db.get_or_create_album(title, artist_id, album.year).ok());

        for track in &tracks {
            let track_artist_id = real_artist_name(track.artist.as_deref())
                .and_then(|name| db.get_or_create_artist(name).ok())
                .or(artist_id);

            let path = track.id.clone();
            seen_paths.insert(path.clone());

            if let Ok(track_db_id) = db.upsert_track_with_added_at(
                &path,
                &track.title,
                track_artist_id,
                db_album_id,
                track.track_number,
                track.duration_secs,
                track.suffix.as_deref(),
                track.size,
                None,
                Some(collection_id),
                album.year,
                // The server's date, so Recently added reflects when music
                // reached the server rather than when Vibo first synced it.
                track.created.or(album.created),
            ) {
                // Tag from track genre or album genre — split like a file's
                // genre ("Rock; Metal" is two tags, not one).
                let genre = track.genre.as_deref().or(album.genre.as_deref());
                for genre_name in crate::scanner::split_genres(genre) {
                    match db.get_or_create_tag(&genre_name) {
                        Ok(tag_id) => {
                            if let Err(e) = db.add_track_tag(track_db_id, tag_id) {
                                log::warn!("Failed to tag synced track {}: {}", track_db_id, e);
                            }
                        }
                        Err(e) => log::warn!("Failed to create tag {:?}: {}", genre_name, e),
                    }
                }
                // OpenSubsonic ReplayGain → extra_tags, under the same keys as
                // file-tag RG — for display only (track page → Details). Playback
                // ReplayGain is mpv's, read from the stream's own tags, so a
                // server that transcodes (dropping them) plays un-normalized.
                // Legacy servers omit it, leaving extra_tags null.
                if let Some(et) = crate::models::replaygain_extra_tags_json(
                    track.rg_track_gain,
                    track.rg_track_peak,
                    track.rg_album_gain,
                    track.rg_album_peak,
                ) {
                    let _ = db.set_track_extra_tags(track_db_id, Some(&et));
                }
            }
        }

        synced += 1;
        if synced % 5 == 0 || synced == total {
            progress_callback(synced, total);
        }
    }

    // Delete tracks that are no longer on the server.
    //
    // Pruning is destructive and relies on `seen_paths` being a complete picture
    // of what the server currently holds. If any album fetch failed this run, its
    // tracks are missing from `seen_paths` even though they still exist on the
    // server -- pruning then would silently delete real tracks (e.g. a flaky
    // connection that fails 70% of album fetches would wipe 70% of the library
    // while still reporting success). Only prune when we have a trustworthy,
    // complete snapshot; otherwise keep everything and let the next clean sync
    // do the pruning.
    let removed_count = if fetch_failures > 0 {
        log::warn!(
            "Skipping prune for collection {}: {} of {} album fetch(es) failed, server view is incomplete",
            collection_id,
            fetch_failures,
            total
        );
        0
    } else {
        let removed: Vec<String> = existing_paths
            .into_iter()
            .filter(|p| !seen_paths.contains(p))
            .collect();
        let count = removed.len() as u64;
        db.delete_tracks_by_paths_in_collection(collection_id, &removed)
            .map_err(|e| e.to_string())?;
        count
    };

    db.rebuild_fts().map_err(|e| e.to_string())?;
    db.recompute_counts().map_err(|e| e.to_string())?;
    // Seed tracks.liked for freshly-synced rows that were liked before they
    // existed in the library (durable entity_likes is the source of truth).
    let _ = db.reconcile_track_likes_from_entity_likes();
    db.update_collection_synced(collection_id, start.elapsed().as_secs_f64())
        .map_err(|e| e.to_string())?;

    Ok(removed_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    /// A Subsonic server on a local socket answering `getAlbumList2` and
    /// `getAlbum` from fixed JSON, the way Navidrome files untagged music.
    fn fake_server() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut line = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                // Drain the headers.
                let mut h = String::new();
                while reader.read_line(&mut h).map(|n| n > 2).unwrap_or(false) {
                    h.clear();
                }
                // The fields beside `"status":"ok"` in the response.
                let payload = if line.contains("getAlbumList2.view") && line.contains("offset=0") {
                    r#","albumList2":{"album":[{"id":"a1"},{"id":"a2"}]}"#
                } else if line.contains("getAlbumList2.view") {
                    r#","albumList2":{"album":[]}"#
                } else if line.contains("id=a1") {
                    // Navidrome's per-artist bucket for songs with no album tag.
                    r#","album":{"id":"a1","name":"[Unknown Album]","artist":"Mono","albumArtist":"Mono",
                        "song":[{"id":"s1","title":"Ashes","artist":"Mono"}]}"#
                } else if line.contains("id=a2") {
                    // A tagged album whose songs have no artist tag.
                    r#","album":{"id":"a2","name":"Real Record","artist":"[Unknown Artist]",
                        "song":[{"id":"s2","title":"Nameless","artist":"[Unknown Artist]"}]}"#
                } else {
                    ""
                };
                let json = format!(r#"{{"subsonic-response":{{"status":"ok"{payload}}}}}"#);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    json.len(),
                    json
                );
            }
        });
        base
    }

    #[test]
    fn test_placeholder_album_and_artist_sync_as_no_tag() {
        let db = Arc::new(Database::new_in_memory().unwrap());
        let base = fake_server();
        let cid = db
            .add_collection("subsonic", "Navidrome", None, Some(&base), Some("u"), Some("p"), None, Some("plaintext"))
            .unwrap()
            .id;
        // What an earlier sync left: a `[Unknown Album]` row holding s1.
        let mono = db.get_or_create_artist("Mono").unwrap();
        let old = db.get_or_create_album("[Unknown Album]", Some(mono), None).unwrap();
        db.upsert_track("s1", "Ashes", Some(mono), Some(old), None, None, None, None, None, Some(cid), None)
            .unwrap();

        let client = SubsonicClient::from_stored(&base, "u", "p", None, "plaintext");
        sync_collection(&db, &client, cid, |_, _| {}).unwrap();

        let tracks = db.get_tracks_for_collection(cid).unwrap();
        assert_eq!(tracks.len(), 2, "the earlier row was updated, not duplicated");
        let ashes = tracks.iter().find(|t| t.title == "Ashes").unwrap();
        assert_eq!(ashes.album_id, None, "[Unknown Album] is no album");
        assert_eq!(ashes.artist_name.as_deref(), Some("Mono"), "the real artist stays");
        let nameless = tracks.iter().find(|t| t.title == "Nameless").unwrap();
        assert_eq!(nameless.artist_id, None, "[Unknown Artist] is no artist");
        assert_eq!(nameless.album_title.as_deref(), Some("Real Record"), "the real album stays");

        assert!(db.find_album_by_name("[Unknown Album]", None).unwrap().is_none(), "the old row is pruned");
        assert!(db.find_artist_by_name("[Unknown Artist]").unwrap().is_none());
    }
}
