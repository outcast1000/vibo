// What a copy of lyrics says about itself, for the Get lyrics compare: where
// it came from, which song the source filed it under, that song's length, and
// how far its timing runs. Shown beside each copy so Replace is decided on
// more than the words — two copies often differ only in which cut they were
// timed to. Pure; unit-tested in __tests__/lyricsFacts.test.ts.

import { formatMinSec } from "../utils";
import { parseLrc } from "./lyrics";
import { normalizeForMatch } from "./normalize";

/** The song the lyrics are being got for. */
export interface LyricsSong {
  title: string;
  artist?: string | null;
  album?: string | null;
  durationSecs?: number | null;
}

export interface LyricsFact {
  label: string;
  value: string;
  /** The fact disagrees with the song: another title or artist, another cut's
   *  length, or timing that runs past the end. */
  differs?: boolean;
  /** Hover text saying how it differs. */
  hint?: string;
}

/** A length more than this far from the song's is another cut — LRCLIB's own
 *  matching window. */
export const LYRICS_LENGTH_TOLERANCE_SECS = 2;
/** Synced lines may start this long after the song's end before they count as
 *  running past it (rounding, a fade-out). */
const RUNS_PAST_SLACK_SECS = 5;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
function same(a: string, b: string | null | undefined): boolean {
  return !b || normalizeForMatch(a) === normalizeForMatch(b.trim());
}
function signed(secs: number): string {
  const r = Math.round(secs);
  return r === 0 ? "same length" : `${r > 0 ? "+" : "−"}${formatMinSec(Math.abs(r))}`;
}

export function lyricsFacts(info: Record<string, unknown> | undefined, song: LyricsSong): LyricsFact[] {
  if (!info) return [];
  const facts: LyricsFact[] = [];
  const meta = info._meta as { providerName?: unknown } | undefined;
  const providerName = str(meta?.providerName);
  if (providerName) facts.push({ label: "Source", value: providerName });

  const source = (info.source ?? {}) as Record<string, unknown>;
  const title = str(source.title);
  if (title) {
    const differs = !same(title, song.title);
    facts.push({ label: "Title", value: title, differs, hint: differs ? `This song is “${song.title}”` : undefined });
  }
  const artist = str(source.artist);
  if (artist) {
    const differs = !same(artist, song.artist);
    facts.push({ label: "Artist", value: artist, differs, hint: differs ? `This song is by ${song.artist}` : undefined });
  }
  // Another album is not a mismatch: the same recording sits on singles and
  // compilations.
  const album = str(source.album);
  if (album) facts.push({ label: "Album", value: album });

  const songLength = num(song.durationSecs);
  const length = num(source.durationSecs);
  if (length != null) {
    const delta = songLength != null ? length - songLength : null;
    const differs = delta != null && Math.abs(delta) > LYRICS_LENGTH_TOLERANCE_SECS;
    facts.push({
      label: "Length",
      value: delta != null ? `${formatMinSec(Math.round(length))} (${signed(delta)})` : formatMinSec(Math.round(length)),
      differs,
      hint: differs ? `This song is ${formatMinSec(Math.round(songLength!))} — the timing may be for another cut` : undefined,
    });
  }

  const text = str(info.text);
  if (text) {
    if (info.kind === "synced") {
      const lines = parseLrc(text).filter((l) => l.text);
      const last = lines.length ? lines[lines.length - 1].time : null;
      const runsPast = last != null && songLength != null && last > songLength + RUNS_PAST_SLACK_SECS;
      facts.push({
        label: "Lines",
        value: last != null ? `${lines.length} · last at ${formatMinSec(last)}` : String(lines.length),
        differs: runsPast,
        hint: runsPast ? `The last line comes after the song ends (${formatMinSec(Math.round(songLength!))})` : undefined,
      });
    } else {
      facts.push({ label: "Lines", value: String(text.split("\n").filter((l) => l.trim()).length) });
    }
  }
  return facts;
}
