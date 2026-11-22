//! Tauri IPC commands bridging frontend UI actions and Rust backend engines.

use crate::documents::{import_book, load_non_pdf_document};
use crate::downloader::DownloadManager;
use crate::exporter::ExportManager;
use crate::media_keys::MediaKeysBridge;
use crate::models::{
    AppBootstrap, BookFormat, BookMeta, Bookmark, DocumentPayload, ExportProgressEvent,
    ExportRequest, IgnoreRule, PronunciationRule, SentenceItem, Settings, SleepTimerStatus,
    TtsStateEvent, VoiceInfo,
};
use crate::sleep_timer::SleepTimer;
use crate::storage::{Storage, now_unix_secs};
use crate::text_pipeline::validate_rule_pattern;
use crate::tts::TtsController;
use crate::voices::list_voices_with_status;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, State};

pub struct AppState {
    pub storage: Arc<Storage>,
    pub downloader: Arc<DownloadManager>,
    pub tts: Arc<TtsController>,
    pub exporter: Arc<ExportManager>,
    pub media_keys: Arc<MediaKeysBridge>,
    pub sleep_timer: Arc<SleepTimer>,
}

#[tauri::command]
pub fn get_bootstrap(state: State<'_, AppState>) -> AppBootstrap {
    let paths = state.storage.paths();
    AppBootstrap {
        model_ready: paths.model_ready(),
        engine_loaded: state.tts.is_model_loaded(),
        appdata_dir: paths.appdata_dir.to_string_lossy().into_owned(),
        data_dir: paths.data_dir.to_string_lossy().into_owned(),
        settings: state.storage.settings(),
        library: state.storage.library(),
        pronunciations: state.storage.pronunciations(),
        ignore_rules: state.storage.ignore_rules(),
        voices: list_voices_with_status(paths),
        mp3_native_available: true,
        ffmpeg_available: false,
    }
}

#[tauri::command]
pub async fn download_model(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let default_vid = state.storage.settings().voice_id;
    state
        .downloader
        .download_phonon_model(&app, state.storage.paths(), Some(&default_vid))
        .await?;
    state.tts.ensure_model_loaded()
}

#[tauri::command]
pub async fn download_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    voice_id: String,
) -> Result<Vec<VoiceInfo>, String> {
    state
        .downloader
        .download_voice(&app, state.storage.paths(), &voice_id)
        .await?;
    Ok(list_voices_with_status(state.storage.paths()))
}

#[tauri::command]
pub async fn download_all_voices(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<VoiceInfo>, String> {
    state
        .downloader
        .download_all_voices(&app, state.storage.paths())
        .await?;
    Ok(list_voices_with_status(state.storage.paths()))
}

#[tauri::command]
pub fn list_voices(state: State<'_, AppState>) -> Vec<VoiceInfo> {
    list_voices_with_status(state.storage.paths())
}

#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let prev = state.storage.settings();
    let saved = state.storage.save_settings(settings)?;

    if (prev.speed - saved.speed).abs() > 0.001 {
        state.tts.set_speed(saved.speed);
    }
    if (prev.volume - saved.volume).abs() > 0.001 {
        state.tts.set_volume(saved.volume);
    }
    if prev.sanitizer != saved.sanitizer {
        state.tts.refresh_pipeline();
    }
    Ok(saved)
}

#[tauri::command]
pub async fn select_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    voice_id: String,
) -> Result<Settings, String> {
    if voice_id != "default" && !state.storage.paths().is_voice_downloaded(&voice_id) {
        state
            .downloader
            .download_voice(&app, state.storage.paths(), &voice_id)
            .await?;
    }
    let mut settings = state.storage.settings();
    settings.voice_id = voice_id;
    let saved = state.storage.save_settings(settings)?;
    state.tts.refresh_pipeline();
    Ok(saved)
}

#[tauri::command]
pub fn save_pronunciation_rules(
    state: State<'_, AppState>,
    rules: Vec<PronunciationRule>,
) -> Result<Vec<PronunciationRule>, String> {
    let saved = state.storage.save_pronunciations(rules)?;
    state.tts.refresh_pipeline();
    Ok(saved)
}

#[tauri::command]
pub fn save_ignore_rules(
    state: State<'_, AppState>,
    rules: Vec<IgnoreRule>,
) -> Result<Vec<IgnoreRule>, String> {
    let saved = state.storage.save_ignore_rules(rules)?;
    state.tts.refresh_pipeline();
    Ok(saved)
}

#[tauri::command]
pub fn validate_rule_regex(
    pattern: String,
    match_case: bool,
    ignore_word_boundary: bool,
    is_regex: bool,
) -> Result<(), String> {
    validate_rule_pattern(&pattern, match_case, ignore_word_boundary, is_regex)
}

