// The Edit Properties dialog's Tags tab, as data. A selection's tags are two
// lists: the ones every selected track carries (`applied`, plain chips) and the
// ones only some do (`partial`, chips with an "n/m" count, the same model the
// album and artist pages' tag panel uses). Editing moves names between them or
// drops them, and `tagDelta` turns the result into the exact add / remove the
// backend applies to every track — so a tag the user never touched stays on
// exactly the tracks that had it. (The dialog used to send a Replace by
// default, which took every tag only some of the tracks had off all of them.)

import { normalizeForMatch } from "./normalize";

export interface PartialTag {
  name: string;
  /** How many of the selected tracks carry it. */
  count: number;
  /** How many tracks are selected. */
  total: number;
}

export interface TagSelection {
  applied: string[];
  partial: PartialTag[];
}

export const EMPTY_TAG_SELECTION: TagSelection = { applied: [], partial: [] };

const same = (a: string, b: string) => normalizeForMatch(a) === normalizeForMatch(b);

/** Build the selection from `get_tag_counts_for_tracks` rows
 *  (`[tagId, name, tracksCarryingIt]`, sorted by name). */
export function selectionFromCounts(rows: Array<[number, string, number]>, total: number): TagSelection {
  const applied: string[] = [];
  const partial: PartialTag[] = [];
  for (const [, name, count] of rows) {
    if (count >= total) applied.push(name);
    else partial.push({ name, count, total });
  }
  return { applied, partial };
}

/** Put `name` on every track: a partial tag becomes applied; a new one is
 *  appended; one already applied is left alone. A name the tracks had before
 *  (`original`) keeps that spelling: the library matches tag names ignoring
 *  case and accents, so "Hip Hop" for a removed "hip hop" would save as the
 *  existing tag, and showing the new spelling would promise a rename that
 *  never happens. */
export function addToAll(sel: TagSelection, name: string, original?: TagSelection): TagSelection {
  const trimmed = name.trim();
  if (!trimmed || sel.applied.some((n) => same(n, trimmed))) return sel;
  const partial = sel.partial.find((p) => same(p.name, trimmed));
  const known = original
    ? original.applied.find((n) => same(n, trimmed)) ?? original.partial.find((p) => same(p.name, trimmed))?.name
    : undefined;
  return {
    applied: [...sel.applied, partial ? partial.name : known ?? trimmed],
    partial: partial ? sel.partial.filter((p) => p !== partial) : sel.partial,
  };
}

/** Take `name` off every track, whether all or some of them have it. */
export function removeFromAll(sel: TagSelection, name: string): TagSelection {
  return {
    applied: sel.applied.filter((n) => !same(n, name)),
    partial: sel.partial.filter((p) => !same(p.name, name)),
  };
}

/** What to send: tags to add to every track (new ones, and partial ones made
 *  applied) and tags to take off every track (gone from both lists). */
export function tagDelta(original: TagSelection, current: TagSelection): { add: string[]; remove: string[] } {
  const add = current.applied.filter((n) => !original.applied.some((o) => same(o, n)));
  const kept = [...current.applied, ...current.partial.map((p) => p.name)];
  const remove = [...original.applied, ...original.partial.map((p) => p.name)]
    .filter((o) => !kept.some((n) => same(n, o)));
  return { add, remove };
}

export function hasTagChanges(original: TagSelection, current: TagSelection): boolean {
  const { add, remove } = tagDelta(original, current);
  return add.length > 0 || remove.length > 0;
}
