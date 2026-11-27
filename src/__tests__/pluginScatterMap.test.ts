import { describe, it, expect } from "vitest";
import {
  buildScatterModel,
  fitScatterView,
  zoomScatterView,
  centreScatterView,
  hitScatterPoint,
  groupLabelAnchors,
  placeLabels,
  scatterMatcher,
  bestScatterHit,
  scatterRadius,
  pointSize,
  scatterOptions,
  sameScatterExtent,
  safeScatterColor,
  scatterId,
  tipPlacement,
  resolveScatterSelection,
  SCATTER_MAX_POINTS,
  SCATTER_MAX_ZOOM,
  SCATTER_MIN_ZOOM,
} from "../utils/pluginScatterMap";
import type { PluginScatterPoint } from "../types/plugin";

const pt = (id: string, x: number, y: number, extra: Partial<PluginScatterPoint> = {}): PluginScatterPoint => ({ id, x, y, label: id, ...extra });

describe("buildScatterModel", () => {
  it("drops points it can't place, and the first copy of an id wins", () => {
    const m = buildScatterModel(
      [pt("a", 0, 0), pt("b", NaN, 1), pt("c", 1, Infinity), pt("", 2, 2), pt("a", 9, 9), pt("d", 3, 4)],
      [],
      [],
    );
    expect(m.points.map((p) => [p.id, p.x])).toEqual([["a", 0], ["d", 3]]);
  });

  it("clamps size, defaults it, and maps groups by id (unknown → -1)", () => {
    const m = buildScatterModel(
      [pt("a", 0, 0, { size: 4, group: "rock" }), pt("b", 1, 1, { size: -1, group: "jazz" }), pt("c", 2, 2)],
      [{ id: "rock", label: "Rock" }, { id: "rock", label: "dupe" }],
      [],
    );
    expect(m.points.map((p) => [p.size, p.group])).toEqual([[1, 0], [0, -1], [0.3, -1]]);
    expect(m.groups).toEqual([{ id: "rock", label: "Rock", color: undefined }]);
  });

  it("keeps a link once, both ways, and ignores dangling or self links", () => {
    const m = buildScatterModel(
      [pt("a", 0, 0), pt("b", 1, 1), pt("c", 2, 2)],
      [],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "zz" }, { from: "c", to: "c" }],
    );
    expect(m.links).toEqual([[0, 1]]);
    expect(m.neighbours).toEqual([[1], [0], []]);
  });

  it("caps the point count", () => {
    const many = Array.from({ length: SCATTER_MAX_POINTS + 10 }, (_, i) => pt(`p${i}`, i, i));
    expect(buildScatterModel(many, [], []).points).toHaveLength(SCATTER_MAX_POINTS);
  });

  it("treats a non-artist/album entity as none, and trims labels", () => {
    const m = buildScatterModel(
      [
        pt("a", 0, 0, { label: "  Massive   Attack ", entity: { kind: "artist", name: "Massive Attack" } }),
        pt("b", 1, 1, { entity: { kind: "track" as "artist", name: "x" } }),
      ],
      [],
      [],
    );
    expect(m.points[0].label).toBe("Massive Attack");
    expect(m.points[0].entity?.name).toBe("Massive Attack");
    expect(m.points[1].entity).toBeUndefined();
  });

  it("survives a plugin sending nothing usable", () => {
    const m = buildScatterModel(undefined, undefined, undefined);
    expect(m.points).toEqual([]);
    expect(m.bounds).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });
});

describe("view maths", () => {
  const bounds = { x0: -100, y0: -50, x1: 100, y1: 50 };

  it("fits the extent inside the box, centred", () => {
    const v = fitScatterView(bounds, 432, 432, 16);
    expect(v.k).toBeCloseTo(2); // 400 / 200, width binds
    expect(0 * v.k + v.tx).toBeCloseTo(216);
    expect(0 * v.k + v.ty).toBeCloseTo(216);
  });

  it("centres a single point at unit scale instead of dividing by zero", () => {
    const v = fitScatterView({ x0: 5, y0: 5, x1: 5, y1: 5 }, 200, 100);
    expect(v.k).toBe(1);
    expect(5 + v.tx).toBe(100);
    expect(5 + v.ty).toBe(50);
  });

  it("zooms about the pointer: the point under it stays put", () => {
    const v = { k: 2, tx: 10, ty: 20 };
    const z = zoomScatterView(v, 1.5, 100, 80, 2);
    const dataX = (100 - v.tx) / v.k, dataY = (80 - v.ty) / v.k;
    expect(dataX * z.k + z.tx).toBeCloseTo(100);
    expect(dataY * z.k + z.ty).toBeCloseTo(80);
  });

  it("clamps zoom relative to the fitted scale", () => {
    expect(zoomScatterView({ k: 1, tx: 0, ty: 0 }, 1000, 0, 0, 1).k).toBe(SCATTER_MAX_ZOOM);
    expect(zoomScatterView({ k: 1, tx: 0, ty: 0 }, 0.001, 0, 0, 1).k).toBe(SCATTER_MIN_ZOOM);
  });

  it("centring zooms in to at least 3× but never out", () => {
    const c = centreScatterView({ k: 1, tx: 0, ty: 0 }, 10, 10, 200, 200, 1);
    expect(c.k).toBe(3);
    expect(10 * c.k + c.tx).toBe(100);
    expect(centreScatterView({ k: 8, tx: 0, ty: 0 }, 0, 0, 200, 200, 1).k).toBe(8);
  });

  it("dots grow with zoom, but at most double", () => {
    const base = scatterRadius(1, { k: 1, tx: 0, ty: 0 }, 1);
    expect(scatterRadius(1, { k: 4, tx: 0, ty: 0 }, 1)).toBeCloseTo(base * 2);
    expect(scatterRadius(1, { k: 100, tx: 0, ty: 0 }, 1)).toBeCloseTo(base * 2);
  });
});