#[tauri::command]
pub fn export_rules_json(
    state: State<'_, AppState>,
    kind: String,
    path: String,
) -> Result<(), String> {
    let json = match kind.as_str() {
        "pronunciation" => serde_json::to_string_pretty(&state.storage.pronunciations()),
        "ignore" => serde_json::to_string_pretty(&state.storage.ignore_rules()),
        other => return Err(format!("Unknown rules kind: {other}")),
    }
    .map_err(|e| format!("Failed serializing rules: {e}"))?;

    std::fs::write(Path::new(&path), json.as_bytes())
        .map_err(|e| format!("Failed writing {}: {e}", path))
}

#[tauri::command]
pub fn import_rules_json(
    state: State<'_, AppState>,
    kind: String,
    path: String,
) -> Result<usize, String> {
    let raw = std::fs::read_to_string(Path::new(&path))
        .map_err(|e| format!("Failed reading {}: {e}", path))?;

    let added = match kind.as_str() {
        "pronunciation" => {
            let incoming: Vec<PronunciationRule> = serde_json::from_str(&raw)
                .map_err(|e| format!("Invalid pronunciation rules JSON: {e}"))?;
            let mut merged = state.storage.pronunciations();
            let mut count = 0usize;
            for mut r in incoming {
                if r.source.trim().is_empty() {
                    continue;
                }
                r.id = uuid::Uuid::new_v4().to_string();
                merged.push(r);
                count += 1;
            }
            state.storage.save_pronunciations(merged)?;
            count
        }
        "ignore" => {
            let incoming: Vec<IgnoreRule> = serde_json::from_str(&raw)
                .map_err(|e| format!("Invalid ignore rules JSON: {e}"))?;
            let mut merged = state.storage.ignore_rules();
            let mut count = 0usize;
            for mut r in incoming {
                if r.pattern.trim().is_empty() {
                    continue;
                }
                r.id = uuid::Uuid::new_v4().to_string();
                merged.push(r);
                count += 1;
            }
            state.storage.save_ignore_rules(merged)?;
            count
        }
        other => return Err(format!("Unknown rules kind: {other}")),
    };

    state.tts.refresh_pipeline();
    Ok(added)
}

#[tauri::command]
pub fn import_book_file(state: State<'_, AppState>, path: String) -> Result<BookMeta, String> {
    import_book(Path::new(&path), &state.storage)
}

#[tauri::command]
pub fn open_book(state: State<'_, AppState>, book_id: String) -> Result<DocumentPayload, String> {
    let mut book = state
        .storage
        .get_book(&book_id)
        .ok_or_else(|| format!("Book not found: {book_id}"))?;
    book.last_opened_at = now_unix_secs();
    let _ = state.storage.upsert_book(book.clone());

    let mut settings = state.storage.settings();
    settings.last_book_id = Some(book_id.clone());
    let _ = state.storage.save_settings(settings);

    state
        .media_keys
        .update_status(Some(&book.title), false, false);

    if book.format == BookFormat::Pdf {
        // PDF text extraction runs with PDF.js using the book's ignore margins and then calls set_pdf_sentences
        return Ok(DocumentPayload {
            book,
            sentences: Vec::new(),
            toc: Vec::new(),
            html_chapters: Vec::new(),
        });
    }

    let path = state.storage.paths().book_path(&book.stored_filename)?;
    let payload = load_non_pdf_document(&path, book.clone())?;
    let _ = state.storage.upsert_book(payload.book.clone());
    state.tts.load_document(
        payload.book.id.clone(),
        payload.sentences.clone(),
        payload.book.current_sentence_idx,
        true,
    );
    Ok(payload)
}

#[tauri::command]
pub fn set_pdf_sentences(
    state: State<'_, AppState>,
    book_id: String,
    sentences: Vec<SentenceItem>,
    cursor_idx: usize,
    preserving: bool,
) -> Result<BookMeta, String> {
    let total_words: usize = sentences
        .iter()
        .map(|s| s.text.split_whitespace().count())
        .sum();
    state.storage.update_book_progress(
        &book_id,
        cursor_idx,
        None,
        None,
        Some(sentences.len()),
        Some(total_words),
    )?;
    if preserving {
        state.tts.update_sentences_preserving_pos(sentences, cursor_idx);
    } else {
        state.tts.load_document(book_id.clone(), sentences, cursor_idx, true);
    }
    state
        .storage
        .get_book(&book_id)
        .ok_or_else(|| "Book missing after update".to_string())
}

#[tauri::command]
pub fn update_pdf_margins(
    state: State<'_, AppState>,
    book_id: String,
    header_pct: f32,
    footer_pct: f32,
) -> Result<BookMeta, String> {
    state
        .storage
        .update_pdf_margins(&book_id, header_pct, footer_pct)
}

#[tauri::command]
pub fn save_reading_progress(
    state: State<'_, AppState>,
    book_id: String,
    sentence_idx: usize,
    page: Option<usize>,
    scroll_y: Option<f64>,
) -> Result<(), String> {
    state
        .storage
        .update_book_progress(&book_id, sentence_idx, page, scroll_y, None, None)
}

