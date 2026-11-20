//! Local lyrics discovery (issue #131): lyrics that live with the user's own
//! files rather than on a lyrics service. Three sources, probed in this
//! order — lyrics embedded in the audio file's tags, a sidecar `.lrc`/`.txt`
//! named like the audio file, and the same files inside a `Lyrics/`
//! subfolder. A synced answer beats a plain one wherever it comes from. The
//! in-app editor saves an edit back into whichever source answered
//! (`save_and_verify`), and lyrics for a file that has none into its tags
//! (`new_lyrics_target`).
//!
//! Everything here is probed live on every lookup and deliberately never
//! cached: the file is the source of truth, re-reading it costs a stat or one
//! tag parse, and a user who just saved an `.lrc` expects it on the next look.
//! (The network lyrics providers keep going through the information-value
//! cache — see `utils/infoFetchChain.ts` — this module sits in front of it.)

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LocalLyrics {
    pub text: String,
    /// "synced" (LRC timestamps present) or "plain".
    pub kind: &'static str,
    /// Which probe answered: "embedded" | "sidecar" | "folder".
    pub source: &'static str,
    /// The audio file whose lyrics these are. Never sent to the webview: the
    /// save path takes it from its own probe rather than from the caller.
    #[serde(skip)]
    pub audio: PathBuf,
    /// The lyrics file that answered (sidecar / folder); `None` for lyrics
    /// embedded in the audio file.
    #[serde(skip)]
    pub file: Option<PathBuf>,
}

/// True when any line opens with an LRC timestamp (`[m:ss` / `[mm:ss.xx` …).
/// The character after `[` must be a digit, so LRC metadata tags like
/// `[ar:Artist]` never count — a `.txt` full of those but no timestamps is
/// still plain text.
pub fn is_synced_lyrics(text: &str) -> bool {
    text.lines().any(line_has_lrc_timestamp)
}

fn line_has_lrc_timestamp(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix('[') else {
        return false;
    };
    let minutes = rest.bytes().take_while(u8::is_ascii_digit).count();
    if minutes == 0 || minutes > 3 {
        return false;
    }
    let Some(rest) = rest[minutes..].strip_prefix(':') else {
        return false;
    };
    rest.bytes().take_while(u8::is_ascii_digit).count() == 2
}

fn kind_of(text: &str) -> &'static str {
    if is_synced_lyrics(text) { "synced" } else { "plain" }
}

/// The lyrics an audio tag carries, if any. lofty splits the concept in two:
/// `ItemKey::Lyrics` (Vorbis `LYRICS`, MP4 `©lyr` — may carry LRC text) and
/// `ItemKey::UnsyncLyrics` (ID3v2 `USLT`, Vorbis `UNSYNCEDLYRICS`) — an ID3v2
/// tag's lyrics only ever surface under the second key, so both must be
/// checked. Whitespace-only values count as absent (some taggers write an
/// empty frame).
pub fn lyrics_from_tag(tag: &lofty::tag::Tag) -> Option<String> {
    use lofty::tag::ItemKey;
    [ItemKey::Lyrics, ItemKey::UnsyncLyrics].into_iter().find_map(|key| {
        tag.get_string(key)
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    })
}

fn embedded_lyrics(path: &Path) -> Option<String> {
    let tagged_file = crate::tag_writer::read_tagged_file(path).ok()?;
    embedded_lyrics_in(&tagged_file)
}

/// The lyrics in an already-read file's tags: the primary tag first, then any
/// other (the scanner passes its own parse, so tags are read once).
pub fn embedded_lyrics_in(tagged_file: &lofty::file::TaggedFile) -> Option<String> {
    use lofty::prelude::*;
    tagged_file
        .primary_tag()
        .and_then(lyrics_from_tag)
        .or_else(|| tagged_file.tags().iter().find_map(lyrics_from_tag))
}

