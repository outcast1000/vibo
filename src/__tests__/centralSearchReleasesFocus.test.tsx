// Picking a result from Cmd+K used to leave focus in the search input. The
// global shortcut handler treats a focused text field as typing, so Space and
// the arrow keys (pause, seek, volume) went dead on the very track the user had
// just started. The hook now reports `onDone` whenever the search is finished
// with, and App blurs the input there.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type React from "react";

const invoke = vi.fn(async () => ({ artists: [], albums: [], tracks: [] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...(args as [])),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { useCentralSearch } from "../hooks/useCentralSearch";
import type { Track } from "../types";

function setup() {
  const onDone = vi.fn();
  const onPlayTrack = vi.fn();
  const onCommitSearch = vi.fn();
  const hook = renderHook(() =>
    useCentralSearch({
      onDone,
      onPlayTrack,
      onEnqueueTrack: vi.fn(),
      onCommitSearch,
      onNavigateToArtist: vi.fn(),
      onNavigateToAlbum: vi.fn(),
      searchProviders: [],
      runProviderSearch: vi.fn(),
      onPlayPluginTrack: vi.fn(),
      onEnqueuePluginTrack: vi.fn(),
      onOpenPluginAlbum: vi.fn(),
      onOpenPluginArtist: vi.fn(),
    }),
  );
  return { hook, onDone, onPlayTrack, onCommitSearch };
}

function key(k: string): React.KeyboardEvent {
  return { key: k, metaKey: false, ctrlKey: false, preventDefault: () => {} } as unknown as React.KeyboardEvent;
}

afterEach(cleanup);

describe("central search hands the keyboard back", () => {
  it("after a track is played from the results", () => {
    const { hook, onDone, onPlayTrack } = setup();
    const track = { id: 7, title: "Song" } as Track;
    act(() => hook.result.current.handleResultClick({ kind: "track", data: track }));
    expect(onPlayTrack).toHaveBeenCalledWith(track);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("after Enter commits the search", () => {
    const { hook, onDone, onCommitSearch } = setup();
    act(() => hook.result.current.setQuery("abba"));
    act(() => hook.result.current.handleKeyDown(key("Enter")));
    expect(onCommitSearch).toHaveBeenCalledWith("abba");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("on Escape, even with nothing typed", () => {
    const { hook, onDone } = setup();
    act(() => hook.result.current.handleKeyDown(key("Escape")));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("not while the user is still moving through the results", () => {
    const { hook, onDone } = setup();
    act(() => hook.result.current.setQuery("abba"));
    act(() => hook.result.current.handleKeyDown(key("ArrowDown")));
    expect(onDone).not.toHaveBeenCalled();
  });
});
