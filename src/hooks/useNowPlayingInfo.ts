import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import type { NowPlayingInfoResult, PluginTrack } from "../types/plugin";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { isLocalTrack, parseUrlScheme } from "../queueEntry";
import { isVideoTrack } from "../utils";
import { resolveTrackYear } from "../utils/contextImages";
import { useLyrics } from "./useLyrics";
import { parseLrc, activeSyncedLine, lyricPosition } from "../utils/lyrics";
import { nativeEngine, type EngineMediaInfo } from "../playback/nativeEngine";
import { useLatestRef } from "./useLatestRef";
import { subscribeVisiblePlaybackPosition, getPlaybackPosition } from "../playback/positionStore";
import type { TrackAudioFacts } from "../waveform/types";

// Stand-in subscription while no synced lyrics exist — keeps the
// useSyncExternalStore call unconditional without ticking on position.
const noopSubscribe = () => () => {};

interface AudioProps { sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }

// Per-item fetch budget. Slow handlers (e.g. a plugin hitting the network) are
// treated as "error" for that track and the item simply doesn't appear that
// cycle. Mirrors the Home-shelf timeout (`useHome.ts`).
const TIMEOUT_MS = 5_000;

export const NOW_PLAYING_ARTIST_ALBUM_ID = "builtin:artist-album";
export const NOW_PLAYING_LYRICS_SYNCED_ID = "builtin:lyrics-synced";
export const NOW_PLAYING_UP_NEXT_ID = "builtin:up-next";
export const NOW_PLAYING_PLAYING_FROM_ID = "builtin:playing-from";
export const NOW_PLAYING_HISTORY_ID = "builtin:history";

// Synced lyrics resolve synchronously from cached lyrics data (so the current
// line can follow playback) — they bypass the async resolve pipeline below.
const LYRICS_IDS = new Set<string>([NOW_PLAYING_LYRICS_SYNCED_ID]);

// Quality, Plays · Rank and History resolve on their own, outside the async
// batch, so neither waits on an unrelated slow item (a plugin can take 5s).
// Quality waits for the engine to decode the track (a stream's facts exist
// only then). Plays · Rank and History share one history read per play, and
// per rank change — the rank moves once this play is recorded, which is when
// the count should include it; History measures against the play's start, so
// that re-read never counts this play as a previous one.
const QUALITY_ID = "builtin:quality";
const PLAYS_RANK_ID = "builtin:plays-rank";
const OWN_EFFECT_IDS = new Set<string>([QUALITY_ID, PLAYS_RANK_ID, NOW_PLAYING_HISTORY_ID]);
// What the history read races against: a slow read must not look like "no
// plays" (null is the backend's real "never played").
const HISTORY_TIMED_OUT = Symbol("history-timed-out");

// Items read straight off the track or the queue — no lookup. They resolve
// during render, so they change in the same frame as the title (or the queue).
// Resolving them inside the async batch made them wait for its slowest member
// (the quality probe, a plugin item, up to the 5s budget) while the previous
// track's artist/album stayed on screen under the new title.
const SYNC_IDS = new Set<string>([
  NOW_PLAYING_ARTIST_ALBUM_ID,
  NOW_PLAYING_UP_NEXT_ID,
  NOW_PLAYING_PLAYING_FROM_ID,
]);

/** Items that were removed (2026-11-24): Artist and Album alone (Artist ·
 *  Album covers both), Duration (the seek bar shows it), Plain Lyrics (a
 *  random line out of context) and Source (folded into Quality). Their stored
 *  selection / dwell entries are dropped on restore. */
const RETIRED_ITEM_IDS = ["builtin:artist", "builtin:album", "builtin:duration", "builtin:lyrics-plain", "builtin:source"];

/** The stored item selection with retired items dropped. Someone who had
 *  Source on gets Quality, which now names the source — unless they chose
 *  for Quality themselves. Returns the same object when nothing changes.
 *  Pure + exported for tests. */
export function migrateNowPlayingSelection(sel: Record<string, boolean>): Record<string, boolean> {
  if (!RETIRED_ITEM_IDS.some((id) => id in sel)) return sel;
  const out: Record<string, boolean> = { ...sel };
  if (out["builtin:source"] === true && out[QUALITY_ID] === undefined) out[QUALITY_ID] = true;
  for (const id of RETIRED_ITEM_IDS) delete out[id];
  return out;
}

/** The stored dwell map with retired items dropped; Source's dwell goes to
 *  Quality unless Quality has its own. Pure + exported for tests. */
export function migrateNowPlayingPersistence(p: Record<string, number>): Record<string, number> {
  if (!RETIRED_ITEM_IDS.some((id) => id in p)) return p;
  const out: Record<string, number> = { ...p };
  if (out["builtin:source"] !== undefined && out[QUALITY_ID] === undefined) out[QUALITY_ID] = out["builtin:source"];
  for (const id of RETIRED_ITEM_IDS) delete out[id];
  return out;
}

/** The stored item order with retired items dropped; Quality takes Source's
 *  place unless it was already ahead of it. Returns the same array when
 *  nothing changes. Pure + exported for tests. */
export function migrateNowPlayingOrder(order: string[]): string[] {
  if (!order.some((id) => RETIRED_ITEM_IDS.includes(id))) return order;
  const sourceAt = order.indexOf("builtin:source");
  const qualityAt = order.indexOf(QUALITY_ID);
  const out = sourceAt >= 0 && (qualityAt < 0 || qualityAt > sourceAt)
    ? order.map((id, i) => (i === sourceAt ? QUALITY_ID : id)).filter((id, i) => !(id === QUALITY_ID && i === qualityAt))
    : order;
  return out.filter((id) => !RETIRED_ITEM_IDS.includes(id));
}

/** What the queue says about the playing track, for the Up next and Playing
 *  from items. App builds it from the queue state. */
export interface NowPlayingQueueInfo {
  /** The entry that plays after this one in the current mode, or null. */
  upNext: QueueTrack | null;
  /** 0-based position of the playing entry; -1 when nothing is playing. */
  index: number;
  length: number;
  /** The queue banner's name (album, playlist, "Radio: X"), or null. */
  contextName: string | null;
}

/** "Next: Endorphins — August Burns Red", or null. Pure + exported for tests. */
export function formatUpNext(next: QueueTrack | null, currentKey: string | null): string | null {
  if (!next || !next.title || next.key === currentKey) return null;
  return next.artist_name ? `Next: ${next.title} — ${next.artist_name}` : `Next: ${next.title}`;
}

