//! Filesystem path resolution for BookReader.
//!
//! - Portable data (`BookReader_Data/{models,voices,books}`) sits next to the
//!   executable in release builds (or at the workspace root during `cargo test`/`dev`).
//! - User settings and rule databases live in `%APPDATA%\Bookreader\`.

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
        let appdata_base = dirs::config_dir()
            .ok_or_else(|| "Could not determine Windows AppData folder".to_string())?;
        let appdata_dir = appdata_base.join("Bookreader");

        let base_dir = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        } else {
            std::env::current_exe()
                .map_err(|e| format!("Failed to determine executable path: {e}"))?
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "Executable has no parent directory".to_string())?
        };

        let data_dir = base_dir.join("BookReader_Data");
        Self::from_roots(appdata_dir, data_dir)
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
}
