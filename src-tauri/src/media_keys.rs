//! OS system media keys integration via `souvlaki` (desktop) and Android MediaSession JNI bridge.

use crate::tts::TtsController;
#[cfg(not(target_os = "android"))]
use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, PlatformConfig};
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(target_os = "android")]
use std::sync::OnceLock;
use std::sync::Arc;
use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[cfg(not(target_os = "android"))]
pub struct MediaKeysBridge {
    controls: Mutex<Option<MediaControls>>,
}

#[cfg(not(target_os = "android"))]
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

#[cfg(not(target_os = "android"))]
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

#[cfg(target_os = "android")]
static ANDROID_TTS: OnceLock<Arc<TtsController>> = OnceLock::new();

#[cfg(target_os = "android")]
static ANDROID_LAST_TITLE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[cfg(target_os = "android")]
pub struct MediaKeysBridge;

#[cfg(target_os = "android")]
impl MediaKeysBridge {
    pub fn init(_app: &AppHandle, tts: Arc<TtsController>) -> Self {
        let _ = ANDROID_TTS.set(tts);
        Self
    }

    pub fn update_status(&self, title: Option<&str>, playing: bool, paused: bool) {
        let resolved_title = {
            let mut guard = ANDROID_LAST_TITLE.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(t) = title {
                *guard = t.to_string();
            }
            if guard.is_empty() {
                "BookReader".to_string()
            } else {
                guard.clone()
            }
        };
        android_jni::notify_playback_state(&resolved_title, playing, paused);
    }
}

#[cfg(target_os = "android")]
mod android_jni {
    use super::ANDROID_TTS;
    use jni::JNIEnv;
    use jni::objects::{JClass, JObject, JValue};
    use jni::sys::jint;
    use std::sync::OnceLock;

    static JVM: OnceLock<jni::JavaVM> = OnceLock::new();

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_bookreader_android_BookReaderPlaybackService_nativeBindJvm(
        env: JNIEnv,
        _class: JClass,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = JVM.set(vm);
        }
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_bookreader_android_BookReaderPlaybackService_nativeOnMediaAction(
        _env: JNIEnv,
        _class: JClass,
        action: jint,
    ) {
        let Some(tts) = ANDROID_TTS.get() else {
            return;
        };
        match action {
            0 => tts.resume(),
            1 => tts.pause(),
            2 => tts.toggle_play_pause(),
            3 => tts.step_sentence(1),
            4 => tts.step_sentence(-1),
            _ => {}
        }
    }

    pub fn notify_playback_state(title: &str, playing: bool, paused: bool) {
        let Some(vm) = JVM.get() else {
            return;
        };
        let Ok(mut env) = vm.attach_current_thread() else {
            return;
        };
        let Ok(cls) = env.find_class("com/bookreader/android/BookReaderPlaybackService") else {
            let _ = env.exception_clear();
            return;
        };
        let Ok(jtitle) = env.new_string(title) else {
            return;
        };
        let _ = env.call_static_method(
            cls,
            "updatePlaybackStateFromNative",
            "(Ljava/lang/String;ZZ)V",
            &[
                JValue::Object(&JObject::from(jtitle)),
                JValue::Bool(u8::from(playing)),
                JValue::Bool(u8::from(paused)),
            ],
        );
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
    }

    pub fn set_wake_lock(hold: bool) {
        let Some(vm) = JVM.get() else {
            return;
        };
        let Ok(mut env) = vm.attach_current_thread() else {
            return;
        };
        let Ok(cls) = env.find_class("com/bookreader/android/BookReaderPlaybackService") else {
            let _ = env.exception_clear();
            return;
        };
        let _ = env.call_static_method(
            cls,
            "setWakeLockFromNative",
            "(Z)V",
            &[JValue::Bool(u8::from(hold))],
        );
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
    }
}

#[cfg(target_os = "android")]
pub fn set_android_wake_lock(hold: bool) {
    android_jni::set_wake_lock(hold);
}