/** "From: Rescue & Restore · 4 of 11", "4 of 11 in queue", or null for a lone
 *  track with no source. Pure + exported for tests. */
export function formatPlayingFrom(info: Pick<NowPlayingQueueInfo, "index" | "length" | "contextName">): string | null {
  const name = info.contextName?.trim() || null;
  const position = info.index >= 0 && info.length > 1 ? `${info.index + 1} of ${info.length}` : null;
  if (name) return position ? `From: ${name} · ${position}` : `From: ${name}`;
  return position ? `${position} in queue` : null;
}

function resolveSyncItem(
  id: string,
  track: QueueTrack,
  artistRank: number | null,
  queue: NowPlayingQueueInfo,
  year: number | null,
): NowPlayingInfoResolved | null {
  if (id === NOW_PLAYING_ARTIST_ALBUM_ID) {
    const segments: NowPlayingInfoSegment[] = [
      artistSegment(track, artistRank != null && artistRank <= 100 ? artistRank : null),
    ];
    const album = albumSegment(track);
    if (album) segments.push(year ? { ...album, text: `${album.text} (${year})` } : album);
    return { id, segments };
  }
  if (id === NOW_PLAYING_UP_NEXT_ID) {
    const text = formatUpNext(queue.upNext, track.key);
    return text ? { id, segments: [{ text }] } : null;
  }
  if (id === NOW_PLAYING_PLAYING_FROM_ID) {
    const text = formatPlayingFrom(queue);
    return text ? { id, segments: [{ text }] } : null;
  }
  return null;
}

/** A piece of the rendered info line. `nav` makes the segment a clickable link
 *  (artist/album navigation); `badge` renders a trailing rank chip (e.g. #12). */
export interface NowPlayingInfoSegment {
  text: string;
  nav?: { kind: "artist" | "album"; name: string; artistName?: string };
  badge?: number | null;
}

/** Designer-controlled visual style for an item type (skin-safe by construction:
 *  `role` resolves to a skin color token in the cycler, never a hardcoded color).
 *  Emphasis (`bold`/`italic`) is independent of `role`. */
export interface NowPlayingInfoStyle {
  bold?: boolean;
  italic?: boolean;
  role?: "muted" | "accent";
}

/** A fully-resolved info item ready to display (one "card" in the cycle). */
export interface NowPlayingInfoResolved {
  id: string;
  segments: NowPlayingInfoSegment[];
  /** Time-of-persistence multiplier (one of NOW_PLAYING_TOP_PRESETS): how many
   *  base cycle intervals this item dwells before the cycler advances. Set in
   *  `resolvedItems`; the cycler treats a missing value as 1. */
  top?: number;
  /** Style from the item's kind (see NowPlayingInfoKind). Set in `resolvedItems`;
   *  a missing value renders with the default (inherited) style. */
  style?: NowPlayingInfoStyle;
}

/** Allowed time-of-persistence multipliers. 0 = "preview only" (shown once in
 *  the opening preview pass, then dropped from the steady rotation); 1 = the
 *  base interval (current behavior); 10 = ten times longer on screen. Used by
 *  the per-item submenu. */
export const NOW_PLAYING_TOP_PRESETS = [0, 1, 2, 5, 10] as const;

/** ToP sentinel for "On request" mode: the item never sits in the steady
 *  rotation — instead it *preempts* whatever is on the line whenever its
 *  resolved content changes or (re)appears, holds for up to ~10s (two base
 *  intervals — REQUEST_HOLD_MULTIPLIER in NowPlayingInfoCycler), and yields
 *  early to a newer request or to its content vanishing. Built for
 *  time-critical content: synced lyrics show exactly while lines are sung and
 *  the ordinary rotation plays through the instrumental gaps, instead of a
 *  dwell timer guessing when the words matter. See `trackOnRequestItems` in
 *  NowPlayingInfoCycler. */
export const NOW_PLAYING_TOP_REQUEST = -1;

/** Whether a stored ToP value is one we honor (a preset or the on-request
 *  sentinel). Pure + exported for tests. */
export function isValidNowPlayingTop(v: number): boolean {
  return v === NOW_PLAYING_TOP_REQUEST || (NOW_PLAYING_TOP_PRESETS as readonly number[]).includes(v);
}

/** What an item *is*, which decides how it looks and how long it stays by
 *  default. A plugin declares it on `api.nowPlayingInfo.registerItem({ kind })`
 *  and the host owns the look, so every play stat reads the same whichever
 *  plugin it comes from, and a skin-safe style is the only style there is.
 *   - `stat`   — a number about the song (plays, listeners, rank): accent,
 *                shown once at each track change (preview only).
 *   - `detail` — secondary facts (source, quality, duration, tags): muted.
 *   - `quote`  — text from the song (lyrics): italic.
 *  No kind renders with the inherited default style. */
export type NowPlayingInfoKind = "stat" | "detail" | "quote";

const NOW_PLAYING_KINDS: readonly NowPlayingInfoKind[] = ["stat", "detail", "quote"];

/** A plugin-supplied kind, or undefined for anything the host doesn't know
 *  (a typo, or a kind a newer plugin targets on an older host). */
export function parseNowPlayingKind(v: unknown): NowPlayingInfoKind | undefined {
  return typeof v === "string" && (NOW_PLAYING_KINDS as readonly string[]).includes(v)
    ? (v as NowPlayingInfoKind)
    : undefined;
}

/** Skin-safe by construction: `role` resolves to a skin color token in the
 *  cycler, never a hardcoded color. */
const NOW_PLAYING_KIND_STYLES: Record<NowPlayingInfoKind, NowPlayingInfoStyle> = {
  stat: { role: "accent" },
  detail: { role: "muted" },
  quote: { italic: true },
};

/** Default time-of-persistence per kind; kinds not listed default to 1. */
const NOW_PLAYING_KIND_DEFAULT_TOP: Partial<Record<NowPlayingInfoKind, number>> = {
  stat: 0, // preview-only: a quick stat at each track change
};

/** Time-of-persistence multiplier for an item — the user's override if it's a
 *  valid preset (or the on-request sentinel), else the item's own default
 *  (built-ins only), else its kind's default, else 1. Pure + for tests. */
