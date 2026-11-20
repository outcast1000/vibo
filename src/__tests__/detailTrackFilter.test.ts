import { describe, it, expect } from "vitest";
import { filterDetailRows, orderedDetailRows, showDetailFilter, trackMatches, normalizeFilterQuery, withoutDisliked } from "../utils/detailTrackFilter";

const t = (title: string, artist_name: string | null = "Artist", album_title: string | null = "Album") =>
  ({ title, artist_name, album_title });

describe("showDetailFilter", () => {
  it("shows only above 10 rows", () => {
    expect(showDetailFilter(10)).toBe(false);
    expect(showDetailFilter(11)).toBe(true);
  });
});

describe("trackMatches", () => {
  it("matches title, artist, album and album artist, case- and accent-insensitively", () => {
    const q = normalizeFilterQuery("  BJORK ");
    expect(trackMatches(t("Jóga", "Björk"), q)).toBe(true);
    expect(trackMatches(t("Hyperballad", "Someone", "Post"), normalizeFilterQuery("post"))).toBe(true);
    expect(trackMatches({ ...t("X", "Y", "Z"), album_artist_name: "Various Artists" }, normalizeFilterQuery("various"))).toBe(true);
    expect(trackMatches(t("Army of Me"), normalizeFilterQuery("joga"))).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(trackMatches(t("Anything"), normalizeFilterQuery("   "))).toBe(true);
  });
});

describe("filterDetailRows", () => {
  const tracks = [t("Alpha"), t("Beta live"), t("Gamma"), t("Delta live")];

  it("returns the inputs unchanged for an empty query", () => {
    const missing = [{ track: t("Omega"), before: 2 }];
    const r = filterDetailRows(tracks, missing, " ");
    expect(r.tracks).toBe(tracks);
    expect(r.missingRows).toBe(missing);
  });

  it("filters library rows and missing rows by the same query", () => {
    const missing = [{ track: t("Epsilon live"), before: 4 }, { track: t("Zeta"), before: 1 }];
    const r = filterDetailRows(tracks, missing, "live");
    expect(r.tracks.map(x => x.title)).toEqual(["Beta live", "Delta live"]);
    expect(r.missingRows.map(m => m.track.title)).toEqual(["Epsilon live"]);
  });

  it("remaps a missing row's position onto the filtered list", () => {
    // Drawn before "Gamma" (index 2) in the full list; one kept row ("Beta live")
    // precedes it, so it lands before index 1 of the filtered list.
    const missing = [{ track: t("Gamma live"), before: 2 }, { track: t("End live"), before: 4 }, { track: t("Start live"), before: 0 }];
    const r = filterDetailRows(tracks, missing, "live");
    expect(r.missingRows.map(m => [m.track.title, m.before])).toEqual([["Gamma live", 1], ["End live", 2], ["Start live", 0]]);
  });

  it("does not report a hidden owned track as missing", () => {
    // Missing rows are placed against the full list by the page; the filter only
    // removes rows, so a filtered-out library track never turns into a missing one.
    const r = filterDetailRows(tracks, [], "gamma");
    expect(r.tracks.map(x => x.title)).toEqual(["Gamma"]);
    expect(r.missingRows).toEqual([]);
  });
});

describe("orderedDetailRows", () => {
  it("interleaves missing rows before their library row, as the TrackList draws them", () => {
    const lib = ["A", "B", "C"];
    const missing = [
      { track: "x", before: 0 },
      { track: "y", before: 2 },
      { track: "z", before: 3 },
      { track: "w", before: 2 },
    ];
    expect(orderedDetailRows(lib, missing)).toEqual(["x", "A", "B", "y", "w", "C", "z"]);
  });

  it("clamps out-of-range positions and copies a list with no missing rows", () => {
    const lib = ["A"];
    expect(orderedDetailRows(lib, [{ track: "x", before: 9 }, { track: "y", before: -1 }])).toEqual(["y", "A", "x"]);
    const out = orderedDetailRows(lib, []);
    expect(out).toEqual(["A"]);
    expect(out).not.toBe(lib);
  });
});

describe("withoutDisliked", () => {
  it("drops library rows by their own mirror and provider rows by the store", () => {
    const list = [
      { id: 1, title: "Owned liked", artist_name: "A", liked: 1 },
      { id: 2, title: "Owned disliked", artist_name: "A", liked: -1 },
      { title: "Missing disliked", artist_name: "A" },
      { title: "Missing neutral", artist_name: "A" },
    ];
    const likeOf = (title: string) => (title === "Missing disliked" || title === "Owned liked" ? -1 : 0);
    // A library row answers by its mirror, never the store; a provider row by the store.
    expect(withoutDisliked(list, likeOf).map(t => t.title)).toEqual(["Owned liked", "Missing neutral"]);
  });
});
