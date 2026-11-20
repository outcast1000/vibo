// startRadio when neither the seed nor its artist is in the library: the
// station comes from library tracks matching the providers' hints, played as
// a switch (the current song keeps playing until the station lands).
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { usePlayActions } from "../hooks/usePlayActions";
import type { Track, QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import type { RadioHints } from "../utils/radioHints";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("../telemetry", () => ({ track: vi.fn() }));
const gatherRadioHints = vi.fn<() => Promise<RadioHints>>();
vi.mock("../utils/radioHints", async (orig) => ({
  ...(await orig<typeof import("../utils/radioHints")>()),
  gatherRadioHints: () => gatherRadioHints(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function libTrack(id: number, title: string): Track {
  return {
    id, path: `file:///${title}.flac`, title, artist_id: 7, artist_name: "Gnoomes",
    album_id: 3, album_title: "Ngan!", year: null, track_number: null, duration_secs: 200,
    format: "flac", file_size: 1, collection_id: 1, collection_name: "Music", liked: 0,
    added_at: null, modified_at: null,
  };
}

function mount(fromHints: Track[] | Error, opts: { live?: boolean } = {}) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "build_radio_station") return { seedInLibrary: false, tracks: [] };
    if (cmd === "build_radio_from_hints") {
      if (fromHints instanceof Error) throw fromHints;
      return fromHints;
    }
    return null;
  });
  const playTracks = vi.fn((_tracks: Array<Track | QueueTrack>, _index: number, _context?: PlaylistContext | null) => 1);
  const beginLoadingPlay = vi.fn((info: object) => ({ ...info, gen: 1, startedAt: 0 }));
  const notify = vi.fn();
  const { result } = renderHook(() => usePlayActions({
    playTracks,
    enqueueTracks: vi.fn(),
    appendToPlaySession: vi.fn(() => null),
    beginLoadingPlay: beginLoadingPlay as never,
    isLoadingPlayLive: vi.fn(() => opts.live ?? true),
    endLoadingPlay: vi.fn(),
    setPlaylistContext: vi.fn(),
    albums: [], artists: [], tags: [],
    getAlbumImage: () => null, getArtistImage: () => null, getTagImage: () => null,
    notify,
    radioOptions: { artistShare: 50, taste: "mixed", spreadArtists: false },
    invokeInfoFetch: vi.fn(),
  }));
  return { startRadio: result.current.startRadio, playTracks, beginLoadingPlay, notify };
}

const seed = { title: "Nimerudi", artistName: "Goat, MC Yallah", coverPath: null };
const hints: RadioHints = { seedArtists: ["Goat", "MC Yallah"], similarArtists: ["Gnoomes"], tags: ["psychedelic"] };

describe("startRadio from hints", () => {
  it("builds the station from the hints and opens it with the seed, as a switch", async () => {
    gatherRadioHints.mockResolvedValue(hints);
    const station = Array.from({ length: 12 }, (_, i) => libTrack(i + 1, `T${i}`));
    const { startRadio, playTracks, beginLoadingPlay, notify } = mount(station);

    expect(await startRadio(seed)).toBe(13);
    expect(beginLoadingPlay).toHaveBeenCalledWith(expect.objectContaining({ mode: "switch", name: "Radio: Nimerudi" }));
    const queue = playTracks.mock.calls[0][0] as QueueTrack[];
    expect(queue[0]).toMatchObject({ title: "Nimerudi", artist_name: "Goat, MC Yallah", path: null });
    expect(queue[1].libraryId).toBe(1);
    expect(playTracks.mock.calls[0][2]).toMatchObject({ name: "Radio: Nimerudi", source: "radio" });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("build_radio_from_hints", expect.objectContaining({
      seedArtists: ["Goat", "MC Yallah"], similarArtists: ["Gnoomes"], tags: ["psychedelic"], targetCount: 29,
    }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns and leaves the queue alone when nothing in the library matches", async () => {
    gatherRadioHints.mockResolvedValue(hints);
    const { startRadio, playTracks, notify } = mount([]);
    expect(await startRadio(seed)).toBeNull();
    expect(playTracks).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("nothing like \"Nimerudi\""), { kind: "warning" });
  });

  it("doesn't ask the backend when the providers knew nothing", async () => {
    gatherRadioHints.mockResolvedValue({ seedArtists: [], similarArtists: [], tags: [] });
    const { startRadio, notify } = mount([]);
    expect(await startRadio(seed)).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("build_radio_from_hints", expect.anything());
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("nothing like"), { kind: "warning" });
  });

  it("reports a failed build as an error", async () => {
    gatherRadioHints.mockResolvedValue(hints);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { startRadio, playTracks, notify } = mount(new Error("db"));
    expect(await startRadio(seed)).toBeNull();
    expect(playTracks).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Failed to start radio.", { kind: "error" });
  });

  it("says nothing when the station was cancelled before it found nothing or failed", async () => {
    // Cancelling is not a failure (conventions.md "Play With Backfill").
    gatherRadioHints.mockResolvedValue(hints);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const answer of [[], new Error("db")]) {
      const { startRadio, playTracks, notify } = mount(answer, { live: false });
      expect(await startRadio(seed)).toBeNull();
      expect(playTracks).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
