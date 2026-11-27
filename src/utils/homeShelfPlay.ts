import type { HomeShelfDisplayKind, HomeShelfItem, PluginTrack } from "../types/plugin";

// Shape of the out-of-band radio seed the radio shelf stuffs onto its first track.
export interface RadioSeed {
  title: string;
  artist_name: string | null;
  image_url?: string | null;
}

// What "playing" a shelf item resolves to. Both callers — the Home page's play
// button (App.tsx) and the control API's `home.play` — map each kind to the
// same canonical play action, so every decision about WHAT plays lives here.
// `none` means the play button should not act (and should not be rendered).
export type ShelfPlayAction =
  | { kind: "album-id"; id: number }
  | { kind: "artist-id"; id: number }
  // `partial`: the shipped tracks are only the known start of the list (the
  // card's cached first track), not the whole thing. The caller plays them
  // immediately and backfills the rest from the shelf's resolve-play handler
  // instead of blocking on it. Absent = the tracks ARE the whole list.
  | { kind: "tracks"; tracks: PluginTrack[]; partial?: true; context?: { name: string; imagePath?: string | null; source?: string } }
  // `coverPath`: the station's banner cover — the seed's own image, else the
  // card's. Decided here so the two callers can't pick differently (they did:
  // the control API dropped the seed image).
  | { kind: "radio"; seed: RadioSeed; coverPath: string | null }
  | { kind: "none" };

export function resolveShelfPlayAction(
  displayKind: HomeShelfDisplayKind,
  item: HomeShelfItem,
): ShelfPlayAction {
  if (displayKind === "album-cards") {
    const it = item as { libraryId?: number; name: string; tracks?: PluginTrack[]; partial?: boolean; entityKind?: "album" | "artist" };
    // Mixed shelves tag artist items so the play button plays the artist, not an
    // album row that happens to share the id.
    if (it.entityKind === "artist") {
      return it.libraryId ? { kind: "artist-id", id: it.libraryId } : { kind: "none" };
    }
    if (it.libraryId) return { kind: "album-id", id: it.libraryId };
    if (it.tracks?.length) return { kind: "tracks", tracks: it.tracks, ...(it.partial ? { partial: true as const } : {}), context: { name: it.name } };
    return { kind: "none" };
  }
  if (displayKind === "artist-cards") {
    const it = item as { libraryId?: number };
    if (it.libraryId) return { kind: "artist-id", id: it.libraryId };
    return { kind: "none" };
  }
  if (displayKind === "playlist-cards") {
    const it = item as { name: string; coverUrl?: string | null; tracks: PluginTrack[]; partial?: boolean };
    const first = it.tracks?.[0] as unknown as { __radioSeed?: RadioSeed } | undefined;
    if (first?.__radioSeed) {
      const seed = first.__radioSeed;
      return { kind: "radio", seed, coverPath: seed.image_url ?? it.coverUrl ?? null };
    }
    return {
      kind: "tracks",
      tracks: it.tracks,
      ...(it.partial && it.tracks?.length ? { partial: true as const } : {}),
      context: { name: it.name, imagePath: it.coverUrl ?? null, source: "playlist" },
    };
  }
  // track-rows
  const it = item as { track: PluginTrack };
  return { kind: "tracks", tracks: [it.track] };
}

// The right-click menu of a Home track row (App.tsx
// `handleHomeShelfItemContextMenu`): the shared track menu's target, plus the
// row's own items above it. A row the library has (`libraryId`, found by its
// path) is a library track, so the shared menu offers Play / Enqueue, Edit
// Properties, Open Containing Folder and Delete. A row it doesn't have is a
// by-name target carrying its path; the shared menu can't play a row with no
// id, so Play / Enqueue / Play Next come first.
export type HomeTrackRowItem = "play" | "enqueue" | "play-next";

export interface HomeTrackRowMenu {
  target: {
    kind: "track";
    trackId?: number;
    path?: string | null;
    isLocal: boolean;
    title: string;
    artistName: string | null;
    albumTitle: string | null;
  };
  leading: HomeTrackRowItem[];
}

export function homeTrackRowMenu(track: PluginTrack, libraryId: number | null): HomeTrackRowMenu {
  const base = {
    kind: "track" as const,
    title: track.title,
    artistName: track.artist_name ?? null,
    albumTitle: track.album_title ?? null,
    isLocal: !!track.path?.startsWith("file://"),
  };
  if (libraryId != null) return { target: { ...base, trackId: libraryId }, leading: [] };
  return { target: { ...base, path: track.path ?? null }, leading: ["play", "enqueue", "play-next"] };
}
