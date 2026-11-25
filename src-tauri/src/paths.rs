//! Filesystem path resolution for BookReader.
//!
//! - Portable data (`BookReader_Data/{models,voices,books}`) sits next to the
//!   executable (Windows) or next to `BookReader.app` (macOS) in release builds,
//!   or at the workspace root during `cargo test`/`dev`.
//! - If the macOS `.app` sits in a read-only location (e.g., mounted `.dmg`,
//!   `/Applications`, or App Translocation), portable data falls back cleanly to
//!   `<system config dir>/Bookreader/BookReader_Data/`.
//! - User settings and rule databases live in `%APPDATA%\Bookreader\` (Windows)
//!   or `~/Library/Application Support/Bookreader/` (macOS).

use crate::models::QwenModelVariant;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Resolved directories used by BookReader at runtime.
#[derive(Clone, Debug)]
pub struct AppPaths {
    pub appdata_dir: PathBuf,
    pub data_dir: PathBuf,
    pub models_dir: PathBuf,
    pub qwen_models_dir: PathBuf,
    pub qwen_0_6b_models_dir: PathBuf,
    pub voices_dir: PathBuf,
    pub cloned_voices_dir: PathBuf,
    pub books_dir: PathBuf,
}

impl AppPaths {
    /// Initializes all required directories on disk and returns the resolved paths.
    pub fn init() -> Result<Self, String> {
        let appdata_dir = match std::env::var_os("BOOKREADER_CONFIG_DIR").filter(|v| !v.is_empty()) {
            Some(override_dir) => PathBuf::from(override_dir),
            None => dirs::config_dir()
                .ok_or_else(|| "Could not determine system config directory".to_string())?
                .join("Bookreader"),
        };

        let data_dir = if let Some(override_data) =
            std::env::var_os("BOOKREADER_DATA_DIR").filter(|v| !v.is_empty())
        {
            PathBuf::from(override_data)
        } else if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
                .join("BookReader_Data")
        } else {
            let exe_path = std::env::current_exe()
                .map_err(|e| format!("Failed to determine executable path: {e}"))?;
            resolve_release_data_dir(&exe_path, &appdata_dir, cfg!(target_os = "macos"))
        };

