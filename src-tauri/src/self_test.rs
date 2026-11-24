//! Comprehensive runtime feature self-test executed inside the compiled release binary
//! via `--self-test` or `--self-test-live-tts`.

use crate::documents::{handle_media_request, import_book, load_non_pdf_document, media_base_url, media_url};
use crate::downloader::DownloadManager;
use crate::exporter::{AudioExportSink, SleepInhibitor};
use crate::models::{
    BookFormat, Bookmark, BracketMode, ExportFormat, IgnoreRule, PauseSettings, PronunciationRule,
    QwenModelVariant, SanitizerSettings, SentenceItem, WindowState,
};
use crate::paths::{AppPaths, bundle_container_dir, resolve_release_data_dir};
use crate::storage::Storage;
use crate::text_pipeline::{ProcessedSentence, TextPipeline};
use crate::tts::alignment::align_words;
use crate::tts::audio::{AudioOutput, MODEL_SAMPLE_RATE};
use crate::tts::engine::PhononEngine;
use crate::tts::pauses::{apply_clause_pause_boost, compute_trailing_pause_ms, trim_and_fade};
use crate::tts::qwen_engine::{
    QWEN_SAMPLE_RATE, QwenCloneEngine, classify_clip_duration, slice_and_normalize_reference,
};
use crate::tts::wsola::WsolaStretcher;
use crate::window_state::{MonitorInfo, Rect, resolve_initial_placement, resolve_window_placement};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::http::{Method, Request, StatusCode, header};
use zip::write::SimpleFileOptions;

fn step<F: FnOnce() -> Result<String, String>>(name: &str, f: F) -> Result<(), String> {
    match f() {
        Ok(detail) => {
            println!("[PASS] {name}: {detail}");
            Ok(())
        }
        Err(err) => Err(format!("[FAIL] {name}: {err}")),
    }
}

fn ensure(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        Ok(())
    } else {
        Err(msg.to_string())
    }
}

/// Initializes real runtime `AppPaths` without opening a GUI window and prints resolved locations.
pub fn check_portable_init() -> Result<(), String> {
    let paths = AppPaths::init()?;
    println!("APPDATA_DIR={}", paths.appdata_dir.display());
    println!("DATA_DIR={}", paths.data_dir.display());
    ensure(paths.models_dir.is_dir(), "models_dir missing")?;
    ensure(paths.voices_dir.is_dir(), "voices_dir missing")?;
    ensure(paths.books_dir.is_dir(), "books_dir missing")?;
    Ok(())
}

