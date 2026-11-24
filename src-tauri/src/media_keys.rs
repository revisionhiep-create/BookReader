//! OS system media keys integration via `souvlaki` (Play/Pause/Next/Prev).

use crate::tts::TtsController;
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, PlatformConfig};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Manager;

pub struct MediaKeysBridge {
    controls: Mutex<Option<MediaControls>>,
}

impl MediaKeysBridge {
    pub fn init(app: &AppHandle, tts: Arc<TtsController>) -> Self {
        let controls = create_controls(app, tts);
        Self {
            controls: Mutex::new(controls),
        }
    }

    pub fn update_status(&self, title: Option<&str>, playing: bool, paused: bool) {
        let mut guard = self.controls.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ctrl) = guard.as_mut() else {
            return;
        };
        if let Some(t) = title {
            let _ = ctrl.set_metadata(MediaMetadata {
                title: Some(t),
                artist: Some("BookReader — Phonon 31M"),
                ..Default::default()
            });
        }
        let playback = if playing {
            MediaPlayback::Playing { progress: None }
        } else if paused {
            MediaPlayback::Paused { progress: None }
        } else {
            MediaPlayback::Stopped
        };
        let _ = ctrl.set_playback(playback);
    }
}

fn create_controls(#[allow(unused_variables)] app: &AppHandle, tts: Arc<TtsController>) -> Option<MediaControls> {
    #[cfg(target_os = "windows")]
    let hwnd = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as *mut std::ffi::c_void);

    #[cfg(not(target_os = "windows"))]
    let hwnd: Option<*mut std::ffi::c_void> = None;

    let config = PlatformConfig {
        dbus_name: "bookreader",
        display_name: "BookReader",
        hwnd,
    };

    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = ?e, "Could not initialize OS media keys");
            return None;
        }
    };

    if let Err(e) = controls.attach(move |event: MediaControlEvent| match event {
        MediaControlEvent::Play => tts.resume(),
        MediaControlEvent::Pause | MediaControlEvent::Stop => tts.pause(),
        MediaControlEvent::Toggle => tts.toggle_play_pause(),
        MediaControlEvent::Next => tts.step_sentence(1),
        MediaControlEvent::Previous => tts.step_sentence(-1),
        _ => {}
    }) {
        tracing::warn!(error = ?e, "Could not attach media key handler");
        return None;
    }

    Some(controls)
}
