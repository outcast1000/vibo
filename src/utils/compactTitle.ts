// Short display names for the places with no room for the whole thing — the
// compact (one-line, 24px) mini player. Drops the parts of a title, artist or
// album that add length without saying which song it is: "Remastered 2009",
// "(feat. X)", "(with X)", "- Single Version", "[Deluxe Edition]", "(2011)".
//
// Display only: never feed the result to a lookup, a like key or navigation —
// those keep the full name. Parts that tell recordings apart (Live, Remix,
// Acoustic, Demo, …) are kept, so two versions of a song still read differently.

/** A bracketed or dash-suffixed part that names a version of the recording. */
const KEEP = /\b(live|remix|mix|acoustic|demo|instrumental|unplugged|reprise|cover|session|take|rehearsal|karaoke)\b/i;

/** A part that is noise: a remaster note, a guest credit, an edition, a year. */
const NOISE = new RegExp(
  [
    String.raw`^(feat\.?|ft\.?|featuring|with)\s`,
    String.raw`\bre-?master(ed)?\b`,
    String.raw`\b(single|album|radio|lp|original|stereo|mono|extended|short|clean|explicit)\s+(version|edit|mix)\b`,
    String.raw`^(single|album)\s+version$`,
    String.raw`^(mono|stereo|explicit|clean|single|bonus track|bonus)$`,
    String.raw`\b(deluxe|expanded|anniversary|special|collector'?s|limited|legacy|bonus|super deluxe)\b`,
    String.raw`\bedition\b`,
    String.raw`^\d{4}$`,
    String.raw`^from\s`,
  ].join("|"),
  "i",
);

function isNoise(part: string): boolean {
  const p = part.trim();
  if (!p) return true;
  if (/^(feat\.?|ft\.?|featuring|with)\s/i.test(p)) return true; // a guest credit, whatever it names
  return NOISE.test(p) && !KEEP.test(p);
}

/** Strip noise from a track title, artist or album name. Falls back to the
 *  input when stripping would leave nothing. */
export function compactName(name: string): string {
  let s = name;
  // Bracketed parts anywhere: "(Remastered 2009)", "[Deluxe Edition]", "(feat. X)".
  s = s.replace(/\s*[([{]([^)\]}]*)[)\]}]/g, (whole, inner: string) => (isNoise(inner) ? "" : whole));
  // Dash suffixes, repeatedly: "Song - 2011 Remaster - Single Version".
  for (;;) {
    const m = /\s+[-–—]\s+([^-–—]+)$/.exec(s);
    if (!m || !isNoise(m[1])) break;
    s = s.slice(0, m.index);
  }
  // An unbracketed guest credit runs to the end: "Song feat. X", "Artist ft. Y".
  s = s.replace(/\s+(feat\.|ft\.|featuring)\s.*$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s || name.trim() || name;
}