/// Write `text` as the lyrics embedded in `path`'s tags. Lyrics already there
/// are replaced in the tag and under the key they were read from
/// (`embedded_lyrics`' order — the primary tag first, `ItemKey::Lyrics` before
/// `UnsyncLyrics`), so the edit lands exactly where the probe will read it.
/// A file with none gets them in its primary tag (created if missing), under
/// the first key that tag type can hold (`new_lyrics_key`). Writes through
/// `read_tagged_file`'s relaxed read, the same as the Edit Properties write.
fn write_embedded_lyrics(path: &Path, text: &str) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::prelude::*;
    use lofty::tag::{ItemKey, Tag};

    let mut tagged = crate::tag_writer::read_tagged_file(path)
        .map_err(|e| format!("Couldn't read the tags of {}: {}", path.display(), e))?;
    let primary = tagged.primary_tag_type();
    let mut order = vec![primary];
    order.extend(tagged.tags().iter().map(|t| t.tag_type()).filter(|t| *t != primary));
    let existing = order.into_iter().find_map(|tag_type| {
        let tag = tagged.tag(tag_type)?;
        [ItemKey::Lyrics, ItemKey::UnsyncLyrics]
            .into_iter()
            .find(|k| tag.get_string(*k).is_some_and(|s| !s.trim().is_empty()))
            .map(|key| (tag_type, key))
    });
    let (tag_type, key) = match existing {
        Some(found) => found,
        None => {
            let key = new_lyrics_key(primary).ok_or_else(|| format!("{} can't hold lyrics in its tags", path.display()))?;
            if tagged.tag(primary).is_none() {
                tagged.insert_tag(Tag::new(primary));
            }
            (primary, key)
        }
    };
    let tag = tagged.tag_mut(tag_type).ok_or_else(|| format!("Couldn't open the tags of {}", path.display()))?;
    if !tag.insert_text(key, text.to_string()) {
        return Err(format!("{} can't hold lyrics in its tags", path.display()));
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("Couldn't save the tags of {}: {}", path.display(), e))
}

/// The key new lyrics go under in a tag of `tag_type`: `ItemKey::Lyrics`
/// where the format has one (Vorbis `LYRICS`, MP4 `©lyr`, APE), else
/// `UnsyncLyrics` — ID3v2's only lyrics frame is USLT, which takes LRC text
/// as is (the probe reads it back, as do the players that show synced lyrics
/// from tags). `None` when the tag type holds neither.
fn new_lyrics_key(tag_type: lofty::tag::TagType) -> Option<lofty::tag::ItemKey> {
    use lofty::tag::{ItemKey, Tag};
    [ItemKey::Lyrics, ItemKey::UnsyncLyrics]
        .into_iter()
        .find(|key| Tag::new(tag_type).insert_text(*key, "x".to_string()))
}

/// Where lyrics for `audio`, whose files hold none, are saved: its own tags
/// when lofty can read the file and its tag type holds lyrics, else a sidecar
/// named like it — `.lrc` for synced text, `.txt` for plain — for the
/// containers lofty can't tag (dsf, mka, mkv, …). Either way the lyrics live
/// in the user's files (owner decision, 2026-11-20). Pass the result to
/// `save_and_verify`.
pub fn new_lyrics_target(audio: &Path, text: &str) -> LocalLyrics {
    use lofty::prelude::*;
    let taggable = crate::tag_writer::read_tagged_file(audio)
        .ok()
        .is_some_and(|f| new_lyrics_key(f.primary_tag_type()).is_some());
    let kind = kind_of(text);
    if taggable {
        return LocalLyrics { text: String::new(), kind, source: "embedded", audio: audio.to_path_buf(), file: None };
    }
    let stem = audio.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = if kind == "synced" { "lrc" } else { "txt" };
    let file = audio.with_file_name(format!("{stem}.{ext}"));
    LocalLyrics { text: String::new(), kind, source: "sidecar", audio: audio.to_path_buf(), file: Some(file) }
}

/// `<stem>.lrc` preferred over `<stem>.txt` — when both exist the synced file
/// is the richer one. An empty or unreadable file is skipped, so an empty
/// `.lrc` can't hide the `.txt` beside it.
fn lyrics_file_in(dir: &Path, stem: &str) -> Option<(PathBuf, String)> {
    ["lrc", "txt"].iter().find_map(|ext| {
        let file = dir.join(format!("{stem}.{ext}"));
        let text = read_text_file(&file)?;
        Some((file, text))
    })
}

