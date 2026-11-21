// What a library track's file says about itself, formatted for the track
// page's Details tab and the Edit Properties dialog's File tab — one copy, so
// the two can't word the same file differently.

/** `get_track_audio_properties`' answer. */
export interface AudioProperties {
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  bitrate?: number;
}

/** "FLAC · 1012 kbps · 96.0 kHz · 24-bit" — the parts that are known. */
export function formatAudioSummary(format: string | null | undefined, props: AudioProperties | null | undefined): string {
  const parts: string[] = [];
  if (format) parts.push(format.toUpperCase());
  if (props?.bitrate) parts.push(`${props.bitrate} kbps`);
  if (props?.sample_rate) parts.push(`${(props.sample_rate / 1000).toFixed(1)} kHz`);
  if (props?.bit_depth) parts.push(`${props.bit_depth}-bit`);
  return parts.join(" · ");
}

// Turn a raw tag key like REPLAYGAIN_TRACK_GAIN / MUSICBRAINZ_RECORDING_ID into a
// readable label ("ReplayGain Track Gain", "MusicBrainz Recording ID").
const TAG_ACRONYMS = new Set(["ID", "ISRC", "BPM", "URL", "UPC", "EAN"]);
export function prettifyTagKey(key: string): string {
  return key
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => {
      const up = w.toUpperCase();
      if (TAG_ACRONYMS.has(up)) return up;
      if (up === "REPLAYGAIN") return "ReplayGain";
      if (up === "MUSICBRAINZ") return "MusicBrainz";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** The file name a path ends in, `file://` and URL escapes removed. */
export function fileNameOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const bare = path.startsWith("file://") ? path.slice("file://".length) : path;
  // A stray `%` makes decodeURIComponent throw; the raw path is a fine label.
  let decoded = bare;
  try { decoded = decodeURIComponent(bare); } catch { /* cosmetic label: keep the raw path */ }
  const segments = decoded.split(/[/\\]/);
  return segments[segments.length - 1] || decoded;
}
