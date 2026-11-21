import { describe, it, expect } from "vitest";
import { addToAll, hasTagChanges, removeFromAll, selectionFromCounts, tagDelta } from "../utils/bulkEditTags";

const counts: Array<[number, string, number]> = [[1, "Jazz", 1], [2, "Live", 3], [3, "Rock", 3]];

describe("selectionFromCounts", () => {
  it("splits tags every track has from tags only some have", () => {
    expect(selectionFromCounts(counts, 3)).toEqual({
      applied: ["Live", "Rock"],
      partial: [{ name: "Jazz", count: 1, total: 3 }],
    });
  });
});

describe("tagDelta", () => {
  const original = selectionFromCounts(counts, 3);

  it("is empty when nothing was touched — a partial tag is never sent", () => {
    expect(tagDelta(original, original)).toEqual({ add: [], remove: [] });
    expect(hasTagChanges(original, original)).toBe(false);
  });

  it("adds a new tag to every track and leaves the partial one alone", () => {
    expect(tagDelta(original, addToAll(original, "Blues"))).toEqual({ add: ["Blues"], remove: [] });
  });

  it("applying a partial tag to all adds it (case- and accent-insensitive)", () => {
    const next = addToAll(original, "jazz");
    expect(next.applied).toEqual(["Live", "Rock", "Jazz"]);
    expect(next.partial).toEqual([]);
    expect(tagDelta(original, next)).toEqual({ add: ["Jazz"], remove: [] });
  });

  it("removes an applied or a partial tag from every track", () => {
    expect(tagDelta(original, removeFromAll(original, "rock"))).toEqual({ add: [], remove: ["Rock"] });
    expect(tagDelta(original, removeFromAll(original, "Jazz"))).toEqual({ add: [], remove: ["Jazz"] });
  });

  it("removing then re-adding a tag is no change", () => {
    const next = addToAll(removeFromAll(original, "Rock"), "Rock");
    expect(hasTagChanges(original, next)).toBe(false);
  });

  it("re-adding a removed tag in another case keeps its existing spelling — no change to save", () => {
    const next = addToAll(removeFromAll(original, "Rock"), "ROCK", original);
    expect(next.applied).toContain("Rock");
    expect(hasTagChanges(original, next)).toBe(false);
    // A partial tag removed and re-added goes on all tracks, spelled as before.
    const jazz = addToAll(removeFromAll(original, "Jazz"), "jazz", original);
    expect(jazz.applied).toContain("Jazz");
    expect(tagDelta(original, jazz)).toEqual({ add: ["Jazz"], remove: [] });
  });

  it("ignores a blank name and an already-applied one", () => {
    expect(addToAll(original, "  ")).toBe(original);
    expect(addToAll(original, "LIVE")).toBe(original);
  });
});
