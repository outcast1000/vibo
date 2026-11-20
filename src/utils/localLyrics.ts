// Local lyrics (issue #131): embedded tag lyrics, a sidecar `.lrc`/`.txt`
// named like the audio file, or the same inside a `Lyrics/` subfolder —
// answered by the backend (`get_local_lyrics`): for a library track from what
// the last scan stored (the library scan reads lyrics files, not this), for a
// file outside the library by reading its files. This is the fetch behind the
// built-in `core:local-lyrics` provider row in the lyrics chain (answered in
// usePlugins.invokeInfoFetch), seeded ahead of the web plugins by DB
// `ensure_builtin_rows` (db/mod.rs). Its answers ride the ordinary info-value cache — which is
// what makes local lyrics reachable by the lyrics full-text search
// (`search_information_values`) — but expire after a day instead of the web
// TTL (`cacheTtlForRow` in infoFetchChain.ts): a file outside the library has
// no scan to notice it changed, and for a library track the re-check is a
// database read.
import { invoke } from "@tauri-apps/api/core";
import type { InfoEntity } from "../types/informationTypes";
import type { LyricsOrigin } from "../types/plugin";
import { CORE_LOCAL_LYRICS_PROVIDER, saveInfoValue } from "./infoFetchChain";
import { announceLyrics } from "./lyricsEvents";

interface LocalLyricsRow {
  text: string;
  kind: "plain" | "synced";
  source: "embedded" | "sidecar" | "folder";
}

/** Provider attribution shown under the lyrics section, naming which local
 *  probe answered rather than a generic "Local". */
export function localLyricsProviderName(source: LocalLyricsRow["source"]): string {
  switch (source) {
    case "embedded": return "Embedded in file";
    case "sidecar": return "Lyrics file";
    case "folder": return "Lyrics folder";
  }
}

function localLyricsValue(found: LocalLyricsRow): Record<string, unknown> {
  return {
    text: found.text,
    kind: found.kind,
    local: true,
    _meta: { providerName: localLyricsProviderName(found.source) },
  };
}

/** LyricsData-shaped value for the lyrics renderers, or null when the track
 *  has no local lyrics. `local: true` marks it for surfaces that treat a
 *  file-backed value differently — the in-app editor saves an edit of it back
 *  to the file (`saveLocalLyrics`), since an edit saved only to the cache
 *  would be overwritten by the next scan of the file. */
export async function fetchLocalLyrics(
  entity: Pick<InfoEntity, "kind" | "name" | "artistName" | "albumTitle">,
  path?: string | null,
): Promise<Record<string, unknown> | null> {
  if (entity.kind !== "track" || !entity.name) return null;
  try {
    const found = await invoke<LocalLyricsRow | null>("get_local_lyrics", {
      title: entity.name,
      artistName: entity.artistName || null,
      albumName: entity.albumTitle || null,
      path: path ?? null,
    });
    return found?.text ? localLyricsValue(found) : null;
  } catch (e) {
    console.error("Failed to read local lyrics:", e);
    return null;
  }
}

/** Save a song's lyrics into its files (`save_local_lyrics`) — always, when
 *  the song has a local file (owner decision, 2026-11-20): back into the
 *  source that answered (the audio file's tags, or the sidecar /
 *  Lyrics-folder file; a replaced file's old version goes to the Trash), and
 *  for a file with no lyrics yet into its tags (a `.lrc`/`.txt` beside it when
 *  its format can't be tagged). The backend finds the file itself — the same
 *  lookup `fetchLocalLyrics` runs — so nothing here names a destination.
 *  Resolves with the value as it now reads from disk, or `null` when the song
 *  has no local file to write into; rejects with the backend's reason,
 *  including "saved, but X still takes priority". */
export async function saveLocalLyrics(
  entity: Pick<InfoEntity, "name" | "artistName" | "albumTitle" | "path">,
  text: string,
): Promise<Record<string, unknown> | null> {
  const saved = await invoke<LocalLyricsRow | null>("save_local_lyrics", {
    title: entity.name,
    artistName: entity.artistName || null,
    albumName: entity.albumTitle || null,
    path: entity.path ?? null,
    text,
  });
  return saved ? localLyricsValue(saved) : null;
}

/** Where `saveSongLyrics` put the lyrics: into the song's files (`value` is
 *  what the file now says) or only into Vibo's cache (no local file). */
export type SongLyricsSave =
  | { savedTo: "file"; value: Record<string, unknown> }
  | { savedTo: "app" };

/** Make `text` a song's lyrics — the one save behind the in-app lyrics editor
 *  and the control API's `lyrics.set`. A track with a local file always gets
 *  them in its files (`saveLocalLyrics`), then cached under the local-lyrics
 *  row as what the file now says; anything else is a cache-only save (the
 *  same write as a plugin's `api.lyrics.save`). Both announce the change, so
 *  every open view of the song re-reads, and tell plugins (`lyrics:changed`,
 *  from `origin` — who asked for the save). Rejects with the file save's
 *  reason (including "saved, but X still takes priority"). */
export async function saveSongLyrics(
  entity: InfoEntity,
  text: string,
  kind: string,
  origin: LyricsOrigin,
  from?: { pluginId?: string | null },
): Promise<SongLyricsSave> {
  const value = entity.kind === "track" ? await saveLocalLyrics(entity, text) : null;
  if (!value) {
    const cached = { text, kind };
    await saveInfoValue({ typeId: "lyrics", entity, value: cached });
    announceLyrics(entity, cached, origin, from);
    return { savedTo: "app" };
  }
  // The file holds the edit now: a cache failure must not report a failed
  // save (a retry would only rewrite the file). The backend has already
  // dropped the stale cached copy (save_local_lyrics → set_track_lyrics), so
  // the next look reads the saved lyrics.
  try {
    await saveInfoValue({ typeId: "lyrics", entity, value, provider: CORE_LOCAL_LYRICS_PROVIDER });
  } catch (cacheErr) {
    console.error("Saved the lyrics file but couldn't update the cached copy:", cacheErr);
  }
  // What the file now says — announced even when the cache write failed,
  // since the file holds the lyrics either way.
  announceLyrics(entity, value, origin, from);
  return { savedTo: "file", value };
}