        Self::from_roots(appdata_dir, data_dir)
    }

    /// Initializes Android directories inside Tauri's private `app_data_dir`.
    #[allow(dead_code)]
    pub fn init_android(app_data_dir: PathBuf) -> Result<Self, String> {
        Self::from_roots(app_data_dir.join("config"), app_data_dir.join("BookReader_Data"))
    }

    /// Creates an [`AppPaths`] rooted at explicit directories (used in tests and [`Self::init`]).
    pub fn from_roots(appdata_dir: PathBuf, data_dir: PathBuf) -> Result<Self, String> {
        let models_dir = data_dir.join("models").join("phonon-31m-en");
        let qwen_models_dir = data_dir
            .join("models")
            .join(QwenModelVariant::Quality1_7B.dir_name());
        let qwen_0_6b_models_dir = data_dir
            .join("models")
            .join(QwenModelVariant::Fast0_6B.dir_name());
        let voices_dir = data_dir.join("voices");
        let cloned_voices_dir = voices_dir.join("cloned");
        let books_dir = data_dir.join("books");

        for dir in [
            &appdata_dir,
            &data_dir,
            &models_dir,
            &qwen_models_dir,
            &qwen_0_6b_models_dir,
            &voices_dir,
            &cloned_voices_dir,
            &books_dir,
        ] {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create directory {}: {e}", dir.display()))?;
        }

        Ok(Self {
            appdata_dir,
            data_dir,
            models_dir,
            qwen_models_dir,
            qwen_0_6b_models_dir,
            voices_dir,
            cloned_voices_dir,
            books_dir,
        })
    }

    pub fn is_cloned_voice_id(voice_id: &str) -> bool {
        voice_id.starts_with("clone_")
    }

    pub fn qwen_model_dir(&self, variant: QwenModelVariant) -> &Path {
        match variant {
            QwenModelVariant::Fast0_6B => &self.qwen_0_6b_models_dir,
            QwenModelVariant::Quality1_7B => &self.qwen_models_dir,
        }
    }

    /// Returns `true` when all required Phonon 31M files exist and are non-empty.
    pub fn model_ready(&self) -> bool {
        ["config.json", "tokenizer.json", "model.q8.gguf", "default-voice.safetensors"]
            .iter()
            .all(|name| {
                let p = self.models_dir.join(name);
                fs::metadata(&p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
            })
    }

    /// Returns `true` when all required files for `variant` exist and are non-empty.
    pub fn qwen_model_ready_for(&self, variant: QwenModelVariant) -> bool {
        let dir = self.qwen_model_dir(variant);
        [
            "config.json",
            "generation_config.json",
            "tokenizer_config.json",
            "vocab.json",
            "merges.txt",
            "model.safetensors",
            "speech_tokenizer/config.json",
            "speech_tokenizer/model.safetensors",
        ]
        .iter()
        .all(|rel| {
            let p = dir.join(rel);
            fs::metadata(&p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
        })
    }

    /// Returns the path for a voice `.safetensors` file after validating `voice_id`.
    pub fn voice_path(&self, voice_id: &str) -> Result<PathBuf, String> {
        validate_single_segment(voice_id)?;
        Ok(self.voices_dir.join(format!("{voice_id}.safetensors")))
    }

    /// Returns the legacy 1.7B serialized Qwen3-TTS voice prompt path for a cloned voice.
    pub fn cloned_voice_prompt_path(&self, voice_id: &str) -> Result<PathBuf, String> {
        validate_single_segment(voice_id)?;
        Ok(self.cloned_voices_dir.join(format!("{voice_id}.prompt.json")))
    }

    /// Returns the variant-specific serialized Qwen3-TTS voice prompt path for a cloned voice.
    pub fn cloned_voice_prompt_path_for(
        &self,
        voice_id: &str,
        variant: QwenModelVariant,
    ) -> Result<PathBuf, String> {
        validate_single_segment(voice_id)?;
        Ok(self
            .cloned_voices_dir
            .join(format!("{voice_id}.{}.prompt.json", variant.prompt_suffix())))
    }

    /// Returns the normalized 24 kHz mono reference WAV path for a cloned voice.
    pub fn cloned_voice_ref_wav_path(&self, voice_id: &str) -> Result<PathBuf, String> {
        validate_single_segment(voice_id)?;
        Ok(self.cloned_voices_dir.join(format!("{voice_id}.ref.wav")))
    }

    /// Returns `true` if a cloned voice has either its `.ref.wav` or a usable prompt for `variant`.
    pub fn is_cloned_voice_available(&self, voice_id: &str, variant: QwenModelVariant) -> bool {
        file_nonempty(self.cloned_voice_ref_wav_path(voice_id))
            || file_nonempty(self.cloned_voice_prompt_path_for(voice_id, variant))
            || (variant == QwenModelVariant::Quality1_7B
                && file_nonempty(self.cloned_voice_prompt_path(voice_id)))
    }

    /// Returns `true` if a voice file exists on disk and is non-empty.
    pub fn is_voice_downloaded(&self, voice_id: &str) -> bool {
        if voice_id == "default" {
            return self.models_dir.join("default-voice.safetensors").is_file();
        }
        if Self::is_cloned_voice_id(voice_id) {
            return file_nonempty(self.cloned_voice_ref_wav_path(voice_id))
                || QwenModelVariant::all()
                    .into_iter()
                    .any(|v| file_nonempty(self.cloned_voice_prompt_path_for(voice_id, v)))
                || file_nonempty(self.cloned_voice_prompt_path(voice_id));
        }
        file_nonempty(self.voice_path(voice_id))
    }

    /// Returns the path for a stored book file after validating it is a plain filename.
    pub fn book_path(&self, stored_filename: &str) -> Result<PathBuf, String> {
        validate_single_segment(stored_filename)?;
        Ok(self.books_dir.join(stored_filename))
    }

    pub fn settings_file(&self) -> PathBuf {
        self.appdata_dir.join("settings.json")
    }

    pub fn pronunciations_file(&self) -> PathBuf {
        self.appdata_dir.join("pronunciations.json")
    }

    pub fn ignore_rules_file(&self) -> PathBuf {
        self.appdata_dir.join("ignore_rules.json")
    }

    pub fn library_file(&self) -> PathBuf {
        self.appdata_dir.join("library.json")
    }

    pub fn cloned_voices_file(&self) -> PathBuf {
        self.appdata_dir.join("cloned_voices.json")
    }

    pub fn window_state_file(&self) -> PathBuf {
        self.appdata_dir.join("window_state.json")
    }
}

fn file_nonempty(path_res: Result<PathBuf, String>) -> bool {
    path_res
        .ok()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Ensures `segment` is a single safe file name with no path traversal.
pub fn validate_single_segment(segment: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }
    let mut components = Path::new(segment).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) if !segment.contains(['/', '\\', ':']) => Ok(()),
        _ => Err(format!("Invalid file identifier: {segment}")),
    }
}

