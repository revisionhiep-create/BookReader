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
    use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
    use jni::sys::jint;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    static JVM: OnceLock<jni::JavaVM> = OnceLock::new();
    static MAIN_ACTIVITY_CLASS: OnceLock<GlobalRef> = OnceLock::new();

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_bookreader_android_MainActivity_nativeBindApp(
        env: JNIEnv,
        class: JClass,
        _activity: JObject,
    ) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = JVM.set(vm);
        }
        if let Ok(global_cls) = env.new_global_ref(class) {
            let _ = MAIN_ACTIVITY_CLASS.set(global_cls);
        }
    }

    pub fn copy_content_uri_to_cache(uri: &str, dest_dir: &Path) -> Result<PathBuf, String> {
        let vm = JVM
            .get()
            .ok_or_else(|| "Android JVM not yet bound to MainActivity".to_string())?;
        let cls_ref = MAIN_ACTIVITY_CLASS
            .get()
            .ok_or_else(|| "Android MainActivity class reference not yet bound".to_string())?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("Failed attaching JNI thread: {e}"))?;

        let local_cls_obj = env
            .new_local_ref(cls_ref.as_obj())
            .map_err(|e| format!("Failed creating MainActivity local ref: {e}"))?;
        let cls = JClass::from(local_cls_obj);

        let dest_str = dest_dir.to_string_lossy();
        let juri = env
            .new_string(uri)
            .map_err(|e| format!("Failed creating URI JNI string: {e}"))?;
        let jdest = env
            .new_string(dest_str.as_ref())
            .map_err(|e| format!("Failed creating dest JNI string: {e}"))?;
        let juri_obj = JObject::from(juri);
        let jdest_obj = JObject::from(jdest);

        let call_res = env.call_static_method(
            cls,
            "copyContentUriToCache",
            "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&juri_obj), JValue::Object(&jdest_obj)],
        );

        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
            return Err("Android ContentResolver failed reading the selected file".to_string());
        }

        let val = call_res.map_err(|e| format!("JNI copyContentUriToCache failed: {e}"))?;
        let out_obj = val
            .l()
            .map_err(|e| format!("Unexpected JNI return type: {e}"))?;
        let out_jstr = JString::from(out_obj);
        let out_path: String = env
            .get_string(&out_jstr)
            .map_err(|e| format!("Failed reading cached file path: {e}"))?
            .into();
        Ok(PathBuf::from(out_path))
    }

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

#[cfg(target_os = "android")]
pub fn copy_android_content_uri(uri: &str, dest_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    android_jni::copy_content_uri_to_cache(uri, dest_dir)
}