describe("hitScatterPoint", () => {
  const m = buildScatterModel([pt("a", 0, 0, { size: 0 }), pt("b", 50, 0, { size: 0 })], [], []);
  const v = { k: 1, tx: 0, ty: 0 };

  it("finds the nearest dot within the slop, nothing beyond it", () => {
    expect(hitScatterPoint(m, v, 1, 2, 1)).toBe(0);
    expect(hitScatterPoint(m, v, 1, 48, 0)).toBe(1);
    expect(hitScatterPoint(m, v, 1, 25, 0)).toBe(-1);
  });

  it("skips dimmed dots", () => {
    expect(hitScatterPoint(m, v, 1, 2, 1, (i) => i !== 0)).toBe(-1);
  });
});

describe("groupLabelAnchors", () => {
  it("labels a group on its body, not pulled out by a far stray", () => {
    const pts = [pt("a", 0, 0), pt("b", 1, 0), pt("c", 0, 1), pt("d", 1, 1), pt("stray", 100, 100)].map((p) => ({ ...p, group: "g" }));
    const [a] = groupLabelAnchors(buildScatterModel(pts, [{ id: "g", label: "G" }], []));
    expect(a!.size).toBe(5);
    expect(a!.x).toBeLessThan(2);
    expect(a!.y).toBeLessThan(2);
  });

  it("is null for a group with no points", () => {
    expect(groupLabelAnchors(buildScatterModel([pt("a", 0, 0)], [{ id: "g", label: "G" }], []))).toEqual([null]);
  });
});

describe("placeLabels", () => {
  it("keeps non-overlapping labels in priority order, forced ones always", () => {
    const kept = placeLabels([
      { box: [0, 0, 10, 10] },
      { box: [5, 5, 15, 15] }, // overlaps the first
      { box: [20, 0, 30, 10] },
      { box: [6, 6, 8, 8], forced: true }, // forced, reserves first
    ]);
    expect(kept.sort()).toEqual([2, 3]);
  });

  it("respects reserved boxes and the cap on free labels", () => {
    expect(placeLabels([{ box: [0, 0, 10, 10] }, { box: [20, 0, 30, 10] }], [[0, 0, 5, 5]])).toEqual([1]);
    expect(placeLabels([{ box: [0, 0, 1, 1] }, { box: [5, 0, 6, 1] }], [], 1)).toEqual([0]);
  });
});

describe("search", () => {
  it("matches every term, ignoring case and accents", () => {
    const m = scatterMatcher("bjork  HOMO");
    expect(m("Björk — Homogenic")).toBe(true);
    expect(m("Björk")).toBe(false);
    expect(scatterMatcher("  ")("anything")).toBe(true);
  });

  it("jumps to an exact label first, then a prefix, then the biggest dot", () => {
    const m = buildScatterModel(
      [pt("1", 0, 0, { label: "The Cure", size: 1 }), pt("2", 0, 0, { label: "Cure", size: 0.1 }), pt("3", 0, 0, { label: "Curve", size: 0.9 })],
      [],
      [],
    );
    expect(bestScatterHit(m, "cure")).toBe(1);
    expect(bestScatterHit(m, "cur")).toBe(2); // "Curve" and "Cure" both prefix; Curve is bigger
    expect(bestScatterHit(m, "zzz")).toBe(-1);
  });
});