/// Non-empty file text, BOM stripped, read lossily — `.lrc` files from the
/// wild aren't reliably UTF-8 and a replacement char beats no lyrics.
fn read_text_file(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// The first synced answer, else the first plain one. Lazy: stops pulling at
/// the first synced hit, so later probes are skipped once one is found.
/// Synced beats plain wherever it comes from — plain lyrics in a tag must not
/// hide a `.lrc` next to the file (the web chain applies the same rule, see
/// `isProvisionalAnswer` in `utils/infoFetchChain.ts`).
pub fn prefer_synced(found: impl IntoIterator<Item = LocalLyrics>) -> Option<LocalLyrics> {
    let mut plain = None;
    for lyrics in found {
        if lyrics.kind == "synced" {
            return Some(lyrics);
        }
        plain.get_or_insert(lyrics);
    }
    plain
}

/// Probe one local audio file for lyrics: embedded tag → sidecar →
/// `Lyrics`/`lyrics` subfolder. A synced hit wins outright; otherwise the
/// first plain one in that order.
pub fn probe_local_lyrics(audio_path: &Path) -> Option<LocalLyrics> {
    if !audio_path.is_file() {
        return None;
    }
    probe_with_embedded(audio_path, embedded_lyrics(audio_path))
}

/// `probe_local_lyrics` with the tag lyrics already read (`None` = the tags
/// hold none, or weren't read — a video container). For the scanner, which
/// has just parsed the file's tags.
pub fn probe_with_embedded(audio_path: &Path, embedded: Option<String>) -> Option<LocalLyrics> {
    let dir = audio_path.parent()?;
    let stem = audio_path.file_stem()?.to_str()?;
    probe_parts(
        audio_path,
        embedded,
        || lyrics_file_in(dir, stem),
        // Both casings probed literally: on a case-sensitive filesystem they
        // are different folders; on macOS's default they resolve to the same
        // one, so one hit is kept (the same file would otherwise answer twice).
        || {
            ["Lyrics", "lyrics"].iter().find_map(|name| {
                let sub = dir.join(name);
                if !sub.is_dir() {
                    return None;
                }
                lyrics_file_in(&sub, stem)
            })
        },
    )
}

/// The probe's order and rule with the file lookups supplied: tag lyrics,
/// then the sidecar, then the `Lyrics/` folder file, each asked only when no
/// synced answer was found before it.
fn probe_parts(
    audio_path: &Path,
    embedded: Option<String>,
    sidecar: impl FnOnce() -> Option<(PathBuf, String)>,
    folder: impl FnOnce() -> Option<(PathBuf, String)>,
) -> Option<LocalLyrics> {
    let from_file = |(file, text): (PathBuf, String), source: &'static str| LocalLyrics {
        kind: kind_of(&text),
        text,
        source,
        audio: audio_path.to_path_buf(),
        file: Some(file),
    };
    let embedded = std::iter::once(embedded.filter(|t| !t.trim().is_empty()).map(|text| LocalLyrics {
        kind: kind_of(&text),
        text,
        source: "embedded",
        audio: audio_path.to_path_buf(),
        file: None,
    }));
    let sidecar = std::iter::once_with(|| sidecar().map(|hit| from_file(hit, "sidecar")));
    let folder = std::iter::once_with(|| folder().map(|hit| from_file(hit, "folder")));
    prefer_synced(embedded.chain(sidecar).chain(folder).flatten())
}

/// One folder scan's view of where lyrics files are: each folder is listed
/// once (and its `Lyrics/` subfolder, if it has one), and a track's lyrics
/// files are looked up in those listings — so a folder of 20 tracks costs two
/// directory reads, not up to 120 failed opens. Names match case-insensitively,
/// as a default macOS or Windows volume would. Lives for one scan.
#[derive(Default)]
pub struct LyricsIndex {
    dirs: std::collections::HashMap<PathBuf, DirListing>,
}

#[derive(Default)]
struct DirListing {
    /// Lowercased file name → the name on disk.
    names: std::collections::HashMap<String, String>,
    /// `Lyrics/` then `lyrics/`, those present, with their own listings.
    lyrics_dirs: Vec<(PathBuf, std::collections::HashMap<String, String>)>,
}

fn list_names(dir: &Path) -> std::collections::HashMap<String, String> {
    let mut names = std::collections::HashMap::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            names.entry(name.to_lowercase()).or_insert(name);
        }
    }
    names
}

