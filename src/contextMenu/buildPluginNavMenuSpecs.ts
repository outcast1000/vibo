import type { MenuItemSpec } from "../nativeMenu";

export interface PluginNavMenuDeps {
  /** The plugin can be removed: not a bundled plugin (a user copy shadowing one reverts instead). */
  canUninstall: boolean;
  /** Removing it brings back the bundled version rather than deleting the plugin. */
  revertsToBuiltin: boolean;
  /** An enable/disable or install is already running — the Extensions view freezes its toggles too. */
  busy: boolean;
  onDetails: () => void;
  onDisable: () => void;
  onUninstall: () => void;
}

/**
 * The right-click native menu on a plugin's entry in the left sidebar: open its
 * page in Extensions, switch it off, or uninstall it. Pure so the items behind
 * a native menu — which has no DOM — stay assertable; App owns the anchor and
 * the confirmation. Only an enabled plugin has a sidebar entry, so there is no
 * Enable here.
 */
export function buildPluginNavMenuSpecs(deps: PluginNavMenuDeps): MenuItemSpec[] {
  const specs: MenuItemSpec[] = [
    { kind: "item", text: "View details", action: deps.onDetails },
    { kind: "separator" },
    { kind: "item", text: "Disable", enabled: !deps.busy, action: deps.onDisable },
  ];
  if (deps.canUninstall) {
    specs.push({
      kind: "item",
      text: deps.revertsToBuiltin ? "Revert to built-in…" : "Uninstall…",
      enabled: !deps.busy,
      action: deps.onUninstall,
    });
  }
  return specs;
}
