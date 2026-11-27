// Pure, DOM-free logic behind the plugin `scatter-map` view kind
// (`pluginViews/PluginScatterMap.tsx`): sanitising what a plugin sent, fitting
// the view, hit-testing, label placement. Kept free of React and canvas so the
// rules can be asserted without rendering (`__tests__/pluginScatterMap.test.ts`).

import type { PluginScatterGroup, PluginScatterLink, PluginScatterPoint } from "../types/plugin";

/** More points than this are dropped (the first ones are kept). A plugin view is
 *  a structured clone across the worker boundary and every draw walks the list. */
export const SCATTER_MAX_POINTS = 5000;
export const SCATTER_MAX_LINKS = 20000;
export const SCATTER_MAX_GROUPS = 64;
const MAX_LABEL = 120;
const MAX_SUBLABEL = 160;
/** Size measures per point (`sizes`) and link kinds a view may declare. */
export const SCATTER_MAX_SIZE_MODES = 8;
export const SCATTER_MAX_LINK_KINDS = 8;
const MAX_KEY = 40;

/** Dot radius in CSS px at the fitted zoom, for `size` 0 and 1. */
export const SCATTER_MIN_RADIUS = 1.8;
export const SCATTER_MAX_RADIUS = 11;
/** Zoom limits, relative to the fitted view. */
export const SCATTER_MIN_ZOOM = 0.5;
export const SCATTER_MAX_ZOOM = 16;
/** A pointer this close to a dot's edge (CSS px) still hits it. */
export const SCATTER_HIT_SLOP = 6;

export interface ScatterPoint {
  id: string;
  x: number;
  y: number;
  label: string;
  sublabel?: string;
  /** 0..1, clamped. */
  size: number;
  /** Other size measures by mode id (`sizeModes`), each 0..1. */
  sizes?: Record<string, number>;
  /** Index into `groups`, or -1. */
  group: number;
  entity?: PluginScatterPoint["entity"];
  data?: unknown;
}

export interface ScatterGroup {
  id: string;
  label: string;
  color?: string;
}

export interface ScatterModel {
  points: ScatterPoint[];
  groups: ScatterGroup[];
  /** Point-index pairs. */
  links: Array<[number, number]>;
  /** Each link's `kind`, parallel to `links` (undefined when the plugin gave none). */
  linkKinds: Array<string | undefined>;
  /** Each point's linked neighbours, for highlighting a hovered or selected dot. */
  neighbours: number[][];
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

const clip = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** An id exactly as the plugin sent it (a string or a finite number, at most
 *  MAX_LABEL characters), or null. Never rewritten: links, `selectedId` and the
 *  select action all speak the plugin's ids, so a cleaned-up copy would match
 *  none of them. */
export function scatterId(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string" || !v || v.length > MAX_LABEL) return null;
  return v;
}

/** A group colour the host will paint: a skin variable or a plain colour
 *  value. Anything else (`url(…)`, `image-set(…)`, a gradient) is refused — a
 *  background that loads a URL would let a plugin send data off the machine
 *  through the host. Null means "use the palette". */
export function safeScatterColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim();
  if (/^var\(--[A-Za-z0-9_-]{1,60}\)$/.test(c)) return c;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c;
  if (/^(?:rgb|rgba|hsl|hsla)\([0-9\s.,%/+-]{1,60}\)$/i.test(c)) return c;
  return null;
}

/** What the renderer draws: non-finite points dropped, sizes clamped, unknown
 *  groups and dangling links ignored, everything capped. */
