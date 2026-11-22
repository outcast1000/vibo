// "Get lyrics" / "Get image": menu rows built from the providers the user has
// switched on (Settings → Providers), not from plugin menu items. Lyrics and
// entity images come through one provider contract each, so the host can ask
// any of them the same way and confirm the answer in one dialog (the Retrieve
// modal in "get" mode). That is what makes host-generated per-provider entries
// fine here, unlike file downloads, whose flows differ per provider and are
// therefore each plugin's own menu item (conventions.md "Download Track").
import type { MenuItemSpec } from "../nativeMenu";
import { coreProviderSupports, imageProviderName, isCoreImageProvider } from "../utils/coreImageProviders";

/** Image provider rows as `get_image_providers` returns them
 *  ([providerId, priority, integerId]), named and narrowed to what can answer
 *  for `entity` — the same rows the Retrieve modal will walk. */
export function imageProviderChoices(
  rows: Array<[string, number, number]>,
  entity: "artist" | "album" | "tag",
  pluginNames: Map<string, string>,
): ProviderChoice[] {
  return rows
    .filter(([id]) => !isCoreImageProvider(id) || coreProviderSupports(id, entity))
    .map(([id]) => ({ key: id, name: imageProviderName(id, pluginNames, "long") }));
}

/** Info-type provider rows ([providerKey, integerId]) as menu choices. */
export function infoProviderChoices(rows: Array<[string, number]>, pluginNames: Map<string, string>): ProviderChoice[] {
  return rows.map(([key]) => ({ key, name: pluginNames.get(key) ?? key }));
}

/** One provider the row can ask: its key (a plugin id, `<pluginId>/<providerId>`
 *  or a built-in `core:*` id) and its display name. */
export interface ProviderChoice {
  key: string;
  name: string;
}

/**
 * The row for one "get" action:
 * - no provider on → a plain item (the dialog then says none is on and
 *   suggests plugins that could supply it);
 * - one → a plain item naming it ("Get lyrics (LRCLIB)");
 * - several → a submenu: "All sources" (the whole chain, in the user's order),
 *   then each provider on its own.
 * `open(null)` walks the chain; `open(key)` asks that provider only.
 */
export function buildGetFromProvidersSpec(
  title: string,
  providers: ProviderChoice[],
  open: (providerKey: string | null) => void,
): MenuItemSpec {
  if (providers.length === 0) return { kind: "item", text: title, action: () => open(null) };
  if (providers.length === 1) {
    const only = providers[0];
    return { kind: "item", text: `${title} (${only.name})`, action: () => open(only.key) };
  }
  return {
    kind: "submenu",
    text: title,
    items: [
      { kind: "item", text: "All sources", action: () => open(null) },
      { kind: "separator" },
      ...providers.map((p): MenuItemSpec => ({ kind: "item", text: p.name, action: () => open(p.key) })),
    ],
  };
}
