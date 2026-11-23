import { describe, it, expect, vi } from "vitest";
import { kenBurnsMove, resolveNowPlayingSlides } from "../utils/nowPlayingArt";
import type { QueueTrack } from "../types";

describe("kenBurnsMove", () => {
  it("gives a picture the same move every time, so the crossfade never switches it mid-fade", () => {
    const src = "asset://localhost/covers/a.jpg";
    expect(kenBurnsMove(src)).toBe(kenBurnsMove(src));
  });

  it("varies across pictures and uses every move", () => {
    const moves = new Set(Array.from({ length: 40 }, (_, i) => kenBurnsMove(`https://img/${i}.jpg`)));
    expect(moves).toEqual(new Set(["zoom-in", "zoom-out", "pan-left", "pan-right"]));
  });
});

function makeTrack(over: Partial<QueueTrack> = {}): QueueTrack {
  return {
    key: "lib:1",
    path: "file:///music/a.flac",
    title: "Song",
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 200,
    liked: 0,
    ...over,
  } as QueueTrack;
}

/** Nothing cached, nothing settled — every lookup is in flight. */
const allPending = {
  getAlbumImage: () => null,
  getArtistImage: () => null,
  isAlbumImageResolved: () => false,
  isArtistImageResolved: () => false,
};

/** Nothing cached, but both lookups have come back empty. */
const allSettledEmpty = {
  getAlbumImage: () => null,
  getArtistImage: () => null,
  isAlbumImageResolved: () => true,
  isArtistImageResolved: () => true,
};

describe("resolveNowPlayingSlides", () => {
  it("orders the cover first and the artist image second", () => {
    const slides = resolveNowPlayingSlides(makeTrack(), {
      ...allSettledEmpty,
      getAlbumImage: () => "/covers/album.jpg",
      getArtistImage: () => "/covers/artist.jpg",
    });
    expect(slides).toEqual({ paths: ["/covers/album.jpg", "/covers/artist.jpg"], pending: false });
  });

  it("asks for the artist image even when the album has a cover", () => {
    // Not a fallback-only ask — the ask is what
    // triggers useImageCache's on-demand fetch of the second slide.
    const getArtistImage = vi.fn(() => null);
    resolveNowPlayingSlides(makeTrack(), {
      ...allSettledEmpty,
      getAlbumImage: () => "/covers/album.jpg",
      getArtistImage,
    });
    expect(getArtistImage).toHaveBeenCalledWith("Artist");
  });

  it("puts an explicit image_url first and still offers the artist image", () => {
    const slides = resolveNowPlayingSlides(
      makeTrack({ image_url: "https://cdn.example/cover.jpg" }),
      { ...allSettledEmpty, getArtistImage: () => "/covers/artist.jpg" },
    );
    expect(slides.paths).toEqual(["https://cdn.example/cover.jpg", "/covers/artist.jpg"]);
  });

  it("collapses to one slide when the artist image IS the cover", () => {
    // No album cover → the artist image is the primary; a duplicate second
    // slide would make the slideshow crossfade an image into itself.
    const slides = resolveNowPlayingSlides(makeTrack(), {
      ...allSettledEmpty,
      getArtistImage: () => "/covers/artist.jpg",
    });
    expect(slides.paths).toEqual(["/covers/artist.jpg"]);
  });

  it("yields one slide while the artist lookup is still out, without pending", () => {
    // The cover can show immediately; the list grows to 2 when the artist
    // image settles. pending stays false — there is art on screen.
    const slides = resolveNowPlayingSlides(makeTrack(), {
      ...allPending,
      getAlbumImage: () => "/covers/album.jpg",
      isAlbumImageResolved: () => true,
    });
    expect(slides).toEqual({ paths: ["/covers/album.jpg"], pending: false });
  });

  it("reports pending only while nothing has settled", () => {
    expect(resolveNowPlayingSlides(makeTrack(), allPending)).toEqual({
      paths: [],
      pending: true,
    });
    expect(resolveNowPlayingSlides(makeTrack(), allSettledEmpty)).toEqual({
      paths: [],
      pending: false,
    });
  });

  it("keys the album lookup by the album artist", () => {
    const getAlbumImage = vi.fn((_name: string, artist?: string | null) =>
      artist === "Various Artists" ? "/covers/comp.jpg" : null);
    const slides = resolveNowPlayingSlides(
      makeTrack({ album_artist_name: "Various Artists" }),
      { ...allSettledEmpty, getAlbumImage },
    );
    expect(slides.paths).toEqual(["/covers/comp.jpg"]);
    expect(getAlbumImage).toHaveBeenCalledWith("Album", "Various Artists");
  });
});