export function nowPlayingItemTop(
  d: Pick<NowPlayingInfoDescriptor, "id" | "kind" | "defaultTop">,
  persistence: Record<string, number>,
): number {
  const v = persistence[d.id];
  if (v != null && isValidNowPlayingTop(v)) return v;
  if (d.defaultTop != null) return d.defaultTop;
  return (d.kind && NOW_PLAYING_KIND_DEFAULT_TOP[d.kind]) ?? 1;
}

/** Style for an item, from its kind; undefined renders with the inherited
 *  default. Pure + exported for tests. */
export function nowPlayingItemStyle(d: Pick<NowPlayingInfoDescriptor, "kind">): NowPlayingInfoStyle | undefined {
  return d.kind ? NOW_PLAYING_KIND_STYLES[d.kind] : undefined;
}

/** Space-joined CSS class list for an item style, using the skin-token-backed
 *  `.npi--*` classes (defined in base.css). Empty string for the default style.
 *  Pure + exported for tests. */
export function nowPlayingStyleClass(style: NowPlayingInfoStyle | undefined): string {
  if (!style) return "";
  const cls: string[] = [];
  if (style.bold) cls.push("npi--bold");
  if (style.italic) cls.push("npi--italic");
  if (style.role === "muted") cls.push("npi--muted");
  if (style.role === "accent") cls.push("npi--accent");
  return cls.join(" ");
}

/** The steady-rotation list: the display order with "preview only" (top === 0)
 *  and "on request" (top === NOW_PLAYING_TOP_REQUEST) items dropped — the
 *  former show once in the preview pass, the latter appear only by preempting.
 *  Order is the user's priority order (see nowPlayingOrderedItems) — ToP
 *  controls only how long an item dwells, never where it sits in the cycle.
 *  Pure + exported for tests. */
export function nowPlayingSteadyOrder<T extends { top?: number }>(items: T[]): T[] {
  return items.filter((it) => (it.top ?? 1) > 0);
}

/** Apply the user's priority order to a registered item list. Items named in
 *  `order` come first in that order; anything unlisted (a newly registered
 *  plugin item, or a built-in added by an app update) keeps its registration
 *  order and lands after them. Pure + exported for tests. */
