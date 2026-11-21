// "A song's cue sheet was just saved or deleted" — the source of the
// `cues:changed` plugin event (`api.cues.onChanged`). usePlugins forwards every
// emit to the subscribed plugins; nothing else listens. (The open Now Playing
// view reloads off the backend's own `cue-sheet-changed` Tauri event.)
//
// Emitted after the write succeeded, from the only two writers there are:
//   assistant  the control API's cues.set / cues.delete (useControlApi)
//   plugin     a plugin's api.cues.set / api.cues.delete (usePlugins)
// The app has no cue-sheet editor of its own.
//
// In-process only, like lyricsEvents: every writer lives in this webview.

import type { CueSheetChange, CueSheetOrigin } from "../types/plugin";

type Listener = (change: CueSheetChange) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscriber. */
export function onCueSheetChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The change for one song's sheet, or null when there is no song to name.
 *  Pure — tested. */
export function cueSheetChange(
  song: { title: string; artistName?: string | null },
  action: CueSheetChange["action"],
  origin: CueSheetOrigin,
  from?: { pluginId?: string | null; updatedAt?: number | null },
): CueSheetChange | null {
  const title = typeof song.title === "string" ? song.title.trim() : "";
  if (!title) return null;
  const updatedAt = from?.updatedAt;
  return {
    title,
    artistName: song.artistName?.trim() || null,
    action,
    origin,
    pluginId: origin === "plugin" ? from?.pluginId ?? null : null,
    updatedAt: action === "saved" && typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

/** Announce one song's sheet change (no-op when `cueSheetChange` says there is
 *  nothing to announce). Never throws: a listener's failure is logged. */
export function announceCueSheet(
  song: { title: string; artistName?: string | null },
  action: CueSheetChange["action"],
  origin: CueSheetOrigin,
  from?: { pluginId?: string | null; updatedAt?: number | null },
): void {
  const change = cueSheetChange(song, action, origin, from);
  if (!change) return;
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (e) {
      console.error("Cue sheet change listener failed:", e);
    }
  }
}