#[tauri::command]
pub fn add_bookmark(
    state: State<'_, AppState>,
    book_id: String,
    label: String,
    sentence_idx: usize,
    page: Option<usize>,
) -> Result<BookMeta, String> {
    let bm = Bookmark {
        id: uuid::Uuid::new_v4().to_string(),
        label,
        sentence_idx,
        page,
        created_at: now_unix_secs(),
    };
    state.storage.add_bookmark(&book_id, bm)
}

#[tauri::command]
pub fn remove_bookmark(
    state: State<'_, AppState>,
    book_id: String,
    bookmark_id: String,
) -> Result<BookMeta, String> {
    state.storage.remove_bookmark(&book_id, &bookmark_id)
}

#[tauri::command]
pub fn delete_book(state: State<'_, AppState>, book_id: String) -> Result<Vec<BookMeta>, String> {
    if state.tts.current_state_event().book_id.as_deref() == Some(book_id.as_str()) {
        state.tts.stop();
    }
    if let Some(filename) = state.storage.delete_book(&book_id)?
        && let Ok(p) = state.storage.paths().book_path(&filename)
    {
        let _ = std::fs::remove_file(p);
    }
    Ok(state.storage.library())
}

#[tauri::command]
pub fn tts_play_from(state: State<'_, AppState>, sentence_idx: usize) -> Result<TtsStateEvent, String> {
    state.tts.ensure_model_loaded()?;
    state.tts.play_from(sentence_idx);
    let evt = state.tts.current_state_event();
    let title = evt
        .book_id
        .as_deref()
        .and_then(|id| state.storage.get_book(id))
        .map(|b| b.title);
    state
        .media_keys
        .update_status(title.as_deref(), true, false);
    Ok(evt)
}

#[tauri::command]
pub fn tts_toggle_play_pause(state: State<'_, AppState>) -> Result<TtsStateEvent, String> {
    state.tts.ensure_model_loaded()?;
    state.tts.toggle_play_pause();
    let evt = state.tts.current_state_event();
    let playing = evt.status == "playing" || evt.status == "loading";
    let paused = evt.status == "paused";
    state.media_keys.update_status(None, playing, paused);
    Ok(evt)
}

#[tauri::command]
pub fn tts_pause(state: State<'_, AppState>) -> TtsStateEvent {
    state.tts.pause();
    state.media_keys.update_status(None, false, true);
    state.tts.current_state_event()
}

#[tauri::command]
pub fn tts_step_sentence(state: State<'_, AppState>, delta: isize) -> TtsStateEvent {
    state.tts.step_sentence(delta);
    state.tts.current_state_event()
}

#[tauri::command]
pub async fn tts_preview_text(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    voice_id: Option<String>,
) -> Result<(), String> {
    let vid = voice_id.unwrap_or_else(|| state.storage.settings().voice_id);
    if vid != "default" && !state.storage.paths().is_voice_downloaded(&vid) {
        state
            .downloader
            .download_voice(&app, state.storage.paths(), &vid)
            .await?;
    }
    state.tts.ensure_model_loaded()?;
    state.tts.preview_text(&text, Some(&vid))
}

#[tauri::command]
pub async fn start_audio_export(
    app: AppHandle,
    state: State<'_, AppState>,
    req: ExportRequest,
) -> Result<String, String> {
    if req.voice_id != "default" && !state.storage.paths().is_voice_downloaded(&req.voice_id) {
        state
            .downloader
            .download_voice(&app, state.storage.paths(), &req.voice_id)
            .await?;
    }
    state.tts.ensure_model_loaded()?;
    state.exporter.start_export(app, req)
}

#[tauri::command]
pub fn cancel_audio_export(state: State<'_, AppState>) -> Result<(), String> {
    state.exporter.cancel()
}

#[tauri::command]
pub fn get_export_progress(state: State<'_, AppState>) -> Option<ExportProgressEvent> {
    state.exporter.current_progress()
}

#[tauri::command]
pub fn set_sleep_timer(
    state: State<'_, AppState>,
    mode: String,
    minutes: Option<u64>,
    end_sentence_idx: Option<usize>,
) -> SleepTimerStatus {
    match mode.as_str() {
        "minutes" => state.sleep_timer.set_minutes(minutes.unwrap_or(15)),
        "end_of_chapter" => state
            .sleep_timer
            .set_end_of_chapter(end_sentence_idx.unwrap_or(usize::MAX)),
        _ => state.sleep_timer.clear(),
    }
}

#[tauri::command]
pub fn open_folder_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let dir = if p.is_file() {
        p.parent().unwrap_or(&p).to_path_buf()
    } else {
        p
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed opening Explorer: {e}"))?;
    }
    Ok(())
}
