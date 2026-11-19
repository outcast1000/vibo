// What radio builds on when neither the seed song nor its artist is in the
// library: names a provider knows about the song — the artists it is credited
// to, artists like them, and its community tags — which the backend matches
// against the library (`build_radio_from_hints`). Fetched through the
// information-type provider chain (`fetchInfoValue`), so any plugin that
// answers `track_tags` / `similar_artists` serves it and the values land in
// the cache the detail pages read. See conventions.md "Start Radio".
import type { InfoEntity } from "../types/informationTypes";
import { fetchInfoValue, type InvokeInfoFetch } from "./infoFetchChain";

export interface RadioHints {
  /** The seed's credit, split: "Goat, MC Yallah" → ["Goat", "MC Yallah"]. */
  seedArtists: string[];
  similarArtists: string[];
  tags: string[];
}

/** How long the hint lookups may take, all together. Radio waits on them with
 *  the current song still playing, so a provider that hangs must not leave
 *  "Starting Radio" up for minutes. */
export const RADIO_HINTS_DEADLINE_MS = 15_000;
/** Names asked for their similar artists: the whole credit, then its parts. */
const MAX_SIMILAR_LOOKUPS = 3;
const MAX_TAGS = 12;
const MAX_SIMILAR_ARTISTS = 40;

// Separators a combined credit uses. The spaced word forms need their spaces
// ("Max Richter" must not split on "x"). "and" and "+" are left out: they are
// as often inside one band's name ("Florence + the Machine") as between two.
const CREDIT_SEPARATORS = /\s*(?:,|;|\/|&|\s(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s)\s*/i;

/** The names a credit lists, in order, de-duplicated; the whole credit when
 *  it lists one. */
export function splitArtistCredit(credit: string | null | undefined): string[] {
  const whole = (credit ?? "").trim();
  if (!whole) return [];
  const parts = whole.split(CREDIT_SEPARATORS).map((p) => p.trim()).filter(Boolean);
  return uniqueNames(parts.length > 0 ? parts : [whole]);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = n.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n.trim());
  }
  return out;
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item && typeof item === "object" ? (item as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === "string" && n.trim() !== "");
}

/** A `track_tags` value's tag names, the track's own first (more specific). */
export function tagsFromTrackTags(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const v = value as { tags?: unknown; artistTags?: unknown };
  return [...names(v.tags), ...names(v.artistTags)];
}

/** A `similar_artists` (entity cards) value's artist names, in its order. */
export function artistsFromSimilar(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return names((value as { items?: unknown }).items);
}

export function hasRadioHints(h: RadioHints): boolean {
  return h.seedArtists.length + h.similarArtists.length + h.tags.length > 0;
}

interface GatherOpts {
  title: string;
  artistName: string | null;
  invokeInfoFetch: InvokeInfoFetch;
  pluginNames?: Map<string, string>;
  deadlineMs?: number;
}

/** One info value through the chain, `null` for anything but an answer — a
 *  type nobody registered (no provider installed) included. */
async function infoValue(opts: GatherOpts, typeId: string, entity: InfoEntity): Promise<unknown> {
  try {
    const out = await fetchInfoValue({ typeId, entity, invokeInfoFetch: opts.invokeInfoFetch, pluginNames: opts.pluginNames });
    return out.status === "ok" ? out.value : null;
  } catch (e) {
    console.error(`Failed to fetch ${typeId} for a radio station:`, e);
    return null;
  }
}

/** Everything radio can build on for a seed the library lacks, as far as the
 *  providers answered by the deadline. Never rejects. */
export async function gatherRadioHints(opts: GatherOpts): Promise<RadioHints> {
  const seedArtists = splitArtistCredit(opts.artistName);
  if (seedArtists.length === 0) return { seedArtists, similarArtists: [], tags: [] };

  const late = Symbol("late");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof late>((resolve) => {
    timer = setTimeout(() => resolve(late), opts.deadlineMs ?? RADIO_HINTS_DEADLINE_MS);
  });
  const byDeadline = async <T,>(p: Promise<T>): Promise<T | null> => {
    const r = await Promise.race([p, deadline]);
    return r === late ? null : (r as T);
  };

  // Tags: ask with the credit as given; a provider that doesn't know the
  // combined name gets asked again with the first credited artist.
  const tagsP = byDeadline((async () => {
    const entity = (artistName: string): InfoEntity => ({ kind: "track", name: opts.title, id: 0, artistName });
    const whole = opts.artistName!.trim();
    let tags = tagsFromTrackTags(await infoValue(opts, "track_tags", entity(whole)));
    if (tags.length === 0 && seedArtists[0] !== whole) {
      tags = tagsFromTrackTags(await infoValue(opts, "track_tags", entity(seedArtists[0])));
    }
    return tags;
  })());
  // The whole credit first: a provider may know a duo by its joint name, and
  // a credit split where it shouldn't have been still gets its real lookup.
  const lookups = uniqueNames([opts.artistName!, ...seedArtists]).slice(0, MAX_SIMILAR_LOOKUPS);
  const similarP = Promise.all(lookups.map((name) =>
    byDeadline(infoValue(opts, "similar_artists", { kind: "artist", name, id: 0 }).then(artistsFromSimilar))));

  try {
    const [tags, similar] = await Promise.all([tagsP, similarP]);
    // Interleave the lookups' lists so the first one can't fill the whole cap
    // by itself.
    const lists = similar.map((l) => l ?? []);
    const interleaved: string[] = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) if (i < l.length) interleaved.push(l[i]);
    }
    const credited = new Set(seedArtists.map((n) => n.toLocaleLowerCase()));
    return {
      seedArtists,
      similarArtists: uniqueNames(interleaved).filter((n) => !credited.has(n.toLocaleLowerCase())).slice(0, MAX_SIMILAR_ARTISTS),
      tags: uniqueNames(tags ?? []).slice(0, MAX_TAGS),
    };
  } finally {
    clearTimeout(timer);
  }
}