/// Resolves the containing folder for a macOS `.app` bundle (`<parent>/BookReader.app/Contents/MacOS/BookReader` -> `<parent>`),
/// falling back to the executable's immediate parent when not running inside an `.app` bundle.
pub fn bundle_container_dir(exe_path: &Path) -> PathBuf {
    let Some(macos_dir) = exe_path.parent() else {
        return PathBuf::from(".");
    };
    if macos_dir.file_name().and_then(|n| n.to_str()) == Some("MacOS")
        && let Some(contents_dir) = macos_dir.parent()
        && contents_dir.file_name().and_then(|n| n.to_str()) == Some("Contents")
        && let Some(app_bundle) = contents_dir.parent()
        && app_bundle
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("app"))
        && let Some(container) = app_bundle.parent()
    {
        return container.to_path_buf();
    }
    macos_dir.to_path_buf()
}

fn is_macos_non_portable_container(container: &Path) -> bool {
    let normalized = container.to_string_lossy().replace('\\', "/");
    if normalized.contains("/AppTranslocation/") {
        return true;
    }
    if normalized == "/Applications" || normalized.starts_with("/Applications/") {
        return true;
    }
    if let Some(home) = dirs::home_dir() {
        let user_apps = home.join("Applications");
        if container == user_apps || container.starts_with(&user_apps) {
            return true;
        }
    }
    false
}