fn find_listed(dir: &Path, names: &std::collections::HashMap<String, String>, stem: &str) -> Option<(PathBuf, String)> {
    ["lrc", "txt"].iter().find_map(|ext| {
        let on_disk = names.get(&format!("{stem}.{ext}").to_lowercase())?;
        let file = dir.join(on_disk);
        let text = read_text_file(&file)?;
        Some((file, text))
    })
}

impl LyricsIndex {
    /// `probe_with_embedded`, with the files looked up in this index.
    pub fn probe(&mut self, audio_path: &Path, embedded: Option<String>) -> Option<LocalLyrics> {
        let dir = audio_path.parent()?;
        let stem = audio_path.file_stem()?.to_str()?;
        let listing = self.dirs.entry(dir.to_path_buf()).or_insert_with(|| {
            let names = list_names(dir);
            let lyrics_dirs = ["Lyrics", "lyrics"]
                .iter()
                .filter_map(|n| names.get(&n.to_lowercase()).filter(|on_disk| on_disk.as_str() == *n))
                .map(|n| dir.join(n))
                .filter(|p| p.is_dir())
                .map(|p| {
                    let names = list_names(&p);
                    (p, names)
                })
                .collect();
            DirListing { names, lyrics_dirs }
        });
        probe_parts(
            audio_path,
            embedded,
            || find_listed(dir, &listing.names, stem),
            || listing.lyrics_dirs.iter().find_map(|(sub, names)| find_listed(sub, names, stem)),
        )
    }
}

/// Lyrics the scan stored (`track_lyrics`) as a `LocalLyrics` for `audio`.
/// The kind is read from the text, as the probe does; the lyrics file isn't
/// recorded, since only the editor needs it and it reads the files itself.
pub fn from_stored(audio: PathBuf, text: String, source: Option<&str>) -> LocalLyrics {
    let source = match source {
        Some("embedded") => "embedded",
        Some("folder") => "folder",
        _ => "sidecar",
    };
    LocalLyrics { kind: kind_of(&text), text, source, audio, file: None }
}

/// Largest lyrics text the editor may save (the assistant's
/// `write_lyrics_file` has the same cap).
pub const MAX_LYRICS_BYTES: usize = 200_000;

/// Save an edit of `found` into the source it came from — the one the probe
/// gave priority to (owner decision, 2026-11-19): back into the tag and key
/// that held embedded lyrics, back into the sidecar or `Lyrics/` folder file
/// otherwise, whatever its extension (the kind is read from the text, so a
/// `.txt` with timestamps reads as synced).
///
/// A file is replaced without ever being missing: the text goes to a temp
/// file, the old file is copied out to a temp folder, the temp file is
/// renamed over the old one (a replace, atomic on the same volume), and only
/// then is the copy handed to `displace` (the Trash, in production — the copy
/// keeps the file's name, so it reads right there). Any failure before the
/// rename leaves the old file as it was.
pub fn save_local_lyrics_edit(
    found: &LocalLyrics,
    text: &str,
    displace: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("The lyrics are empty. To remove them, delete them where they're stored".to_string());
    }
    if text.len() > MAX_LYRICS_BYTES {
        return Err(format!("The lyrics are over the {} KB limit", MAX_LYRICS_BYTES / 1000));
    }
    match &found.file {
        None => write_embedded_lyrics(&found.audio, text),
        Some(file) => replace_text_file(file, text, displace),
    }
}

