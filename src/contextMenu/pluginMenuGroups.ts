// Pure helpers for turning plugin context-menu items into renderable shapes.
// `layoutPluginMenu` decides the structure once and every surface renders that
// tree: the native right-click menus (buildPluginMenuSpecs) and the detail-page
// overflow menu (heroOverflow). The goal is one row per plugin, not one per
// action, so the menu stays short however many plugins are installed:
//
// - An item that declares a shared `action` (see SHARED_MENU_ACTIONS) is laid
//   out by that action, never under its plugin: several providers become one
//   submenu under the host's title ("Start radio ▸ Last.fm / Spotify"), a
//   single provider a flat row named by the action ("Start radio (Last.fm)").
//   Either way the row sorts under the action, so it stays put as providers
//   come and go. Matching labels alone never merge.
// - A plugin left with two or more entries gets one submenu named after the
//   plugin, holding its bare labels and its own `submenuLabel` groups.
// - A plugin left with a single entry stays flat, labelled "Plugin: Label".
// - A `submenuLabel` group shared by several plugins (a common "Search") stays
//   a top-level submenu whose entries name their plugin.
//
// The top level is sorted alphabetically, so a row keeps its position as other
// plugins are installed or removed.
//
// A menu that has its own entry for a shared action (the library radio, the
// library album) joins the plugins' items to it with `mergeHostAction`, which
// keeps the row where the host entry always was. The track menus put the
// remaining shared-action rows (`splitSharedActions`) in that same section,
// beside the host's own actions, never in the plugin section below them.
import type { MenuItemSpec } from "../nativeMenu";
import type { PluginMenuItem, PluginContextMenuTarget, SharedMenuAction } from "../types/plugin";
import { SHARED_MENU_ACTIONS, isSharedMenuAction } from "../types/plugin";

/**
 * Prefix a label with the plugin that owns it ("Last.fm: Play the Full Album"),
 * so a plugin action is never mistaken for a built-in one. Never doubles a
 * name: a label that already names the plugin (an older plugin build's
 * "Upgrade with qBittorrent…") is kept as is, and a label the plugin name
 * already contains (Web Search's "Search" submenu) collapses to the name.
 */
export function withPluginName(label: string, pluginName: string | undefined): string {
  if (!pluginName) return label;
  const l = label.toLowerCase();
  const n = pluginName.toLowerCase();
  if (l.includes(n)) return label;
  if (n.includes(l)) return pluginName;
  return `${pluginName}: ${label}`;
}

/** Display label for a flat (ungrouped) plugin menu item. */
export function pluginMenuItemLabel(item: PluginMenuItem): string {
  return withPluginName(item.label, item.pluginName);
}

/** A laid-out plugin menu: leaves dispatch `item`, submenus nest. */
export type PluginMenuNode =
  | { kind: "leaf"; text: string; item: PluginMenuItem }
  | { kind: "submenu"; key: string; text: string; children: PluginMenuNode[] };

const byOrderThenLabel = (a: PluginMenuItem, b: PluginMenuItem) =>
  (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label);
const byText = (a: PluginMenuNode, b: PluginMenuNode) =>
  a.text.localeCompare(b.text, undefined, { sensitivity: "base" });
const pluginCount = (items: PluginMenuItem[]) => new Set(items.map((it) => it.pluginId)).size;
const providerName = (it: PluginMenuItem) => it.pluginName ?? it.pluginId;

/** The shared action an item is laid out by, or null for a plain item. */
function sharedActionOf(it: PluginMenuItem): SharedMenuAction | null {
  return !it.submenuLabel && isSharedMenuAction(it.action) ? it.action : null;
}

/** Group `items` by `keyOf`, keeping first-seen order. */
function groupBy<T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const arr = out.get(k);
    if (arr) arr.push(it); else out.set(k, [it]);
  }
  return out;
}

/** One entry per provider of a shared action, sorted by provider name: a leaf
 *  named after the plugin, or — for a plugin offering the action more than
 *  once (Soulseek's Download / Download and let me choose…) — a submenu named
 *  after the plugin holding its own labels. */
function sharedActionLeaves(items: PluginMenuItem[], action: string): PluginMenuNode[] {
  return [...groupBy(items, (it) => it.pluginId)]
    .map(([pluginId, own]): PluginMenuNode => own.length === 1
      ? { kind: "leaf", text: providerName(own[0]), item: own[0] }
      : {
          kind: "submenu",
          key: `action:${action}:${pluginId}`,
          text: providerName(own[0]),
          children: [...own].sort(byOrderThenLabel).map((it) => ({ kind: "leaf", text: it.label, item: it })),
        })
    .sort(byText);
}

