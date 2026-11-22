import { describe, expect, it } from "vitest";
import { fitTabs } from "../utils/tabOverflow";

const widths = { a: 100, b: 100, c: 100, d: 100, e: 100 };
const ids = ["a", "b", "c", "d", "e"];

describe("fitTabs", () => {
  it("shows every tab when they all fit", () => {
    expect(fitTabs({ ids, widths, available: 500, moreWidth: 60, activeId: "a" })).toEqual({
      visible: ids,
      overflow: [],
    });
  });

  it("shows every tab before anything is measured", () => {
    expect(fitTabs({ ids, widths: {}, available: 0, moreWidth: 0, activeId: "a" }).overflow).toEqual([]);
    expect(fitTabs({ ids, widths, available: 0, moreWidth: 60, activeId: "a" }).overflow).toEqual([]);
  });

  it("keeps a prefix and leaves room for More", () => {
    // 450 - 60 = 390 → three tabs fit; a fourth would not.
    expect(fitTabs({ ids, widths, available: 450, moreWidth: 60, activeId: "a" })).toEqual({
      visible: ["a", "b", "c"],
      overflow: ["d", "e"],
    });
  });

  it("never hides the active tab, and keeps it in its place", () => {
    expect(fitTabs({ ids, widths, available: 450, moreWidth: 60, activeId: "e" })).toEqual({
      visible: ["a", "b", "e"],
      overflow: ["c", "d"],
    });
  });

  it("stops at the first tab that doesn't fit rather than skipping ahead", () => {
    const w = { a: 100, b: 300, c: 20, d: 20 };
    expect(fitTabs({ ids: ["a", "b", "c", "d"], widths: w, available: 300, moreWidth: 50, activeId: "a" })).toEqual({
      visible: ["a"],
      overflow: ["b", "c", "d"],
    });
  });

  it("shows the active tab even when it alone is wider than the row", () => {
    expect(fitTabs({ ids, widths: { ...widths, c: 900 }, available: 300, moreWidth: 60, activeId: "c" })).toEqual({
      visible: ["c"],
      overflow: ["a", "b", "d", "e"],
    });
  });

  it("ignores an active id that is not a tab", () => {
    expect(fitTabs({ ids, widths, available: 450, moreWidth: 60, activeId: "zzz" }).visible).toEqual(["a", "b", "c"]);
  });
});
