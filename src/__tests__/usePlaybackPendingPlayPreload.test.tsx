import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { QueueTrack, ResolvedTrackSource, EngineSource } from "../types";

// Starting a new list while the old song is in its last 45s: the old session
// keeps ticking while the new play resolves, and `peekNext()` already answers
// for the NEW queue. The progress machine used to pre-resolve the new list's
// second entry alongside its first (two yt-dlp walks, two "Trying yt-dlp…"
// rows). These pin that a pending play silences the outgoing session's ticks.

const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../store", () => ({
  store: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../telemetry", () => ({ track: vi.fn(), sourceClass: () => "local" }));
vi.mock("../utils/tauriEvents", () => ({
  subscribe: (name: string, fn: (e: { payload: unknown }) => void) => { handlers.set(name, fn); return () => {}; },
  combineUnlisten: () => () => {},
}));
vi.mock("../playback/nativeEngine", () => ({
  nativeEngine: new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get(target, prop: string) {
      if (!target[prop]) target[prop] = vi.fn().mockResolvedValue(undefined);
      return target[prop];
    },
  }),
}));

import { usePlayback } from "../hooks/usePlayback";

const old: QueueTrack = {
  key: "q:1", path: "file:///music/old.flac", title: "Old", artist_name: "A",
  album_title: null, duration_secs: 200, format: "flac",
};
const head: QueueTrack = {
  key: "q:2", path: null, title: "Wrong Way", artist_name: "Sublime",
  album_title: null, duration_secs: 136, format: null,
};
const second: QueueTrack = {
  key: "q:3", path: null, title: "Could You Be Loved", artist_name: "Bob Marley",
  album_title: null, duration_secs: 237, format: null,
};

const resolvedFor = (t: QueueTrack): ResolvedTrackSource => ({
  src: `asset://${t.key}`,
  engineSource: { kind: "http", url: `https://example.test/${t.key}` } as EngineSource,
}) as ResolvedTrackSource;

function ref<T>(current: T) {
  return { current };
}

function mount() {
  const waiting: Array<(r: ResolvedTrackSource) => void> = [];
  const resolve = vi.fn((t: QueueTrack, _opts?: { preload?: boolean }) =>
    t.key === old.key
      ? Promise.resolve(resolvedFor(t))
      : new Promise<ResolvedTrackSource>((r) => { waiting.push(r); }));
  const next = ref<() => QueueTrack | null>(() => null);
  const hook = renderHook(() =>
    usePlayback(
      ref(true), next, ref(0), ref(() => {}), ref(() => false), ref(resolve),
      ref(() => {}), ref(true), ref(true), ref(() => {}), ref(null),
    ),
  );
  const finish = (t: QueueTrack) => waiting.splice(0).forEach((r) => r(resolvedFor(t)));
  const tick = (positionSecs: number) =>
    handlers.get("engine-position")!({ payload: { trackKey: old.key, positionSecs, durationSecs: 200 } });
  return { ...hook, resolve, next, finish, tick };
}

const preloads = (resolve: ReturnType<typeof vi.fn>) =>
  resolve.mock.calls.filter((c) => c[1]?.preload).map((c) => (c[0] as QueueTrack).key);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePlayback: the outgoing session while a new play resolves", () => {
  it("doesn't pre-resolve the new queue's second entry", async () => {
    const { result, resolve, next, finish, tick } = mount();
    await act(async () => { await result.current.handlePlay(old); });

    // A new list replaces the queue: its head is resolving, its 2nd is "next".
    next.current = () => second;
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.handlePlay(head); });

    act(() => { tick(170); tick(171); });
    expect(preloads(resolve)).toEqual([]);

    await act(async () => { finish(head); await pending; });
  });

  it("still preloads in the lead window when no play is pending", async () => {
    const { result, resolve, next, tick } = mount();
    await act(async () => { await result.current.handlePlay(old); });
    next.current = () => second;
    act(() => { tick(170); });
    expect(preloads(resolve)).toEqual(["q:3"]);
  });
});