fn dir_is_writable_for_data(candidate: &Path) -> bool {
    if fs::create_dir_all(candidate).is_err() {
        return false;
    }
    let probe = candidate.join(format!(".bookreader_write_probe_{}", uuid::Uuid::new_v4()));
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Resolves the release `BookReader_Data` folder for the given executable and config directory.
/// On macOS, uses `<container>/BookReader_Data` when portable & writable, and otherwise falls back
/// cleanly to `<appdata_dir>/BookReader_Data` (for mounted `.dmg`, `/Applications`, or App Translocation).
pub fn resolve_release_data_dir(exe_path: &Path, appdata_dir: &Path, is_macos: bool) -> PathBuf {
    if !is_macos {
        let base = exe_path.parent().unwrap_or_else(|| Path::new("."));
        return base.join("BookReader_Data");
    }

    let container = bundle_container_dir(exe_path);
    let portable_candidate = container.join("BookReader_Data");
    let non_portable = is_macos_non_portable_container(&container);

    if (!non_portable || portable_candidate.is_dir()) && dir_is_writable_for_data(&portable_candidate)
    {
        return portable_candidate;
    }
    appdata_dir.join("BookReader_Data")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_per_variant_qwen_paths_and_legacy_fallback() {
        let root = std::env::temp_dir().join(format!("bookreader_paths_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_roots(root.join("appdata"), root.join("data")).unwrap();

        assert!(paths.qwen_model_dir(QwenModelVariant::Fast0_6B).ends_with("qwen3-tts-0.6b-base"));
        assert!(paths.qwen_model_dir(QwenModelVariant::Quality1_7B).ends_with("qwen3-tts-1.7b-base"));

        let vid = "clone_test1";
        assert!(!paths.is_cloned_voice_available(vid, QwenModelVariant::Fast0_6B));
        assert!(!paths.is_cloned_voice_available(vid, QwenModelVariant::Quality1_7B));

        // Legacy 1.7B prompt only counts for 1.7B unless .ref.wav or 0.6B prompt exists.
        fs::write(paths.cloned_voice_prompt_path(vid).unwrap(), b"{}").unwrap();
        assert!(!paths.is_cloned_voice_available(vid, QwenModelVariant::Fast0_6B));
        assert!(paths.is_cloned_voice_available(vid, QwenModelVariant::Quality1_7B));
        assert!(paths.is_voice_downloaded(vid));

        // Having .ref.wav unlocks automatic reuse on both 0.6B and 1.7B.
        fs::write(paths.cloned_voice_ref_wav_path(vid).unwrap(), b"RIFF").unwrap();
        assert!(paths.is_cloned_voice_available(vid, QwenModelVariant::Fast0_6B));
        assert!(paths.is_cloned_voice_available(vid, QwenModelVariant::Quality1_7B));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_macos_bundle_container_and_fallbacks() {
        let root = std::env::temp_dir().join(format!("bookreader_mac_paths_{}", uuid::Uuid::new_v4()));
        let portable_dir = root.join("PortableFolder");
        fs::create_dir_all(portable_dir.join("BookReader.app/Contents/MacOS")).unwrap();
        let exe = portable_dir.join("BookReader.app/Contents/MacOS/BookReader");
        let appdata = root.join("AppSupport/Bookreader");

        assert_eq!(bundle_container_dir(&exe), portable_dir);
        let resolved_portable = resolve_release_data_dir(&exe, &appdata, true);
        assert_eq!(resolved_portable, portable_dir.join("BookReader_Data"));

        // AppTranslocation must fall back to appdata/BookReader_Data
        let translocated = PathBuf::from(
            "/private/var/folders/xx/T/AppTranslocation/ABC-123/d/BookReader.app/Contents/MacOS/BookReader",
        );
        assert_eq!(
            resolve_release_data_dir(&translocated, &appdata, true),
            appdata.join("BookReader_Data")
        );

        // /Applications without pre-existing BookReader_Data falls back to appdata/BookReader_Data
        let applications_exe = PathBuf::from("/Applications/BookReader.app/Contents/MacOS/BookReader");
        assert_eq!(
            resolve_release_data_dir(&applications_exe, &appdata, true),
            appdata.join("BookReader_Data")
        );

        // Windows always resolves next to exe
        let win_exe = portable_dir.join("BookReader.exe");
        assert_eq!(
            resolve_release_data_dir(&win_exe, &appdata, false),
            portable_dir.join("BookReader_Data")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn initializes_android_app_data_roots() {
        let root = std::env::temp_dir().join(format!("bookreader_android_paths_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::init_android(root.clone()).unwrap();
        assert_eq!(paths.appdata_dir, root.join("config"));
        assert_eq!(paths.data_dir, root.join("BookReader_Data"));
        assert!(paths.models_dir.is_dir());
        assert!(paths.voices_dir.is_dir());
        assert!(paths.books_dir.is_dir());
        let _ = fs::remove_dir_all(root);
    }
}