export function nowPlayingOrderedItems<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((it, i) => ({ it, i, rank: rank.get(it.id) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((e) => e.it);
}


/** A registered item, shown as a checkbox in the context-menu checklist.
 *  `defaultEnabled` decides whether it's on before the user customizes. */
export interface NowPlayingInfoDescriptor {
  id: string;
  label: string;
  defaultEnabled: boolean;
  /** Decides the style and the default dwell — see NowPlayingInfoKind. */
  kind?: NowPlayingInfoKind;
  /** Built-ins only: a default dwell that differs from the kind's. */
  defaultTop?: number;
}

// Built-in items contributed by the core app, in display order. Each declares
// its own default-enabled state; Artist · Album and Synced Lyrics are on by
// default (plus the Last.fm plugin's Scrobbles). Plays and rank share one item
// (rank is derived from the play count) — it shows e.g. "142 plays · #12".
export const BUILTIN_DESCRIPTORS: NowPlayingInfoDescriptor[] = [
  // Artist · Album (Year) — the year once the library knows it.
  { id: NOW_PLAYING_ARTIST_ALBUM_ID, label: "Artist · Album", defaultEnabled: true },
  // A stat, but it stays in the rotation: it predates the stat kind's
  // preview-only default, and users who switched it on expect it to stay.
  { id: PLAYS_RANK_ID, label: "Plays · Rank", defaultEnabled: false, kind: "stat", defaultTop: 1 },
  { id: NOW_PLAYING_HISTORY_ID, label: "Listening history", defaultEnabled: false, kind: "stat" },
  { id: NOW_PLAYING_UP_NEXT_ID, label: "Up next", defaultEnabled: false },
  { id: NOW_PLAYING_PLAYING_FROM_ID, label: "Playing from", defaultEnabled: false, kind: "detail" },
  // Names the source too for anything that isn't a local file.
  { id: QUALITY_ID, label: "Quality", defaultEnabled: false, kind: "detail" },
  { id: "builtin:tags", label: "Tags", defaultEnabled: false, kind: "detail" },
  // Synced Lyrics is on by default, On request: each sung line preempts the
  // rotation as it happens (karaoke), and the rotation plays through intros
  // and instrumental gaps. Lyrics only fetch when this item is enabled, so
  // this makes the default experience fetch lyrics for each track.
  { id: NOW_PLAYING_LYRICS_SYNCED_ID, label: "Synced Lyrics", defaultEnabled: true, kind: "quote", defaultTop: NOW_PLAYING_TOP_REQUEST },
];

/** Whether an item is enabled: the user's explicit choice if any, else the
 *  item's own registered default. Pure + exported for tests. */
export function isNowPlayingItemSelected(
  id: string,
  selection: Record<string, boolean>,
  items: NowPlayingInfoDescriptor[],
): boolean {
  return selection[id] ?? items.find((d) => d.id === id)?.defaultEnabled ?? false;
}

/** Format a play count, or null when there's nothing worth showing. Pure +
 *  exported for tests. */
export function formatPlays(count: number | null | undefined): string | null {
  if (count == null || count <= 0) return null;
  return count === 1 ? "1 play" : `${count.toLocaleString()} plays`;
}

/** The Plays · Rank line ("142 plays · #12"), or null. The count includes the
 *  play in progress once it is recorded; the rank shows only in the top 100.
 *  Pure + exported for tests. */
export function formatPlaysRank(count: number | null | undefined, rank: number | null): string | null {
  const parts: string[] = [];
  const plays = formatPlays(count);
  if (plays) parts.push(plays);
  if (rank != null && rank <= 100) parts.push(`#${rank}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "3 weeks ago" for an age in seconds ("earlier today", "yesterday", days,
 *  weeks, months, years). Pure + exported for tests. */
export function formatAgo(secs: number): string {
  const day = 86_400;
  const days = Math.floor(Math.max(0, secs) / day);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (days < 1) return "earlier today";
  if (days < 2) return "yesterday";
  if (days < 14) return unit(days, "day");
  if (days < 60) return unit(Math.floor(days / 7), "week");
  if (days < 365) return unit(Math.floor(days / 30), "month");
  return unit(Math.floor(days / 365), "year");
}

export interface TrackPlayStats {
  play_count: number;
  first_played_at: number | null;
  last_played_at: number | null;
}

/** The Listening history line, measured against when THIS play started
 *  (`startedAt`, unix seconds) so the play in progress — recorded at the
 *  scrobble threshold, mid-song — never counts as a previous one:
 *  "First time you've heard this", "Last played 3 weeks ago", or — when the
 *  newest play recorded is this one — "First heard 2 years ago".
 *  Pure + exported for tests. */
export function formatListeningHistory(
  stats: TrackPlayStats | null,
  startedAt: number,
  now: number,
): string | null {
  const count = stats?.play_count ?? 0;
  const last = stats?.last_played_at ?? null;
  const thisPlayCounted = last != null && last >= startedAt;
  const previous = thisPlayCounted ? count - 1 : count;
  if (previous <= 0) return "First time you've heard this";
  if (!thisPlayCounted && last != null) return `Last played ${formatAgo(now - last)}`;
  const first = stats?.first_played_at ?? null;
  return first != null && first < startedAt ? `First heard ${formatAgo(now - first)}` : null;
}

/** What the Listening history item shows for a history read. A read that
 *  timed out says nothing — it must never become "First time you've heard
 *  this" (null is the backend's real "never played"). `playStartedAt` 0 means
 *  no play has started yet (a track restored at launch): nothing recorded so
 *  far can be this play. Pure + exported for tests. */
export function listeningHistoryLine(
  answer: TrackPlayStats | null | "timed-out",
  playStartedAt: number,
  now: number,
): string | null {
  if (answer === "timed-out") return null;
  return formatListeningHistory(answer, playStartedAt > 0 ? playStartedAt : now, now);
}

/** Advance a cycle index, wrapping at `len`. Pure + exported for tests. */
export function nextCycleIndex(i: number, len: number): number {
  return len <= 0 ? 0 : (i + 1) % len;
}

/** Human-readable playback source from a track path, or null if unknown. Pure +
 *  exported for tests. */
export function formatSource(path: string | null | undefined): string | null {
  if (!path) return null;
  const parsed = parseUrlScheme(path);
  if (parsed.scheme === "file") return "Local";
  if (parsed.scheme === "subsonic") return "Subsonic";
  if (parsed.scheme === "mixtape") return "Mixtape";
  if (parsed.scheme === "external") return "External";
  const proto = parsed.protocol;
  if (proto === "http" || proto === "https") return "Web";
  return proto ? proto.charAt(0).toUpperCase() + proto.slice(1) : null;
}

/** The Quality line with where it plays from in front ("Subsonic · MP3 ·
 *  320 kbps"), for anything that isn't a local file — the old Source item,
 *  folded in. A local file needs no label. Pure + exported for tests. */
export function withQualitySource(path: string | null | undefined, text: string | null): string | null {
  const source = formatSource(path);
  if (!source || source === "Local") return text;
  return text ? `${source} · ${text}` : source;
}

/** Compact audio-quality string (e.g. "FLAC · 44.1 kHz · 16-bit", "MP3 · 320 kbps"),
 *  or null when nothing is known. Pure + exported for tests. */
export function formatQuality(format: string | null | undefined, props: AudioProps | null): string | null {
  const parts: string[] = [];
  if (format) parts.push(format.toUpperCase());
  if (props?.bit_depth && props?.sample_rate) {
    parts.push(`${(props.sample_rate / 1000).toFixed(1)} kHz · ${props.bit_depth}-bit`);
  } else if (props?.bitrate) {
    parts.push(`${props.bitrate} kbps`);
  } else if (props?.sample_rate) {
    parts.push(`${(props.sample_rate / 1000).toFixed(1)} kHz`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Bit depth for an mpv sample-format string ("s16" → "16-bit"), or null when
 *  the format doesn't identify the *source's* depth.
 *
 *  `audio-params/format` is the **decoder's output** format, not a property of
 *  the recording, and for the wide formats the two part company: ffmpeg's FLAC
 *  decoder emits **s32 for a 24-bit file** (`ffmpeg -i` prints it as
 *  `flac, 96000 Hz, s32 (24 bit)`, and mpv duly reports `s32` — measured
 *  against real libmpv by `probe_engine_audio_params` in `mpv_engine/mod.rs`),
 *  and every lossy codec decodes to float regardless of what it stores. So s32
 *  / float / double are reported as **unknown** rather than as a bit depth: a
 *  24-bit master labelled "32-bit" is a wrong claim about the one number a
 *  hi-res listener is checking, and "32-bit float" for an MP3 is noise. The
 *  narrow formats are unambiguous — nothing decodes *up* to s16 — so they
 *  stand. When a real depth is wanted for a file on disk, read it with lofty
 *  (`get_audio_properties_by_path`), which reports what the file says. */
function bitDepthFromMpvFormat(format: string | null | undefined): string | null {
  if (!format) return null;
  const f = format.toLowerCase().replace(/p$/, ""); // planar variants
  if (f === "u8" || f === "s8") return "8-bit";
  if (f === "s16") return "16-bit";
  if (f === "s24") return "24-bit";
  return null;
}

/** Quality string from the mpv engine's live decode facts (works for remote
 *  streams that tag readers can't inspect), or null when nothing is known.
 *  Pure + exported for tests. */
export function formatEngineQuality(info: {
  codec: string | null;
  sampleRate: number | null;
  format: string | null;
  bitrate: number | null;
} | null): string | null {
  if (!info) return null;
  const parts: string[] = [];
  if (info.codec) parts.push(info.codec.toUpperCase());
  // Sample rate is unconditional when known. It used to hang off the bit depth
  // ("rate · depth", else bitrate, else rate), so a file whose decode format
  // says nothing about its depth — every 24-bit lossless one, see
  // `bitDepthFromMpvFormat` — lost its sample rate to the bitrate branch.
  if (info.sampleRate) parts.push(`${(info.sampleRate / 1000).toFixed(1)} kHz`);
  const depth = bitDepthFromMpvFormat(info.format);
  if (depth) parts.push(depth);
  // Bitrate stands in for the depth we can't state — and for a lossy stream it
  // is the number that describes the quality anyway.
  else if (info.bitrate && info.bitrate > 0) parts.push(`${Math.round(info.bitrate / 1000)} kbps`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Human resolution label from pixel dimensions ("1080p", "4K", "1440p", …),
 *  or null. Keyed off height, with thresholds a touch below each standard tier
 *  so slightly-cropped frames (e.g. 1072, 2140) still read as their tier.
 *  Pure + exported for tests. */
export function resolutionShorthand(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  const h = height ?? 0;
  const w = width ?? 0;
  if (h <= 0 && w <= 0) return null;
  if (h >= 4300 || w >= 7600) return "8K";
  if (h >= 2100 || w >= 3800) return "4K";
  if (h >= 1400) return "1440p";
  if (h >= 1060) return "1080p";
  if (h >= 700) return "720p";
  if (h >= 460) return "480p";
  if (h >= 340) return "360p";
  if (h > 0) return `${h}p`;
  return null;
}

/** Compact video-quality string from the engine's live decode facts
 *  (e.g. "H264 · 1080p · 30fps"), or null when no video is playing.
 *  Pure + exported for tests. */
export function formatEngineVideoQuality(info: {
  videoCodec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
} | null): string | null {
  if (!info) return null;
  const hasVideo = (info.width ?? 0) > 0 || (info.height ?? 0) > 0 || !!info.videoCodec;
  if (!hasVideo) return null;
  const parts: string[] = [];
  if (info.videoCodec) parts.push(info.videoCodec.toUpperCase());
  const res = resolutionShorthand(info.width, info.height);
  if (res) parts.push(res);
  if (info.fps && info.fps > 0) parts.push(`${Math.round(info.fps)}fps`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Compact tag line (e.g. "#rock · #jazz"), or null when there are no tags.
 *  Pure + exported for tests. */
export function formatTags(names: string[] | null | undefined): string | null {
  if (!names || names.length === 0) return null;
  return names.map((t) => `#${t}`).join(" · ");
}

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
  ]);
}