/// `save_local_lyrics_edit`, then read the same audio file back and check the
/// edit is what it shows. It may not be: synced beats plain across sources, so
/// a plain edit loses to synced lyrics elsewhere for this file, and a plain
/// edit of a file loses to plain lyrics in the tags. The edit is then on disk
/// but invisible, which must not look like a save that worked — the error
/// names what wins instead. Only `found.audio` is read back, never other
/// library copies of the song: their lyrics say nothing about this edit.
pub fn save_and_verify(
    found: &LocalLyrics,
    text: &str,
    displace: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<LocalLyrics, String> {
    save_local_lyrics_edit(found, text, displace)?;
    let saved_to = describe_source(found);
    match probe_local_lyrics(&found.audio) {
        Some(now) if now.source == found.source && now.file == found.file => Ok(now),
        Some(now) => Err(format!(
            "Saved to {saved_to}, but the {} lyrics in {} take priority, so they still show. Remove them to use this edit",
            now.kind,
            describe_source(&now),
        )),
        None => Err(format!("Saved to {saved_to}, but couldn't read it back")),
    }
}

/// Where lyrics live, for a message: "the tags of song.mp3", "song.lrc",
/// "Lyrics/song.lrc".
fn describe_source(lyrics: &LocalLyrics) -> String {
    match &lyrics.file {
        None => format!("the tags of {}", file_name_of(&lyrics.audio)),
        Some(file) if lyrics.source == "folder" => format!("Lyrics/{}", file_name_of(file)),
        Some(file) => file_name_of(file),
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

fn replace_text_file(target: &Path, text: &str, displace: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "The lyrics file has no name".to_string())?;
    // No media or lyrics extension, so neither the scanner nor the probe can
    // pick up a temp file a crash left behind.
    let tmp = target.with_file_name(format!(".{name}.viboplr-save"));
    fs::write(&tmp, text).map_err(|e| format!("Couldn't write next to {}: {}", target.display(), e))?;

    let backup = if target.exists() {
        let kept = keep_copy(target, name);
        if kept.is_err() {
            let _ = fs::remove_file(&tmp); // our own temp copy; the error below is what the user needs
        }
        Some(kept?)
    } else {
        None
    };

    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp); // our own temp copy; the old file is untouched
        if let Some(dir) = &backup {
            let _ = fs::remove_dir_all(dir); // the copy isn't needed: nothing was replaced
        }
        return Err(format!("Couldn't save {}: {}", target.display(), e));
    }
    if let Some(dir) = backup {
        // The save has happened; losing the Trash copy only costs the undo.
        if let Err(e) = displace(&dir.join(name)) {
            log::warn!("Saved {}, but couldn't move the previous version to the Trash: {}", target.display(), e);
        }
        let _ = fs::remove_dir_all(&dir); // our own temp folder, empty once the copy is in the Trash
    }
    Ok(())
}

/// Copy `target` into a fresh folder under the system temp dir, keeping its
/// name. Returns the folder.
fn keep_copy(target: &Path, name: &str) -> Result<PathBuf, String> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("viboplr-lyrics-{}-{nanos}-{seq}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't keep a copy of the old lyrics: {}", e))?;
    if let Err(e) = fs::copy(target, dir.join(name)) {
        let _ = fs::remove_dir_all(&dir); // our own temp folder
        return Err(format!("Couldn't keep a copy of the old {}: {}", target.display(), e));
    }
    Ok(dir)
}

