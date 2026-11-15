import type { SkinInfo } from "../types/skin";
import defaultSkin from "./default.json";
import oledBlack from "./oled-black.json";
import arcticLight from "./arctic-light.json";
import forest from "./forest.json";
import silver from "./silver.json";
import oceanBlue from "./ocean-blue.json";
import viboplr from "./viboplr.json";
import sunset from "./sunset.json";
import tidePool from "./tide-pool.json";

function toSkinInfo(id: string, json: Record<string, unknown>): SkinInfo {
  return { id, source: "builtin", ...(json as Omit<SkinInfo, "id" | "source">) };
}

/** The skin a profile uses until the user picks one (and falls back to when the
 *  active skin is deleted or missing). Keep `base.css`'s `:root` first-paint
 *  colours in step with it. "default" is the id of Default Dark Blue, which was
 *  the default skin before Tide Pool — the id is kept so a saved pick still resolves. */
export const DEFAULT_SKIN_ID = "tide-pool";

export const BUILTIN_SKINS: SkinInfo[] = [
  toSkinInfo("default", defaultSkin),
  toSkinInfo("oled-black", oledBlack),
  toSkinInfo("arctic-light", arcticLight),
  toSkinInfo("forest", forest),
  toSkinInfo("silver", silver),
  toSkinInfo("ocean-blue", oceanBlue),
  toSkinInfo("viboplr", viboplr),
  toSkinInfo("sunset", sunset),
  toSkinInfo("tide-pool", tidePool),
];
