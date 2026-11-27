import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PluginScatterGroup, PluginScatterLink, PluginScatterPoint } from "../../types/plugin";
import type { TreeEntityMenuTarget } from "./PluginTree";
import {
  buildScatterModel,
  bestScatterHit,
  centreScatterView,
  fitScatterView,
  groupLabelAnchors,
  hitScatterPoint,
  placeLabels,
  pointSize,
  resolveScatterSelection,
  sameScatterExtent,
  scatterMatcher,
  scatterOptions,
  scatterRadius,
  tipPlacement,
  zoomScatterView,
  type LabelBox,
  type ScatterClickMark,
  type ScatterModel,
  type ScatterView,
} from "../../utils/pluginScatterMap";
import { useLatestRef } from "../../hooks/useLatestRef";

const DEFAULT_HEIGHT = 520;
const PALETTE_SIZE = 12;

interface Props {
  points: PluginScatterPoint[];
  groups?: PluginScatterGroup[];
  links?: PluginScatterLink[];
  selectAction?: string;
  selectedId?: string;
  sizeModes?: { id: string; label: string }[];
  linkToggles?: { kind: string; label: string }[];
  height?: number;
  searchable?: boolean;
  emptyText?: string;
  ariaLabel?: string;
  onAction?: (actionId: string, data?: unknown) => void;
  onEntityContextMenu?: (e: React.MouseEvent, entity: TreeEntityMenuTarget) => void;
}

/** The plugin `scatter-map` view kind: a zoomable 2D point map drawn on a
 *  canvas. Drawn on demand only (pointer, resize, data, skin) — nothing runs
 *  while it sits still. Rules live in `utils/pluginScatterMap.ts`. */
