// The `lyrics:changed` source (utils/lyricsEvents.ts) and the one emit that
// lives outside a save path: a provider chain walk that came back with lyrics.
import { describe, it, expect, vi, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { announceLyrics, lyricsChange, onLyricsChanged } from "../utils/lyricsEvents";
import { fetchInfoThroughChain } from "../utils/infoFetchChain";
import type { InfoEntity } from "../types/informationTypes";
import type { LyricsChange } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const song: InfoEntity = { kind: "track", name: "Teardrop", id: 0, artistName: "Massive Attack", albumTitle: "Mezzanine", durationSecs: 330 };

afterEach(() => vi.clearAllMocks());

describe("lyricsChange", () => {
  it("describes one track's lyrics", () => {
    expect(lyricsChange(song, { text: "[00:01.00]Love", kind: "synced" }, "plugin", { pluginId: "community" })).toEqual({
      title: "Teardrop", artistName: "Massive Attack", albumTitle: "Mezzanine", durationSecs: 330,
      kind: "synced", text: "[00:01.00]Love", origin: "plugin", pluginId: "community", provider: null,
    });
  });

  it("is null for anything but a track with text of a known kind", () => {
    expect(lyricsChange({ kind: "artist", name: "Massive Attack", id: 0 }, { text: "x", kind: "plain" }, "edit")).toBeNull();
    expect(lyricsChange(song, { text: "   ", kind: "plain" }, "edit")).toBeNull();
    expect(lyricsChange(song, { text: "x", kind: "karaoke" }, "edit")).toBeNull();
    expect(lyricsChange(song, null, "edit")).toBeNull();
  });

  it("leaves out a length that isn't one", () => {
    expect(lyricsChange({ ...song, durationSecs: 0 }, { text: "x", kind: "plain" }, "edit")?.durationSecs).toBeNull();
  });
});

describe("announceLyrics", () => {
  it("reaches every listener until it unsubscribes, and survives one that throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: LyricsChange[] = [];
    const offBad = onLyricsChanged(() => { throw new Error("listener"); });
    const off = onLyricsChanged((c) => seen.push(c));
    announceLyrics(song, { text: "x", kind: "plain" }, "assistant");
    expect(seen.map((c) => c.origin)).toEqual(["assistant"]);
    off();
    offBad();
    announceLyrics(song, { text: "x", kind: "plain" }, "assistant");
    expect(seen).toHaveLength(1);
  });

  it("announces nothing for a value with nothing in it", () => {
    const listener = vi.fn();
    const off = onLyricsChanged(listener);
    announceLyrics(song, {}, "edit");
    off();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("a provider chain walk", () => {
  async function walk(typeId: string, answers: Record<string, unknown>) {
    const seen: LyricsChange[] = [];
    const off = onLyricsChanged((c) => seen.push(c));
    await fetchInfoThroughChain({
      typeId,
      providers: Object.keys(answers).map((id, i) => [id, i + 1] as [string, number]),
      entity: song,
      entityKey: "track:massive attack:teardrop",
      invokeInfoFetch: async (pluginId) => answers[pluginId] as never,
    });
    off();
    return seen;
  }

  it("announces the lyrics it found, naming the provider that answered", async () => {
    const seen = await walk("lyrics", {
      "core:local-lyrics": { status: "not_found" },
      "lyrics/lrclib": { status: "ok", value: { text: "[00:01.00]Love", kind: "synced" } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ origin: "provider", provider: "lyrics/lrclib", kind: "synced", pluginId: null });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("info_upsert_value", expect.objectContaining({ status: "ok" }));
  });

  it("names the provider whose provisional answer stood", async () => {
    const seen = await walk("lyrics", {
      "core:local-lyrics": { status: "ok", value: { text: "Love", kind: "plain" } },
      "lyrics/lrclib": { status: "not_found" },
    });
    expect(seen.map((c) => [c.provider, c.kind])).toEqual([["core:local-lyrics", "plain"]]);
  });

  it("announces nothing for a miss or for another info type", async () => {
    expect(await walk("lyrics", { "lyrics/lrclib": { status: "not_found" } })).toEqual([]);
    expect(await walk("artist_bio", { lastfm: { status: "ok", value: { text: "Bristol", kind: "plain" } } })).toEqual([]);
  });
});