export function buildScatterModel(
  rawPoints: PluginScatterPoint[] | undefined,
  rawGroups: PluginScatterGroup[] | undefined,
  rawLinks: PluginScatterLink[] | undefined,
): ScatterModel {
  const groups: ScatterGroup[] = [];
  const groupIndex = new Map<string, number>();
  for (const g of Array.isArray(rawGroups) ? rawGroups : []) {
    if (groups.length >= SCATTER_MAX_GROUPS) break;
    const id = scatterId(g?.id);
    if (!id || groupIndex.has(id)) continue;
    groupIndex.set(id, groups.length);
    groups.push({ id, label: clip(g.label, MAX_LABEL) || id, color: safeScatterColor(g.color) ?? undefined });
  }

  const points: ScatterPoint[] = [];
  const pointIndex = new Map<string, number>();
  for (const p of Array.isArray(rawPoints) ? rawPoints : []) {
    if (points.length >= SCATTER_MAX_POINTS) break;
    const id = scatterId(p?.id);
    const x = Number(p?.x), y = Number(p?.y);
    if (!id || pointIndex.has(id) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = Number(p.size);
    const entity = p.entity && (p.entity.kind === "artist" || p.entity.kind === "album") && typeof p.entity.name === "string" && p.entity.name.trim()
      ? p.entity : undefined;
    let sizes: Record<string, number> | undefined;
    if (p.sizes && typeof p.sizes === "object") {
      for (const key of Object.keys(p.sizes).slice(0, SCATTER_MAX_SIZE_MODES)) {
        const v = Number((p.sizes as Record<string, unknown>)[key]);
        if (!key || key.length > MAX_KEY || !Number.isFinite(v)) continue;
        (sizes ??= {})[key] = Math.min(1, Math.max(0, v));
      }
    }
    pointIndex.set(id, points.length);
    points.push({
      id, x, y,
      label: clip(p.label, MAX_LABEL) || id,
      sublabel: p.sublabel != null ? clip(p.sublabel, MAX_SUBLABEL) || undefined : undefined,
      size: Number.isFinite(size) ? Math.min(1, Math.max(0, size)) : 0.3,
      sizes,
      group: p.group != null ? groupIndex.get(scatterId(p.group) ?? "") ?? -1 : -1,
      entity,
      data: p.data,
    });
  }

  const links: Array<[number, number]> = [];
  const linkKinds: Array<string | undefined> = [];
  const neighbours: number[][] = points.map(() => []);
  const seen = new Set<string>();
  for (const l of Array.isArray(rawLinks) ? rawLinks : []) {
    if (links.length >= SCATTER_MAX_LINKS) break;
    const a = pointIndex.get(scatterId(l?.from) ?? ""), b = pointIndex.get(scatterId(l?.to) ?? "");
    if (a == null || b == null || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([a, b]);
    linkKinds.push(typeof l.kind === "string" && l.kind && l.kind.length <= MAX_KEY ? l.kind : undefined);
    neighbours[a].push(b);
    neighbours[b].push(a);
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const bounds = points.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { points, groups, links, linkKinds, neighbours, bounds };
}

/** A point's size under the chosen measure (`sizeModes`); `size` when the
 *  point carries no value for it, or no measure is chosen. */
export function pointSize(p: ScatterPoint, mode?: string | null): number {
  if (mode && p.sizes && p.sizes[mode] != null) return p.sizes[mode];
  return p.size;
}

/** The size measures and link toggles a view declared, cleaned: unique ids,
 *  capped, labels trimmed. Pure so the controls the host offers are assertable. */
export function scatterOptions(
  sizeModes: Array<{ id: string; label: string }> | undefined,
  linkToggles: Array<{ kind: string; label: string }> | undefined,
): { sizeModes: Array<{ id: string; label: string }>; linkToggles: Array<{ kind: string; label: string }> } {
  const uniq = <T,>(list: T[] | undefined, key: (t: T) => unknown, cap: number) => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const t of Array.isArray(list) ? list : []) {
      const k = typeof key(t) === "string" ? (key(t) as string) : "";
      if (!k || k.length > MAX_KEY || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= cap) break;
    }
    return out;
  };
  return {
    sizeModes: uniq(sizeModes, (m) => m?.id, SCATTER_MAX_SIZE_MODES).map((m) => ({ id: m.id, label: clip(m.label, MAX_LABEL) || m.id })),
    linkToggles: uniq(linkToggles, (t) => t?.kind, SCATTER_MAX_LINK_KINDS).map((t) => ({ kind: t.kind, label: clip(t.label, MAX_LABEL) || t.kind })),
  };
}

/** Whether a new model can keep the current view: same extent means the
 *  plugin redrew the same map (a selection, a label change), so a re-fit would
 *  throw away the user's zoom for nothing. */
export function sameScatterExtent(a: ScatterModel["bounds"] | null, b: ScatterModel["bounds"]): boolean {
  return !!a && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/** Screen transform: screen = data * k + (tx, ty). */
export interface ScatterView {
  k: number;
  tx: number;
  ty: number;
}

/** The view that fits `bounds` inside a (w × h) box with `pad` px all round.
 *  A degenerate extent (one point, or all on a line) is centred at a unit scale. */
export function fitScatterView(bounds: ScatterModel["bounds"], w: number, h: number, pad = 32): ScatterView {
  const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
  const aw = Math.max(1, w - pad * 2), ah = Math.max(1, h - pad * 2);
  const kx = bw > 0 ? aw / bw : Infinity, ky = bh > 0 ? ah / bh : Infinity;
  let k = Math.min(kx, ky);
  if (!Number.isFinite(k) || k <= 0) k = 1;
  return { k, tx: w / 2 - k * (bounds.x0 + bounds.x1) / 2, ty: h / 2 - k * (bounds.y0 + bounds.y1) / 2 };
}

/** Zoom by `factor` about the screen point (px, py), clamped to the zoom limits
 *  relative to `fitK` (the fitted scale). */
export function zoomScatterView(view: ScatterView, factor: number, px: number, py: number, fitK: number): ScatterView {
  const k = Math.min(fitK * SCATTER_MAX_ZOOM, Math.max(fitK * SCATTER_MIN_ZOOM, view.k * factor));
  const f = k / view.k;
  return { k, tx: px - (px - view.tx) * f, ty: py - (py - view.ty) * f };
}

/** A view centred on (x, y) in data space, at least `minZoom` × the fitted scale. */
export function centreScatterView(view: ScatterView, x: number, y: number, w: number, h: number, fitK: number, minZoom = 3): ScatterView {
  const k = Math.min(fitK * SCATTER_MAX_ZOOM, Math.max(view.k, fitK * minZoom));
  return { k, tx: w / 2 - x * k, ty: h / 2 - y * k };
}

/** Dots grow a little as you zoom in, never past double, never below 70%. */
export function scatterRadius(size: number, view: ScatterView, fitK: number): number {
  const zoom = fitK > 0 ? view.k / fitK : 1;
  const grow = Math.min(2, Math.max(0.7, Math.sqrt(zoom)));
  return (SCATTER_MIN_RADIUS + (SCATTER_MAX_RADIUS - SCATTER_MIN_RADIUS) * Math.sqrt(size)) * grow;
}

/** The dot under the pointer: nearest by distance to its edge, within the slop.
 *  `visible(i)` filters out dots that are dimmed (a group filter, a search). */
export function hitScatterPoint(
  model: ScatterModel,
  view: ScatterView,
  fitK: number,
  px: number,
  py: number,
  visible: (i: number) => boolean = () => true,
  sizeMode?: string | null,
): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < model.points.length; i++) {
    if (!visible(i)) continue;
    const p = model.points[i];
    const d = Math.hypot(p.x * view.k + view.tx - px, p.y * view.k + view.ty - py) - scatterRadius(pointSize(p, sizeMode), view, fitK);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= SCATTER_HIT_SLOP ? best : -1;
}

/** Where a group's name goes: the mean of its denser half (the members nearest
 *  its median), so a group with a few strays far out is labelled on its body,
 *  not in the empty space between. Data-space coordinates; null for an empty group. */
export function groupLabelAnchors(model: ScatterModel): Array<{ x: number; y: number; size: number } | null> {
  return model.groups.map((_, g) => {
    const xs: number[] = [], ys: number[] = [];
    for (const p of model.points) if (p.group === g) { xs.push(p.x); ys.push(p.y); }
    if (!xs.length) return null;
    const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const mx = median(xs), my = median(ys);
    const dist = xs.map((x, i) => Math.hypot(x - mx, ys[i] - my));
    const cut = [...dist].sort((a, b) => a - b)[Math.max(0, Math.ceil(dist.length / 2) - 1)];
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < xs.length; i++) if (dist[i] <= cut) { sx += xs[i]; sy += ys[i]; n++; }
    return { x: sx / n, y: sy / n, size: xs.length };
  });
}

