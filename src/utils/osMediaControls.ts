// Pure helpers for the OS Now Playing integration (hooks/useOsMediaControls.ts,
// backend now_playing/). Kept apart so the resync rule is assertable.

/** What the OS was last told about the position. */
export interface PositionReport {
  positionSecs: number;
  /** `performance.now()`-style ms when it was sent. */
  atMs: number;
  playing: boolean;
  /** Playback speed the OS advances its clock at while playing. */
  rate: number;
}

/** A position the OS extrapolation is this far off from is re-sent (a seek,
 *  a stall, a non-1x speed). Below it, the OS's own clock is close enough. */
export const POSITION_DRIFT_SECS = 2;

/** While playing, the position is re-sent at least this often anyway: Windows'
 *  media card doesn't advance its timeline on its own the way macOS does. */
export const POSITION_REFRESH_MS = 10_000;

/** Where the OS believes playback is now, given what it was last told. */
export function expectedOsPosition(last: PositionReport, nowMs: number): number {
  if (!last.playing) return last.positionSecs;
  const rate = Number.isFinite(last.rate) && last.rate > 0 ? last.rate : 1;
  return last.positionSecs + (Math.max(0, nowMs - last.atMs) / 1000) * rate;
}

/** Whether a live position tick should be forwarded to the OS. */
export function needsPositionResync(last: PositionReport | null, positionSecs: number, nowMs: number): boolean {
  if (!last) return true;
  if (Math.abs(positionSecs - expectedOsPosition(last, nowMs)) > POSITION_DRIFT_SECS) return true;
  return last.playing && nowMs - last.atMs >= POSITION_REFRESH_MS;
}

/** A command from the OS (the backend's `media-control` event). */
export type MediaControlEvent =
  | { action: "play" | "pause" | "toggle" | "next" | "previous" | "stop" }
  | { action: "seek"; positionSecs: number };

export interface MediaControlActions {
  playing: boolean;
  /** The player's one play/pause toggle. */
  togglePlayPause: () => void;
  next: () => void;
  previous: () => void;
  stop: () => void;
  seek: (secs: number) => void;
}

/** Map an OS command onto the player. `play` / `pause` are explicit states
 *  (a headset's pause must not start playback), so they go through the toggle
 *  only when it moves the player the asked-for way. */
export function dispatchMediaControl(event: MediaControlEvent, a: MediaControlActions): void {
  switch (event.action) {
    case "play":
      if (!a.playing) a.togglePlayPause();
      return;
    case "pause":
      if (a.playing) a.togglePlayPause();
      return;
    case "toggle":
      a.togglePlayPause();
      return;
    case "next":
      a.next();
      return;
    case "previous":
      a.previous();
      return;
    case "stop":
      a.stop();
      return;
    case "seek":
      if (Number.isFinite(event.positionSecs)) a.seek(Math.max(0, event.positionSecs));
      return;
  }
}
