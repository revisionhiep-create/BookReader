//! Tauri IPC commands bridging frontend UI actions and Rust backend engines.

use crate::documents::{import_book, import_book_bytes as store_imported_book_bytes, load_non_pdf_document, media_base_url};
use crate::downloader::DownloadManager;
use crate::exporter::ExportManager;
use crate::media_keys::MediaKeysBridge;
use crate::models::{
    AppBootstrap, AudioClipProbe, BookFormat, BookMeta, Bookmark, CloneVoiceRequest,
    CloneVoiceResponse, DeleteClonedVoiceResponse, DocumentPayload, ExportProgressEvent,
    ExportRequest, IgnoreRule, PronunciationRule, QwenModelStatus, QwenModelVariant,
    QwenVariantStatus, SentenceItem, SetQwenVariantResponse, Settings, SleepTimerStatus,
    TtsStateEvent, VoiceInfo,
};
use crate::paths::AppPaths;
use crate::sleep_timer::SleepTimer;
use crate::storage::{Storage, now_unix_secs};
use crate::text_pipeline::validate_rule_pattern;
use crate::tts::TtsController;
use crate::tts::qwen_engine::{decode_reference_slice, probe_audio_clip};
use crate::voices::{list_voices_with_status, pick_downloaded_fallback_voice};
use std::path::Path;
#[cfg(not(target_os = "android"))]
use std::path::PathBuf;
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
    let voice_cloning_enabled = cfg!(feature = "voice-cloning") && !cfg!(target_os = "android");
    let cloned = if voice_cloning_enabled {
        state.storage.cloned_voices()
    } else {
        Vec::new()
    };
    let mut settings = state.storage.settings();
    if !voice_cloning_enabled && AppPaths::is_cloned_voice_id(&settings.voice_id) {
        settings.voice_id = pick_downloaded_fallback_voice(paths);
        let _ = state.storage.save_settings(settings.clone());
    }
    let variant = settings.qwen_model_variant;
    let platform = if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    AppBootstrap {
        model_ready: paths.model_ready(),
        engine_loaded: state.tts.is_model_loaded(),
        qwen_model_variant: variant,
        qwen_model_ready: voice_cloning_enabled && paths.qwen_model_ready_for(variant),
        qwen_device_label: if voice_cloning_enabled {
            state.tts.engine().qwen().device_label()
        } else {
            "Disabled".to_string()
        },
        appdata_dir: paths.appdata_dir.to_string_lossy().into_owned(),
        data_dir: paths.data_dir.to_string_lossy().into_owned(),
        media_base_url: media_base_url().to_string(),
        platform: platform.to_string(),
        voice_cloning_enabled,
        settings,
        library: state.storage.library(),
        pronunciations: state.storage.pronunciations(),
        ignore_rules: state.storage.ignore_rules(),
        voices: list_voices_with_status(paths, &cloned),
        mp3_native_available: true,
        ffmpeg_available: false,
    }
}

fn build_qwen_model_status(storage: &Storage, tts: &TtsController) -> QwenModelStatus {
    let paths = storage.paths();
    let active_variant = storage.settings().qwen_model_variant;
    let qwen = tts.engine().qwen();
    let variants = QwenModelVariant::all()
        .into_iter()
        .map(|v| QwenVariantStatus {
            variant: v,
            display_name: v.display_name().to_string(),
            model_ready: paths.qwen_model_ready_for(v),
            engine_loaded: qwen.is_variant_loaded(v),
            model_dir: paths.qwen_model_dir(v).to_string_lossy().into_owned(),
            estimated_size_mb: v.estimated_size_mb(),
        })
        .collect();

    QwenModelStatus {
        active_variant,
        model_ready: paths.qwen_model_ready_for(active_variant),
        engine_loaded: qwen.is_variant_loaded(active_variant),
        device_label: qwen.device_label(),
        model_dir: paths.qwen_model_dir(active_variant).to_string_lossy().into_owned(),
        estimated_size_mb: active_variant.estimated_size_mb(),
        variants,
    }
}

fn validate_cloned_voice_ready(
    storage: &Storage,
    voice_id: &str,
    variant: QwenModelVariant,
) -> Result<(), String> {
    let paths = storage.paths();
    if storage.get_cloned_voice(voice_id).is_none() {
        return Err("Cloned voice could not be found".to_string());
    }
    if !paths.qwen_model_ready_for(variant) {
        return Err(format!(
            "{} model files are not downloaded yet. Open Voice Cloning to download them.",
            variant.display_name()
        ));
    }
    if !paths.is_cloned_voice_available(voice_id, variant) {
        return Err("Cloned voice audio/prompt files are missing on disk".to_string());
    }
    Ok(())
}

