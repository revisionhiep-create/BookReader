//! Filesystem path resolution for BookReader.
//!
//! - Portable data (`BookReader_Data/{models,voices,books}`) sits next to the
//!   executable in release builds (or at the workspace root during `cargo test`/`dev`).
//! - User settings and rule databases live in `%APPDATA%\Bookreader\`.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Resolved directories used by BookReader at runtime.
#[derive(Clone, Debug)]
pub struct AppPaths {
    pub appdata_dir: PathBuf,
    pub data_dir: PathBuf,
    pub models_dir: PathBuf,
    pub voices_dir: PathBuf,
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
        let voices_dir = data_dir.join("voices");
        let books_dir = data_dir.join("books");

        for dir in [&appdata_dir, &data_dir, &models_dir, &voices_dir, &books_dir] {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create directory {}: {e}", dir.display()))?;
        }

        Ok(Self {
            appdata_dir,
            data_dir,
            models_dir,
            voices_dir,
            books_dir,
        })
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

    /// Returns the path for a voice `.safetensors` file after validating `voice_id`.
    pub fn voice_path(&self, voice_id: &str) -> Result<PathBuf, String> {
        validate_single_segment(voice_id)?;
        Ok(self.voices_dir.join(format!("{voice_id}.safetensors")))
    }

    /// Returns `true` if a voice file exists on disk and is non-empty.
    pub fn is_voice_downloaded(&self, voice_id: &str) -> bool {
        if voice_id == "default" {
            return self.models_dir.join("default-voice.safetensors").is_file();
        }
        self.voice_path(voice_id)
            .ok()
            .and_then(|p| fs::metadata(p).ok())
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
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
