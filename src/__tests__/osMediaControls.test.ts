import { describe, it, expect, vi } from "vitest";
import {
  dispatchMediaControl,
  expectedOsPosition,
  needsPositionResync,
  POSITION_DRIFT_SECS,
  POSITION_REFRESH_MS,
  type MediaControlActions,
} from "../utils/osMediaControls";

function actions(playing: boolean): MediaControlActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    playing,
    togglePlayPause: vi.fn(() => calls.push("toggle")),
    next: vi.fn(() => calls.push("next")),
    previous: vi.fn(() => calls.push("previous")),
    stop: vi.fn(() => calls.push("stop")),
    seek: vi.fn((s: number) => calls.push(`seek:${s}`)),
  };
}

describe("dispatchMediaControl", () => {
  it("play only starts a paused player, pause only stops a playing one", () => {
    const paused = actions(false);
    dispatchMediaControl({ action: "pause" }, paused);
    dispatchMediaControl({ action: "play" }, paused);
    expect(paused.calls).toEqual(["toggle"]);

    const playing = actions(true);
    dispatchMediaControl({ action: "play" }, playing);
    dispatchMediaControl({ action: "pause" }, playing);
    expect(playing.calls).toEqual(["toggle"]);
  });

  it("toggle always toggles, the rest map one-to-one", () => {
    const a = actions(true);
    dispatchMediaControl({ action: "toggle" }, a);
    dispatchMediaControl({ action: "next" }, a);
    dispatchMediaControl({ action: "previous" }, a);
    dispatchMediaControl({ action: "stop" }, a);
    expect(a.calls).toEqual(["toggle", "next", "previous", "stop"]);
  });

  it("seeks clamp below zero and ignore a non-number", () => {
    const a = actions(true);
    dispatchMediaControl({ action: "seek", positionSecs: -3 }, a);
    dispatchMediaControl({ action: "seek", positionSecs: Number.NaN }, a);
    dispatchMediaControl({ action: "seek", positionSecs: 42.5 }, a);
    expect(a.calls).toEqual(["seek:0", "seek:42.5"]);
  });
});

describe("position resync", () => {
  const last = { positionSecs: 10, atMs: 1_000, playing: true, rate: 1 };

  it("extrapolates while playing and holds while paused", () => {
    expect(expectedOsPosition(last, 4_000)).toBe(13);
    expect(expectedOsPosition({ ...last, playing: false }, 4_000)).toBe(10);
  });

  it("advances at the playback speed, so a non-1x play doesn't read as drift", () => {
    const fast = { ...last, rate: 1.35 };
    expect(expectedOsPosition(fast, 3_000)).toBeCloseTo(12.7);
    expect(needsPositionResync(fast, 10 + 6 * 1.35, 7_000)).toBe(false);
    // Assuming 1x, the same play drifts past the allowance within 6s — the
    // repeated resend (and jumping scrubber) this rule avoids.
    expect(needsPositionResync(last, 10 + 6 * 1.35, 7_000)).toBe(true);
  });

  it("sends the first report and any jump past the drift allowance", () => {
    expect(needsPositionResync(null, 0, 0)).toBe(true);
    expect(needsPositionResync(last, 13.5, 4_000)).toBe(false);
    expect(needsPositionResync(last, 13 + POSITION_DRIFT_SECS + 0.1, 4_000)).toBe(true);
    expect(needsPositionResync(last, 60, 2_000)).toBe(true);
  });

  it("refreshes a playing position periodically, never a paused one", () => {
    const at = last.atMs + POSITION_REFRESH_MS;
    expect(needsPositionResync(last, 10 + POSITION_REFRESH_MS / 1000, at)).toBe(true);
    expect(needsPositionResync({ ...last, playing: false }, 10, at + 60_000)).toBe(false);
  });
});
