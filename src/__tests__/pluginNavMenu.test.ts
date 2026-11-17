import { describe, it, expect, vi } from "vitest";
import { buildPluginNavMenuSpecs, type PluginNavMenuDeps } from "../contextMenu/buildPluginNavMenuSpecs";
import type { MenuItemSpec } from "../nativeMenu";

function deps(over: Partial<PluginNavMenuDeps> = {}): PluginNavMenuDeps {
  return {
    canUninstall: true, revertsToBuiltin: false, busy: false,
    onDetails: vi.fn(), onDisable: vi.fn(), onUninstall: vi.fn(),
    ...over,
  };
}
const items = (specs: MenuItemSpec[]) =>
  specs.flatMap((s) => (s.kind === "item" ? [s] : []));

describe("buildPluginNavMenuSpecs", () => {
  it("offers details, disable and uninstall, each wired to its handler", () => {
    const d = deps();
    const its = items(buildPluginNavMenuSpecs(d));
    expect(its.map((i) => i.text)).toEqual(["View details", "Disable", "Uninstall…"]);
    its.forEach((i) => i.action());
    expect(d.onDetails).toHaveBeenCalledOnce();
    expect(d.onDisable).toHaveBeenCalledOnce();
    expect(d.onUninstall).toHaveBeenCalledOnce();
  });

  it("has no uninstall for a bundled plugin", () => {
    expect(items(buildPluginNavMenuSpecs(deps({ canUninstall: false }))).map((i) => i.text))
      .toEqual(["View details", "Disable"]);
  });

  it("names the revert for a user copy over a bundled plugin", () => {
    expect(items(buildPluginNavMenuSpecs(deps({ revertsToBuiltin: true }))).at(-1)?.text).toBe("Revert to built-in…");
  });

  it("freezes disable and uninstall while an extension operation runs, keeps details", () => {
    const its = items(buildPluginNavMenuSpecs(deps({ busy: true })));
    expect(its.map((i) => i.enabled ?? true)).toEqual([true, false, false]);
  });
});
