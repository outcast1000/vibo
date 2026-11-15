import { createContext, useContext } from "react";
import { NO_TAG_REFRESH, type TagOpsDeps } from "../utils/tagOps";

/**
 * The refresh hooks App wires for the shared tag ops (utils/tagOps.ts) —
 * a debounced tag recount + library reload after DB-only edits, and the full
 * post-bulk-edit refresh after file writes. Provided once at the App root so
 * in-app tag surfaces (TagPopover via useTagActions, useEntityTags) refresh the Library the
 * same way the plugin API and control API do, without threading props.
 */
const TagOpsContext = createContext<TagOpsDeps>(NO_TAG_REFRESH);

export const TagOpsProvider = TagOpsContext.Provider;

export function useTagOpsDeps(): TagOpsDeps {
  return useContext(TagOpsContext);
}
