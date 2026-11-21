// The `cues:changed` source (utils/cueEvents.ts).
import { describe, it, expect, vi } from "vitest";
import { announceCueSheet, cueSheetChange, onCueSheetChanged } from "../utils/cueEvents";
import type { CueSheetChange } from "../types/plugin";

const song = { title: "Teardrop", artistName: "Massive Attack" };

describe("cueSheetChange", () => {
  it("describes a plugin's save, with who wrote it and when", () => {
    expect(cueSheetChange(song, "saved", "plugin", { pluginId: "community", updatedAt: 1700000000 })).toEqual({
      title: "Teardrop", artistName: "Massive Attack", action: "saved", origin: "plugin", pluginId: "community", updatedAt: 1700000000,
    });
  });

  it("names a plugin only for a plugin's write, and a time only for a save", () => {
    const byAssistant = cueSheetChange(song, "saved", "assistant", { pluginId: "community", updatedAt: 5 });
    expect(byAssistant?.pluginId).toBeNull();
    expect(byAssistant?.updatedAt).toBe(5);
    expect(cueSheetChange(song, "deleted", "plugin", { pluginId: "x", updatedAt: 5 })?.updatedAt).toBeNull();
  });

  it("is null without a title, and an empty artist reads as none", () => {
    expect(cueSheetChange({ title: "  " }, "saved", "assistant")).toBeNull();
    expect(cueSheetChange({ title: "Intro", artistName: " " }, "saved", "assistant")?.artistName).toBeNull();
  });
});

describe("announceCueSheet", () => {
  it("reaches every listener until it unsubscribes, and survives one that throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: CueSheetChange[] = [];
    const offBad = onCueSheetChanged(() => { throw new Error("listener"); });
    const off = onCueSheetChanged((c) => seen.push(c));
    announceCueSheet(song, "deleted", "assistant");
    expect(seen.map((c) => c.action)).toEqual(["deleted"]);
    off();
    offBad();
    announceCueSheet(song, "deleted", "assistant");
    expect(seen).toHaveLength(1);
  });
});
