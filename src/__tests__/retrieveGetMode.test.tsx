// The Retrieve modal's "get" mode (the menus' Get lyrics / Get image): nothing
// is applied without a click, the current value is shown beside the new one,
// and song lyrics are saved like the lyrics editor saves them (files first).
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("../utils/localLyrics", () => ({
  saveSongLyrics: vi.fn(async () => ({ savedTo: "file" })),
}));

import { invoke } from "@tauri-apps/api/core";
import { saveSongLyrics } from "../utils/localLyrics";
import {
  currentInfoFromRows, lyricsToSave, pickProviders, useRetrieveModal, type RetrieveModalData,
} from "../hooks/useRetrieveModal";
import { RetrieveModal, applyLabel } from "../components/RetrieveModal";
import type { InfoFetchResult } from "../types/informationTypes";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  vi.mocked(saveSongLyrics).mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("get-mode helpers", () => {
  it("reads the current lyrics from the cached rows; an empty row is nothing yet", () => {
    const rows: Array<[number, string, string, string, number]> = [
      [1, "lyrics", JSON.stringify({ text: "la la", kind: "plain" }), "ok", 0],
      [2, "artist_bio", "{}", "ok", 0],
    ];
    expect(currentInfoFromRows(rows, "lyrics")).toEqual({ status: "ok", info: { text: "la la", kind: "plain" } });
    expect(currentInfoFromRows([[1, "lyrics", JSON.stringify({ text: "  " }), "ok", 0]], "lyrics")).toEqual({ status: "none" });
    expect(currentInfoFromRows([[1, "lyrics", "{}", "not_found", 0]], "lyrics")).toEqual({ status: "none" });
  });

  it("saves a song's lyrics through saveSongLyrics, nothing else", () => {
    const base = { kind: "info" as const, infoTypeId: "lyrics", entityKind: "track" as const };
    expect(lyricsToSave({ ...base, infoPreview: { text: "[00:01.00]hi", kind: "synced" } })).toEqual({ text: "[00:01.00]hi", kind: "synced" });
    expect(lyricsToSave({ ...base, infoPreview: { text: "hi" } })).toEqual({ text: "hi", kind: "plain" });
    expect(lyricsToSave({ ...base, infoTypeId: "track_bio", infoPreview: { text: "x" } })).toBeNull();
    expect(lyricsToSave({ ...base, infoPreview: { text: "" } })).toBeNull();
  });

  it("narrows to the picked provider, or keeps every row", () => {
    const rows = [["a", 1], ["b", 2]] as Array<[string, number]>;
    expect(pickProviders(rows, (r) => r[0], "b")).toEqual([["b", 2]]);
    expect(pickProviders(rows, (r) => r[0], null)).toEqual(rows);
  });

  it("words the apply button by what it does", () => {
    const m = { mode: "get", countdown: null } as unknown as RetrieveModalData;
    expect(applyLabel({ ...m, current: { status: "none" } })).toBe("Add");
    expect(applyLabel({ ...m, current: { status: "ok", info: {} } })).toBe("Replace");
    expect(applyLabel({ ...m, mode: "retrieve", countdown: 7 })).toBe("Apply now (7)");
  });
});

describe("useRetrieveModal in get mode", () => {
  const entity = { kind: "track" as const, id: 0, name: "Teardrop", artistName: "Massive Attack", path: "file:///m/teardrop.flac" };

  function openLyrics(onlyProvider: string | null) {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "info_get_values_for_entity") return [[1, "lyrics", JSON.stringify({ text: "old", kind: "plain" }), "ok", 0]];
      throw new Error(`unexpected ${cmd}`);
    });
    const infoFetch = vi.fn(async (pluginId: string): Promise<InfoFetchResult> =>
      ({ status: "ok", value: { text: `from ${pluginId}`, kind: "plain" } }));
    const hook = renderHook(() => useRetrieveModal(vi.fn(), infoFetch));
    act(() => {
      hook.result.current.openInfo({
        infoTypeId: "lyrics", label: "lyrics", displayKind: "lyrics", entity,
        providers: [["lyrics/lrclib", 1], ["genius", 2]], pluginNames: new Map([["genius", "Genius"]]),
        mode: "get", onlyProvider,
      });
    });
    return { hook, infoFetch };
  }

  it("asks only the picked provider, shows the current value, and never applies on its own", async () => {
    vi.useFakeTimers();
    const { hook, infoFetch } = openLyrics("genius");
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const m = hook.result.current.modal!;
    expect(m.label).toBe("Get lyrics");
    expect(m.providers.map((p) => p.id)).toEqual(["genius"]);
    expect(infoFetch).toHaveBeenCalledTimes(1);
    expect(m.phase).toBe("paused");
    expect(m.countdown).toBeNull();
    expect(m.current).toEqual({ status: "ok", info: { text: "old", kind: "plain" } });
    // Long past the retrieve countdown: still waiting for the user.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(hook.result.current.modal?.phase).toBe("paused");
    expect(saveSongLyrics).not.toHaveBeenCalled();
  });

  it("saves the lyrics into the song's files on Replace, with the file as a hint", async () => {
    const { hook } = openLyrics(null);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(hook.result.current.modal?.phase).toBe("paused"));
    await act(async () => { hook.result.current.applyNow(); });
    await vi.waitFor(() => expect(saveSongLyrics).toHaveBeenCalled());
    const [savedEntity, text, kind, origin, from] = vi.mocked(saveSongLyrics).mock.calls[0];
    expect(savedEntity).toMatchObject({ kind: "track", name: "Teardrop", artistName: "Massive Attack", path: "file:///m/teardrop.flac" });
    expect([text, kind, origin, from]).toEqual(["from lyrics/lrclib", "plain", "provider", { provider: "lyrics/lrclib" }]);
    expect(invokeMock).not.toHaveBeenCalledWith("info_upsert_value", expect.anything());
  });
});

describe("RetrieveModal in get mode", () => {
  const found: RetrieveModalData = {
    kind: "image", mode: "get", label: "Get artist image", title: "Portishead", entityKind: "artist", name: "Portishead",
    providers: [{ id: "artwork/deezer", name: "Deezer", pluginId: "artwork/deezer", status: "found" }],
    currentIndex: 0, phase: "paused", countdown: null, keepOpen: false,
    imagePreview: { src: "https://img/new.jpg", save: { kind: "url", url: "https://img/new.jpg" } },
  };
  const noop = () => {};

  it("puts the current image beside the new one and offers Replace / Keep current", () => {
    render(<RetrieveModal modal={{ ...found, current: { status: "ok", imageSrc: "asset://old.jpg" } }} onTryNext={noop} onApplyNow={noop} onCancel={noop} onSetKeepOpen={noop} />);
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByText("From Deezer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep current" })).toBeTruthy();
    expect(screen.queryByText(/Keep open/)).toBeNull();
  });

  it("offers Add when there is nothing yet", () => {
    render(<RetrieveModal modal={{ ...found, current: { status: "none" } }} onTryNext={noop} onApplyNow={noop} onCancel={noop} onSetKeepOpen={noop} />);
    expect(screen.queryByText("Current")).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
