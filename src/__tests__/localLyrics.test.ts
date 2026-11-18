import { describe, it, expect, vi, beforeEach } from "vitest";

// A fresh vi.fn per test, not one shared mock + mockReset: under vitest 4 a
// mock that resolved in an earlier test reports a later test's *caught*
// rejection as an unhandled error (reproduced in isolation before settling
// on this shape).
let invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { fetchLocalLyrics, localLyricsProviderName, saveLocalLyrics } from "../utils/localLyrics";

describe("fetchLocalLyrics", () => {
  beforeEach(() => { invokeMock = vi.fn(); });

  it("shapes a hit as LyricsData with local: true and a provider name", async () => {
    invokeMock.mockResolvedValue({ text: "[00:01]la", kind: "synced", source: "sidecar" });
    const value = await fetchLocalLyrics(
      { kind: "track", name: "Jóga", artistName: "Björk", albumTitle: "Homogenic" },
      "file:///music/Björk/Jóga.flac",
    );
    expect(invokeMock).toHaveBeenCalledWith("get_local_lyrics", {
      title: "Jóga",
      artistName: "Björk",
      albumName: "Homogenic",
      path: "file:///music/Björk/Jóga.flac",
    });
    expect(value).toEqual({
      text: "[00:01]la",
      kind: "synced",
      local: true,
      _meta: { providerName: "Lyrics file" },
    });
  });

  it("resolves null for a miss", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await fetchLocalLyrics({ kind: "track", name: "Song" })).toBeNull();
  });

  it("never asks the backend for a non-track entity", async () => {
    expect(await fetchLocalLyrics({ kind: "artist", name: "Björk" })).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resolves null instead of throwing on a backend error", async () => {
    // Never throws — the caller treats local as best-effort and falls
    // through to the cache/provider chain.
    invokeMock.mockRejectedValue(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fetchLocalLyrics({ kind: "track", name: "Song" })).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("sends null for absent artist/album/path so the backend lookup cascades", async () => {
    invokeMock.mockResolvedValue(null);
    await fetchLocalLyrics({ kind: "track", name: "Song", artistName: "" });
    expect(invokeMock).toHaveBeenCalledWith("get_local_lyrics", {
      title: "Song",
      artistName: null,
      albumName: null,
      path: null,
    });
  });

  it("names each local source distinctly", () => {
    expect(localLyricsProviderName("embedded")).toBe("Embedded in file");
    expect(localLyricsProviderName("sidecar")).toBe("Lyrics file");
    expect(localLyricsProviderName("folder")).toBe("Lyrics folder");
  });
});

describe("saveLocalLyrics", () => {
  beforeEach(() => { invokeMock = vi.fn(); });

  it("names the track, never a destination, and returns what the file now says", async () => {
    // An edit of embedded lyrics comes back from a new sidecar.
    invokeMock.mockResolvedValue({ text: "[00:02]new", kind: "synced", source: "sidecar" });
    const value = await saveLocalLyrics(
      { name: "Jóga", artistName: "Björk", albumTitle: "Homogenic", path: "file:///music/Jóga.flac" },
      "[00:02]new",
    );
    expect(invokeMock).toHaveBeenCalledWith("save_local_lyrics", {
      title: "Jóga",
      artistName: "Björk",
      albumName: "Homogenic",
      path: "file:///music/Jóga.flac",
      text: "[00:02]new",
    });
    expect(value).toEqual({ text: "[00:02]new", kind: "synced", local: true, _meta: { providerName: "Lyrics file" } });
  });

  it("rejects with the backend's reason, so the editor can show it", async () => {
    invokeMock.mockRejectedValue("The track's lyrics file is gone");
    await expect(saveLocalLyrics({ name: "Song" }, "x")).rejects.toBe("The track's lyrics file is gone");
  });
});