/** The Quality text for a track ("FLAC · 96.0 kHz · 24-bit", "H264 · 1080p ·
 *  30fps"), or null. Shared by the Quality info item and the cue-sheet
 *  context (`utils/cueContext.ts`). `playing` says the engine's live decode
 *  facts describe THIS track — pass false for any other track, or it would be
 *  labelled with whatever is playing. */
export async function resolveTrackQuality(
  track: QueueTrack,
  { playing }: { playing: boolean },
): Promise<string | null> {
  const engineInfo = playing ? await readEngineInfo() : null;
  // Video is the engine's alone — resolution is the answer there, and no
  // tag reader supplies it.
  const videoText = formatEngineVideoQuality(engineInfo);
  if (videoText) return videoText;
  // For audio, a file on disk beats the engine: lofty reports the depth
  // the FILE carries, while `audio-params/format` reports what the
  // decoder is emitting — s32 for a 24-bit FLAC (see
  // `bitDepthFromMpvFormat`). The engine stays the only source for
  // anything streamed.
  const props = await readFileProps(track);
  if (props) {
    const text = formatQuality(track.format, props);
    if (text) return text;
  }
  return formatEngineQuality(engineInfo) ?? formatQuality(track.format, null);
}

/** How long the Quality item waits for the engine to start decoding the
 *  track it describes (a stream's resolve can take seconds), and then how much
 *  longer for a stream's bitrate, which mpv reports a moment after decoding
 *  starts. Past either it shows what it has. */
export const QUALITY_ENGINE_WAIT_MS = 15_000;
export const QUALITY_BITRATE_WAIT_MS = 6_000;
const QUALITY_POLL_MS = 250;

export interface PlayingQualityDeps {
  readFileProps: (track: QueueTrack) => Promise<AudioProps | null>;
  readEngineInfo: () => Promise<EngineMediaInfo | null>;
  sleep: (ms: number) => Promise<void>;
}