export function layoutPluginMenu(matching: PluginMenuItem[]): PluginMenuNode[] {
  const top: PluginMenuNode[] = [];

  // Shared actions → laid out by the action, whatever plugin offers them.
  for (const [action, items] of groupBy(matching.filter((it) => sharedActionOf(it)), (it) => it.action!)) {
    const title = SHARED_MENU_ACTIONS[action as SharedMenuAction];
    if (items.length === 1) {
      top.push({ kind: "leaf", text: `${title} (${providerName(items[0])})`, item: items[0] });
    } else {
      top.push({ kind: "submenu", key: `action:${action}`, text: title, children: sharedActionLeaves(items, action) });
    }
  }
  const plain = matching.filter((it) => !sharedActionOf(it));

  // A submenuLabel group spanning several plugins stays top level, leaves named.
  const ownGroups: PluginMenuItem[] = [];
  for (const [label, items] of groupBy(plain.filter((it) => it.submenuLabel), (it) => it.submenuLabel!)) {
    if (pluginCount(items) < 2) { ownGroups.push(...items); continue; }
    top.push({
      kind: "submenu",
      key: `group:${label}`,
      text: label,
      children: [...items].sort(byOrderThenLabel)
        .map((it) => ({ kind: "leaf", text: pluginMenuItemLabel(it), item: it })),
    });
  }

  // Everything left belongs to exactly one plugin.
  const rest = [...plain.filter((it) => !it.submenuLabel), ...ownGroups];
  for (const [pluginId, items] of groupBy(rest, (it) => it.pluginId)) {
    const entries: PluginMenuNode[] = items
      .filter((it) => !it.submenuLabel)
      .map((it) => ({ kind: "leaf", text: it.label, item: it }));
    for (const [label, sub] of groupBy(items.filter((it) => it.submenuLabel), (it) => it.submenuLabel!)) {
      entries.push({
        kind: "submenu",
        key: `group:${pluginId}:${label}`,
        text: label,
        children: [...sub].sort(byOrderThenLabel).map((it) => ({ kind: "leaf", text: it.label, item: it })),
      });
    }
    const name = items[0].pluginName;
    if (entries.length === 1) {
      top.push({ ...entries[0], text: withPluginName(entries[0].text, name) });
    } else {
      top.push({ kind: "submenu", key: `plugin:${pluginId}`, text: name ?? pluginId, children: entries });
    }
  }

  return top.sort(byText);
}

type Dispatch = (pluginId: string, actionId: string, t: PluginContextMenuTarget) => void;

const nodeToSpec = (target: PluginContextMenuTarget, dispatch: Dispatch) => {
  const toSpec = (node: PluginMenuNode): MenuItemSpec =>
    node.kind === "leaf"
      ? { kind: "item", text: node.text, action: () => dispatch(node.item.pluginId, node.item.id, target) }
      : { kind: "submenu", text: node.text, items: node.children.map(toSpec) };
  return toSpec;
};

/**
 * Split plugin items into the shared-action ones (Start radio, Play the Full
 * Album, Download, Find downloads) and the rest. A track menu lays the shared
 * rows out beside its own actions — they are things to do with the track, like
 * the library's own radio — and only the plain items in the plugin section at
 * the bottom.
 */
export function splitSharedActions(items: PluginMenuItem[]): { shared: PluginMenuItem[]; plain: PluginMenuItem[] } {
  return {
    shared: items.filter((it) => sharedActionOf(it)),
    plain: items.filter((it) => !sharedActionOf(it)),
  };
}

/** Native context-menu specs for the plugin items matching one target. */
export function buildPluginMenuSpecs(
  matching: PluginMenuItem[],
  target: PluginContextMenuTarget,
  dispatch: Dispatch,
): MenuItemSpec[] {
  return layoutPluginMenu(matching).map(nodeToSpec(target, dispatch));
}

/** The leaf the host's own entry takes inside a shared-action submenu. */
export const HOST_PROVIDER_LABEL = "Library";

/**
 * Join the host's own entry for a shared action with the plugins' items for
 * the same action, so the menu has one "Start radio" rather than a host item
 * plus a plugin submenu next to it. With no plugin offering the action the
 * host entry is returned as it always was (`text`); otherwise one submenu
 * under the action's title, the host first as "Library", then each plugin.
 * Returns the spec for the host entry's position and the plugin items still
 * to lay out (`buildPluginMenuSpecs(rest, …)`), the joined ones removed.
 */
export function mergeHostAction(
  host: { action: SharedMenuAction; text: string; run: () => void },
  matching: PluginMenuItem[],
  target: PluginContextMenuTarget,
  dispatch: Dispatch,
): { spec: MenuItemSpec; rest: PluginMenuItem[] } {
  const joined = matching.filter((it) => sharedActionOf(it) === host.action);
  if (joined.length === 0) {
    return { spec: { kind: "item", text: host.text, action: host.run }, rest: matching };
  }
  return {
    spec: {
      kind: "submenu",
      text: SHARED_MENU_ACTIONS[host.action],
      items: [
        { kind: "item", text: HOST_PROVIDER_LABEL, action: host.run },
        ...sharedActionLeaves(joined, host.action).map(nodeToSpec(target, dispatch)),
      ],
    },
    rest: matching.filter((it) => !joined.includes(it)),
  };
}
