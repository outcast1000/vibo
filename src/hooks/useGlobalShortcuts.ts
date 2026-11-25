import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";

import { useAssignRef } from "./useLatestRef";
interface GlobalShortcutActions {
  togglePlayPause: () => void;
  playNext: () => void;
  playPrevious: () => void;
  stop: () => void;
}

/** macOS and Windows deliver the media keys through the OS Now Playing
 *  integration instead (`useOsMediaControls`, backend `now_playing/`): the OS
 *  routes them to the app it considers Now Playing. Registering them here too
 *  would fire twice where it works at all — on macOS it is an event tap that
 *  needs Accessibility permission, and on Windows a hotkey that would grab
 *  the keys from every other player even while Vibo is idle. So these are
 *  registered only when the backend says the native integration isn't there:
 *  always on Linux (no MPRIS integration), and on macOS / Windows only if
 *  registering with the OS failed. */
async function osOwnsMediaKeys(): Promise<boolean> {
  try {
    return await invoke<boolean>("now_playing_available");
  } catch (e) {
    console.error("Failed to ask whether the OS media controls are available:", e);
    return false;
  }
}

export function useGlobalShortcuts(actions: GlobalShortcutActions) {
  const actionsRef = useRef(actions);
  useAssignRef(actionsRef, actions);

  useEffect(() => {
    let mounted = true;

    async function registerShortcuts() {
      if (await osOwnsMediaKeys()) return;
      if (!mounted) return;
      try {
        await register("MediaPlayPause", () => { if (mounted) actionsRef.current.togglePlayPause(); });
        await register("MediaTrackNext", () => { if (mounted) actionsRef.current.playNext(); });
        await register("MediaTrackPrevious", () => { if (mounted) actionsRef.current.playPrevious(); });
        await register("MediaStop", () => { if (mounted) actionsRef.current.stop(); });
      } catch (e) {
        console.error("Failed to register global media-key shortcuts:", e);
      }
    }

    registerShortcuts();

    return () => {
      mounted = false;
      unregisterAll().catch(console.error);
    };
  }, []);
}
