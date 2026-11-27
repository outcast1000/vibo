import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { PluginScatterMap } from "../components/pluginViews/PluginScatterMap";
import { PluginViewRenderer } from "../components/PluginViewRenderer";
import type { PluginViewData } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: (p: string) => p,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  safeUnlisten: () => {},
  combineUnlisten: () => () => {},
}));

beforeAll(() => {
  // jsdom has neither; the map must still render its chrome without them.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.setPointerCapture ??= () => {};
  // Every canvas is 200×100, measured as soon as the map mounts.
  HTMLCanvasElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  // jsdom has no PointerEvent, so fireEvent.pointer* would drop clientX/button.
  if (!("PointerEvent" in globalThis)) {
    class FakePointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
  }
});
afterEach(cleanup);


const data = (extra: Partial<Extract<PluginViewData, { type: "scatter-map" }>> = {}): PluginViewData => ({
  type: "scatter-map",
  selectAction: "pick",
  points: [
    { id: "a", x: 0, y: 0, label: "Massive Attack", size: 1, group: "trip", entity: { kind: "artist", name: "Massive Attack" }, data: { n: 1 } },
    { id: "b", x: 10, y: 10, label: "Portishead", group: "trip" },
    { id: "c", x: 10, y: 0, label: "Slayer", group: "metal" },
  ],
  groups: [{ id: "trip", label: "Trip hop" }, { id: "metal", label: "Metal" }],
  ...extra,
});

describe("scatter-map view node", () => {
  it("lists the groups with their counts, and a group chip toggles", () => {
    const r = render(<PluginViewRenderer pluginName="Stats" data={data()} currentTrack={null} />);
    const chip = r.getByRole("button", { name: /Trip hop/ });
    expect(chip.textContent).toContain("2");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the empty text when no point is drawable", () => {
    const r = render(<PluginViewRenderer pluginName="Stats" data={data({ points: [{ id: "x", x: NaN, y: 0, label: "x" }], emptyText: "Refresh to build the map" })} currentTrack={null} />);
    expect(r.getByText("Refresh to build the map")).toBeTruthy();
    expect(r.container.querySelector("canvas")).toBeNull();
  });

  it("a click on a dot fires the select action with its id and data", () => {
    const onAction = vi.fn();
    const r = render(<PluginViewRenderer pluginName="Stats" data={data()} currentTrack={null} onAction={onAction} />);
    const canvas = r.container.querySelector("canvas")!;
    fireEvent.click(r.getByRole("button", { name: "Fit the map" }));
    // Point "a" (0,0) lands at the top-left of the fitted extent.
    const pad = 32, k = Math.min((200 - pad * 2) / 10, (100 - pad * 2) / 10);
    const x = 100 - k * 5, y = 50 - k * 5;
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x, clientY: y });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: x, clientY: y });
    expect(onAction).toHaveBeenCalledWith("pick", { id: "a", data: { n: 1 } });
  });

  it("a drag pans instead of selecting", () => {
    const onAction = vi.fn();
    const r = render(<PluginViewRenderer pluginName="Stats" data={data()} currentTrack={null} onAction={onAction} />);
    const canvas = r.container.querySelector("canvas")!;
    fireEvent.click(r.getByRole("button", { name: "Fit the map" }));
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 60 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 90, clientY: 60 });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("right-click on a dot with an entity opens the host's entity menu", () => {
    const onEntityContextMenu = vi.fn();
    const r = render(<PluginViewRenderer pluginName="Stats" data={data()} currentTrack={null} extras={{ onEntityContextMenu }} />);
    const canvas = r.container.querySelector("canvas")!;
    fireEvent.click(r.getByRole("button", { name: "Fit the map" }));
    const pad = 32, k = Math.min((200 - pad * 2) / 10, (100 - pad * 2) / 10);
    fireEvent.contextMenu(canvas, { clientX: 100 - k * 5, clientY: 50 - k * 5 });
    expect(onEntityContextMenu).toHaveBeenCalledTimes(1);
    expect(onEntityContextMenu.mock.calls[0][1]).toEqual({ kind: "artist", name: "Massive Attack" });
  });

  it("Enter in the search box selects the best match", () => {
    const onAction = vi.fn();
    const r = render(<PluginViewRenderer pluginName="Stats" data={data()} currentTrack={null} onAction={onAction} />);
    const input = r.getByRole("searchbox", { name: "Find on the map" });
    fireEvent.change(input, { target: { value: "porti" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("pick", { id: "b", data: undefined });
  });

  it("offers the size switch and link toggles only when the view declares them", () => {
    const plain = render(<PluginViewRenderer pluginName="Stats" data={data()} currentTrack={null} />);
    expect(plain.queryByRole("group", { name: "Dot size" })).toBeNull();
    expect(plain.queryByRole("checkbox")).toBeNull();
    cleanup();
    const r = render(
      <PluginViewRenderer
        pluginName="Stats"
        data={data({
          sizeModes: [{ id: "plays", label: "Size by plays" }, { id: "tracks", label: "by tracks" }],
          linkToggles: [{ kind: "lastfm", label: "Show Last.fm links" }],
        })}
        currentTrack={null}
      />,
    );
    const plays = r.getByRole("button", { name: "Size by plays" });
    const tracks = r.getByRole("button", { name: "by tracks" });
    expect(plays.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tracks);
    expect(tracks.getAttribute("aria-pressed")).toBe("true");
    expect(plays.getAttribute("aria-pressed")).toBe("false");
    const box = r.getByRole("checkbox", { name: "Show Last.fm links" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it("a map that started empty is measured once its points arrive", () => {
    const observed: Element[] = [];
    const prev = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe(el: Element) { observed.push(el); } unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try {
      const r = render(<PluginScatterMap points={[]} emptyText="Nothing yet" />);
      expect(r.getByText("Nothing yet")).toBeTruthy();
      r.rerender(<PluginScatterMap points={[{ id: "a", x: 0, y: 0, label: "A" }, { id: "b", x: 1, y: 1, label: "B" }]} />);
      expect(observed).toEqual([r.container.querySelector("canvas")]);
    } finally {
      globalThis.ResizeObserver = prev;
    }
  });

  it("a group colour that would load a URL is replaced by the palette in the legend", () => {
    const r = render(
      <PluginScatterMap
        points={[{ id: "a", x: 0, y: 0, label: "A", group: "g" }]}
        groups={[{ id: "g", label: "G", color: "url(https://evil.example/?d=secret)" }]}
      />,
    );
    const dot = r.container.querySelector(".plugin-scatter-dot") as HTMLElement;
    expect(dot.getAttribute("style") ?? "").not.toMatch(/url\(/);
    expect(dot.getAttribute("style") ?? "").toMatch(/--chart-cat-1/);
  });

  it("hides the search box when the plugin turns it off", () => {
    const r = render(<PluginViewRenderer pluginName="Stats" data={data({ searchable: false })} currentTrack={null} />);
    expect(r.queryByRole("searchbox")).toBeNull();
  });
});
