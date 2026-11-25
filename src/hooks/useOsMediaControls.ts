import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { QueueTrack } from "../types";
import { getPlaybackPosition, subscribePlaybackPosition } from "../playback/positionStore";
import { subscribe } from "../utils/tauriEvents";
import {
  dispatchMediaControl,
  needsPositionResync,
  type MediaControlActions,
  type MediaControlEvent,
  type PositionReport,
} from "../utils/osMediaControls";
import { useLatestRef } from "./useLatestRef";

interface OsMediaControlsInput {
  track: QueueTrack | null;
  playing: boolean;
  /** Stopped (track still loaded and cued), as opposed to paused. */
  stopped: boolean;
  /** Playback speed — the OS advances its clock at it. */
  rate: number;
  durationSecs: number;
  video: boolean;
  /** Raw image source (path / http URL / data URI) — never a webview URL;
   *  the backend reads it itself. */
  artwork: string | null;
  actions: Omit<MediaControlActions, "playing">;
}

/** How long a toggle we just issued counts as the player's state before the
 *  render that reflects it has arrived. */
const OPTIMISTIC_TOGGLE_MS = 1000;

/**
 * The OS "Now Playing" entry and its media keys (backend `now_playing/`):
 * Control Center / the menu-bar widget / F7–F9 / headset buttons on macOS,
 * the media flyout and keyboard media keys on Windows.
 *
 * Publishes on every change of track, play state, duration or artwork, and a
 * position only when the OS's own extrapolation would be off (a seek, a
 * stall) — the 4 Hz ticks are not forwarded. Commands from the OS arrive as
 * `media-control` and go to the player's canonical handlers.
 */
export function useOsMediaControls({ track, playing, stopped, rate, durationSecs, video, artwork, actions }: OsMediaControlsInput) {
  const lastReportRef = useRef<PositionReport | null>(null);
  const infoRef = useRef<Record<string, unknown> | null>(null);

  // Reads only refs, so it is stable.
  const send = useCallback((positionSecs: number) => {
    const info = infoRef.current;
    if (!info) return;
    lastReportRef.current = {
      positionSecs,
      atMs: performance.now(),
      playing: Boolean(info.playing) && !info.stopped,
      rate: typeof info.rate === "number" ? info.rate : 1,
    };
    invoke("set_now_playing", { info: { ...info, positionSecs } })
      .catch((e) => console.error("Failed to update Now Playing:", e));
  }, []);

  const title = track?.title ?? null;
  const artist = track?.artist_name ?? null;
  const album = track?.album_title ?? null;
  const duration = durationSecs > 0 ? durationSecs : track?.duration_secs ?? null;

  useEffect(() => {
    if (title === null) {
      infoRef.current = null;
      lastReportRef.current = null;
      invoke("set_now_playing", { info: null }).catch((e) => console.error("Failed to clear Now Playing:", e));
      return;
    }
    infoRef.current = { title, artist, album, durationSecs: duration, playing, stopped, rate, video, artwork };
    send(getPlaybackPosition());
  }, [title, artist, album, duration, playing, stopped, rate, video, artwork, send]);

  useEffect(() => subscribePlaybackPosition(() => {
    if (!infoRef.current) return;
    const position = getPlaybackPosition();
    if (needsPositionResync(lastReportRef.current, position, performance.now())) send(position);
  }), [send]);

  // `playing` only refreshes on render, so two OS commands inside one frame (a
  // headset's pause then play) would both read the old value and one would be
  // lost. A toggle we issue counts as the new state until the render that
  // reflects it — or, if the toggle changed nothing, until it expires.
  const latest = useLatestRef({ ...actions, playing });
  const optimisticRef = useRef<{ playing: boolean; untilMs: number } | null>(null);
  useEffect(() => {
    optimisticRef.current = null;
  }, [playing]);
  useEffect(() => subscribe<MediaControlEvent>("media-control", ({ payload }) => {
    const a = latest.current;
    const now = performance.now();
    const optimistic = optimisticRef.current;
    const playingNow = optimistic && now < optimistic.untilMs ? optimistic.playing : a.playing;
    dispatchMediaControl(payload, {
      ...a,
      playing: playingNow,
      togglePlayPause: () => {
        a.togglePlayPause();
        optimisticRef.current = { playing: !playingNow, untilMs: performance.now() + OPTIMISTIC_TOGGLE_MS };
      },
    });
  }), [latest]);
}
