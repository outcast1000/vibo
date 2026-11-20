// "A song's lyrics were just put in place" — the source of the `lyrics:changed`
// plugin event (`api.lyrics.onChanged`). usePlugins forwards every emit to the
// subscribed plugins; nothing else listens.
//
// Emitted from each place lyrics land, after the write succeeded — the user's
// saves through localLyrics.saveSongLyrics, which takes the origin:
//   edit       the in-app lyrics editor (InformationSections "save-lyrics")
//   assistant  the control API's lyrics.set (an AI saving lyrics for the user)
//   plugin     a plugin's api.lyrics.save (e.g. a Community import) — through
//              saveSongLyrics with lyrics:files, else usePlugins' cache save
//   provider   a provider chain walk that came back with lyrics
//              (fetchInfoThroughChain — a lyrics site or the song's own files)
//
// "edit" and "assistant" are the user's own lyrics; the other two came from
// somewhere else, which is what a consumer that shares lyrics needs to know.
//
// In-process only, like infoValueEvents: every writer lives in this webview.

import type { InfoEntity } from "../types/informationTypes";
import type { LyricsChange, LyricsOrigin } from "../types/plugin";

type Listener = (change: LyricsChange) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscriber. */
export function onLyricsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The change for one track's lyrics, or null when there is nothing to
 *  announce: not a track, or no text of a known kind. Pure — tested. */
export function lyricsChange(
  entity: InfoEntity,
  value: unknown,
  origin: LyricsOrigin,
  from?: { pluginId?: string | null; provider?: string | null },
): LyricsChange | null {
  if (entity.kind !== "track" || !entity.name) return null;
  const v = (value && typeof value === "object" ? value : {}) as { text?: unknown; kind?: unknown };
  if (typeof v.text !== "string" || !v.text.trim()) return null;
  if (v.kind !== "synced" && v.kind !== "plain") return null;
  return {
    title: entity.name,
    artistName: entity.artistName ?? null,
    albumTitle: entity.albumTitle ?? null,
    durationSecs: typeof entity.durationSecs === "number" && entity.durationSecs > 0 ? entity.durationSecs : null,
    kind: v.kind,
    text: v.text,
    origin,
    pluginId: from?.pluginId ?? null,
    provider: from?.provider ?? null,
  };
}

/** Announce one track's lyrics (no-op when `lyricsChange` says there is
 *  nothing to announce). Never throws: a listener's failure is logged. */
export function announceLyrics(
  entity: InfoEntity,
  value: unknown,
  origin: LyricsOrigin,
  from?: { pluginId?: string | null; provider?: string | null },
): void {
  const change = lyricsChange(entity, value, origin, from);
  if (!change) return;
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (e) {
      console.error("Lyrics change listener failed:", e);
    }
  }
}