/// Runs end-to-end feature verification inside an isolated temporary workspace.
pub fn run_self_test(live_tts: bool) -> Result<(), String> {
    let root = std::env::temp_dir().join(format!("bookreader_selftest_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).map_err(|e| format!("Failed creating self-test root: {e}"))?;

    let result = run_inner(&root, live_tts);
    let _ = fs::remove_dir_all(&root);
    result
}

fn run_inner(root: &Path, live_tts: bool) -> Result<(), String> {
    let appdata_dir = root.join("config/Bookreader");
    let data_dir = root.join("portable/BookReader_Data");
    let paths = AppPaths::from_roots(appdata_dir.clone(), data_dir.clone())?;

    step("1. Portable & Fallback Path Resolution", || {
        let sim_portable = root.join("sim_portable");
        let sim_exe = sim_portable.join("BookReader.app/Contents/MacOS/BookReader");
        fs::create_dir_all(sim_exe.parent().unwrap())
            .map_err(|e| format!("mkdir failed: {e}"))?;
        ensure(
            bundle_container_dir(&sim_exe) == sim_portable,
            "bundle_container_dir did not resolve parent of .app",
        )?;
        let mac_resolved = resolve_release_data_dir(&sim_exe, &appdata_dir, true);
        ensure(
            mac_resolved == sim_portable.join("BookReader_Data"),
            &format!("Expected portable BookReader_Data next to .app, got {}", mac_resolved.display()),
        )?;

        let translocated = PathBuf::from(
            "/private/var/folders/aa/T/AppTranslocation/1234/d/BookReader.app/Contents/MacOS/BookReader",
        );
        ensure(
            resolve_release_data_dir(&translocated, &appdata_dir, true)
                == appdata_dir.join("BookReader_Data"),
            "AppTranslocation did not fall back to appdata BookReader_Data",
        )?;

        let apps_exe = PathBuf::from("/Applications/BookReader.app/Contents/MacOS/BookReader");
        ensure(
            resolve_release_data_dir(&apps_exe, &appdata_dir, true)
                == appdata_dir.join("BookReader_Data"),
            "/Applications did not fall back to appdata BookReader_Data",
        )?;
        Ok(format!(
            "portable={} | appdata={}",
            mac_resolved.display(),
            appdata_dir.display()
        ))
    })?;

    let storage = Storage::load(paths.clone())?;
    step("2. Storage Persistence (Settings, Bookmarks, Rules, WindowState)", || {
        let mut s = storage.settings();
        s.speed = 1.25;
        s.theme = "light".to_string();
        s.qwen_model_variant = QwenModelVariant::Fast0_6B;
        storage.save_settings(s)?;

        storage.save_pronunciations(vec![PronunciationRule {
            id: "p1".into(),
            source: "gacha".into(),
            replace: "gotcha".into(),
            match_case: false,
            ignore_word_boundary: false,
            is_regex: false,
            enabled: true,
        }])?;
        storage.save_ignore_rules(vec![IgnoreRule {
            id: "i1".into(),
            pattern: "[SFX]".into(),
            match_case: true,
            ignore_word_boundary: true,
            is_regex: false,
            enabled: true,
        }])?;

        let reloaded = Storage::load(paths.clone())?;
        ensure(
            (reloaded.settings().speed - 1.25).abs() < 1e-4,
            "Speed setting did not round-trip",
        )?;
        ensure(
            reloaded.pronunciations().len() == 1 && reloaded.ignore_rules().len() == 1,
            "Rules did not round-trip",
        )?;
        Ok("settings + rules round-trip verified".to_string())
    })?;

    let mut imported_pdf_id = String::new();
    let mut imported_epub_id = String::new();
    step("3. Document Importers & Parsers (TXT, DOCX, EPUB, PDF + Bookmarks)", || {
        let txt_src = root.join("story.txt");
        fs::write(&txt_src, "Chapter One\n\nHello world. This is BookReader!\n\nSecond paragraph.")
            .map_err(|e| e.to_string())?;
        let txt_meta = import_book(&txt_src, &storage)?;
        ensure(txt_meta.format == BookFormat::Txt, "TXT format mismatch")?;
        let txt_doc = load_non_pdf_document(&paths.book_path(&txt_meta.stored_filename)?, txt_meta)?;
        ensure(txt_doc.sentences.len() >= 3, "TXT sentences missing")?;

        let docx_src = root.join("doc.docx");
        {
            let f = File::create(&docx_src).map_err(|e| e.to_string())?;
            let mut zw = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("word/_rels/document.xml.rels", opts).map_err(|e| e.to_string())?;
            zw.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="media/img.png"/></Relationships>"#,
            )
            .map_err(|e| e.to_string())?;
            zw.start_file("word/media/img.png", opts).map_err(|e| e.to_string())?;
            zw.write_all(b"\x89PNG\r\n\x1a\nFAKEPNG").map_err(|e| e.to_string())?;
            zw.start_file("word/document.xml", opts).map_err(|e| e.to_string())?;
            zw.write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Doc Title</w:t></w:r></w:p><w:p><w:r><a:blip r:embed="rId1"/><w:t>Word paragraph.</w:t></w:r></w:p></w:body></w:document>"#,
            )
            .map_err(|e| e.to_string())?;
            zw.finish().map_err(|e| e.to_string())?;
        }
        let docx_meta = import_book(&docx_src, &storage)?;
        let docx_doc = load_non_pdf_document(&paths.book_path(&docx_meta.stored_filename)?, docx_meta)?;
        ensure(docx_doc.sentences.len() == 2, "DOCX sentence count mismatch")?;

        let epub_src = root.join("novel.epub");
        {
            let f = File::create(&epub_src).map_err(|e| e.to_string())?;
            let mut zw = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("META-INF/container.xml", opts).map_err(|e| e.to_string())?;
            zw.write_all(
                br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
            )
            .map_err(|e| e.to_string())?;
            zw.start_file("OEBPS/content.opf", opts).map_err(|e| e.to_string())?;
            zw.write_all(
                br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/opf/2007"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB Sample</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#,
            )
            .map_err(|e| e.to_string())?;
            zw.start_file("OEBPS/Images/cover.png", opts).map_err(|e| e.to_string())?;
            zw.write_all(b"\x89PNG\r\n\x1a\nCOVER").map_err(|e| e.to_string())?;
            zw.start_file("OEBPS/ch1.xhtml", opts).map_err(|e| e.to_string())?;
            zw.write_all(
                br#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter 1</h1><img src="Images/cover.png"/><p>&ldquo;Ready?&rdquo;&mdash;Let us go.</p></body></html>"#,
            )
            .map_err(|e| e.to_string())?;
            zw.finish().map_err(|e| e.to_string())?;
        }
        let epub_meta = import_book(&epub_src, &storage)?;
        imported_epub_id = epub_meta.id.clone();
        let epub_doc = load_non_pdf_document(&paths.book_path(&epub_meta.stored_filename)?, epub_meta)?;
        ensure(epub_doc.sentences.len() >= 2, "EPUB sentence count mismatch")?;

        let pdf_src = root.join("paper.pdf");
        fs::write(&pdf_src, b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
            .map_err(|e| e.to_string())?;
        let pdf_meta = import_book(&pdf_src, &storage)?;
        imported_pdf_id = pdf_meta.id.clone();
        let with_bm = storage.add_bookmark(
            &pdf_meta.id,
            Bookmark {
                id: "bm1".into(),
                label: "Page 1".into(),
                sentence_idx: 0,
                page: Some(1),
                created_at: 1,
            },
        )?;
        ensure(with_bm.bookmarks.len() == 1, "Bookmark add failed")?;
        let after_rm = storage.remove_bookmark(&pdf_meta.id, "bm1")?;
        ensure(after_rm.bookmarks.is_empty(), "Bookmark remove failed")?;

        Ok("TXT, DOCX, EPUB, PDF + bookmarks verified".to_string())
    })?;

    step("4. bookmedia:// / http://bookmedia.localhost Protocol & Range Requests", || {
        let base = media_base_url();
        let pdf_uri = media_url("book", &imported_pdf_id, "");
        ensure(pdf_uri.starts_with(base), "media_url prefix mismatch")?;

        let opts = Request::builder()
            .method(Method::OPTIONS)
            .uri(&pdf_uri)
            .body(Vec::new())
            .map_err(|e| e.to_string())?;
        ensure(
            handle_media_request(&paths, &storage, &opts).status() == StatusCode::NO_CONTENT,
            "OPTIONS preflight failed",
        )?;

        let range_req = Request::builder()
            .method(Method::GET)
            .uri(&pdf_uri)
            .header(header::RANGE, "bytes=0-7")
            .body(Vec::new())
            .map_err(|e| e.to_string())?;
        let range_resp = handle_media_request(&paths, &storage, &range_req);
        ensure(
            range_resp.status() == StatusCode::PARTIAL_CONTENT && range_resp.body() == b"%PDF-1.4",
            "PDF Range 206 response mismatch",
        )?;

        let img_req = Request::builder()
            .method(Method::GET)
            .uri(media_url("epub", &imported_epub_id, "OEBPS/Images/cover.png"))
            .body(Vec::new())
            .map_err(|e| e.to_string())?;
        let img_resp = handle_media_request(&paths, &storage, &img_req);
        ensure(
            img_resp.status() == StatusCode::OK && !img_resp.body().is_empty(),
            "Embedded EPUB image fetch failed",
        )?;

        Ok(format!("base={base} | 206 Range + EPUB image OK"))
    })?;

    step("5. Pre-TTS Sanitizer, Ignore & Pronunciation Rules Pipeline", || {
        let san = SanitizerSettings {
            strip_kaomoji_emotes: true,
            strip_decorative_dividers: true,
            strip_emojis_symbols: true,
            skip_citation_brackets: true,
            bracket_mode: BracketMode::StripBracketsReadInner,
        };
        let pipe = TextPipeline::compile(&san, &storage.ignore_rules(), &storage.pronunciations());
        let out = pipe.process("[SFX] Wait!!!! Look at gacha [12] (quietly) (╯°□°)╯︵ ┻━┻");
        match out {
            ProcessedSentence::Speak(text) => {
                ensure(text.contains("gotcha"), "Pronunciation replacement missing")?;
                ensure(!text.contains("[SFX]"), "Ignore rule did not strip [SFX]")?;
                ensure(!text.contains("!!!!"), "Repeated punctuation not normalized")?;
                ensure(!text.contains("[12]"), "Citation bracket not stripped")?;
                Ok(format!("processed=\"{text}\""))
            }
            other => Err(format!("Unexpected Skip: {other:?}")),
        }
    })?;

    step("6. WSOLA Speed Stretching, Word Alignment & Boundary Pauses", || {
        let tone: Vec<f32> = (0..24_000)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * 190.0 * i as f32 / 24_000.0).sin())
            .collect();
        let trimmed = trim_and_fade(&tone, MODEL_SAMPLE_RATE);
        let boosted = apply_clause_pause_boost(trimmed, "First, second.", 40, 0, MODEL_SAMPLE_RATE);
        let timings = align_words("First, second.", &boosted, MODEL_SAMPLE_RATE);
        ensure(timings.len() == 2, "Word alignment count mismatch")?;

        let stretcher = WsolaStretcher::new(MODEL_SAMPLE_RATE);
        let (fast, map) = stretcher.stretch(&boosted, 1.5);
        ensure(!fast.is_empty() && fast.len() < boosted.len(), "1.5x stretch failed")?;
        ensure(map.len() == fast.len(), "WSOLA src_map length mismatch")?;

        let sent = SentenceItem {
            text: "First, second.".into(),
            is_paragraph_end: true,
            ..SentenceItem::default()
        };
        let pause = compute_trailing_pause_ms(&sent, &PauseSettings::default(), 1.5);
        ensure(pause > 0, "Pause duration was 0")?;

        Ok(format!(
            "words={} | stretched={} samples | pause={}ms",
            timings.len(),
            fast.len(),
            pause
        ))
    })?;

    step("7. AudioOutput Queue, Live Respeed & Playback Snapshot", || {
        // Test real AudioOutput::start (must never fail even on speakerless CI runners)
        let _real_audio = AudioOutput::start(1.0, 0.9)?;

        let headless = AudioOutput::new_headless(1.0, 1.0);
        let seg_gen = headless.generation();
        let tone: Vec<f32> = (0..24_000)
            .map(|i| 0.25 * (2.0 * std::f32::consts::PI * 200.0 * i as f32 / 24_000.0).sin())
            .collect();
        headless.enqueue_speech(seg_gen, 0, false, tone, 150, Vec::new());
        ensure(headless.snapshot().has_audio, "Audio queue did not accept segment")?;
        headless.set_speed(1.4);
        ensure(
            (headless.current_speed() - 1.4).abs() < 1e-3,
            "AudioOutput speed update failed",
        )?;
        headless.flush_and_bump_generation();
        ensure(!headless.snapshot().has_audio, "Flush did not clear queue")?;
        Ok(format!("standby_ok=true | real_device_ready={}", _real_audio.is_output_ready()))
    })?;

    step("8. Qwen3-TTS Device Detection & Reference Clip Slicing", || {
        let label = QwenCloneEngine::detect_device_label();
        ensure(!label.is_empty(), "Empty device label")?;
        let (_, _, _) = {
            let (status, s, e, _) = classify_clip_duration(42.0);
            ensure(status == "will_trim" && (e - s - 15.0).abs() < 1e-3, "Duration classification error")?;
            (status, s, e)
        };
        let clip: Vec<f32> = (0..QWEN_SAMPLE_RATE as usize * 8)
            .map(|i| 0.2 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / QWEN_SAMPLE_RATE as f32).sin())
            .collect();
        let (norm, dur) = slice_and_normalize_reference(&clip, QWEN_SAMPLE_RATE, Some(1.0), Some(6.0))?;
        ensure(!norm.is_empty() && (dur - 5.0).abs() < 0.1, "Reference slice duration mismatch")?;
        Ok(format!("device=\"{label}\" | sliced={dur:.1}s"))
    })?;

    step("9. WAV & MP3 Audio Export + Sleep Inhibitor", || {
        let _sleep = SleepInhibitor::acquire();
        let tone: Vec<f32> = (0..12_000)
            .map(|i| 0.25 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 24_000.0).sin())
            .collect();

        let wav = root.join("out.wav");
        let mut ws = AudioExportSink::create(ExportFormat::Wav, &wav, "SelfTest")?;
        ws.write_f32_chunk(&tone)?;
        ws.write_silence(1200)?;
        ws.finish()?;
        let wb = fs::read(&wav).map_err(|e| e.to_string())?;
        ensure(wb.len() > 44 && &wb[0..4] == b"RIFF", "Invalid WAV header")?;

        let mp3 = root.join("out.mp3");
        let mut ms = AudioExportSink::create(ExportFormat::Mp3, &mp3, "SelfTest")?;
        ms.write_f32_chunk(&tone)?;
        ms.write_silence(1200)?;
        ms.finish()?;
        let mb = fs::read(&mp3).map_err(|e| e.to_string())?;
        ensure(mb.len() > 256, "Invalid MP3 output")?;

        Ok(format!("wav={}B | mp3={}B", wb.len(), mb.len()))
    })?;

    step("10. Multi-Monitor & Retina Window Placement Safeguards", || {
        let retina = vec![MonitorInfo {
            work_area: Rect {
                x: 0,
                y: 50,
                width: 3024,
                height: 1850,
            },
            scale_factor: 2.0,
            is_primary: true,
        }];
        let init = resolve_initial_placement(&retina)
            .ok_or_else(|| "Initial placement returned None".to_string())?;
        ensure(init.y >= 50, "Window overlapped macOS menu bar area")?;

        let unplugged = WindowState {
            x: 4000,
            y: 100,
            width: 1400,
            height: 900,
            maximized: false,
            scale_factor: 1.0,
            ..WindowState::default()
        };
        let recovered = resolve_window_placement(&unplugged, &retina)
            .ok_or_else(|| "Recovery placement returned None".to_string())?;
        ensure(recovered.relocated && recovered.x < 3024, "Off-screen window was not relocated")?;
        Ok(format!("initial=({},{}) {}x{}", init.x, init.y, init.width, init.height))
    })?;

    if live_tts {
        step("11. Live Phonon 31M Download + Neural Synthesis + WAV/MP3 Export", || {
            let downloader = DownloadManager::new()?;
            let rt = tokio::runtime::Runtime::new()
                .map_err(|e| format!("Failed creating tokio runtime: {e}"))?;
            rt.block_on(downloader.download_phonon_model_headless(&paths, Some("default")))?;
            ensure(paths.model_ready(), "Phonon 31M model files incomplete after download")?;

            let engine = PhononEngine::new();
            engine.ensure_loaded(&paths)?;
            let raw_pcm = engine.synthesize(
                &paths,
                QwenModelVariant::Fast0_6B,
                None,
                "Hello from BookReader on this platform.",
                "default",
            )?;
            ensure(raw_pcm.len() > 4000, "Synthesized speech too short")?;
            let peak = raw_pcm.iter().fold(0.0_f32, |m, &s| m.max(s.abs()));
            ensure(peak > 0.01, "Synthesized speech was silent")?;

            let trimmed = trim_and_fade(&raw_pcm, MODEL_SAMPLE_RATE);
            let timings = align_words(
                "Hello from BookReader on this platform.",
                &trimmed,
                MODEL_SAMPLE_RATE,
            );
            ensure(timings.len() == 6, "Live TTS word alignment mismatch")?;

            let stretcher = WsolaStretcher::new(MODEL_SAMPLE_RATE);
            let (stretched, _) = stretcher.stretch(&trimmed, 1.25);

            let live_mp3 = root.join("live_tts.mp3");
            let mut sink = AudioExportSink::create(ExportFormat::Mp3, &live_mp3, "LiveTTS")?;
            sink.write_f32_chunk(&stretched)?;
            sink.finish()?;
            let mp3_size = fs::metadata(&live_mp3).map(|m| m.len()).unwrap_or(0);
            ensure(mp3_size > 1000, "Live TTS MP3 export too small")?;

            Ok(format!(
                "pcm={} samples (peak={peak:.3}) | mp3={mp3_size}B",
                raw_pcm.len()
            ))
        })?;
    }

    println!("ALL SELF-TESTS PASSED (live_tts={live_tts})");
    Ok(())
}
