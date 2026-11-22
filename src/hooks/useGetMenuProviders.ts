import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DisplayKind } from "../types/informationTypes";

/** Where the menus' Get lyrics / Get image rows read their providers from.
 *  A native menu is built synchronously, so the lists are kept as a snapshot:
 *  read when the plugins change, and again in the background each time a menu
 *  opens (`refresh`), so a provider switched on or off in Settings shows up by
 *  the next menu at the latest. */
export interface GetMenuProviders {
  /** The lyrics type's provider chain ([providerKey, integerId]), in the user's order. */
  lyrics: { providers: Array<[string, number]>; displayKind: DisplayKind } | null;
  /** Image provider rows per entity ([providerId, priority, integerId]). */
  images: Record<"artist" | "album" | "tag", Array<[string, number, number]>>;
}

// Backend row: [type_id, name, display_kind, ttl, sort_order, providers, description]
type TypeRow = [string, string, string, number, number, Array<[string, number]>, string];

const EMPTY: GetMenuProviders = { lyrics: null, images: { artist: [], album: [], tag: [] } };

export function useGetMenuProviders(pluginsVersion: unknown): GetMenuProviders & { refresh: () => void } {
  const [state, setState] = useState<GetMenuProviders>(EMPTY);
  const genRef = useRef(0);

  const refresh = useCallback(() => {
    const gen = ++genRef.current;
    void (async () => {
      try {
        const [types, artist, album, tag] = await Promise.all([
          invoke<TypeRow[]>("info_get_types_for_entity", { entity: "track" }),
          invoke<Array<[string, number, number]>>("get_image_providers", { entity: "artist" }),
          invoke<Array<[string, number, number]>>("get_image_providers", { entity: "album" }),
          invoke<Array<[string, number, number]>>("get_image_providers", { entity: "tag" }),
        ]);
        if (gen !== genRef.current) return;
        const row = types.find(([id]) => id === "lyrics");
        setState({
          // Built-in rows (core:local-lyrics, the song's own files) are left
          // out: getting lyrics "from the file" into the file would only offer
          // the current lyrics back. Get lyrics asks the web providers.
          lyrics: row ? { providers: row[5].filter(([key]) => !key.startsWith("core:")), displayKind: row[2] as DisplayKind } : null,
          images: { artist, album, tag },
        });
      } catch (e) {
        console.error("Failed to load the providers for the Get lyrics / Get image menus:", e);
      }
    })();
  }, []);

  // Plugins loading, reloading or toggling change which providers exist.
  useEffect(() => { refresh(); }, [refresh, pluginsVersion]);

  return { ...state, refresh };
}
