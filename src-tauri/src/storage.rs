//! Immediate, atomic JSON persistence in `%APPDATA%\Bookreader\`.

use crate::models::{BookMeta, Bookmark, IgnoreRule, PronunciationRule, Settings};
use crate::paths::AppPaths;
use serde::{Serialize, de::DeserializeOwned};
use std::fs;
use std::path::Path;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
struct StoreData {
    settings: Settings,
    pronunciations: Vec<PronunciationRule>,
    ignore_rules: Vec<IgnoreRule>,
    library: Vec<BookMeta>,
}

/// Thread-safe persistence layer backed by atomic JSON files in AppData.
pub struct Storage {
    paths: AppPaths,
    data: RwLock<StoreData>,
}

impl Storage {
    /// Loads existing settings/rules/library from disk or initializes clean defaults.
    pub fn load(paths: AppPaths) -> Result<Self, String> {
        let mut settings: Settings = load_or_init(&paths.settings_file(), Settings::default)?;
        settings.sanitize();

        let pronunciations: Vec<PronunciationRule> =
            load_or_init(&paths.pronunciations_file(), Vec::new)?;
        let ignore_rules: Vec<IgnoreRule> = load_or_init(&paths.ignore_rules_file(), Vec::new)?;
        let library: Vec<BookMeta> = load_or_init(&paths.library_file(), Vec::new)?;

        Ok(Self {
            paths,
            data: RwLock::new(StoreData {
                settings,
                pronunciations,
                ignore_rules,
                library,
            }),
        })
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    pub fn settings(&self) -> Settings {
        self.data.read().unwrap().settings.clone()
    }

    pub fn save_settings(&self, mut next: Settings) -> Result<Settings, String> {
        next.sanitize();
        write_atomic(&self.paths.settings_file(), &next)?;
        self.data.write().unwrap().settings = next.clone();
        Ok(next)
    }

    pub fn pronunciations(&self) -> Vec<PronunciationRule> {
        self.data.read().unwrap().pronunciations.clone()
    }

    pub fn save_pronunciations(&self, rules: Vec<PronunciationRule>) -> Result<Vec<PronunciationRule>, String> {
        write_atomic(&self.paths.pronunciations_file(), &rules)?;
        self.data.write().unwrap().pronunciations = rules.clone();
        Ok(rules)
    }

    pub fn ignore_rules(&self) -> Vec<IgnoreRule> {
        self.data.read().unwrap().ignore_rules.clone()
    }

    pub fn save_ignore_rules(&self, rules: Vec<IgnoreRule>) -> Result<Vec<IgnoreRule>, String> {
        write_atomic(&self.paths.ignore_rules_file(), &rules)?;
        self.data.write().unwrap().ignore_rules = rules.clone();
        Ok(rules)
    }

    pub fn library(&self) -> Vec<BookMeta> {
        self.data.read().unwrap().library.clone()
    }

    pub fn get_book(&self, book_id: &str) -> Option<BookMeta> {
        self.data
            .read()
            .unwrap()
            .library
            .iter()
            .find(|b| b.id == book_id)
            .cloned()
    }

    pub fn upsert_book(&self, book: BookMeta) -> Result<BookMeta, String> {
        let mut guard = self.data.write().unwrap();
        if let Some(existing) = guard.library.iter_mut().find(|b| b.id == book.id) {
            *existing = book.clone();
        } else {
            guard.library.insert(0, book.clone());
        }
        write_atomic(&self.paths.library_file(), &guard.library)?;
        Ok(book)
    }

    pub fn update_book_progress(
        &self,
        book_id: &str,
        sentence_idx: usize,
        page: Option<usize>,
        scroll_y: Option<f64>,
        total_sentences: Option<usize>,
        total_words: Option<usize>,
    ) -> Result<(), String> {
        let mut guard = self.data.write().unwrap();
        let Some(book) = guard.library.iter_mut().find(|b| b.id == book_id) else {
            return Ok(());
        };
        book.current_sentence_idx = sentence_idx;
        if let Some(p) = page {
            book.current_page = p;
        }
        if let Some(y) = scroll_y {
            book.scroll_y = y;
        }
        if let Some(ts) = total_sentences {
            book.total_sentences = ts;
        }
        if let Some(tw) = total_words {
            book.total_words = tw;
        }
        book.last_opened_at = now_unix_secs();
        write_atomic(&self.paths.library_file(), &guard.library)
    }

    pub fn update_pdf_margins(
        &self,
        book_id: &str,
        header_pct: f32,
        footer_pct: f32,
    ) -> Result<BookMeta, String> {
        let mut guard = self.data.write().unwrap();
        let book = guard
            .library
            .iter_mut()
            .find(|b| b.id == book_id)
            .ok_or_else(|| format!("Book not found: {book_id}"))?;
        book.pdf_header_ignore_pct = header_pct.clamp(0.0, 0.45);
        book.pdf_footer_ignore_pct = footer_pct.clamp(0.0, 0.45);
        let updated = book.clone();
        write_atomic(&self.paths.library_file(), &guard.library)?;
        Ok(updated)
    }

    pub fn add_bookmark(&self, book_id: &str, bookmark: Bookmark) -> Result<BookMeta, String> {
        let mut guard = self.data.write().unwrap();
        let book = guard
            .library
            .iter_mut()
            .find(|b| b.id == book_id)
            .ok_or_else(|| format!("Book not found: {book_id}"))?;
        book.bookmarks.push(bookmark);
        let updated = book.clone();
        write_atomic(&self.paths.library_file(), &guard.library)?;
        Ok(updated)
    }

    pub fn remove_bookmark(&self, book_id: &str, bookmark_id: &str) -> Result<BookMeta, String> {
        let mut guard = self.data.write().unwrap();
        let book = guard
            .library
            .iter_mut()
            .find(|b| b.id == book_id)
            .ok_or_else(|| format!("Book not found: {book_id}"))?;
        book.bookmarks.retain(|bm| bm.id != bookmark_id);
        let updated = book.clone();
        write_atomic(&self.paths.library_file(), &guard.library)?;
        Ok(updated)
    }

    pub fn delete_book(&self, book_id: &str) -> Result<Option<String>, String> {
        let mut guard = self.data.write().unwrap();
        let idx = guard.library.iter().position(|b| b.id == book_id);
        let removed_file = idx.map(|i| guard.library.remove(i).stored_filename);
        write_atomic(&self.paths.library_file(), &guard.library)?;
        if guard.settings.last_book_id.as_deref() == Some(book_id) {
            guard.settings.last_book_id = None;
            write_atomic(&self.paths.settings_file(), &guard.settings)?;
        }
        Ok(removed_file)
    }
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_or_init<T, F>(path: &Path, default_fn: F) -> Result<T, String>
where
    T: Serialize + DeserializeOwned,
    F: FnOnce() -> T,
{
    if !path.is_file() {
        let val = default_fn();
        write_atomic(path, &val)?;
        return Ok(val);
    }

    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    match serde_json::from_str::<T>(&raw) {
        Ok(val) => Ok(val),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "Corrupt JSON file found; backing up and resetting to defaults"
            );
            let backup = path.with_extension("json.bak");
            let _ = fs::copy(path, backup);
            let val = default_fn();
            write_atomic(path, &val)?;
            Ok(val)
        }
    }
}

/// Atomically writes `value` as pretty JSON via a `.tmp` sibling file.
pub fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("Failed to write temp file {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to persist {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_rules_round_trip() {
        let root = std::env::temp_dir().join(format!("bookreader_store_test_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_roots(root.join("appdata"), root.join("data")).unwrap();
        let store = Storage::load(paths.clone()).unwrap();

        let mut s = store.settings();
        s.speed = 1.38;
        s.theme = "light".to_string();
        store.save_settings(s).unwrap();

        store
            .save_ignore_rules(vec![IgnoreRule {
                id: "1".to_string(),
                pattern: "[SFX]".to_string(),
                match_case: true,
                ignore_word_boundary: true,
                is_regex: false,
                enabled: true,
            }])
            .unwrap();

        let reloaded = Storage::load(paths).unwrap();
        assert!((reloaded.settings().speed - 1.38).abs() < 1e-4);
        assert_eq!(reloaded.settings().theme, "light");
        assert_eq!(reloaded.ignore_rules().len(), 1);
        assert_eq!(reloaded.ignore_rules()[0].pattern, "[SFX]");

        let _ = fs::remove_dir_all(root);
    }
}
