// Pure model behind the lyrics editor (components/renderers/LyricsEditor.tsx).
//
// The editor has two views over ONE text: Write (a textarea) and Sync (tap a
// key on each line while the song plays). The text stays the single source of
// truth — Sync parses it into lines, changes one line, and writes it back — so
// switching views never loses anything. Each line keeps its `raw` spelling and
// only a line the user actually re-timed is re-spelled, which keeps a pasted
// LRC byte-identical until it is touched (3-digit milliseconds, metadata tags
// like `[ar:…]` and blank stanza breaks all survive).

/** One line of the editor's text. `time` is seconds, or null when untimed. */
export interface EditorLine {
  raw: string;
  time: number | null;
  text: string;
  /** An LRC header tag (`[ar:Artist]`, `[offset:+200]`) — kept verbatim and
   *  never offered for syncing. */
  meta: boolean;
}

export type LyricsKind = "plain" | "synced";

const TIMED_RE = /^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/;
const META_RE = /^\s*\[[a-zA-Z#]+:[^\]]*\]\s*$/;

export function parseEditorLines(text: string): EditorLine[] {
  return text.split(/\r?\n/).map(raw => {
    const m = raw.match(TIMED_RE);
    if (m) {
      const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
      return { raw, time: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: m[4].trim(), meta: false };
    }
    if (META_RE.test(raw)) return { raw, time: null, text: raw.trim(), meta: true };
    return { raw, time: null, text: raw.trim(), meta: false };
  });
}

export function serializeEditorLines(lines: EditorLine[]): string {
  return lines.map(l => l.raw).join("\n");
}

/** `mm:ss.cc` — the spelling LRC players all read. */
export function formatLrcTime(secs: number): string {
  const cs = Math.round(Math.max(0, secs) * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** `m:ss.c` for on-screen readouts (the stamps in the Sync list). */
export function formatClock(secs: number): string {
  const ds = Math.round(Math.max(0, secs) * 10);
  const m = Math.floor(ds / 600);
  const s = Math.floor((ds % 600) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${ds % 10}`;
}

function respell(line: EditorLine, time: number | null): EditorLine {
  if (time == null) return { ...line, time: null, raw: line.text };
  const t = Math.max(0, Math.round(time * 100) / 100);
  return { ...line, time: t, raw: `[${formatLrcTime(t)}]${line.text}` };
}

/** The lines Sync offers: sung lines only — not headers, not blank lines
 *  (a blank stanza break, timed or not, is kept but never needs a stamp). */
export function syncableIndices(lines: EditorLine[]): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => { if (!l.meta && l.text) out.push(i); });
  return out;
}

export function setLineTime(lines: EditorLine[], index: number, time: number | null): EditorLine[] {
  if (index < 0 || index >= lines.length) return lines;
  const next = lines.slice();
  next[index] = respell(lines[index], time);
  return next;
}

export function nudgeLineTime(lines: EditorLine[], index: number, delta: number): EditorLine[] {
  const t = lines[index]?.time;
  if (t == null) return lines;
  return setLineTime(lines, index, t + delta);
}

/** Text-level wrappers: what the editor actually calls, since text is its state. */
export function stampInText(text: string, index: number, time: number | null): string {
  return serializeEditorLines(setLineTime(parseEditorLines(text), index, time));
}

export function nudgeInText(text: string, index: number, delta: number): string {
  return serializeEditorLines(nudgeLineTime(parseEditorLines(text), index, delta));
}

/**
 * Reaction lead: a tap lands as late as the hand that makes it (≈0.2–0.3s
 * after the line starts), so every stamp is moved this much earlier. Without
 * it a carefully tapped sheet runs uniformly late. Sync offers the choices;
 * the pick is stored as `lyricsSyncLeadMs`.
 */
export const STAMP_LEAD_OPTIONS_MS = [0, 100, 150, 200, 250, 300, 400, 500] as const;
export const DEFAULT_STAMP_LEAD_MS = 250;
export const STAMP_LEAD_STORE_KEY = "lyricsSyncLeadMs";

/** A stored lead, or the default when it isn't one of the choices. */
export function coerceStampLeadMs(value: unknown): number {
  return typeof value === "number" && (STAMP_LEAD_OPTIONS_MS as readonly number[]).includes(value) ? value : DEFAULT_STAMP_LEAD_MS;
}

/** The time a tap at `positionSecs` stamps: earlier by the lead, never below 0. */
export function stampTime(positionSecs: number, leadMs: number): number {
  return Math.max(0, positionSecs - leadMs / 1000);
}

/** Remove every timestamp (Sync's "Start over"), headers included. */
export function clearAllTimes(text: string): string {
  return serializeEditorLines(
    parseEditorLines(text)
      .filter(l => !l.meta)
      .map(l => (l.time == null ? l : respell(l, null))),
  );
}

export interface LyricsStats {
  /** Sung lines (what Sync offers). */
  lines: number;
  timed: number;
  /** Timed lines whose time is earlier than a timed line before them —
   *  they would play out of order. */
  outOfOrder: number;
  /** Index (into the parsed lines) of the first of those, or -1. */
  firstOutOfOrder: number;
}

export function lyricsStats(lines: EditorLine[]): LyricsStats {
  let timed = 0;
  let outOfOrder = 0;
  let firstOutOfOrder = -1;
  let last = -Infinity;
  const idx = syncableIndices(lines);
  for (const i of idx) {
    const t = lines[i].time;
    if (t == null) continue;
    timed++;
    if (t < last) {
      outOfOrder++;
      if (firstOutOfOrder < 0) firstOutOfOrder = i;
    }
    last = Math.max(last, t);
  }
  return { lines: idx.length, timed, outOfOrder, firstOutOfOrder };
}

/** The kind to save as, read off the text — never a separate choice. A text
 *  with any timed SUNG line is synced; that's what LRC means. A timed blank
 *  stanza break alone doesn't count: saved as synced, that rendered an empty
 *  panel (as did the Plain/Synced dropdown that used to decide). */
export function detectLyricsKind(text: string): LyricsKind {
  return parseEditorLines(text).some(l => l.time != null && !l.meta && l.text) ? "synced" : "plain";
}

/** Where Sync's cursor should start: the first sung line without a time, or
 *  the first sung line when every one is already timed. -1 when there is
 *  nothing to sync. */
export function firstUntimedIndex(lines: EditorLine[]): number {
  const idx = syncableIndices(lines);
  return idx.find(i => lines[i].time == null) ?? idx[0] ?? -1;
}

/** The sung line after `index` (or -1 at the end). */
export function nextSyncable(lines: EditorLine[], index: number): number {
  return syncableIndices(lines).find(i => i > index) ?? -1;
}

/** The sung line before `index` (or -1 at the start). */
export function prevSyncable(lines: EditorLine[], index: number): number {
  const idx = syncableIndices(lines);
  for (let k = idx.length - 1; k >= 0; k--) if (idx[k] < index) return idx[k];
  return -1;
}

/** The longest lyrics text a save from outside the editor accepts (a plugin's
 *  `api.lyrics.save`, the control API's `lyrics.set`) — far past any song,
 *  short of a pasted web page. */
export const MAX_LYRICS_CHARS = 200_000;

export interface LyricsSaveCheck {
  kind: LyricsKind;
  stats: LyricsStats;
  /** Saved anyway, but worth telling the caller (untimed lines in a synced
   *  text never highlight). */
  warnings: string[];
}

/** The checks behind a lyrics save from outside the editor (the control
 *  API's `lyrics.set`): the kind comes off the text, as in the editor, and a
 *  text that would render wrong is refused with the reason. Throws on empty
 *  or oversized text and on timed lines out of order. */
export function checkLyricsForSave(text: string): LyricsSaveCheck {
  if (!text.trim()) throw new Error("text is empty");
  if (text.length > MAX_LYRICS_CHARS) throw new Error(`text is longer than ${MAX_LYRICS_CHARS} characters`);
  const lines = parseEditorLines(text);
  const stats = lyricsStats(lines);
  if (stats.lines === 0) throw new Error("text has no lyric lines");
  if (stats.firstOutOfOrder >= 0) {
    const i = stats.firstOutOfOrder;
    throw new Error(
      `${stats.outOfOrder} timed line(s) are earlier than a line before them — first: line ${i + 1} "${lines[i].raw}"`,
    );
  }
  const kind = detectLyricsKind(text);
  const warnings: string[] = [];
  if (kind === "synced" && stats.timed < stats.lines) {
    warnings.push(`${stats.lines - stats.timed} of ${stats.lines} lines have no timestamp and won't highlight`);
  }
  return { kind, stats, warnings };
}
