// Radio hints for a seed the library lacks: the split credit, similar artists
// and community tags, fetched through the info chain (mocked here).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InfoEntity } from "../types/informationTypes";

const fetchInfoValue = vi.fn();
vi.mock("../utils/infoFetchChain", () => ({ fetchInfoValue: (opts: unknown) => fetchInfoValue(opts) }));

import { artistsFromSimilar, gatherRadioHints, hasRadioHints, splitArtistCredit, tagsFromTrackTags } from "../utils/radioHints";

const invokeInfoFetch = vi.fn();
const ok = (value: unknown) => ({ status: "ok", value });

beforeEach(() => {
  fetchInfoValue.mockReset();
});

describe("splitArtistCredit", () => {
  it("splits a combined credit on the usual separators", () => {
    expect(splitArtistCredit("Goat, MC Yallah")).toEqual(["Goat", "MC Yallah"]);
    expect(splitArtistCredit("Daft Punk feat. Pharrell Williams")).toEqual(["Daft Punk", "Pharrell Williams"]);
    expect(splitArtistCredit("A ft B & C / D; E")).toEqual(["A", "B", "C", "D", "E"]);
    expect(splitArtistCredit("Skrillex x Diplo")).toEqual(["Skrillex", "Diplo"]);
  });

  it("leaves one band's name whole", () => {
    expect(splitArtistCredit("Florence + the Machine")).toEqual(["Florence + the Machine"]);
    expect(splitArtistCredit("Nick Cave and the Bad Seeds")).toEqual(["Nick Cave and the Bad Seeds"]);
    expect(splitArtistCredit("Max Richter")).toEqual(["Max Richter"]);
  });

  it("de-duplicates and drops blanks", () => {
    expect(splitArtistCredit("Goat, goat,  ")).toEqual(["Goat"]);
    expect(splitArtistCredit(null)).toEqual([]);
    expect(splitArtistCredit("  ")).toEqual([]);
  });
});

describe("value parsing", () => {
  it("reads track_tags with the track's own tags first", () => {
    expect(tagsFromTrackTags({ tags: [{ name: "afrobeat" }], artistTags: [{ name: "psychedelic" }, { nope: 1 }] }))
      .toEqual(["afrobeat", "psychedelic"]);
    expect(tagsFromTrackTags(null)).toEqual([]);
  });

  it("reads similar_artists entity cards", () => {
    expect(artistsFromSimilar({ items: [{ name: "Gnoomes", match: 1 }, { name: "" }] })).toEqual(["Gnoomes"]);
    expect(artistsFromSimilar({})).toEqual([]);
  });
});

describe("gatherRadioHints", () => {
  it("asks for the song's tags and each name's similar artists, whole credit first", async () => {
    fetchInfoValue.mockImplementation(async ({ typeId, entity }: { typeId: string; entity: InfoEntity }) => {
      if (typeId === "track_tags") return ok({ tags: [{ name: "afro-psych" }], artistTags: [{ name: "Psychedelic Rock" }] });
      if (entity.name === "Goat") return ok({ items: [{ name: "Gnoomes" }, { name: "MC Yallah" }, { name: "Kikagaku Moyo" }] });
      if (entity.name === "MC Yallah") return ok({ items: [{ name: "Nyege Nyege" }] });
      return { status: "not_found" };
    });
    const hints = await gatherRadioHints({ title: "Nimerudi", artistName: "Goat, MC Yallah", invokeInfoFetch });

    expect(hints.seedArtists).toEqual(["Goat", "MC Yallah"]);
    expect(hints.tags).toEqual(["afro-psych", "Psychedelic Rock"]);
    // Interleaved across lookups; a credited artist is not its own "similar".
    expect(hints.similarArtists).toEqual(["Gnoomes", "Nyege Nyege", "Kikagaku Moyo"]);
    const asked = fetchInfoValue.mock.calls.map(([o]) => `${o.typeId}:${o.entity.name}:${o.entity.artistName ?? ""}`);
    expect(asked).toContain("similar_artists:Goat, MC Yallah:");
    expect(asked).toContain("track_tags:Nimerudi:Goat, MC Yallah");
  });

  it("retries the tags with the first credited artist when the whole credit has none", async () => {
    fetchInfoValue.mockImplementation(async ({ typeId, entity }: { typeId: string; entity: InfoEntity }) =>
      (typeId === "track_tags" && entity.artistName === "Goat" ? ok({ tags: [{ name: "psych" }] }) : { status: "not_found" }));
    const hints = await gatherRadioHints({ title: "Nimerudi", artistName: "Goat, MC Yallah", invokeInfoFetch });
    expect(hints.tags).toEqual(["psych"]);
  });

  it("keeps what answered when a provider throws or misses the deadline", async () => {
    fetchInfoValue.mockImplementation(async ({ typeId }: { typeId: string }) => {
      if (typeId === "track_tags") throw new Error("type not registered");
      return new Promise(() => {}); // never answers
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hints = await gatherRadioHints({ title: "T", artistName: "Solo", invokeInfoFetch, deadlineMs: 20 });
    expect(hints).toEqual({ seedArtists: ["Solo"], similarArtists: [], tags: [] });
    expect(hasRadioHints(hints)).toBe(true);
  });

  it("asks nothing without an artist", async () => {
    const hints = await gatherRadioHints({ title: "T", artistName: null, invokeInfoFetch });
    expect(hasRadioHints(hints)).toBe(false);
    expect(fetchInfoValue).not.toHaveBeenCalled();
  });
});