export type LabelBox = [number, number, number, number];

const overlaps = (a: LabelBox, b: LabelBox) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** Greedy label placement: candidates in priority order, each kept only if its
 *  box doesn't overlap one already kept (or a reserved box). `forced` ones are
 *  always kept and reserve their space first. Returns the kept candidates' indices. */
export function placeLabels(
  candidates: Array<{ box: LabelBox; forced?: boolean }>,
  reserved: LabelBox[] = [],
  max = Infinity,
): number[] {
  const taken: LabelBox[] = [...reserved];
  const kept: number[] = [];
  candidates.forEach((c, i) => { if (c.forced) { taken.push(c.box); kept.push(i); } });
  let free = 0;
  for (let i = 0; i < candidates.length && free < max; i++) {
    const c = candidates[i];
    if (c.forced) continue;
    if (taken.some((t) => overlaps(c.box, t))) continue;
    taken.push(c.box);
    kept.push(i);
    free++;
  }
  return kept;
}

/** A click's mark, held until the plugin answers. */
export interface ScatterClickMark {
  id: string;
  /** The `points` array and `selectedId` on screen when the click happened. */
  points: unknown;
  selectedId: string | undefined;
}

/** The selection to draw: the clicked dot until the plugin answers with new
 *  points or a different `selectedId`, then the plugin's. Both are compared —
 *  a plugin that re-sends the same array with a new selection must win. */
export function resolveScatterSelection(mark: ScatterClickMark | null, points: unknown, selectedId: string | undefined): string | undefined {
  return mark && mark.points === points && mark.selectedId === selectedId ? mark.id : selectedId;
}

/** Which side of the pointer the hover tip opens on, so it stays inside a
 *  (w × h) map: right and below by default, flipped near the far edges. */
export function tipPlacement(x: number, y: number, w: number, h: number): { left: boolean; up: boolean } {
  return { left: x > w - 300, up: y > h - 70 };
}

/** Search match: every whitespace-separated term appears in the label (case-
 *  and accent-insensitive). An empty query matches everything. */
export function scatterMatcher(query: string): (label: string) => boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  return (label) => {
    const l = fold(label);
    return terms.every((t) => l.includes(t));
  };
}

/** The best search hit to jump to: an exact label first, then a label that
 *  starts with the query, then the largest dot among the rest. -1 for none. */
export function bestScatterHit(model: ScatterModel, query: string, allowed: (i: number) => boolean = () => true): number {
  const match = scatterMatcher(query);
  const q = query.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  let best = -1, bestRank = -1;
  model.points.forEach((p, i) => {
    if (!allowed(i) || !match(p.label)) return;
    const l = p.label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const rank = (l === q ? 2 : l.startsWith(q) ? 1 : 0) * 10 + p.size;
    if (rank > bestRank) { bestRank = rank; best = i; }
  });
  return best;
}