export function PluginScatterMap({
  points, groups, links, selectAction, selectedId, sizeModes, linkToggles, height, searchable = true,
  emptyText, ariaLabel, onAction, onEntityContextMenu,
}: Props) {
  const model = useMemo(() => buildScatterModel(points, groups, links), [points, groups, links]);
  const anchors = useMemo(() => groupLabelAnchors(model), [model]);
  const options = useMemo(() => scatterOptions(sizeModes, linkToggles), [sizeModes, linkToggles]);

  // Host-local view controls: they redraw in place, never a round trip to the plugin.
  const [sizeModePick, setSizeMode] = useState<string | null>(null);
  const sizeMode = options.sizeModes.some((m) => m.id === sizeModePick) ? sizeModePick : options.sizeModes[0]?.id ?? null;
  const [shownKinds, setShownKinds] = useState<string[]>([]);

  // Largest dots first, so labels go to the dots that matter and small dots
  // are painted on top of big ones (drawn in reverse).
  const order = useMemo(
    () => model.points.map((_, i) => i).sort((a, b) => pointSize(model.points[b], sizeMode) - pointSize(model.points[a], sizeMode)),
    [model, sizeMode],
  );
  const groupCounts = useMemo(() => {
    const c = model.groups.map(() => 0);
    for (const p of model.points) if (p.group >= 0) c[p.group]++;
    return c;
  }, [model]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const viewRef = useRef<ScatterView>({ k: 1, tx: 0, ty: 0 });
  const fitKRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const hoverRef = useRef(-1);

  const [query, setQuery] = useState("");
  const [focusGroup, setFocusGroup] = useState(-1);
  const [tip, setTip] = useState<{ x: number; y: number; i: number; left: boolean; up: boolean } | null>(null);

  // A click marks its dot at once; the plugin's next answer — new points or a
  // different selectedId — takes over (the same optimistic rule as `tree`).
  // Both are compared: a plugin that re-sends the same array with a new
  // selection must still win.
  const [optimistic, setOptimistic] = useState<ScatterClickMark | null>(null);
  const selId = resolveScatterSelection(optimistic, points, selectedId);
  const selIndex = useMemo(() => (selId ? model.points.findIndex((p) => p.id === selId) : -1), [model, selId]);

  const match = useMemo(() => scatterMatcher(query), [query]);
  const filtered = focusGroup >= 0 || query.trim() !== "";
  const visible = useCallback(
    (i: number) => {
      const p = model.points[i];
      if (focusGroup >= 0 && p.group !== focusGroup) return false;
      return match(p.label);
    },
    [model, focusGroup, match],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current, probe = probeRef.current;
    const { w, h } = sizeRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !probe || !w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Canvas can't read var(): resolve every colour through a hidden probe.
    const resolve = (c: string) => { probe.style.color = ""; probe.style.color = c; return getComputedStyle(probe).color; };
    const groupColor = model.groups.map((g, i) => resolve(g.color ?? `var(--chart-cat-${(i % PALETTE_SIZE) + 1})`));
    const fallback = resolve("var(--text-tertiary)");
    const ink = resolve("var(--text-primary)");
    const halo = resolve("var(--bg-primary)");
    const accent = resolve("var(--accent)");
    const font = getComputedStyle(wrapRef.current ?? canvas).fontFamily;
    const colorOf = (i: number) => (model.points[i].group >= 0 ? groupColor[model.points[i].group] : fallback);

    const view = viewRef.current, fitK = fitKRef.current;
    const sx = (i: number) => model.points[i].x * view.k + view.tx;
    const sy = (i: number) => model.points[i].y * view.k + view.ty;
    const r = (i: number) => scatterRadius(pointSize(model.points[i], sizeMode), view, fitK);
    const active = hoverRef.current >= 0 ? hoverRef.current : selIndex;

    if (shownKinds.length) {
      ctx.strokeStyle = ink; ctx.lineWidth = 1;
      for (let l = 0; l < model.links.length; l++) {
        const kind = model.linkKinds[l];
        if (!kind || !shownKinds.includes(kind)) continue;
        const [a, b] = model.links[l];
        ctx.globalAlpha = !filtered || (visible(a) && visible(b)) ? 0.16 : 0.04;
        ctx.beginPath(); ctx.moveTo(sx(a), sy(a)); ctx.lineTo(sx(b), sy(b)); ctx.stroke();
      }
    }
    if (active >= 0) {
      ctx.strokeStyle = ink; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
      for (const j of model.neighbours[active]) {
        ctx.beginPath(); ctx.moveTo(sx(active), sy(active)); ctx.lineTo(sx(j), sy(j)); ctx.stroke();
      }
    }
    for (let n = order.length - 1; n >= 0; n--) {
      const i = order[n];
      const x = sx(i), y = sy(i), rad = r(i);
      if (x < -rad || y < -rad || x > w + rad || y > h + rad) continue;
      ctx.globalAlpha = !filtered || visible(i) ? 0.9 : 0.1;
      ctx.fillStyle = colorOf(i);
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const i of [selIndex, hoverRef.current]) {
      if (i < 0) continue;
      ctx.strokeStyle = i === selIndex ? accent : ink; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(i), sy(i), r(i) + 4, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.lineJoin = "round"; ctx.textBaseline = "middle";
    const label = (text: string, x: number, y: number, fill: string) => {
      ctx.strokeStyle = halo; ctx.lineWidth = 4; ctx.strokeText(text, x, y);
      ctx.fillStyle = fill; ctx.fillText(text, x, y);
    };

    // Group names, biggest group first; one that would collide is left out.
    ctx.textAlign = "center";
    const groupCands = model.groups
      .map((g, gi) => ({ g, gi, a: anchors[gi] }))
      .filter((c) => c.a && (focusGroup < 0 || c.gi === focusGroup))
      .sort((a, b) => b.a!.size - a.a!.size)
      .map((c) => {
        const fs = Math.round(Math.min(20, 12 + Math.sqrt(c.a!.size) * 0.8));
        ctx.font = `700 ${fs}px ${font}`;
        const x = c.a!.x * view.k + view.tx, y = c.a!.y * view.k + view.ty;
        const tw = ctx.measureText(c.g.label).width;
        return { ...c, fs, x, y, box: [x - tw / 2 - 4, y - fs * 0.7, x + tw / 2 + 4, y + fs * 0.7] as LabelBox };
      });
    const groupBoxes: LabelBox[] = [];
    for (const k of placeLabels(groupCands)) {
      const c = groupCands[k];
      ctx.font = `700 ${c.fs}px ${font}`;
      label(c.g.label, c.x, c.y, groupColor[c.gi]);
      groupBoxes.push(c.box);
    }

    // Dot names: the selected and hovered dots always; then their linked
    // neighbours, then the biggest dots — each only where it finds room, so a
    // dense neighbourhood never stacks names on top of each other. More fit as
    // you zoom in.
    ctx.textAlign = "left";
    ctx.font = `600 12px ${font}`;
    const forced = new Set<number>([selIndex, hoverRef.current].filter((i) => i >= 0));
    const first = active >= 0 ? model.neighbours[active] : [];
    const cands: Array<{ i: number; box: LabelBox; forced?: boolean }> = [];
    const seen = new Set<number>();
    for (const i of [...forced, ...first, ...order]) {
      if (!forced.has(i) && cands.length > 400) break;
      if (seen.has(i)) continue;
      seen.add(i);
      if (!forced.has(i) && filtered && !visible(i)) continue;
      const x = sx(i) + r(i) + 4, y = sy(i);
      if (x > w || x < 0 || y < 0 || y > h) continue;
      const tw = ctx.measureText(model.points[i].label).width;
      cands.push({ i, box: [x - 2, y - 8, x + tw + 2, y + 8], forced: forced.has(i) });
    }
    const zoom = fitK > 0 ? view.k / fitK : 1;
    for (const k of placeLabels(cands, groupBoxes, Math.round(18 * zoom))) {
      const c = cands[k];
      label(model.points[c.i].label, c.box[0] + 2, sy(c.i), c.i === selIndex ? accent : ink);
    }
  }, [model, anchors, order, selIndex, filtered, visible, focusGroup, sizeMode, shownKinds]);
  const drawRef = useLatestRef(draw);
  const modelRef = useLatestRef(model);
  const hasCanvas = model.points.length > 0;
  useEffect(() => { draw(); }, [draw]);

  // Fit the view when the map changes; keep it when the plugin only redrew the
  // same map (every click re-renders the view), and centred across resizes.
  const fittedBounds = useRef<ScatterModel["bounds"] | null>(null);
  useLayoutEffect(() => {
    const { w, h } = sizeRef.current;
    if (!w || !h) return;
    if (!sameScatterExtent(fittedBounds.current, model.bounds)) {
      viewRef.current = fitScatterView(model.bounds, w, h);
      fitKRef.current = viewRef.current.k;
      fittedBounds.current = model.bounds;
    }
    drawRef.current();
  }, [model, drawRef]);

  // A selection the host didn't make (the plugin's "closest" list) brings the map to it.
  const lastClicked = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId === lastClicked.current) return;
    const p = model.points.find((q) => q.id === selectedId);
    const { w, h } = sizeRef.current;
    if (!p || !w || !h) return;
    viewRef.current = centreScatterView(viewRef.current, p.x, p.y, w, h, fitKRef.current);
    lastClicked.current = selectedId;
    drawRef.current();
  }, [selectedId, model, drawRef]);
  // The canvas exists only while there are points (an empty map renders its
  // empty text instead), so this attaches whenever the canvas appears — a map
  // that started empty must still be measured once its points arrive.
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!hasCanvas || !wrap || !canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const first = !sizeRef.current.w;
      const old = sizeRef.current;
      sizeRef.current = { w: rect.width, h: rect.height };
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const bounds = modelRef.current.bounds;
      if (first || !rect.width || !rect.height) {
        viewRef.current = fitScatterView(bounds, rect.width, rect.height);
        fittedBounds.current = bounds;
      } else {
        const v = viewRef.current;
        viewRef.current = { ...v, tx: v.tx + (rect.width - old.w) / 2, ty: v.ty + (rect.height - old.h) / 2 };
      }
      fitKRef.current = fitScatterView(bounds, rect.width, rect.height).k;
      drawRef.current();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    // A skin change re-colours nothing by itself on a canvas.
    const mo = new MutationObserver(() => drawRef.current());
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin-type", "style", "class"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
      // The next canvas starts over with a fresh fit.
      sizeRef.current = { w: 0, h: 0 };
      fittedBounds.current = null;
    };
  }, [hasCanvas, drawRef, modelRef]);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const pick = (x: number, y: number) =>
    hitScatterPoint(model, viewRef.current, fitKRef.current, x, y, filtered ? visible : undefined, sizeMode);
  const zoomAt = (factor: number, x: number, y: number) => {
    viewRef.current = zoomScatterView(viewRef.current, factor, x, y, fitKRef.current);
    drawRef.current();
  };

  // Pinch (ctrl+wheel on a trackpad) or Cmd/Ctrl+scroll zooms; a plain scroll
  // is left to the page, so the map never traps it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      viewRef.current = zoomScatterView(viewRef.current, Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top, fitKRef.current);
      drawRef.current();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [hasCanvas, drawRef]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; pinch: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    drag.current = { x: p.x, y: p.y, tx: viewRef.current.tx, ty: viewRef.current.ty, moved: false, pinch: 0 };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    const d = drag.current;
    if (d && pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, p);
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (d.pinch) zoomAt(dist / d.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        d.pinch = dist; d.moved = true;
        return;
      }
      if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) > 4) d.moved = true;
      if (d.moved) {
        viewRef.current = { ...viewRef.current, tx: d.tx + p.x - d.x, ty: d.ty + p.y - d.y };
        setTip(null);
        drawRef.current();
        return;
      }
    }
    const i = pick(p.x, p.y);
    if (i !== hoverRef.current) { hoverRef.current = i; drawRef.current(); }
    setTip(i >= 0 ? { x: p.x, y: p.y, i, ...tipPlacement(p.x, p.y, sizeRef.current.w, sizeRef.current.h) } : null);
  };
  const select = (i: number) => {
    if (i < 0 || !selectAction) return;
    const p = model.points[i];
    setOptimistic({ id: p.id, points, selectedId });
    lastClicked.current = p.id;
    onAction?.(selectAction, { id: p.id, data: p.data });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    if (d && !d.moved && pointers.current.size === 0) {
      const p = local(e);
      select(pick(p.x, p.y));
    }
    if (pointers.current.size === 0) drag.current = null;
    else if (pointers.current.size === 1) {
      // A pinch ended with one finger still down: pan from where that finger
      // is now, not from where the gesture began (which made the map jump).
      const [rest] = [...pointers.current.values()];
      drag.current = { x: rest.x, y: rest.y, tx: viewRef.current.tx, ty: viewRef.current.ty, moved: true, pinch: 0 };
    }
  };
  const onPointerLeave = () => {
    if (hoverRef.current >= 0) { hoverRef.current = -1; drawRef.current(); }
    setTip(null);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    const p = local(e);
    const i = pick(p.x, p.y);
    const entity = i >= 0 ? model.points[i].entity : undefined;
    if (entity && onEntityContextMenu) { e.preventDefault(); onEntityContextMenu(e, entity); }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    zoomAt(2, p.x, p.y);
  };

  const refit = () => {
    const { w, h } = sizeRef.current;
    viewRef.current = fitScatterView(model.bounds, w, h);
    fitKRef.current = viewRef.current.k;
    fittedBounds.current = model.bounds;
    drawRef.current();
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const i = bestScatterHit(model, query, (j) => focusGroup < 0 || model.points[j].group === focusGroup);
    if (i < 0) return;
    const { w, h } = sizeRef.current;
    const p = model.points[i];
    viewRef.current = centreScatterView(viewRef.current, p.x, p.y, w, h, fitKRef.current);
    if (selectAction) select(i);
    else { hoverRef.current = i; drawRef.current(); }
  };
  const toggleGroup = (g: number) => {
    const next = focusGroup === g ? -1 : g;
    setFocusGroup(next);
    const { w, h } = sizeRef.current;
    if (next < 0) { viewRef.current = fitScatterView(model.bounds, w, h); return; }
    const m = model.points.filter((p) => p.group === next);
    const b = { x0: Math.min(...m.map((p) => p.x)), x1: Math.max(...m.map((p) => p.x)), y0: Math.min(...m.map((p) => p.y)), y1: Math.max(...m.map((p) => p.y)) };
    const v = fitScatterView(b, w, h, 64);
    const k = Math.min(v.k, fitKRef.current * 6);
    viewRef.current = { k, tx: w / 2 - k * (b.x0 + b.x1) / 2, ty: h / 2 - k * (b.y0 + b.y1) / 2 };
  };

  const mapHeight = Math.min(1200, Math.max(240, height ?? DEFAULT_HEIGHT));
  if (model.points.length === 0) {
    return <div className="plugin-scatter-empty">{emptyText ?? "Nothing to show yet."}</div>;
  }
  const tipPoint = tip ? model.points[tip.i] : null;

  return (
    <div className="plugin-scatter" ref={wrapRef}>
      {(options.sizeModes.length > 1 || options.linkToggles.length > 0) && (
        <div className="plugin-scatter-controls">
          {options.sizeModes.length > 1 && (
            <div className="plugin-scatter-seg" role="group" aria-label="Dot size">
              {options.sizeModes.map((m) => (
                <button key={m.id} type="button" aria-pressed={sizeMode === m.id} onClick={() => setSizeMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {options.linkToggles.map((t) => (
            <label key={t.kind} className="plugin-scatter-check">
              <input
                type="checkbox"
                checked={shownKinds.includes(t.kind)}
                onChange={(e) => {
                  const on = e.target.checked;
                  setShownKinds((prev) => (on ? [...prev, t.kind] : prev.filter((k) => k !== t.kind)));
                }}
              />
              {t.label}
            </label>
          ))}
        </div>
      )}
      <div className="plugin-scatter-map" style={{ height: mapHeight }}>
        <canvas
          ref={canvasRef}
          className="plugin-scatter-canvas"
          role="img"
          aria-label={ariaLabel ?? `Map of ${model.points.length} items`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onContextMenu={onContextMenu}
          onDoubleClick={onDoubleClick}
        />
        <span ref={probeRef} className="plugin-scatter-probe" aria-hidden />
        {searchable && (
          <input
            type="search"
            className="ds-input plugin-scatter-search"
            placeholder="Find…"
            aria-label="Find on the map"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
        )}
        <div className="plugin-scatter-zoom">
          <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" aria-label="Zoom in" onClick={() => zoomAt(1.5, sizeRef.current.w / 2, sizeRef.current.h / 2)}>+</button>
          <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.5, sizeRef.current.w / 2, sizeRef.current.h / 2)}>−</button>
          <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" aria-label="Fit the map" onClick={refit}>Fit</button>
        </div>
        <div className="plugin-scatter-hint">Drag to move · pinch or ⌘-scroll to zoom</div>
        {tipPoint && (
          <div
            className={"plugin-scatter-tip" + (tip!.left ? " plugin-scatter-tip--left" : "") + (tip!.up ? " plugin-scatter-tip--up" : "")}
            style={{ left: tip!.x, top: tip!.y }}
          >
            <div className="plugin-scatter-tip-title">{tipPoint.label}</div>
            {tipPoint.sublabel && <div className="plugin-scatter-tip-sub">{tipPoint.sublabel}</div>}
          </div>
        )}
      </div>
      {model.groups.length > 0 && (
        <div className="plugin-scatter-legend">
          {model.groups.map((g, gi) => (
            <button
              key={g.id}
              type="button"
              className="plugin-scatter-chip"
              aria-pressed={focusGroup === gi}
              onClick={() => toggleGroup(gi)}
            >
              <span className="plugin-scatter-dot" style={{ background: g.color ?? `var(--chart-cat-${(gi % PALETTE_SIZE) + 1})` }} />
              <span className="plugin-scatter-chip-label">{g.label}</span>
              <span className="plugin-scatter-chip-count">{groupCounts[gi]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