describe("size measures, link kinds and view options", () => {
  it("keeps each point's measures clamped, and falls back to size", () => {
    const m = buildScatterModel([pt("a", 0, 0, { size: 0.5, sizes: { plays: 2, tracks: 0.25, bad: NaN } })], [], []);
    expect(m.points[0].sizes).toEqual({ plays: 1, tracks: 0.25 });
    expect(pointSize(m.points[0], "plays")).toBe(1);
    expect(pointSize(m.points[0], "tracks")).toBe(0.25);
    expect(pointSize(m.points[0], "unknown")).toBe(0.5);
    expect(pointSize(m.points[0], null)).toBe(0.5);
  });

  it("carries each link's kind beside it", () => {
    const m = buildScatterModel([pt("a", 0, 0), pt("b", 1, 1), pt("c", 2, 2)], [], [
      { from: "a", to: "b", kind: "lastfm" },
      { from: "b", to: "c" },
    ]);
    expect(m.linkKinds).toEqual(["lastfm", undefined]);
  });

  it("offers each size mode and link toggle once", () => {
    const o = scatterOptions(
      [{ id: "plays", label: "Size by plays" }, { id: "plays", label: "dupe" }, { id: "", label: "x" }, { id: "tracks", label: "" }],
      [{ kind: "lastfm", label: "Show Last.fm links" }, { kind: "lastfm", label: "again" }],
    );
    expect(o.sizeModes).toEqual([{ id: "plays", label: "Size by plays" }, { id: "tracks", label: "tracks" }]);
    expect(o.linkToggles).toEqual([{ kind: "lastfm", label: "Show Last.fm links" }]);
    expect(scatterOptions(undefined, undefined)).toEqual({ sizeModes: [], linkToggles: [] });
  });

  it("treats a redraw of the same extent as the same map", () => {
    const b = { x0: 0, y0: 0, x1: 10, y1: 5 };
    expect(sameScatterExtent(b, { ...b })).toBe(true);
    expect(sameScatterExtent(b, { ...b, x1: 11 })).toBe(false);
    expect(sameScatterExtent(null, b)).toBe(false);
  });
});

describe("review fixes", () => {
  it("paints only colours that can't load anything", () => {
    for (const ok of ["var(--accent)", "#fff", "#12ab34", "#12ab34cc", "rgb(1, 2, 3)", "hsl(200 50% 40% / 0.5)"]) {
      expect(safeScatterColor(ok)).toBe(ok);
    }
    for (const bad of ["url(https://evil.example/?d=1)", "image-set('x.png' 1x)", "linear-gradient(red, blue)", "var(--x), url(y)", "red;background:url(z)", 42, null]) {
      expect(safeScatterColor(bad)).toBeNull();
    }
    const m = buildScatterModel([pt("a", 0, 0, { group: "g" })], [{ id: "g", label: "G", color: "url(https://evil.example/)" }], []);
    expect(m.groups[0].color).toBeUndefined();
  });

  it("keeps ids exactly as sent, so links and selection still match them", () => {
    expect(scatterId("a  b")).toBe("a  b");
    expect(scatterId(" x ")).toBe(" x ");
    expect(scatterId(7)).toBe("7");
    expect(scatterId("x".repeat(121))).toBeNull();
    expect(scatterId("")).toBeNull();
    const m = buildScatterModel([pt("a  b", 0, 0), pt("c", 1, 1)], [], [{ from: "a  b", to: "c" }]);
    expect(m.points[0].id).toBe("a  b");
    expect(m.links).toEqual([[0, 1]]);
  });

  it("search can be limited to what the map shows", () => {
    const m = buildScatterModel([pt("1", 0, 0, { label: "Cure", size: 1 }), pt("2", 0, 0, { label: "Cure", size: 0.1 })], [], []);
    expect(bestScatterHit(m, "cure")).toBe(0);
    expect(bestScatterHit(m, "cure", (i) => i === 1)).toBe(1);
    expect(bestScatterHit(m, "cure", () => false)).toBe(-1);
  });

  it("opens the tip away from the near edges", () => {
    expect(tipPlacement(10, 10, 800, 600)).toEqual({ left: false, up: false });
    expect(tipPlacement(700, 10, 800, 600)).toEqual({ left: true, up: false });
    expect(tipPlacement(10, 580, 800, 600)).toEqual({ left: false, up: true });
  });
});

describe("resolveScatterSelection", () => {
  const pts = [{ id: "a" }];
  it("shows the click until the plugin answers", () => {
    expect(resolveScatterSelection({ id: "a", points: pts, selectedId: undefined }, pts, undefined)).toBe("a");
  });
  it("new points from the plugin take over", () => {
    expect(resolveScatterSelection({ id: "a", points: pts, selectedId: undefined }, [{ id: "a" }], "b")).toBe("b");
  });
  it("a different selectedId takes over even with the same points array", () => {
    expect(resolveScatterSelection({ id: "a", points: pts, selectedId: "a" }, pts, "b")).toBe("b");
  });
  it("with no click it is the plugin's selection", () => {
    expect(resolveScatterSelection(null, pts, "b")).toBe("b");
  });
});