const defaultQualityDeps: PlayingQualityDeps = {
  readFileProps,
  readEngineInfo,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** The Quality item's text for the track that is playing, reported through
 *  `onText` as it gets better ("MP3 · 44.1 kHz", then "… · 320 kbps").
 *
 *  Unlike `resolveTrackQuality` it never reads the engine before the engine is
 *  decoding THIS track (`engineOnTrack`): at a track change the engine still
 *  describes the previous one, or nothing — and for a stream, which has no
 *  file to read, that read was the whole answer, so the item said only "MP3"
 *  (the format) or the previous song's facts. A local audio file answers from
 *  its own properties at once; video waits for the engine (resolution is the
 *  answer there). Gives up quietly on `signal`. */
export async function resolvePlayingTrackQuality(
  track: QueueTrack,
  engineOnTrack: () => boolean,
  onText: (text: string | null) => void,
  signal: AbortSignal,
  deps: PlayingQualityDeps = defaultQualityDeps,
): Promise<void> {
  const fallback = formatQuality(track.format, null);
  const video = isVideoTrack(track);
  const props = await deps.readFileProps(track);
  if (signal.aborted) return;
  const fileText = props ? formatQuality(track.format, props) : null;
  if (fileText && !video) {
    onText(fileText);
    return;
  }
  for (let waited = 0; !engineOnTrack(); waited += QUALITY_POLL_MS) {
    if (waited >= QUALITY_ENGINE_WAIT_MS) {
      onText(fileText ?? fallback);
      return;
    }
    await deps.sleep(QUALITY_POLL_MS);
    if (signal.aborted) return;
  }
  for (let waited = 0; ; waited += QUALITY_POLL_MS) {
    const info = await deps.readEngineInfo();
    if (signal.aborted) return;
    const videoText = formatEngineVideoQuality(info);
    onText(videoText ?? fileText ?? formatEngineQuality(info) ?? fallback);
    // Done once nothing better is coming: video and file answers are complete,
    // and a stream's line is complete once its bitrate is in.
    if (videoText || fileText || (info?.bitrate ?? 0) > 0 || !info) return;
    if (waited >= QUALITY_BITRATE_WAIT_MS) return;
    await deps.sleep(QUALITY_POLL_MS);
    if (signal.aborted) return;
  }
}

/** The engine's live decode facts for whatever is playing, or null. */
async function readEngineInfo(): Promise<EngineMediaInfo | null> {
  try {
    return await withTimeout(nativeEngine.getMediaInfo(), null);
  } catch (e) {
    console.error("Failed to resolve engine media quality:", e);
    return null;
  }
}

/** What a local file's own tags say about its audio (lofty), or null. */
async function readFileProps(track: QueueTrack): Promise<AudioProps | null> {
  if (!track.path || !isLocalTrack(track)) return null;
  try {
    return await withTimeout(
      invoke<AudioProps | null>("get_audio_properties_by_path", { path: track.path }),
      null,
    );
  } catch (e) {
    console.error("Failed to resolve audio quality:", e);
    return null;
  }
}

/** The facts that describe one copy of a song — what `api.waveforms` plugins
 *  are told (to match the recording and count its format). Same sources and
 *  precedence as `resolveTrackQuality`: the file's own tags for a local file,
 *  the engine's live decode facts for a stream, and never a bit depth read off
 *  the decoder's sample format beyond the unambiguous ones. Pure given its
 *  inputs + exported for tests. */
export function buildTrackAudioFacts(
  track: QueueTrack,
  durationSecs: number,
  props: AudioProps | null,
  engineInfo: EngineMediaInfo | null,
): TrackAudioFacts {
  const depth = bitDepthFromMpvFormat(engineInfo?.format);
  const positive = (n: number | null | undefined) => (n != null && Number.isFinite(n) && n > 0 ? n : null);
  return {
    title: track.title,
    artistName: track.artist_name,
    albumName: track.album_title,
    albumArtistName: track.album_artist_name ?? null,
    durationSecs,
    codec: (track.format || engineInfo?.codec || null)?.toLowerCase() ?? null,
    sampleRate: positive(props?.sample_rate) ?? positive(engineInfo?.sampleRate),
    bitDepth: positive(props?.bit_depth) ?? (depth ? parseInt(depth, 10) : null),
    channels: positive(props?.channels),
    // lofty reports kbps, the engine bits/s.
    bitrateKbps: positive(props?.bitrate) ?? (positive(engineInfo?.bitrate) ? Math.round(engineInfo!.bitrate! / 1000) : null),
  };
}

/** How long to wait for the engine to start decoding a just-started track
 *  before giving up on its live facts (they'd describe the previous one). */
export const ENGINE_FACTS_WAIT_MS = 2000;
const ENGINE_FACTS_POLL_MS = 200;

/** `buildTrackAudioFacts` for the track that is playing right now.
 *  `engineOnTrack` says whether the native engine is decoding THIS track: its
 *  media info is read only once it is (up to `ENGINE_FACTS_WAIT_MS`), because
 *  the command answers about whatever the engine holds — at a track change,
 *  the one before. Never satisfied → the engine half is null. */
export async function resolveTrackAudioFacts(
  track: QueueTrack,
  durationSecs: number,
  engineOnTrack: () => boolean,
  signal?: AbortSignal,
): Promise<TrackAudioFacts> {
  const waitForEngine = async (): Promise<EngineMediaInfo | null> => {
    for (let waited = 0; !engineOnTrack(); waited += ENGINE_FACTS_POLL_MS) {
      if (waited >= ENGINE_FACTS_WAIT_MS || signal?.aborted) return null;
      await new Promise((r) => setTimeout(r, ENGINE_FACTS_POLL_MS));
    }
    return readEngineInfo();
  };
  const [props, engineInfo] = await Promise.all([readFileProps(track), waitForEngine()]);
  return buildTrackAudioFacts(track, durationSecs, props, engineInfo);
}

function artistSegment(track: QueueTrack, badge?: number | null): NowPlayingInfoSegment {
  const name = track.artist_name || "Unknown";
  return {
    text: name,
    nav: track.artist_name ? { kind: "artist", name: track.artist_name } : undefined,
    badge,
  };
}

function albumSegment(track: QueueTrack): NowPlayingInfoSegment | null {
  if (!track.album_title) return null;
  return {
    text: track.album_title,
    nav: { kind: "album", name: track.album_title, artistName: (track.album_artist_name ?? track.artist_name) ?? undefined },
  };
}

interface UseNowPlayingInfoArgs {
  currentTrack: QueueTrack | null;
  trackRank: number | null;
  artistRank: number | null;
  // Plugin-registered descriptors (from usePlugins, already priority-sorted).
  pluginItems: { pluginId: string; itemId: string; label: string; defaultEnabled: boolean; kind?: NowPlayingInfoKind }[];
  // Whether the engine is decoding this track key (usePlayback): the Quality
  // item reads the engine's facts only once they describe the playing track.
  isEngineDecoding: (trackKey: string) => boolean;
  // The queue around the playing track, for Up next and Playing from.
  queue: NowPlayingQueueInfo;
  // When the current play started (usePlayback; unix seconds, 0 before any
  // play): what Listening history measures "before" against.
  playStartedAt: number;
  invokeNowPlayingInfo: (pluginId: string, itemId: string, track: PluginTrack) => Promise<NowPlayingInfoResult>;
  selection: Record<string, boolean>;
  // Per-item time-of-persistence multipliers (id → 1/2/5/10). Missing = 1.
  persistence: Record<string, number>;
  // User priority order (ordered item ids). Drives both the preview pass and the
  // steady rotation; ids missing from it keep their registration order at the end.
  order: string[];
  // Plugin info-type bridge — lyrics are fetched through the same cache/chain as
  // the track-detail Lyrics tab (via useLyrics), only when a lyrics item is on.
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
    onFetchUrl?: (url: string) => void,
  ) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  // True once all plugins have finished activating. Gating the lyrics fetch on
  // this avoids a startup race: the lyrics info-type row persists in the DB, so
  // the fetch fires the moment the restored track is set — but if the lyrics
  // plugin hasn't activated yet, the provider call returns "error", which gets
  // cached for an hour and suppresses lyrics for the track playing at launch.
  pluginsLoaded: boolean;
  // True while a NowPlayingInfoCycler is actually on screen (mini mode, or the
  // full bar with "Show in player bar" on). Gates the synced-lyrics position
  // subscription: it re-renders the HOST — App — every time the sung line
  // changes (~every 2-5s for the whole track), which is pure waste when no
  // cycler renders.
  cyclerVisible: boolean;
  /** Per-track lyrics timing offset; positive delays. The mini player's synced
   *  line has to honour it too, or the same track reads one line here and a
   *  different one on the Now Playing view. See `lyricPosition`. */
  lyricsOffsetSecs?: number;
}

