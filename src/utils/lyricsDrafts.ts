// Lyrics drafts waiting for the user's review — `api.ui.requestAction(
// "review-lyrics", …)`.
//
// A plugin that produces lyrics it isn't sure of (Whisper's transcripts and
// timings) doesn't save them: it hands them to the host, which opens the
// song's track page with the draft in the lyrics editor. The user's Save is
// the approval and goes through the editor's ordinary save (files first);
// Discard leaves the song's lyrics as they were. Either way the plugin is told
// (`onLyricsDraftClosed` → its `api.ui.onAction("review-lyrics:closed")`), so
// it never has to guess the outcome from lyric saves.
//
// One draft per song, matched the way detail-tab requests are (folded case and
// accents; a draft sent without an artist matches the title under any artist),
// so the page built from the library's spelling finds a draft named with the
// plugin's. Kept in memory only: the plugin owns its drafts and re-sends one to
// review it again — a re-sent draft replaces the one on screen (`seq`).

import { useSyncExternalStore } from "react";
import { normalizeForMatch } from "./normalize";

/** Longest draft accepted, in characters — a long video's transcript fits. */
export const MAX_LYRICS_DRAFT_CHARS = 400_000;

export interface LyricsDraftInput {
  pluginId: string;
  /** Shown in the banner: "Draft from Whisper". */
  source: string;
  title: string;
  artistName: string | null;
  albumTitle: string | null;
  text: string;
  /** One or two plain sentences for the banner: what to check. */
  note: string | null;
}

export interface LyricsDraft extends LyricsDraftInput {
  /** Bumped on every put, so the editor showing a draft is rebuilt when a
   *  newer one for the same song arrives. */
  seq: number;
}

/** How a review ended, told to the plugin that sent the draft. */
export interface LyricsDraftOutcome {
  pluginId: string;
  title: string;
  artistName: string | null;
  outcome: "saved" | "discarded";
}

interface DraftTarget {
  name: string;
  artistName?: string | null;
}

const fold = (s: string | null | undefined) => normalizeForMatch((s ?? "").trim());

const drafts: LyricsDraft[] = [];
const listeners = new Set<() => void>();
let closedListener: ((o: LyricsDraftOutcome) => void) | null = null;
let version = 0;
let seq = 0;

function changed() {
  version++;
  for (const l of Array.from(listeners)) l();
}

/** Does this draft belong to the page for `target`? A draft with no artist
 *  matches the title under any artist (a page always has its row's artist). */
function draftMatches(d: LyricsDraft, target: DraftTarget): boolean {
  if (fold(d.title) !== fold(target.name)) return false;
  return !d.artistName || fold(d.artistName) === fold(target.artistName);
}

/**
 * A plugin's `review-lyrics` payload → a draft, or the reason it was refused.
 * Pure; the caller supplies the plugin's id and name.
 */
export function parseLyricsDraft(
  pluginId: string,
  pluginName: string,
  payload: unknown,
): LyricsDraftInput | { error: string } {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const title = str(p.title);
  if (!title) return { error: "review-lyrics: a title is required" };
  if (typeof p.text !== "string" || !p.text.trim()) return { error: "review-lyrics: text is required" };
  if (p.text.length > MAX_LYRICS_DRAFT_CHARS) return { error: "review-lyrics: text is too long" };
  const note = str(p.note);
  return {
    pluginId,
    source: str(p.source) ?? pluginName,
    title,
    artistName: str(p.artistName),
    albumTitle: str(p.albumTitle),
    text: p.text.replace(/\r\n?/g, "\n").replace(/\s+$/, ""),
    note: note ? note.slice(0, 600) : null,
  };
}

/** Replaces any draft for the same song (same folded title and artist). */
export function putLyricsDraft(input: LyricsDraftInput): LyricsDraft {
  const draft: LyricsDraft = { ...input, seq: ++seq };
  for (let i = drafts.length - 1; i >= 0; i--) {
    const d = drafts[i];
    if (fold(d.title) === fold(input.title) && fold(d.artistName) === fold(input.artistName)) drafts.splice(i, 1);
  }
  drafts.push(draft);
  changed();
  return draft;
}

/** The newest draft for this page's track, or null. */
export function getLyricsDraft(target: DraftTarget): LyricsDraft | null {
  for (let i = drafts.length - 1; i >= 0; i--) if (draftMatches(drafts[i], target)) return drafts[i];
  return null;
}

/**
 * The review of `draft` ended: drop it and tell the plugin that sent it.
 * A newer draft that replaced it meanwhile (another `seq`) is left alone.
 */
export function closeLyricsDraft(draft: LyricsDraft, outcome: "saved" | "discarded"): void {
  const i = drafts.findIndex((d) => d.seq === draft.seq);
  if (i < 0) return;
  drafts.splice(i, 1);
  changed();
  closedListener?.({ pluginId: draft.pluginId, title: draft.title, artistName: draft.artistName, outcome });
}

/** App's one listener: forwards the outcome to the plugin. Returns the remover. */
export function onLyricsDraftClosed(listener: (o: LyricsDraftOutcome) => void): () => void {
  closedListener = listener;
  return () => { if (closedListener === listener) closedListener = null; };
}

export function subscribeLyricsDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The draft waiting for this track, kept current. */
export function useLyricsDraft(target: DraftTarget | null): LyricsDraft | null {
  useSyncExternalStore(subscribeLyricsDrafts, () => version);
  return target ? getLyricsDraft(target) : null;
}

/** Test seam: forget every draft. */
export function resetLyricsDraftsForTest(): void {
  drafts.length = 0;
  closedListener = null;
  changed();
}
