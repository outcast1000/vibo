import { describe, it, expect, vi } from "vitest";
import { buildGetFromProvidersSpec, imageProviderChoices, infoProviderChoices } from "../contextMenu/providerMenus";
import type { MenuItemSpec } from "../nativeMenu";

const text = (s: MenuItemSpec) => (s.kind === "item" || s.kind === "submenu" || s.kind === "check" ? s.text : "—");

describe("buildGetFromProvidersSpec", () => {
  it("is a plain item with no provider, asking the (empty) chain", () => {
    const open = vi.fn();
    const spec = buildGetFromProvidersSpec("Get lyrics", [], open);
    expect(spec.kind === "item" && spec.text).toBe("Get lyrics");
    if (spec.kind === "item") spec.action();
    expect(open).toHaveBeenCalledWith(null);
  });

  it("names a lone provider and asks only it", () => {
    const open = vi.fn();
    const spec = buildGetFromProvidersSpec("Get lyrics", [{ key: "lyrics/lrclib", name: "LRCLIB" }], open);
    expect(spec.kind === "item" && spec.text).toBe("Get lyrics (LRCLIB)");
    if (spec.kind === "item") spec.action();
    expect(open).toHaveBeenCalledWith("lyrics/lrclib");
  });

  it("offers All sources, then each provider in order", () => {
    const open = vi.fn();
    const spec = buildGetFromProvidersSpec("Get image", [
      { key: "artwork/deezer", name: "Deezer" },
      { key: "spotify-browse", name: "Spotify" },
    ], open);
    if (spec.kind !== "submenu") throw new Error("expected a submenu");
    expect(spec.text).toBe("Get image");
    expect(spec.items.map(text)).toEqual(["All sources", "—", "Deezer", "Spotify"]);
    const [all, , deezer] = spec.items;
    if (all.kind === "item") all.action();
    if (deezer.kind === "item") deezer.action();
    expect(open.mock.calls).toEqual([[null], ["artwork/deezer"]]);
  });
});

describe("provider choices", () => {
  const names = new Map([["artwork/deezer", "Deezer"], ["genius", "Genius"]]);

  it("names image rows and drops built-in ones that can't answer for the entity", () => {
    const rows: Array<[string, number, number]> = [["core:embedded", 0, 1], ["artwork/deezer", 1, 2]];
    // Embedded artwork is album-only; an artist image never comes from it.
    expect(imageProviderChoices(rows, "artist", names).map((c) => c.key)).toEqual(["artwork/deezer"]);
    expect(imageProviderChoices(rows, "album", names).map((c) => c.key)).toEqual(["core:embedded", "artwork/deezer"]);
  });

  it("names info rows, falling back to the key", () => {
    expect(infoProviderChoices([["genius", 3], ["mystery", 4]], names)).toEqual([
      { key: "genius", name: "Genius" },
      { key: "mystery", name: "mystery" },
    ]);
  });
});