/// Production `displace` for `save_local_lyrics_edit`: the Trash, quietly (no
/// Finder sound on every save). The copy it is handed lives in the system temp
/// folder, so a lyrics file on a network share still gets a recoverable
/// previous version.
pub fn displace_lyrics_file(path: &Path) -> Result<(), String> {
    crate::plugins::trash_quietly(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LRC: &str = "[ar:Artist]\n[00:12.30]First line\n[00:15.80]Second line\n";
    const PLAIN: &str = "First line\nSecond line\n";

    #[test]
    fn test_lrc_timestamps_classify_as_synced() {
        assert!(is_synced_lyrics(LRC));
        assert!(is_synced_lyrics("[0:05]short minute form"));
        assert!(is_synced_lyrics("  [112:00.5] over an hour, leading spaces"));
    }

    #[test]
    fn test_plain_text_and_bare_lrc_metadata_tags_classify_as_plain() {
        assert!(!is_synced_lyrics(PLAIN));
        // Metadata-only LRC tags carry no timeline — treating them as synced
        // would render an empty karaoke view.
        assert!(!is_synced_lyrics("[ar:Artist]\n[ti:Title]\njust words"));
        assert!(!is_synced_lyrics("[verse 1] not a timestamp"));
    }

    #[test]
    fn test_embedded_tag_lyrics_are_read_and_empty_frames_are_not() {
        use lofty::tag::{ItemKey, Tag, TagType};

        // ID3v2's USLT frame surfaces as UnsyncLyrics — ItemKey::Lyrics is
        // not a valid ID3v2 key in lofty, which is why both keys are probed.
        let mut id3 = Tag::new(TagType::Id3v2);
        assert!(id3.insert_text(ItemKey::UnsyncLyrics, LRC.to_string()));
        assert_eq!(lyrics_from_tag(&id3), Some(LRC.to_string()));

        // Vorbis carries the plain LYRICS comment under ItemKey::Lyrics.
        let mut vorbis = Tag::new(TagType::VorbisComments);
        assert!(vorbis.insert_text(ItemKey::Lyrics, PLAIN.to_string()));
        assert_eq!(lyrics_from_tag(&vorbis), Some(PLAIN.to_string()));

        let mut empty = Tag::new(TagType::Id3v2);
        empty.insert_text(ItemKey::UnsyncLyrics, "   \n ".to_string());
        assert_eq!(lyrics_from_tag(&empty), None);
        assert_eq!(lyrics_from_tag(&Tag::new(TagType::Id3v2)), None);
    }

    #[test]
    fn test_sidecar_lrc_wins_over_txt_and_reports_synced() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"not really audio").unwrap();
        fs::write(dir.path().join("song.txt"), PLAIN).unwrap();
        fs::write(dir.path().join("song.lrc"), LRC).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "sidecar");
        assert_eq!(found.kind, "synced");
        assert_eq!(found.text, LRC);
    }

    #[test]
    fn test_txt_sidecar_reports_plain() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.flac");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.txt"), PLAIN).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "sidecar");
        assert_eq!(found.kind, "plain");
    }

    #[test]
    fn test_lyrics_subfolder_is_probed_after_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        let sub = dir.path().join("Lyrics");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("song.lrc"), LRC).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "folder");
        assert_eq!(found.kind, "synced");
    }

    #[test]
    fn test_a_wrong_stem_empty_file_or_missing_track_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("other.lrc"), LRC).unwrap();
        fs::write(dir.path().join("song.lrc"), "  \n ").unwrap(); // whitespace-only
        assert_eq!(probe_local_lyrics(&audio), None);
        assert_eq!(probe_local_lyrics(&dir.path().join("gone.mp3")), None);
    }

    fn found(kind: &'static str, source: &'static str) -> LocalLyrics {
        LocalLyrics { text: format!("{kind} from {source}"), kind, source, audio: PathBuf::new(), file: None }
    }

    #[test]
    fn test_prefer_synced_takes_a_later_synced_over_an_earlier_plain() {
        let got = prefer_synced([found("plain", "embedded"), found("synced", "sidecar")]).unwrap();
        assert_eq!(got.source, "sidecar");
    }

    #[test]
    fn test_prefer_synced_keeps_the_first_plain_when_nothing_is_synced() {
        let got = prefer_synced([found("plain", "embedded"), found("plain", "sidecar")]).unwrap();
        assert_eq!(got.source, "embedded");
        assert_eq!(prefer_synced(Vec::new()), None);
    }

    #[test]
    fn test_prefer_synced_stops_pulling_at_the_first_synced() {
        let mut pulled = 0;
        let got = prefer_synced(
            [found("synced", "embedded"), found("synced", "sidecar")]
                .into_iter()
                .inspect(|_| pulled += 1),
        );
        assert_eq!(got.unwrap().source, "embedded");
        assert_eq!(pulled, 1);
    }

    #[test]
    fn test_txt_sidecar_does_not_mask_a_synced_lyrics_folder_file() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.txt"), PLAIN).unwrap();
        let sub = dir.path().join("Lyrics");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("song.lrc"), LRC).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "folder");
        assert_eq!(found.kind, "synced");
    }

    #[test]
    fn test_bom_is_stripped_from_sidecar_text() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.lrc"), format!("\u{feff}{LRC}")).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert!(found.text.starts_with("[ar:"));
        assert_eq!(found.kind, "synced");
    }

    #[test]
    fn test_probe_reports_the_file_that_answered() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        let sub = dir.path().join("Lyrics");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("song.lrc"), LRC).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.audio, audio);
        assert_eq!(found.file, Some(sub.join("song.lrc")));
    }

    #[test]
    fn test_an_empty_lrc_does_not_hide_the_txt_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.lrc"), "").unwrap();
        fs::write(dir.path().join("song.txt"), PLAIN).unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.file, Some(dir.path().join("song.txt")));
        assert_eq!(found.text, PLAIN);
    }

    /// An MP3 whose tag carries `lyrics` (ID3v2 USLT).
    fn mp3_with_lyrics(path: &Path, lyrics: &str) {
        use lofty::config::WriteOptions;
        use lofty::prelude::*;
        use lofty::tag::ItemKey;
        fs::write(path, crate::tag_writer::mp3_with_malformed_date("Song", "Band")).unwrap();
        let mut file = crate::tag_writer::read_tagged_file(path).unwrap();
        assert!(file.primary_tag_mut().unwrap().insert_text(ItemKey::UnsyncLyrics, lyrics.to_string()));
        file.save_to_path(path, WriteOptions::default()).unwrap();
    }

    /// A test Trash: moves what it's handed into `bin`, so a test can see the
    /// previous version was kept.
    fn trash_into(bin: &Path) -> impl Fn(&Path) -> Result<(), String> + '_ {
        move |p: &Path| fs::rename(p, bin.join(p.file_name().unwrap())).map_err(|e| e.to_string())
    }

    #[test]
    fn test_tag_lyrics_come_first_among_plain_answers() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        mp3_with_lyrics(&audio, PLAIN);
        fs::write(dir.path().join("song.txt"), "Other words\n").unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!((found.source, found.text.as_str()), ("embedded", PLAIN));

        // ...but a synced file still beats plain tag lyrics.
        fs::write(dir.path().join("song.lrc"), LRC).unwrap();
        assert_eq!(probe_local_lyrics(&audio).unwrap().source, "sidecar");
    }

    #[test]
    fn test_an_edit_of_tag_lyrics_goes_back_into_the_tag() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        mp3_with_lyrics(&audio, PLAIN);
        let bin = tempfile::tempdir().unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        let now = save_and_verify(&found, LRC, &trash_into(bin.path())).unwrap();
        assert_eq!((now.source, now.kind, now.text.as_str()), ("embedded", "synced", LRC));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no sidecar was written");
    }

    #[test]
    fn test_new_lyrics_go_into_the_tags_of_a_file_that_has_none() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, crate::tag_writer::mp3_with_malformed_date("Song", "Band")).unwrap();
        assert!(probe_local_lyrics(&audio).is_none());
        let bin = tempfile::tempdir().unwrap();

        for text in [LRC, PLAIN] {
            let target = new_lyrics_target(&audio, text);
            assert_eq!((target.source, target.file.as_ref()), ("embedded", None));
            let now = save_and_verify(&target, text, &trash_into(bin.path())).unwrap();
            assert_eq!((now.source, now.text.as_str()), ("embedded", text));
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no sidecar was written");
        // The rest of the tag is untouched.
        let file = crate::tag_writer::read_tagged_file(&audio).unwrap();
        use lofty::prelude::*;
        assert_eq!(file.primary_tag().unwrap().title().as_deref(), Some("Song"));
    }

    #[test]
    fn test_new_lyrics_create_the_tag_of_an_untagged_file() {
        use lofty::prelude::*;
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        // MPEG-1 Layer III frames of silence, no tag at all: the write has to
        // create one.
        let mut bytes = Vec::new();
        for _ in 0..8 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat(0u8).take(413));
        }
        fs::write(&audio, bytes).unwrap();
        assert!(crate::tag_writer::read_tagged_file(&audio).unwrap().primary_tag().is_none());

        let bin = tempfile::tempdir().unwrap();
        let target = new_lyrics_target(&audio, LRC);
        assert_eq!(target.source, "embedded");
        let now = save_and_verify(&target, LRC, &trash_into(bin.path())).unwrap();
        assert_eq!((now.source, now.kind, now.text.as_str()), ("embedded", "synced", LRC));
    }

    #[test]
    fn test_new_lyrics_go_into_the_tags_of_an_mp4_video() {
        if !crate::video_frames::is_ffmpeg_available() {
            eprintln!("ffmpeg not installed; skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("clip.mp4");
        let status = crate::dependencies::command_with_path("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest"])
            .args(["-c:v", "mpeg4", "-c:a", "aac"])
            .arg(&video)
            .status()
            .unwrap();
        assert!(status.success());
        let bin = tempfile::tempdir().unwrap();

        let target = new_lyrics_target(&video, LRC);
        assert_eq!(target.source, "embedded", "an MP4 holds lyrics in its own tags");
        let now = save_and_verify(&target, LRC, &trash_into(bin.path())).unwrap();
        assert_eq!((now.source, now.kind, now.text.as_str()), ("embedded", "synced", LRC));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no sidecar was written");
        // The scanner reads a video's lyrics with the same embedded_lyrics_in
        // the read-back above went through.
        let file = crate::tag_writer::read_tagged_file(&video).unwrap();
        assert_eq!(embedded_lyrics_in(&file).as_deref(), Some(LRC));
    }

    #[test]
    fn test_new_lyrics_for_a_file_that_cant_be_tagged_go_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.dsf");
        fs::write(&audio, b"not a file lofty reads").unwrap();
        let bin = tempfile::tempdir().unwrap();

        let target = new_lyrics_target(&audio, LRC);
        assert_eq!(target.file, Some(dir.path().join("song.lrc")));
        let now = save_and_verify(&target, LRC, &trash_into(bin.path())).unwrap();
        assert_eq!((now.source, now.text.as_str()), ("sidecar", LRC));

        let plain = dir.path().join("other.dsf");
        fs::write(&plain, b"x").unwrap();
        let target = new_lyrics_target(&plain, PLAIN);
        save_and_verify(&target, PLAIN, &trash_into(bin.path())).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("other.txt")).unwrap(), PLAIN);
    }

    #[test]
    fn test_an_edit_of_a_file_goes_back_into_that_file_and_keeps_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        let sub = dir.path().join("Lyrics");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("song.txt"), PLAIN).unwrap();
        let bin = tempfile::tempdir().unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        // Timestamps added to a .txt stay in the .txt: the kind is read from
        // the text, so it reads back as synced.
        let now = save_and_verify(&found, LRC, &trash_into(bin.path())).unwrap();
        assert_eq!((now.source, now.kind), ("folder", "synced"));
        assert_eq!(fs::read_to_string(sub.join("song.txt")).unwrap(), LRC);
        assert_eq!(fs::read_to_string(bin.path().join("song.txt")).unwrap(), PLAIN, "the previous version went to the Trash");
        assert_eq!(fs::read_dir(&sub).unwrap().count(), 1, "no temp file is left behind");
    }

    #[test]
    fn test_an_edit_that_something_else_outranks_is_reported_not_shown_as_saved() {
        // Plain lyrics in the tags + a synced .lrc: the .lrc shows. Stripping
        // its timestamps saves a plain .lrc — which the tag's plain lyrics
        // then outrank.
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        mp3_with_lyrics(&audio, PLAIN);
        fs::write(dir.path().join("song.lrc"), LRC).unwrap();
        let bin = tempfile::tempdir().unwrap();

        let found = probe_local_lyrics(&audio).unwrap();
        assert_eq!(found.source, "sidecar");
        let err = save_and_verify(&found, "Edited words\n", &trash_into(bin.path())).unwrap_err();
        assert!(err.contains("Saved to song.lrc"), "{err}");
        assert!(err.contains("the tags of song.mp3"), "{err}");
        assert_eq!(fs::read_to_string(dir.path().join("song.lrc")).unwrap(), "Edited words\n", "the edit is on disk");
    }

    #[test]
    fn test_empty_or_oversized_text_is_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.lrc"), LRC).unwrap();
        let bin = tempfile::tempdir().unwrap();
        let found = probe_local_lyrics(&audio).unwrap();

        assert!(save_and_verify(&found, "  \n", &trash_into(bin.path())).is_err());
        assert!(save_and_verify(&found, &"x".repeat(MAX_LYRICS_BYTES + 1), &trash_into(bin.path())).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("song.lrc")).unwrap(), LRC);
    }

    #[test]
    fn test_a_failed_trash_still_saves() {
        // The Trash copy is only the undo; the save itself has happened.
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("song.mp3");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("song.lrc"), LRC).unwrap();
        let found = probe_local_lyrics(&audio).unwrap();

        let refuse = |_: &Path| -> Result<(), String> { Err("no trash here".to_string()) };
        let now = save_and_verify(&found, "[00:02.00]x\n", &refuse).unwrap();
        assert_eq!(now.text, "[00:02.00]x\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2, "only the audio and the .lrc remain");
    }

    #[test]
    fn test_a_failed_replace_leaves_the_old_file_in_place() {
        // The target is a directory, so the rename over it fails: the old
        // "file" must still be there and no temp file left behind.
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("song.lrc");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), "x").unwrap();
        let bin = tempfile::tempdir().unwrap();
        assert!(replace_text_file(&target, LRC, &trash_into(bin.path())).is_err());
        assert!(target.join("keep").exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
