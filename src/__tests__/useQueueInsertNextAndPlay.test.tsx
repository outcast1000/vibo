// insertNextAndPlay is what a viboplr://play link runs (utils/appLinks.ts):
// any web page can fire one, so it must start the song without taking the
// user's queue away — insert after the playing entry, never replace.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useQueue } from "../hooks/useQueue";
import type { QueueTrack, Track } from "../types";
import { useRef } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: () => () => {},
  combineUnlisten: (...fns: Array<() => void>) => () => fns.forEach((f) => f()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local", bucketCount: () => "0" }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeTrack(n: number): QueueTrack {
  return {
    key: `q:${n}`,
    path: `file:///song-${n}.mp3`,
    title: `Song ${n}`,
    artist_name: "Artist",
    album_title: "Album",
    duration_secs: 100,
    format: "mp3",
  };
}

function mountQueue() {
  const handlePlay = vi.fn();
  const hook = renderHook(() => {
    const restoredRef = useRef(true);
    return useQueue(restoredRef, handlePlay);
  });
  return { ...hook, handlePlay };
}

describe("insertNextAndPlay", () => {
  it("inserts after the playing entry, keeps the rest, and plays it", () => {
    const { result, handlePlay } = mountQueue();
    act(() => { result.current.playTracks([makeTrack(1), makeTrack(2), makeTrack(3)], 1); });
    handlePlay.mockClear();

    let inserted: QueueTrack | undefined;
    act(() => { inserted = result.current.insertNextAndPlay(makeTrack(9)); });

    expect(result.current.queue.map((t) => t.title)).toEqual(["Song 1", "Song 2", "Song 9", "Song 3"]);
    expect(result.current.queueIndex).toBe(2);
    expect(handlePlay).toHaveBeenCalledTimes(1);
    expect(handlePlay.mock.calls[0][0]).toBe(inserted);
  });

  it("starts an empty queue at index 0", () => {
    const { result, handlePlay } = mountQueue();
    act(() => { result.current.insertNextAndPlay(makeTrack(9)); });
    expect(result.current.queue.map((t) => t.title)).toEqual(["Song 9"]);
    expect(result.current.queueIndex).toBe(0);
    expect(handlePlay).toHaveBeenCalledTimes(1);
  });
});

// Edit Properties' Sync "Play this song": start the edited library track
// without doubling it in the queue.
describe("playLibraryTrackInQueue", () => {
  const libTrack = (id: number) => ({ ...makeTrack(id), id, key: undefined }) as unknown as Track;
  const queued = (n: number, libraryId?: number): QueueTrack => ({ ...makeTrack(n), libraryId });

  it("jumps to a copy already queued after the playing entry", () => {
    const { result, handlePlay } = mountQueue();
    act(() => { result.current.playTracks([queued(1), queued(2, 7), queued(3), queued(4, 7)], 2); });
    handlePlay.mockClear();

    act(() => { result.current.playLibraryTrackInQueue(libTrack(7)); });

    expect(result.current.queue).toHaveLength(4);
    expect(result.current.queueIndex).toBe(3);
    expect(handlePlay).toHaveBeenCalledWith(result.current.queue[3], "user");
  });

  it("falls back to an earlier copy, and inserts when there is none", () => {
    const { result, handlePlay } = mountQueue();
    act(() => { result.current.playTracks([queued(1, 7), queued(2)], 1); });
    act(() => { result.current.playLibraryTrackInQueue(libTrack(7)); });
    expect(result.current.queue).toHaveLength(2);
    expect(result.current.queueIndex).toBe(0);

    handlePlay.mockClear();
    act(() => { result.current.playLibraryTrackInQueue(libTrack(8)); });
    expect(result.current.queue.map((t) => t.libraryId)).toEqual([7, 8, undefined]);
    expect(result.current.queueIndex).toBe(1);
    expect(handlePlay).toHaveBeenCalledTimes(1);
  });
});