fn validate_voice_ready(storage: &Storage, voice_id: &str) -> Result<(), String> {
    let paths = storage.paths();
    if AppPaths::is_cloned_voice_id(voice_id) {
        let variant = storage.settings().qwen_model_variant;
        validate_cloned_voice_ready(storage, voice_id, variant)?;
    } else if !paths.model_ready() {
        return Err("Phonon 31M model files are not downloaded yet".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_qwen_model_status(state: State<'_, AppState>) -> Result<QwenModelStatus, String> {
    let storage = Arc::clone(&state.storage);
    let tts = Arc::clone(&state.tts);
    tokio::task::spawn_blocking(move || build_qwen_model_status(&storage, &tts))
        .await
        .map_err(|e| format!("Failed joining Qwen3-TTS status task: {e}"))
}

#[tauri::command]
pub async fn set_qwen_model_variant(
    state: State<'_, AppState>,
    variant: QwenModelVariant,
) -> Result<SetQwenVariantResponse, String> {
    if state.exporter.is_exporting_cloned_voice() {
        return Err(
            "Cannot switch Qwen3-TTS model size while an audio export is using a cloned voice."
                .to_string(),
        );
    }

    let mut settings = state.storage.settings();
    if settings.qwen_model_variant != variant {
        settings.qwen_model_variant = variant;
        settings = state.storage.save_settings(settings)?;
        if AppPaths::is_cloned_voice_id(&settings.voice_id) {
            if state.storage.paths().qwen_model_ready_for(variant) {
                state.tts.refresh_pipeline();
            } else {
                state.tts.pause_and_flush();
            }
        }
    }

    let storage = Arc::clone(&state.storage);
    let tts = Arc::clone(&state.tts);
    let status = tokio::task::spawn_blocking(move || build_qwen_model_status(&storage, &tts))
        .await
        .map_err(|e| format!("Failed joining Qwen3-TTS status task: {e}"))?;

    Ok(SetQwenVariantResponse { settings, status })
}

#[tauri::command]
pub async fn download_qwen_model(
    app: AppHandle,
    state: State<'_, AppState>,
    variant: Option<QwenModelVariant>,
) -> Result<QwenModelStatus, String> {
    let target = variant.unwrap_or_else(|| state.storage.settings().qwen_model_variant);
    state
        .downloader
        .download_qwen_model(&app, state.storage.paths(), target)
        .await?;
    let tts = Arc::clone(&state.tts);
    let storage = Arc::clone(&state.storage);
    tokio::task::spawn_blocking(move || {
        if storage.settings().qwen_model_variant == target {
            tts.ensure_qwen_loaded(target)?;
        }
        Ok::<QwenModelStatus, String>(build_qwen_model_status(&storage, &tts))
    })
    .await
    .map_err(|e| format!("Failed joining Qwen3-TTS loader task: {e}"))?
}

#[tauri::command]
pub async fn probe_clone_audio(path: String) -> Result<AudioClipProbe, String> {
    tokio::task::spawn_blocking(move || probe_audio_clip(Path::new(&path)))
        .await
        .map_err(|e| format!("Failed joining audio probe task: {e}"))?
}

#[tauri::command]
pub async fn preview_clone_slice(
    state: State<'_, AppState>,
    path: String,
    trim_start_sec: Option<f32>,
    trim_end_sec: Option<f32>,
) -> Result<(), String> {
    let (pcm, _) = tokio::task::spawn_blocking(move || {
        decode_reference_slice(Path::new(&path), trim_start_sec, trim_end_sec)
    })
    .await
    .map_err(|e| format!("Failed joining audio preview task: {e}"))??;
    state.tts.play_raw_preview_pcm(pcm);
    Ok(())
}

#[tauri::command]
pub async fn create_cloned_voice(
    state: State<'_, AppState>,
    req: CloneVoiceRequest,
) -> Result<CloneVoiceResponse, String> {
    let variant = state.storage.settings().qwen_model_variant;
    if !state.storage.paths().qwen_model_ready_for(variant) {
        return Err(format!(
            "{} model is not downloaded yet. Download it above before cloning.",
            variant.display_name()
        ));
    }
    let storage = Arc::clone(&state.storage);
    let tts = Arc::clone(&state.tts);
    let created = tokio::task::spawn_blocking(move || {
        tts.engine().qwen().clone_voice(storage.paths(), variant, &req)
    })
    .await
    .map_err(|e| format!("Failed joining voice clone task: {e}"))??;

    let cloned = state.storage.add_cloned_voice(created.clone())?;
    let voices = list_voices_with_status(state.storage.paths(), &cloned);
    Ok(CloneVoiceResponse { created, voices })
}

#[tauri::command]
pub async fn delete_cloned_voice(
    state: State<'_, AppState>,
    voice_id: String,
) -> Result<DeleteClonedVoiceResponse, String> {
    if !AppPaths::is_cloned_voice_id(&voice_id) {
        return Err("Only custom cloned voices can be deleted".to_string());
    }
    if state.exporter.is_exporting_voice(&voice_id) {
        return Err(
            "Cannot delete this cloned voice while an audio export is actively using it."
                .to_string(),
        );
    }

    state.tts.engine().qwen().evict_cached_voice(&voice_id);

    let paths_for_fs = state.storage.paths().clone();
    let vid_for_fs = voice_id.clone();
    tokio::task::spawn_blocking(move || {
        if let Ok(p) = paths_for_fs.cloned_voice_prompt_path(&vid_for_fs) {
            let _ = std::fs::remove_file(p);
        }
        for variant in QwenModelVariant::all() {
            if let Ok(p) = paths_for_fs.cloned_voice_prompt_path_for(&vid_for_fs, variant) {
                let _ = std::fs::remove_file(p);
            }
        }
        if let Ok(p) = paths_for_fs.cloned_voice_ref_wav_path(&vid_for_fs) {
            let _ = std::fs::remove_file(p);
        }
    })
    .await
    .map_err(|e| format!("Failed joining cloned voice cleanup task: {e}"))?;

    let active_playing = state.storage.settings().voice_id == voice_id;
    let remaining = state.storage.delete_cloned_voice(&voice_id)?;
    let mut settings = state.storage.settings();
    if active_playing {
        settings.voice_id = pick_downloaded_fallback_voice(state.storage.paths());
        settings = state.storage.save_settings(settings)?;
        state.tts.refresh_pipeline();
    }

    let voices = list_voices_with_status(state.storage.paths(), &remaining);
    Ok(DeleteClonedVoiceResponse { voices, settings })
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
    Ok(list_voices_with_status(
        state.storage.paths(),
        &state.storage.cloned_voices(),
    ))
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
    Ok(list_voices_with_status(
        state.storage.paths(),
        &state.storage.cloned_voices(),
    ))
}

#[tauri::command]
pub fn list_voices(state: State<'_, AppState>) -> Vec<VoiceInfo> {
    list_voices_with_status(state.storage.paths(), &state.storage.cloned_voices())
}

#[tauri::command]
pub fn update_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let prev = state.storage.settings();
    if prev.qwen_model_variant != settings.qwen_model_variant
        && state.exporter.is_exporting_cloned_voice()
    {
        return Err(
            "Cannot switch Qwen3-TTS model size while an audio export is using a cloned voice."
                .to_string(),
        );
    }

    let saved = state.storage.save_settings(settings)?;

    if (prev.speed - saved.speed).abs() > 0.001 {
        state.tts.set_speed(saved.speed);
    }
    if (prev.volume - saved.volume).abs() > 0.001 {
        state.tts.set_volume(saved.volume);
    }
    let variant_affects_active = prev.qwen_model_variant != saved.qwen_model_variant
        && AppPaths::is_cloned_voice_id(&saved.voice_id);
    if variant_affects_active
        && !state
            .storage
            .paths()
            .qwen_model_ready_for(saved.qwen_model_variant)
    {
        state.tts.pause_and_flush();
    } else if prev.sanitizer != saved.sanitizer || variant_affects_active {
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
    if AppPaths::is_cloned_voice_id(&voice_id) {
        let variant = state.storage.settings().qwen_model_variant;
        validate_cloned_voice_ready(&state.storage, &voice_id, variant)?;
    } else if voice_id != "default" && !state.storage.paths().is_voice_downloaded(&voice_id) {
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
    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        let tmp_dir = state.storage.paths().data_dir.join("import_tmp");
        let copied = crate::media_keys::copy_android_content_uri(&path, &tmp_dir)?;
        let res = import_book(&copied, &state.storage);
        if let Some(parent) = copied.parent() {
            if parent != tmp_dir.as_path() && parent.starts_with(&tmp_dir) {
                let _ = std::fs::remove_dir_all(parent);
            } else {
                let _ = std::fs::remove_file(&copied);
            }
        } else {
            let _ = std::fs::remove_file(&copied);
        }
        return res;
    }
    import_book(Path::new(&path), &state.storage)
}

#[tauri::command]
pub fn import_book_bytes(
    state: State<'_, AppState>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<BookMeta, String> {
    store_imported_book_bytes(&filename, &bytes, &state.storage)
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
pub fn tts_play_from(
    state: State<'_, AppState>,
    sentence_idx: usize,
) -> Result<TtsStateEvent, String> {
    let voice_id = state.storage.settings().voice_id;
    validate_voice_ready(&state.storage, &voice_id)?;

    state.tts.play_from(sentence_idx);
    let evt = state.tts.current_state_event();
    let title = evt
        .book_id
        .as_deref()
        .and_then(|id| state.storage.get_book(id))
        .map(|b| b.title);
    let playing = evt.status == "playing" || evt.status == "loading";
    let paused = evt.status == "paused";
    state
        .media_keys
        .update_status(title.as_deref(), playing, paused);
    Ok(evt)
}

#[tauri::command]
pub fn tts_toggle_play_pause(state: State<'_, AppState>) -> Result<TtsStateEvent, String> {
    if state.tts.is_actively_playing() {
        state.tts.pause();
    } else {
        let voice_id = state.storage.settings().voice_id;
        validate_voice_ready(&state.storage, &voice_id)?;
        state.tts.resume();
    }
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
    let settings = state.storage.settings();
    let vid = voice_id.unwrap_or_else(|| settings.voice_id.clone());
    if AppPaths::is_cloned_voice_id(&vid) {
        validate_cloned_voice_ready(&state.storage, &vid, settings.qwen_model_variant)?;
    } else if vid != "default" && !state.storage.paths().is_voice_downloaded(&vid) {
        state
            .downloader
            .download_voice(&app, state.storage.paths(), &vid)
            .await?;
    }

    let tts = Arc::clone(&state.tts);
    tokio::task::spawn_blocking(move || {
        tts.ensure_engine_for_voice(&vid)?;
        tts.preview_text(&text, Some(&vid))
    })
    .await
    .map_err(|e| format!("Failed joining preview synthesis task: {e}"))?
}

#[tauri::command]
pub async fn start_audio_export(
    app: AppHandle,
    state: State<'_, AppState>,
    req: ExportRequest,
) -> Result<String, String> {
    if state.exporter.is_active() {
        return Err("Another audio export is already in progress".to_string());
    }
    if AppPaths::is_cloned_voice_id(&req.voice_id) {
        let variant = state.storage.settings().qwen_model_variant;
        validate_cloned_voice_ready(&state.storage, &req.voice_id, variant)?;
    } else if req.voice_id != "default" && !state.storage.paths().is_voice_downloaded(&req.voice_id) {
        state
            .downloader
            .download_voice(&app, state.storage.paths(), &req.voice_id)
            .await?;
    }

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
    #[cfg(target_os = "android")]
    {
        let _ = path;
        return Err("Folder explorer is not available on Android".to_string());
    }
    #[cfg(not(target_os = "android"))]
    {
        let p = PathBuf::from(&path);
        #[cfg(target_os = "windows")]
        {
            let dir = if p.is_file() {
                p.parent().unwrap_or(&p).to_path_buf()
            } else {
                p
            };
            std::process::Command::new("explorer")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("Failed opening Explorer: {e}"))?;
        }
        #[cfg(target_os = "macos")]
        {
            let mut cmd = std::process::Command::new("open");
            if p.is_file() {
                cmd.arg("-R").arg(&p);
            } else {
                cmd.arg(&p);
            }
            cmd.spawn()
                .map_err(|e| format!("Failed opening Finder: {e}"))?;
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            let dir = if p.is_file() {
                p.parent().unwrap_or(&p).to_path_buf()
            } else {
                p
            };
            std::process::Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| format!("Failed opening file manager: {e}"))?;
        }
        Ok(())
    }
}
