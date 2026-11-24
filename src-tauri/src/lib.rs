//! BookReader Tauri application wiring, custom protocol, and backend services.

mod commands;
mod documents;
mod downloader;
mod exporter;
mod media_keys;
mod models;
mod paths;
pub mod self_test;
mod sleep_timer;
mod storage;
mod text_pipeline;
mod tts;
mod voices;
mod window_state;

use commands::AppState;
use downloader::DownloadManager;
use exporter::ExportManager;
use media_keys::MediaKeysBridge;
use paths::AppPaths;
use sleep_timer::SleepTimer;
use std::sync::Arc;
use storage::Storage;
use tauri::Manager;
use tts::TtsController;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

    let paths = AppPaths::init().expect("Failed to initialize BookReader folders");
    let storage = Arc::new(Storage::load(paths.clone()).expect("Failed to initialize storage"));
    let downloader = Arc::new(DownloadManager::new().expect("Failed to initialize downloader"));

    let storage_for_protocol = Arc::clone(&storage);
    let paths_for_protocol = paths.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("bookmedia", move |_ctx, request| {
            documents::handle_media_request(&paths_for_protocol, &storage_for_protocol, &request)
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let tts = TtsController::start(handle.clone(), Arc::clone(&storage))
                .expect("Failed starting TTS controller");
            let exporter = Arc::new(ExportManager::new(
                Arc::clone(&storage),
                Arc::clone(tts.engine()),
            ));
            let media_keys = Arc::new(MediaKeysBridge::init(&handle, Arc::clone(&tts)));
            let sleep_timer = SleepTimer::start(handle.clone(), Arc::clone(&storage), Arc::clone(&tts));

            if let Some(main_window) = app.get_webview_window("main") {
                window_state::init_window_state(main_window, Arc::clone(&storage));
            }

            app.manage(AppState {
                storage,
                downloader,
                tts,
                exporter,
                media_keys,
                sleep_timer,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::get_qwen_model_status,
            commands::set_qwen_model_variant,
            commands::download_qwen_model,
            commands::probe_clone_audio,
            commands::preview_clone_slice,
            commands::create_cloned_voice,
            commands::delete_cloned_voice,
            commands::download_model,
            commands::download_voice,
            commands::download_all_voices,
            commands::list_voices,
            commands::update_settings,
            commands::select_voice,
            commands::save_pronunciation_rules,
            commands::save_ignore_rules,
            commands::validate_rule_regex,
            commands::export_rules_json,
            commands::import_rules_json,
            commands::import_book_file,
            commands::open_book,
            commands::set_pdf_sentences,
            commands::update_pdf_margins,
            commands::save_reading_progress,
            commands::add_bookmark,
            commands::remove_bookmark,
            commands::delete_book,
            commands::tts_play_from,
            commands::tts_toggle_play_pause,
            commands::tts_pause,
            commands::tts_step_sentence,
            commands::tts_preview_text,
            commands::start_audio_export,
            commands::cancel_audio_export,
            commands::get_export_progress,
            commands::set_sleep_timer,
            commands::open_folder_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("Error while running BookReader");
}
