//! macOS half of the Now Playing integration: `MPNowPlayingInfoCenter` (what
//! Control Center / the menu-bar widget / the lock screen show) and
//! `MPRemoteCommandCenter` (play, pause, next, previous, scrubbing — from those
//! surfaces, the F7–F9 keys and headset buttons).
//!
//! macOS routes the media keys to whichever app it considers "Now Playing", and
//! an app becomes that by registering remote commands and publishing
//! `nowPlayingInfo` + `playbackState`. No Accessibility permission is involved.
//!
//! All MediaPlayer calls run on the main thread (`run_on_main_thread`); the
//! state they need lives in a main-thread `thread_local!`.

use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_app_kit::NSImage;
use objc2_foundation::{NSData, NSMutableDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle,
    MPMediaItemPropertyArtist, MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration,
    MPMediaItemPropertyTitle, MPNowPlayingInfoCenter, MPNowPlayingInfoMediaType,
    MPNowPlayingInfoPropertyDefaultPlaybackRate, MPNowPlayingInfoPropertyElapsedPlaybackTime,
    MPNowPlayingInfoPropertyMediaType,
    MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommand,
    MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
};
use tauri::AppHandle;

use super::{artwork, emit, mark_available, MediaControlEvent, NowPlayingInfo};

#[derive(Default)]
struct State {
    info: Option<NowPlayingInfo>,
    artwork: Option<Retained<MPMediaItemArtwork>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn on_main(app: &AppHandle, f: impl FnOnce() + Send + 'static) {
    if let Err(e) = app.run_on_main_thread(f) {
        log::warn!("Now Playing: couldn't reach the main thread: {e}");
    }
}

/// Register the remote commands. Called from `setup`, on the main thread.
pub fn install(app: AppHandle) {
    // SAFETY: MediaPlayer is used on the main thread (setup runs there); the
    // handler blocks are 'static and only clone an AppHandle.
    unsafe {
        let center = MPRemoteCommandCenter::sharedCommandCenter();
        let simple: [(Retained<MPRemoteCommand>, MediaControlEvent); 6] = [
            (center.playCommand(), MediaControlEvent::Play),
            (center.pauseCommand(), MediaControlEvent::Pause),
            (center.togglePlayPauseCommand(), MediaControlEvent::Toggle),
            (center.nextTrackCommand(), MediaControlEvent::Next),
            (center.previousTrackCommand(), MediaControlEvent::Previous),
            (center.stopCommand(), MediaControlEvent::Stop),
        ];
        for (command, event) in simple {
            let app = app.clone();
            let handler = RcBlock::new(move |_ev: NonNull<MPRemoteCommandEvent>| {
                emit(&app, event);
                MPRemoteCommandHandlerStatus::Success
            });
            command.setEnabled(true);
            // The center retains the target it hands back.
            let _target = command.addTargetWithHandler(&handler);
        }

        let seek = center.changePlaybackPositionCommand();
        let seek_app = app.clone();
        let handler = RcBlock::new(move |ev: NonNull<MPRemoteCommandEvent>| {
            let ev: &AnyObject = ev.as_ref();
            match ev.downcast_ref::<MPChangePlaybackPositionCommandEvent>() {
                Some(pos) => {
                    let position_secs = pos.positionTime().max(0.0);
                    emit(&seek_app, MediaControlEvent::Seek { position_secs });
                    MPRemoteCommandHandlerStatus::Success
                }
                None => MPRemoteCommandHandlerStatus::CommandFailed,
            }
        });
        seek.setEnabled(true);
        let _target = seek.addTargetWithHandler(&handler);
    }
    mark_available();
    log::info!("Now Playing: registered with MPRemoteCommandCenter");
}

pub fn update(app: &AppHandle, info: Option<NowPlayingInfo>) {
    on_main(app, move || {
        STATE.with(|st| {
            let mut st = st.borrow_mut();
            if info.is_none() {
                st.artwork = None;
            }
            st.info = info;
            publish(&st);
        });
    });
}

pub fn set_artwork(app: &AppHandle, generation: u64, bytes: Option<Vec<u8>>) {
    on_main(app, move || {
        // A newer request may have landed since this closure was queued.
        if !artwork::is_current(generation) {
            return;
        }
        let artwork = bytes.and_then(|b| artwork_from_bytes(&b));
        STATE.with(|st| {
            let mut st = st.borrow_mut();
            st.artwork = artwork;
            if st.info.is_some() {
                publish(&st);
            }
        });
    });
}

fn artwork_from_bytes(bytes: &[u8]) -> Option<Retained<MPMediaItemArtwork>> {
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data)?;
    let size = image.size();
    let handler = RcBlock::new(move |_size| NonNull::from(&*image));
    // SAFETY: the block returns a pointer to the NSImage it keeps alive.
    Some(unsafe {
        MPMediaItemArtwork::initWithBoundsSize_requestHandler(
            MPMediaItemArtwork::alloc(),
            size,
            &handler,
        )
    })
}

fn publish(st: &State) {
    // SAFETY: main thread (callers run inside run_on_main_thread); every key is
    // a MediaPlayer constant and every value an NSString / NSNumber /
    // MPMediaItemArtwork, as the API documents.
    unsafe {
        let center = MPNowPlayingInfoCenter::defaultCenter();
        let Some(info) = st.info.as_ref() else {
            center.setNowPlayingInfo(None);
            center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
            return;
        };

        let dict = NSMutableDictionary::<NSString, AnyObject>::new();
        dict.insert(MPMediaItemPropertyTitle, &*NSString::from_str(&info.title));
        if let Some(artist) = info.artist.as_deref().filter(|s| !s.is_empty()) {
            dict.insert(MPMediaItemPropertyArtist, &*NSString::from_str(artist));
        }
        if let Some(album) = info.album.as_deref().filter(|s| !s.is_empty()) {
            dict.insert(MPMediaItemPropertyAlbumTitle, &*NSString::from_str(album));
        }
        if let Some(duration) = info.duration_secs.filter(|d| d.is_finite() && *d > 0.0) {
            dict.insert(MPMediaItemPropertyPlaybackDuration, &*NSNumber::new_f64(duration));
        }
        dict.insert(
            MPNowPlayingInfoPropertyElapsedPlaybackTime,
            &*NSNumber::new_f64(info.position_secs.max(0.0)),
        );
        dict.insert(
            MPNowPlayingInfoPropertyPlaybackRate,
            &*NSNumber::new_f64(info.effective_rate()),
        );
        dict.insert(MPNowPlayingInfoPropertyDefaultPlaybackRate, &*NSNumber::new_f64(1.0));
        let media_type = if info.video {
            MPNowPlayingInfoMediaType::Video
        } else {
            MPNowPlayingInfoMediaType::Audio
        };
        dict.insert(MPNowPlayingInfoPropertyMediaType, &*NSNumber::new_usize(media_type.0));
        if let Some(artwork) = st.artwork.as_ref() {
            dict.insert(MPMediaItemPropertyArtwork, &**artwork);
        }

        center.setNowPlayingInfo(Some(&dict));
        center.setPlaybackState(if info.stopped {
            MPNowPlayingPlaybackState::Stopped
        } else if info.playing {
            MPNowPlayingPlaybackState::Playing
        } else {
            MPNowPlayingPlaybackState::Paused
        });
    }
}
