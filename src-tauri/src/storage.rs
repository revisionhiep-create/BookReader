//! Immediate, atomic JSON persistence in `%APPDATA%\Bookreader\`.

use crate::models::{
    BookMeta, Bookmark, ClonedVoiceMeta, IgnoreRule, PronunciationRule, Settings, WindowState,
};
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
    cloned_voices: Vec<ClonedVoiceMeta>,
    window_state: Option<WindowState>,
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
        let mut library: Vec<BookMeta> = load_or_init(&paths.library_file(), Vec::new)?;
        sort_library_mru(&mut library);
        let cloned_voices: Vec<ClonedVoiceMeta> =
            load_or_init(&paths.cloned_voices_file(), Vec::new)?;
        let window_state: Option<WindowState> = load_optional(&paths.window_state_file())?;

        Ok(Self {
            paths,
            data: RwLock::new(StoreData {
                settings,
                pronunciations,
                ignore_rules,
                library,
                cloned_voices,
                window_state,
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

    pub fn window_state(&self) -> Option<WindowState> {
        self.data
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .window_state
            .clone()
    }

    pub fn save_window_state(&self, next: WindowState) -> Result<(), String> {
        let mut guard = self.data.write().unwrap_or_else(|e| e.into_inner());
        if guard.window_state.as_ref() == Some(&next) {
            return Ok(());
        }
        write_atomic(&self.paths.window_state_file(), &next)?;
        guard.window_state = Some(next);
        Ok(())
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

    pub fn cloned_voices(&self) -> Vec<ClonedVoiceMeta> {
        self.data
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .cloned_voices
            .clone()
    }

    pub fn get_cloned_voice(&self, voice_id: &str) -> Option<ClonedVoiceMeta> {
        self.data
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .cloned_voices
            .iter()
            .find(|v| v.voice_id == voice_id)
            .cloned()
    }

    pub fn add_cloned_voice(&self, voice: ClonedVoiceMeta) -> Result<Vec<ClonedVoiceMeta>, String> {
        let mut guard = self.data.write().unwrap_or_else(|e| e.into_inner());
        guard.cloned_voices.retain(|v| v.voice_id != voice.voice_id);
        guard.cloned_voices.insert(0, voice);
        write_atomic(&self.paths.cloned_voices_file(), &guard.cloned_voices)?;
        Ok(guard.cloned_voices.clone())
    }

    pub fn delete_cloned_voice(&self, voice_id: &str) -> Result<Vec<ClonedVoiceMeta>, String> {
        let mut guard = self.data.write().unwrap_or_else(|e| e.into_inner());
        guard.cloned_voices.retain(|v| v.voice_id != voice_id);
        write_atomic(&self.paths.cloned_voices_file(), &guard.cloned_voices)?;
        Ok(guard.cloned_voices.clone())
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
        guard.library.retain(|b| b.id != book.id);
        guard.library.insert(0, book.clone());
        sort_library_mru(&mut guard.library);
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
        let Some(pos) = guard.library.iter().position(|b| b.id == book_id) else {
            return Ok(());
        };
        {
            let book = &mut guard.library[pos];
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
        }
        if pos > 0 {
            let book = guard.library.remove(pos);
            guard.library.insert(0, book);
        }
        sort_library_mru(&mut guard.library);
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

fn sort_library_mru(library: &mut [BookMeta]) {
    library.sort_by(|a, b| {
        b.last_opened_at.cmp(&a.last_opened_at).then_with(|| {
            if a.last_opened_at == 0 && b.last_opened_at == 0 {
                b.added_at.cmp(&a.added_at)
            } else {
                std::cmp::Ordering::Equal
            }
        })
    });
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

fn load_optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.is_file() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    match serde_json::from_str::<T>(&raw) {
        Ok(val) => Ok(Some(val)),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "Corrupt JSON file found; backing up and resetting to none"
            );
            let backup = path.with_extension("json.bak");
            let _ = fs::copy(path, backup);
            let _ = fs::remove_file(path);
            Ok(None)
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
    use crate::models::QwenModelVariant;

    #[test]
    fn settings_and_rules_round_trip() {
        let root = std::env::temp_dir().join(format!("bookreader_store_test_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_roots(root.join("appdata"), root.join("data")).unwrap();
        let store = Storage::load(paths.clone()).unwrap();
        assert!(store.window_state().is_none());

        let mut s = store.settings();
        s.speed = 1.38;
        s.theme = "light".to_string();
        s.qwen_model_variant = QwenModelVariant::Fast0_6B;
        s.typography.reader_zoom = 1.4;
        s.typography.cc_font_size = 34;
        s.pdf_invert_dark = false;
        store.save_settings(s).unwrap();

        let ws = WindowState {
            x: 1960,
            y: 80,
            width: 1440,
            height: 920,
            maximized: true,
            scale_factor: 1.5,
            monitor_x: Some(1920),
            monitor_y: Some(0),
            monitor_width: Some(2560),
            monitor_height: Some(1400),
        };
        store.save_window_state(ws.clone()).unwrap();

        let cv = ClonedVoiceMeta {
            voice_id: "clone_abc123".to_string(),
            name: "My Narrator".to_string(),
            description: "Cloned · 6.5s · ICL".to_string(),
            ref_text: Some("Sample line".to_string()),
            icl_mode: true,
            duration_sec: 6.5,
            created_at: 1700000000,
        };
        store.add_cloned_voice(cv.clone()).unwrap();

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
        assert_eq!(
            reloaded.settings().qwen_model_variant,
            QwenModelVariant::Fast0_6B
        );
        assert!((reloaded.settings().typography.reader_zoom - 1.4).abs() < 1e-4);
        assert_eq!(reloaded.settings().typography.cc_font_size, 34);
        assert!(!reloaded.settings().pdf_invert_dark);
        assert_eq!(reloaded.window_state(), Some(ws));
        assert_eq!(reloaded.cloned_voices(), vec![cv]);
        assert_eq!(reloaded.ignore_rules().len(), 1);
        assert_eq!(reloaded.ignore_rules()[0].pattern, "[SFX]");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn library_sorts_by_most_recently_opened_and_promotes_on_reopen() {
        let root = std::env::temp_dir().join(format!("bookreader_mru_test_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_roots(root.join("appdata"), root.join("data")).unwrap();

        let make_book = |id: &str, added_at: u64, last_opened_at: u64| BookMeta {
            id: id.to_string(),
            title: id.to_string(),
            format: crate::models::BookFormat::Txt,
            stored_filename: format!("{id}.txt"),
            original_filename: format!("{id}.txt"),
            added_at,
            last_opened_at,
            current_sentence_idx: 0,
            current_page: 1,
            scroll_y: 0.0,
            total_sentences: 10,
            total_words: 100,
            pdf_header_ignore_pct: 0.06,
            pdf_footer_ignore_pct: 0.06,
            bookmarks: Vec::new(),
        };

        // Seed unsorted library on disk before Storage::load
        write_atomic(
            &paths.library_file(),
            &vec![
                make_book("oldest", 100, 100),
                make_book("newest", 300, 300),
                make_book("middle", 200, 200),
                make_book("never_b", 50, 0),
                make_book("never_a", 75, 0),
            ],
        )
        .unwrap();

        let store = Storage::load(paths.clone()).unwrap();
        let initial_ids: Vec<String> = store.library().into_iter().map(|b| b.id).collect();
        assert_eq!(
            initial_ids,
            vec!["newest", "middle", "oldest", "never_a", "never_b"]
        );

        // Re-opening an older book with the same timestamp as "newest" promotes it to index 0
        let mut reopened = store.get_book("oldest").unwrap();
        reopened.last_opened_at = 300;
        store.upsert_book(reopened).unwrap();
        let after_same_sec: Vec<String> = store.library().into_iter().map(|b| b.id).collect();
        assert_eq!(after_same_sec[0], "oldest");

        // Updating progress on an older book promotes it to the top and persists across reload
        store
            .update_book_progress("middle", 4, None, None, None, None)
            .unwrap();
        let reloaded = Storage::load(paths).unwrap();
        let after_progress: Vec<String> = reloaded.library().into_iter().map(|b| b.id).collect();
        assert_eq!(after_progress[0], "middle");

        let _ = fs::remove_dir_all(root);
    }
}