export function useNowPlayingInfo({
  currentTrack,
  trackRank,
  artistRank,
  pluginItems,
  isEngineDecoding,
  queue,
  playStartedAt,
  invokeNowPlayingInfo,
  selection,
  persistence,
  order,
  invokeInfoFetch,
  pluginNames,
  pluginsLoaded,
  cyclerVisible,
  lyricsOffsetSecs = 0,
}: UseNowPlayingInfoArgs): {
  availableItems: NowPlayingInfoDescriptor[];
  resolvedItems: NowPlayingInfoResolved[];
} {
  // Registration order — built-ins first, then plugin items (plugin id =
  // `${pluginId}:${itemId}`) — then the user's priority order on top, which is
  // the display order everywhere: the menu, the preview pass, the rotation.
  const availableItems = useMemo<NowPlayingInfoDescriptor[]>(
    () => nowPlayingOrderedItems([
      ...BUILTIN_DESCRIPTORS,
      ...pluginItems.map((p) => ({ id: `${p.pluginId}:${p.itemId}`, label: p.label, defaultEnabled: p.defaultEnabled, kind: p.kind })),
    ], order),
    [pluginItems, order],
  );

  // Async items (everything that needs a lookup) — resolved once per
  // track/selection, stamped with the track they describe so a previous
  // track's plays / quality / plugin text never shows under the next title.
  const [asyncResolved, setAsyncResolved] = useState<{ sig: string; items: NowPlayingInfoResolved[] }>({ sig: "", items: [] });
  const genRef = useRef(0);

  // Synced lyrics resolve synchronously from cached lyrics data, so the
  // current line can track playback position without re-running the async
  // resolvers each tick. Only fetch when the item is actually enabled.
  const syncedEnabled = isNowPlayingItemSelected(NOW_PLAYING_LYRICS_SYNCED_ID, selection, availableItems);
  const { data: lyricsData } = useLyrics({
    track: currentTrack,
    // Wait for plugins so the first fetch reaches the (now-loaded) lyrics
    // provider instead of caching a spurious "plugin not loaded" error.
    enabled: pluginsLoaded && syncedEnabled,
    invokeInfoFetch,
    pluginNames,
  });

  const syncedLines = useMemo(
    () => (lyricsData?.kind === "synced" && lyricsData.text ? parseLrc(lyricsData.text) : null),
    [lyricsData],
  );
  // Strict "what's being sung right now" — null during intros/instrumental gaps,
  // so the synced-lyrics item drops out of the cycle instead of showing a stale
  // line (see activeSyncedLine). Reads the external position store with a
  // line-level snapshot (a string), so the host re-renders only when the sung
  // LINE changes — not on every ~4 Hz position tick. Gated on cyclerVisible:
  // the host is App, and re-rendering the whole tree per sung line buys
  // nothing while the mini-only cycler isn't rendered.
  const syncedLive = Boolean(syncedLines) && cyclerVisible;
  const syncedText = useSyncExternalStore(
    syncedLive ? subscribeVisiblePlaybackPosition : noopSubscribe,
    () => (syncedLive && syncedLines
      ? activeSyncedLine(syncedLines, lyricPosition(getPlaybackPosition(), lyricsOffsetSecs))
      : null),
  );
  const lyricsResolved = useMemo<NowPlayingInfoResolved[]>(
    () => (syncedEnabled && syncedText ? [{ id: NOW_PLAYING_LYRICS_SYNCED_ID, segments: [{ text: `“${syncedText}”` }] }] : []),
    [syncedEnabled, syncedText],
  );

  // A stable signature so the resolve effect only re-runs when something it
  // actually reads changes (track identity, ranks, the enabled set). Lyrics ids
  // are excluded — they're resolved synchronously above, not in this effect.
  const selectionSig = availableItems
    .filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems))
    .filter((d) => !LYRICS_IDS.has(d.id) && !SYNC_IDS.has(d.id) && !OWN_EFFECT_IDS.has(d.id))
    .map((d) => d.id)
    .join("|");
  const trackSig = currentTrack
    ? `${currentTrack.key}|${currentTrack.title}|${currentTrack.artist_name ?? ""}|${currentTrack.album_title ?? ""}`
    : "";

  useEffect(() => {
    const gen = ++genRef.current;
    const track = currentTrack;
    const sig = trackSig;
    if (!track) {
      setAsyncResolved({ sig, items: [] });
      return;
    }
    const enabled = availableItems
      .filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems))
      .filter((d) => !LYRICS_IDS.has(d.id) && !SYNC_IDS.has(d.id) && !OWN_EFFECT_IDS.has(d.id));

    const pluginTrack: PluginTrack = {
      path: track.path,
      title: track.title,
      artist_name: track.artist_name,
      album_title: track.album_title,
      duration_secs: track.duration_secs,
    };

    const resolveOne = async (id: string): Promise<NowPlayingInfoResolved | null> => {
      if (id === "builtin:tags") {
        // Tags only exist for library tracks; resolve the row by metadata, then
        // read its tags (same path the Now Playing bar's tag chips use).
        try {
          const lib = await withTimeout(
            invoke<{ id: number } | null>("find_track_by_metadata", {
              title: track.title,
              artistName: track.artist_name,
              albumName: track.album_title,
            }),
            null,
          );
          if (!lib) return null;
          const rows = await withTimeout(
            invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId: lib.id }),
            [] as Array<{ id: number; name: string }>,
          );
          const text = formatTags(rows.map((r) => r.name));
          return text ? { id, segments: [{ text }] } : null;
        } catch (e) {
          console.error("Failed to resolve tags for now-playing info:", e);
          return null;
        }
      }
      // Plugin item: id is `${pluginId}:${itemId}`.
      const sep = id.indexOf(":");
      if (sep <= 0) return null;
      const pluginId = id.slice(0, sep);
      const itemId = id.slice(sep + 1);
      try {
        const res = await withTimeout(invokeNowPlayingInfo(pluginId, itemId, pluginTrack), {
          status: "error",
          message: "timeout",
        } as NowPlayingInfoResult);
        if (res.status === "ok" && res.text.trim()) {
          return { id, segments: [{ text: res.text }] };
        }
        if (res.status === "error") {
          console.error(`Now-playing info "${id}" failed:`, res.message ?? "");
        }
        return null;
      } catch (e) {
        console.error(`Now-playing info "${id}" threw:`, e);
        return null;
      }
    };

    Promise.all(enabled.map((d) => resolveOne(d.id)))
      .then((results) => {
        if (gen !== genRef.current) return; // stale — a newer resolve started
        setAsyncResolved({ sig, items: results.filter((r): r is NowPlayingInfoResolved => r !== null) });
      })
      .catch((e) => console.error("Failed to resolve now-playing info:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSig, selectionSig, availableItems, invokeNowPlayingInfo]);

  // Per-track facts resolved apart from the batch (Quality, Plays · Rank,
  // History — see OWN_EFFECT_IDS — and the album year Artist · Album shows).
  // Stamped with the track they describe, like the batch, so a previous
  // track's line never shows under the next title. Nothing ever needs
  // clearing: the merge ignores facts stamped for another track and drops
  // items that are switched off.
  type OwnFacts = { quality: string | null; plays: string | null; history: string | null; year: number | null };
  const NO_FACTS: OwnFacts = { quality: null, plays: null, history: null, year: null };
  const [ownFacts, setOwnFacts] = useState<OwnFacts & { sig: string }>({ sig: "", ...NO_FACTS });
  const setOwnFact = (sig: string, patch: Partial<OwnFacts>) =>
    setOwnFacts((prev) => {
      const base = prev.sig === sig ? prev : { sig, ...NO_FACTS };
      const next = { ...base, ...patch };
      const same = next.sig === prev.sig && next.quality === prev.quality && next.plays === prev.plays
        && next.history === prev.history && next.year === prev.year;
      return same ? prev : next;
    });

  const qualityEnabled = isNowPlayingItemSelected(QUALITY_ID, selection, availableItems);
  const engineDecodingRef = useLatestRef(isEngineDecoding);
  useEffect(() => {
    const track = currentTrack;
    const sig = trackSig;
    if (!track || !qualityEnabled) return;
    const controller = new AbortController();
    resolvePlayingTrackQuality(
      track,
      () => engineDecodingRef.current(track.key),
      (text) => setOwnFact(sig, { quality: withQualitySource(track.path, text) }),
      controller.signal,
    ).catch((e) => console.error("Failed to resolve now-playing quality:", e));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSig, qualityEnabled]);

  // One history read for Plays · Rank and Listening history.
  const playsEnabled = isNowPlayingItemSelected(PLAYS_RANK_ID, selection, availableItems);
  const historyEnabled = isNowPlayingItemSelected(NOW_PLAYING_HISTORY_ID, selection, availableItems);
  useEffect(() => {
    const track = currentTrack;
    const sig = trackSig;
    if (!track || (!playsEnabled && !historyEnabled)) return;
    let live = true;
    const now = Math.floor(Date.now() / 1000);
    withTimeout<TrackPlayStats | null | typeof HISTORY_TIMED_OUT>(
      invoke<TrackPlayStats | null>("get_track_play_stats", { title: track.title, artistName: track.artist_name }),
      HISTORY_TIMED_OUT,
    )
      .then((stats) => {
        if (!live) return;
        const answer = stats === HISTORY_TIMED_OUT ? "timed-out" : stats;
        setOwnFact(sig, {
          // A read that timed out shows neither line (it knows nothing).
          plays: answer === "timed-out" ? null : formatPlaysRank(answer?.play_count, trackRank),
          history: listeningHistoryLine(answer, playStartedAt, now),
        });
      })
      .catch((e) => console.error("Failed to read the play history for now-playing info:", e));
    return () => { live = false; };
    // Re-read per play (playStartedAt moves on a replay of the same entry),
    // per track (an Edit info rename keeps the play's start), and when the
    // rank moves — which happens once this play is recorded, so the count
    // takes it in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSig, playsEnabled, historyEnabled, playStartedAt, trackRank]);

  const artistAlbumEnabled = isNowPlayingItemSelected(NOW_PLAYING_ARTIST_ALBUM_ID, selection, availableItems);
  useEffect(() => {
    const track = currentTrack;
    const sig = trackSig;
    if (!track || !artistAlbumEnabled || !track.album_title) return;
    let live = true;
    resolveTrackYear(track)
      .then((year) => {
        if (live) setOwnFact(sig, { year });
      })
      .catch((e) => console.error("Failed to resolve the album year:", e));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSig, artistAlbumEnabled]);

  const year = ownFacts.sig === trackSig ? ownFacts.year : null;
  const syncResolved = useMemo<NowPlayingInfoResolved[]>(() => {
    if (!currentTrack) return [];
    return availableItems
      .filter((d) => SYNC_IDS.has(d.id) && isNowPlayingItemSelected(d.id, selection, availableItems))
      .map((d) => resolveSyncItem(d.id, currentTrack, artistRank, queue, year))
      .filter((r): r is NowPlayingInfoResolved => r !== null);
  }, [currentTrack, artistRank, availableItems, selection, queue, year]);

  // Merge async + lyrics items back into one list, ordered by availableItems and
  // gated by the current selection.
  const resolvedItems = useMemo<NowPlayingInfoResolved[]>(() => {
    const byId = new Map<string, NowPlayingInfoResolved>();
    for (const r of syncResolved) byId.set(r.id, r);
    if (asyncResolved.sig === trackSig) for (const r of asyncResolved.items) byId.set(r.id, r);
    for (const r of lyricsResolved) byId.set(r.id, r);
    if (ownFacts.sig === trackSig) {
      if (ownFacts.quality) byId.set(QUALITY_ID, { id: QUALITY_ID, segments: [{ text: ownFacts.quality }] });
      if (ownFacts.plays) byId.set(PLAYS_RANK_ID, { id: PLAYS_RANK_ID, segments: [{ text: ownFacts.plays }] });
      if (ownFacts.history) byId.set(NOW_PLAYING_HISTORY_ID, { id: NOW_PLAYING_HISTORY_ID, segments: [{ text: ownFacts.history }] });
    }
    return availableItems
      .filter((d) => isNowPlayingItemSelected(d.id, selection, availableItems))
      .map((d): NowPlayingInfoResolved | undefined => {
        const r = byId.get(d.id);
        return r ? { ...r, top: nowPlayingItemTop(d, persistence), style: nowPlayingItemStyle(d) } : undefined;
      })
      .filter((r): r is NowPlayingInfoResolved => r !== undefined);
  }, [syncResolved, asyncResolved, ownFacts, trackSig, lyricsResolved, availableItems, selection, persistence]);

  return { availableItems, resolvedItems };
}
