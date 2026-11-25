//! Windows half of the Now Playing integration: the System Media Transport
//! Controls (the media card in the volume / Quick Settings flyout, the lock
//! screen) — which is also what Windows routes the keyboard's media keys to.
//!
//! A desktop (non-UWP) app gets its SMTC instance for a window through
//! `ISystemMediaTransportControlsInterop::GetForWindow`. The WinRT objects are
//! agile, so updates may come from any thread; the instance is kept behind a
//! mutex. Artwork is written into an in-memory stream on the loader thread.

use std::sync::Mutex;

use tauri::AppHandle;
use windows::core::{factory, Ref, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
    SystemMediaTransportControls, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

use super::{artwork, emit, mark_available, MediaControlEvent, NowPlayingInfo};

static SMTC: Mutex<Option<SystemMediaTransportControls>> = Mutex::new(None);

/// 100-nanosecond ticks, WinRT's `TimeSpan` unit.
const TICKS_PER_SEC: f64 = 10_000_000.0;

fn span(secs: f64) -> TimeSpan {
    TimeSpan { Duration: (secs.max(0.0) * TICKS_PER_SEC) as i64 }
}

pub fn install(hwnd: isize, app: AppHandle) {
    match create(hwnd, app) {
        Ok(smtc) => {
            *SMTC.lock().unwrap_or_else(|p| p.into_inner()) = Some(smtc);
            mark_available();
            log::info!("Now Playing: registered with the System Media Transport Controls");
        }
        Err(e) => log::warn!("Now Playing: couldn't set up the media transport controls: {e}"),
    }
}

fn create(hwnd: isize, app: AppHandle) -> windows::core::Result<SystemMediaTransportControls> {
    let interop = factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
    // SAFETY: `hwnd` is the live main window's handle, passed from setup.
    let smtc: SystemMediaTransportControls =
        unsafe { interop.GetForWindow(HWND(hwnd as *mut core::ffi::c_void))? };

    // Stays disabled — no card, keys go elsewhere — until something plays.
    smtc.SetIsEnabled(false)?;
    smtc.SetIsPlayEnabled(true)?;
    smtc.SetIsPauseEnabled(true)?;
    smtc.SetIsStopEnabled(true)?;
    smtc.SetIsNextEnabled(true)?;
    smtc.SetIsPreviousEnabled(true)?;

    let button_app = app.clone();
    smtc.ButtonPressed(&TypedEventHandler::new(
        move |_: Ref<SystemMediaTransportControls>,
              args: Ref<SystemMediaTransportControlsButtonPressedEventArgs>| {
            if let Some(args) = args.as_ref() {
                let event = match args.Button()? {
                    SystemMediaTransportControlsButton::Play => Some(MediaControlEvent::Play),
                    SystemMediaTransportControlsButton::Pause => Some(MediaControlEvent::Pause),
                    SystemMediaTransportControlsButton::Stop => Some(MediaControlEvent::Stop),
                    SystemMediaTransportControlsButton::Next => Some(MediaControlEvent::Next),
                    SystemMediaTransportControlsButton::Previous => Some(MediaControlEvent::Previous),
                    _ => None,
                };
                if let Some(event) = event {
                    emit(&button_app, event);
                }
            }
            Ok(())
        },
    ))?;

    smtc.PlaybackPositionChangeRequested(&TypedEventHandler::new(
        move |_: Ref<SystemMediaTransportControls>,
              args: Ref<PlaybackPositionChangeRequestedEventArgs>| {
            if let Some(args) = args.as_ref() {
                let position_secs = (args.RequestedPlaybackPosition()?.Duration as f64 / TICKS_PER_SEC).max(0.0);
                emit(&app, MediaControlEvent::Seek { position_secs });
            }
            Ok(())
        },
    ))?;

    Ok(smtc)
}

pub fn update(info: Option<NowPlayingInfo>) {
    let guard = SMTC.lock().unwrap_or_else(|p| p.into_inner());
    let Some(smtc) = guard.as_ref() else { return };
    if let Err(e) = apply(smtc, info.as_ref()) {
        log::warn!("Now Playing: couldn't update the media transport controls: {e}");
    }
}

fn apply(smtc: &SystemMediaTransportControls, info: Option<&NowPlayingInfo>) -> windows::core::Result<()> {
    let Some(info) = info else {
        smtc.SetPlaybackStatus(MediaPlaybackStatus::Stopped)?;
        smtc.DisplayUpdater()?.ClearAll()?;
        smtc.SetIsEnabled(false)?;
        return Ok(());
    };
    smtc.SetIsEnabled(true)?;

    let updater = smtc.DisplayUpdater()?;
    let title = HSTRING::from(info.title.as_str());
    let artist = HSTRING::from(info.artist.as_deref().unwrap_or(""));
    if info.video {
        updater.SetType(MediaPlaybackType::Video)?;
        let video = updater.VideoProperties()?;
        video.SetTitle(&title)?;
        video.SetSubtitle(&artist)?;
    } else {
        updater.SetType(MediaPlaybackType::Music)?;
        let music = updater.MusicProperties()?;
        music.SetTitle(&title)?;
        music.SetArtist(&artist)?;
        music.SetAlbumTitle(&HSTRING::from(info.album.as_deref().unwrap_or("")))?;
    }
    updater.Update()?;

    smtc.SetPlaybackStatus(if info.stopped {
        MediaPlaybackStatus::Stopped
    } else if info.playing {
        MediaPlaybackStatus::Playing
    } else {
        MediaPlaybackStatus::Paused
    })?;
    if info.playing && !info.stopped {
        smtc.SetPlaybackRate(info.effective_rate())?;
    }

    let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
    let duration = info.duration_secs.filter(|d| d.is_finite() && *d > 0.0).unwrap_or(0.0);
    timeline.SetStartTime(span(0.0))?;
    timeline.SetMinSeekTime(span(0.0))?;
    timeline.SetEndTime(span(duration))?;
    timeline.SetMaxSeekTime(span(duration))?;
    timeline.SetPosition(span(info.position_secs.min(if duration > 0.0 { duration } else { f64::MAX })))?;
    smtc.UpdateTimelineProperties(&timeline)?;
    Ok(())
}

pub fn set_artwork(generation: u64, bytes: Option<Vec<u8>>) {
    // Built before taking the lock: the stream write waits on an async op.
    let thumbnail = match bytes.map(|b| thumbnail_from_bytes(&b)).transpose() {
        Ok(t) => t,
        Err(e) => {
            log::debug!("Now Playing: unusable artwork: {e}");
            None
        }
    };
    let guard = SMTC.lock().unwrap_or_else(|p| p.into_inner());
    let Some(smtc) = guard.as_ref() else { return };
    // Checked under the SMTC lock: a newer request that already cleared or
    // replaced the cover must not be undone by this one landing late.
    if !artwork::is_current(generation) {
        return;
    }
    let result = (|| -> windows::core::Result<()> {
        let updater = smtc.DisplayUpdater()?;
        updater.SetThumbnail(thumbnail.as_ref())?;
        updater.Update()
    })();
    if let Err(e) = result {
        log::warn!("Now Playing: couldn't set the media artwork: {e}");
    }
}

fn thumbnail_from_bytes(bytes: &[u8]) -> windows::core::Result<RandomAccessStreamReference> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(bytes)?;
    writer.StoreAsync()?.get()?;
    writer.FlushAsync()?.get()?;
    // Keep the stream open when the writer goes away.
    writer.DetachStream()?;
    stream.Seek(0)?;
    RandomAccessStreamReference::CreateFromStream(&stream)
}
