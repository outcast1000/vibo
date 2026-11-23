// The one implementation of "reconcile in-memory like state against the
// durable entity_likes store". Five surfaces used to re-derive this by hand
// (queue adds, startup restore, current-track identity changes, the
// entity-likes-changed listener, playlist detail rows), each re-stating the
// dedup, the metadata identity, and the apply-without-churning rules — with
// the identity helper literally declared twice.
import { invoke } from "@tauri-apps/api/core";
import { trackLikeKey } from "../likeKeys";

/** Anything carrying the metadata the durable like key is built from. */
export interface LikeIdentified {
  title: string;
  artist_name?: string | null;
  liked?: number;
}

/** Metadata identity for like state — exactly the backend's entity_likes key
 *  (`trackLikeKey`). It used `normalizeForMatch`, which doesn't trim, so a
 *  padded title missed its own durable like and every same-song match. */
export function trackLikeId(title: string | null | undefined, artist: string | null | undefined): string {
  return trackLikeKey(title, artist);
}

/** Dedup by trackLikeId, then batch-read authoritative states from the
 *  backend. Returns id → state (0 = no durable row) for every requested
 *  identity; empty input skips the round-trip. */
export async function fetchLikeStates(
  tracks: Iterable<LikeIdentified | null | undefined>,
): Promise<Map<string, number>> {
  const seen = new Set<string>();
  const items: { title: string; artistName: string | null }[] = [];
  for (const t of tracks) {
    if (!t) continue;
    const id = trackLikeId(t.title, t.artist_name ?? null);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ title: t.title, artistName: t.artist_name ?? null });
  }
  const byId = new Map<string, number>();
  if (items.length === 0) return byId;
  const states = await invoke<number[]>("get_track_like_states", { tracks: items });
  items.forEach((it, i) => byId.set(trackLikeId(it.title, it.artistName), states[i] ?? 0));
  return byId;
}

/** Patch one entry from a fetched map, preserving object identity when
 *  nothing changes (safe inside functional setState — an unchanged map pass
 *  causes no re-render). */
export function applyLikeState<T extends LikeIdentified>(
  t: T,
  byId: Map<string, number>,
): T {
  const v = byId.get(trackLikeId(t.title, t.artist_name ?? null));
  if (v == null) return t;
  return v !== t.liked ? { ...t, liked: v } : t;
}
