//! The operating system's "Now Playing" entry and the media keys that go with it.
//!
//! macOS: `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` (Control Center,
//! the menu-bar widget, the lock screen, F7–F9, AirPods / headset buttons).
//! Windows: System Media Transport Controls (the volume flyout's media card,
//! the lock screen, the keyboard media keys).
//!
//! Why this lives in Rust: the webview's `navigator.mediaSession` only reaches
//! the OS while an HTML `<audio>`/`<video>` element is playing, and playback is
//! libmpv-only — so the old mediaSession code published nothing and the system
//! never considered Vibo the playing app. The OS also routes the media keys to
//! whichever app it considers Now Playing, which is why registering them as
//! global shortcuts (an Accessibility-gated event tap on macOS) was not enough.
//!
//! Direction of travel:
//! - frontend → `set_now_playing` whenever the track, play state, duration,
//!   artwork or a position jump changes (the OS extrapolates the position from
//!   the last update while playing, so ticks are not forwarded);
//! - OS → the `media-control` event (`MediaControlEvent`), which the frontend
//!   maps to its canonical handlers (pause toggle, next, previous, stop, seek).
//!
//! Linux has no implementation (MPRIS would be its counterpart); the frontend
//! keeps the global media-key shortcuts there.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod win;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingInfo {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Unknown (a stream before the engine reports it) → no duration / no
    /// scrubber in the OS surface.
    pub duration_secs: Option<f64>,
    pub position_secs: f64,
    pub playing: bool,
    /// Stopped (the track is still loaded, cued) rather than paused.
    #[serde(default)]
    pub stopped: bool,
    /// Playback speed (the engine's `speed`), so the OS clock advances at it.
    #[serde(default = "default_rate")]
    pub rate: f64,
    pub video: bool,
    /// Raw image source: a local path (optionally `file://`, optionally with a
    /// `#v=N` cache-buster), an `http(s)` URL or a `data:` URI. Never a
    /// webview `asset:` URL — the backend reads it itself.
    pub artwork: Option<String>,
}

fn default_rate() -> f64 {
    1.0
}

impl NowPlayingInfo {
    /// The rate the OS should advance its clock at: 0 unless playing, and a
    /// sane positive speed when it is.
    pub(crate) fn effective_rate(&self) -> f64 {
        if !self.playing || self.stopped {
            0.0
        } else if self.rate.is_finite() && self.rate > 0.0 {
            self.rate
        } else {
            1.0
        }
    }
}

/// Whether the native integration registered with the OS. The frontend keeps
/// the global media-key shortcuts as a fallback when it didn't.
static AVAILABLE: AtomicBool = AtomicBool::new(false);

pub(crate) fn mark_available() {
    AVAILABLE.store(true, Ordering::Relaxed);
}

/// Does the OS deliver media keys / Now Playing commands to us natively?
#[tauri::command]
pub fn now_playing_available() -> bool {
    AVAILABLE.load(Ordering::Relaxed)
}

/// What the OS asked for. Emitted to the frontend as `media-control`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum MediaControlEvent {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Stop,
    #[serde(rename_all = "camelCase")]
    Seek { position_secs: f64 },
}

pub(crate) fn emit(app: &AppHandle, event: MediaControlEvent) {
    log::debug!("Media control from the OS: {event:?}");
    if let Err(e) = app.emit("media-control", event) {
        log::warn!("Failed to emit media-control: {e}");
    }
}

/// Register with the OS. Called once from `setup` on the main thread.
#[allow(unused_variables)]
pub fn install(app: &AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    macos::install(app.clone());
    #[cfg(target_os = "windows")]
    match window.hwnd() {
        Ok(hwnd) => win::install(hwnd.0 as isize, app.clone()),
        Err(e) => log::warn!("Now Playing: no window handle for the media controls: {e}"),
    }
}

/// Publish (or clear, with `None`) what is playing.
#[tauri::command]
pub fn set_now_playing(app: AppHandle, info: Option<NowPlayingInfo>) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let artwork = info.as_ref().and_then(|i| i.artwork.clone());
        artwork::request(&app, artwork);
        #[cfg(target_os = "macos")]
        macos::update(&app, info);
        #[cfg(target_os = "windows")]
        win::update(info);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, info);
    }
}

/// Artwork is read off the calling thread (a cover can be an `http` URL) and
/// handed to the platform once loaded — unless a newer request superseded it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod artwork {
    use std::sync::Mutex;
    use std::time::Duration;

    use base64::Engine;
    use tauri::AppHandle;

    /// Covers bigger than this are not worth holding for a thumbnail.
    const MAX_BYTES: usize = 16 * 1024 * 1024;

    struct State {
        /// The source the OS currently shows or is being loaded.
        current: Option<String>,
        generation: u64,
    }

    static STATE: Mutex<State> = Mutex::new(State { current: None, generation: 0 });

    pub fn request(app: &AppHandle, source: Option<String>) {
        let generation = {
            let mut st = STATE.lock().unwrap_or_else(|p| p.into_inner());
            if st.current == source {
                return;
            }
            st.current = source.clone();
            st.generation += 1;
            st.generation
        };
        let Some(source) = source else {
            apply(app, generation, None);
            return;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            let bytes = match load(&source) {
                Ok(b) => Some(b),
                Err(e) => {
                    log::debug!("Now Playing: no artwork from {source}: {e}");
                    None
                }
            };
            if is_current(generation) {
                apply(&app, generation, bytes);
            }
        });
    }

    /// Whether `generation` is still the newest request. The platforms check
    /// this again at the moment they install the cover (inside the main-thread
    /// closure / under the SMTC lock): a check here alone leaves a window in
    /// which a newer request can land first and the stale cover after it.
    pub fn is_current(generation: u64) -> bool {
        STATE.lock().unwrap_or_else(|p| p.into_inner()).generation == generation
    }

    fn apply(app: &AppHandle, generation: u64, bytes: Option<Vec<u8>>) {
        #[cfg(target_os = "macos")]
        super::macos::set_artwork(app, generation, bytes);
        #[cfg(target_os = "windows")]
        {
            let _ = app;
            super::win::set_artwork(generation, bytes);
        }
    }

    fn load(source: &str) -> Result<Vec<u8>, String> {
        let bytes = if source.starts_with("http://") || source.starts_with("https://") {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client.get(source).send().map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            resp.bytes().map_err(|e| e.to_string())?.to_vec()
        } else if let Some(rest) = source.strip_prefix("data:") {
            let (_, payload) = rest.split_once(";base64,").ok_or("not a base64 data URI")?;
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .map_err(|e| e.to_string())?
        } else {
            let path = source.strip_prefix("file://").unwrap_or(source);
            let path = path.split_once("#v=").map_or(path, |(p, _)| p);
            std::fs::read(path).map_err(|e| e.to_string())?
        };
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(format!("unusable size ({} bytes)", bytes.len()));
        }
        Ok(bytes)
    }
}
