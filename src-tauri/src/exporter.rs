//! Background streaming audio exporter (WAV & MP3) with progress, ETA, cancel, and sleep prevention.

use crate::models::{ExportFormat, ExportProgressEvent, ExportRequest, ExportScope, SentenceItem};
use crate::paths::AppPaths;
use crate::storage::Storage;
use crate::text_pipeline::{ProcessedSentence, TextPipeline};
use crate::tts::audio::MODEL_SAMPLE_RATE;
use crate::tts::engine::PhononEngine;
use crate::tts::pauses::{apply_clause_pause_boost, compute_trailing_pause_ms, trim_and_fade};
use crate::tts::wsola::WsolaStretcher;
use mp3lame_encoder::{Bitrate, Builder as LameBuilder, FlushNoGap, MonoPcm, Quality};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

struct ActiveExport {
    job_id: String,
    voice_id: String,
    cancel: Arc<AtomicBool>,
    latest: ExportProgressEvent,
}

/// Manages background audio export jobs (one export at a time to keep CPU/RAM clean).
pub struct ExportManager {
    storage: Arc<Storage>,
    engine: Arc<PhononEngine>,
    active: Arc<Mutex<Option<ActiveExport>>>,
}

impl ExportManager {
    pub fn new(storage: Arc<Storage>, engine: Arc<PhononEngine>) -> Self {
        Self {
            storage,
            engine,
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn current_progress(&self) -> Option<ExportProgressEvent> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.latest.clone())
    }

    pub fn is_active(&self) -> bool {
        self.active.lock().unwrap().as_ref().is_some_and(|existing| {
            matches!(
                existing.latest.status.as_str(),
                "preparing" | "running" | "finalizing"
            )
        })
    }

    pub fn is_exporting_voice(&self, voice_id: &str) -> bool {
        self.active.lock().unwrap().as_ref().is_some_and(|existing| {
            existing.voice_id == voice_id
                && matches!(
                    existing.latest.status.as_str(),
                    "preparing" | "running" | "finalizing"
                )
        })
    }

    pub fn is_exporting_cloned_voice(&self) -> bool {
        self.active.lock().unwrap().as_ref().is_some_and(|existing| {
            AppPaths::is_cloned_voice_id(&existing.voice_id)
                && matches!(
                    existing.latest.status.as_str(),
                    "preparing" | "running" | "finalizing"
                )
        })
    }

    pub fn cancel(&self) -> Result<(), String> {
        let guard = self.active.lock().unwrap();
        if let Some(job) = guard.as_ref() {
            job.cancel.store(true, Ordering::Release);
            Ok(())
        } else {
            Err("No export job is currently running".to_string())
        }
    }

    pub fn start_export(&self, app: AppHandle, req: ExportRequest) -> Result<String, String> {
        {
            let guard = self.active.lock().unwrap();
            if let Some(existing) = guard.as_ref()
                && matches!(
                    existing.latest.status.as_str(),
                    "preparing" | "running" | "finalizing"
                )
            {
                return Err("Another audio export is already in progress".to_string());
            }
        }

        if req.sentences.is_empty() {
            return Err("No sentences available to export".to_string());
        }

        let (start, end) = match req.scope {
            ExportScope::EntireBook => (0, req.sentences.len() - 1),
            ExportScope::Range => {
                let s = req.start_sentence.min(req.sentences.len() - 1);
                let e = req.end_sentence.clamp(s, req.sentences.len() - 1);
                (s, e)
            }
        };

        let slice: Vec<SentenceItem> = req.sentences[start..=end].to_vec();
        let total = slice.len();
        let job_id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));

        let initial = ExportProgressEvent {
            job_id: job_id.clone(),
            book_title: req.book_title.clone(),
            format: req.format,
            status: "preparing".to_string(),
            completed_sentences: 0,
            total_sentences: total,
            percent: 0.0,
            elapsed_sec: 0.0,
            eta_sec: None,
            realtime_factor: 0.0,
            bytes_written: 0,
            output_path: req.output_path.clone(),
            error: None,
        };

        {
            let mut guard = self.active.lock().unwrap();
            *guard = Some(ActiveExport {
                job_id: job_id.clone(),
                voice_id: req.voice_id.clone(),
                cancel: Arc::clone(&cancel),
                latest: initial.clone(),
            });
        }
        let _ = app.emit("export:progress", &initial);

        let storage = Arc::clone(&self.storage);
        let engine = Arc::clone(&self.engine);
        let active_ref = Arc::clone(&self.active);
        let ret_job_id = job_id.clone();

        std::thread::Builder::new()
            .name("bookreader-export".to_string())
            .spawn(move || {
                run_export_worker(app, storage, engine, active_ref, job_id, cancel, req, slice);
            })
            .map_err(|e| format!("Failed starting export thread: {e}"))?;

        Ok(ret_job_id)
    }
}

#[allow(clippy::too_many_arguments)]
fn run_export_worker(
    app: AppHandle,
    storage: Arc<Storage>,
    engine: Arc<PhononEngine>,
    active_ref: Arc<Mutex<Option<ActiveExport>>>,
    job_id: String,
    cancel: Arc<AtomicBool>,
    req: ExportRequest,
    sentences: Vec<SentenceItem>,
) {
    let _sleep_guard = SleepInhibitor::acquire();
    let started = Instant::now();
    let total = sentences.len();

    let emit_state = |status: &str,
                      done: usize,
                      eta: Option<f64>,
                      rt: f64,
                      bytes: u64,
                      error: Option<String>| {
        let pct = if total == 0 {
            100.0
        } else {
            ((done as f32 / total as f32) * 100.0).min(100.0)
        };
        let evt = ExportProgressEvent {
            job_id: job_id.clone(),
            book_title: req.book_title.clone(),
            format: req.format,
            status: status.to_string(),
            completed_sentences: done,
            total_sentences: total,
            percent: pct,
            elapsed_sec: started.elapsed().as_secs_f64(),
            eta_sec: eta,
            realtime_factor: rt,
            bytes_written: bytes,
            output_path: req.output_path.clone(),
            error,
        };
        if let Some(slot) = active_ref.lock().unwrap().as_mut()
            && slot.job_id == job_id
        {
            slot.latest = evt.clone();
        }
        let _ = app.emit("export:progress", &evt);
    };

    let settings = storage.settings();
    let qwen_variant = settings.qwen_model_variant;
    let cloned_meta = AppPaths::is_cloned_voice_id(&req.voice_id)
        .then(|| storage.get_cloned_voice(&req.voice_id))
        .flatten();

    if let Err(err) = engine.ensure_engine_for_voice(storage.paths(), qwen_variant, &req.voice_id) {
        emit_state("error", 0, None, 0.0, 0, Some(err));
        return;
    }

    let out_path = Path::new(&req.output_path);
    if let Some(parent) = out_path.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        emit_state(
            "error",
            0,
            None,
            0.0,
            0,
            Some(format!("Failed creating output directory: {e}")),
        );
        return;
    }

    let mut sink = match AudioExportSink::create(req.format, out_path, &req.book_title) {
        Ok(s) => s,
        Err(err) => {
            emit_state("error", 0, None, 0.0, 0, Some(err));
            return;
        }
    };

    let pipeline = TextPipeline::compile(
        &settings.sanitizer,
        &storage.ignore_rules(),
        &storage.pronunciations(),
    );
    let stretcher = WsolaStretcher::new(MODEL_SAMPLE_RATE);
    let speed = req.speed.clamp(0.5, 3.0);
    let mut total_audio_samples: u64 = 0;

    for (idx, sent) in sentences.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            drop(sink);
            let _ = std::fs::remove_file(out_path);
            emit_state("cancelled", idx, None, 0.0, 0, None);
            return;
        }

        let mut speech_pcm: Vec<f32> = Vec::new();
        let mut pause_sent = sent.clone();

        match pipeline.process(&sent.text) {
            ProcessedSentence::Skip { is_section_break } => {
                if is_section_break {
                    pause_sent.is_section_break = true;
                }
            }
            ProcessedSentence::Speak(spoken_text) => {
                match engine.synthesize(
                    storage.paths(),
                    qwen_variant,
                    cloned_meta.as_ref(),
                    &spoken_text,
                    &req.voice_id,
                ) {
                    Ok(raw) => {
                        let trimmed = trim_and_fade(&raw, MODEL_SAMPLE_RATE);
                        let boosted = apply_clause_pause_boost(
                            trimmed,
                            &spoken_text,
                            settings.pauses.comma_extra_ms,
                            settings.pauses.semicolon_extra_ms,
                            MODEL_SAMPLE_RATE,
                        );
                        let (stretched, _) = stretcher.stretch(&boosted, speed);
                        speech_pcm = stretched;
                    }
                    Err(err) => {
                        drop(sink);
                        let _ = std::fs::remove_file(out_path);
                        emit_state("error", idx, None, 0.0, 0, Some(err));
                        return;
                    }
                }
            }
        }

        if let Err(err) = sink.write_f32_chunk(&speech_pcm) {
            drop(sink);
            let _ = std::fs::remove_file(out_path);
            emit_state("error", idx, None, 0.0, 0, Some(err));
            return;
        }
        total_audio_samples += speech_pcm.len() as u64;

        let pause_ms = compute_trailing_pause_ms(&pause_sent, &settings.pauses, speed);
        let pause_samples = ((MODEL_SAMPLE_RATE as u64 * pause_ms as u64) / 1000) as usize;
        if pause_samples > 0 {
            if let Err(err) = sink.write_silence(pause_samples) {
                drop(sink);
                let _ = std::fs::remove_file(out_path);
                emit_state("error", idx, None, 0.0, 0, Some(err));
                return;
            }
            total_audio_samples += pause_samples as u64;
        }

        let done = idx + 1;
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        let audio_sec = total_audio_samples as f64 / MODEL_SAMPLE_RATE as f64;
        let rt = audio_sec / elapsed;
        let avg_per_sent = elapsed / done as f64;
        let eta = if done < total {
            Some(avg_per_sent * (total - done) as f64)
        } else {
            Some(0.0)
        };
        let bytes = std::fs::metadata(out_path).map(|m| m.len()).unwrap_or(0);
        emit_state("running", done, eta, rt, bytes, None);
    }

    emit_state("finalizing", total, Some(0.0), 0.0, 0, None);
    if let Err(err) = sink.finish() {
        let _ = std::fs::remove_file(out_path);
        emit_state("error", total, None, 0.0, 0, Some(err));
        return;
    }

    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let audio_sec = total_audio_samples as f64 / MODEL_SAMPLE_RATE as f64;
    let bytes = std::fs::metadata(out_path).map(|m| m.len()).unwrap_or(0);
    emit_state(
        "completed",
        total,
        Some(0.0),
        audio_sec / elapsed,
        bytes,
        None,
    );
}

pub enum AudioExportSink {
    Wav(hound::WavWriter<BufWriter<File>>),
    Mp3 {
        encoder: mp3lame_encoder::Encoder,
        writer: BufWriter<File>,
        buf: Vec<u8>,
    },
}

impl AudioExportSink {
    pub fn create(format: ExportFormat, path: &Path, title: &str) -> Result<Self, String> {
        match format {
            ExportFormat::Wav => {
                let spec = hound::WavSpec {
                    channels: 1,
                    sample_rate: MODEL_SAMPLE_RATE,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let writer = hound::WavWriter::create(path, spec)
                    .map_err(|e| format!("Failed creating WAV file: {e}"))?;
                Ok(Self::Wav(writer))
            }
            ExportFormat::Mp3 => {
                let mut builder = LameBuilder::new()
                    .ok_or_else(|| "Failed creating LAME MP3 encoder".to_string())?;
                builder
                    .set_num_channels(1)
                    .map_err(|e| format!("LAME channels error: {e:?}"))?;
                builder
                    .set_sample_rate(MODEL_SAMPLE_RATE)
                    .map_err(|e| format!("LAME sample rate error: {e:?}"))?;
                builder
                    .set_brate(Bitrate::Kbps128)
                    .map_err(|e| format!("LAME bitrate error: {e:?}"))?;
                builder
                    .set_quality(Quality::Good)
                    .map_err(|e| format!("LAME quality error: {e:?}"))?;
                let _ = builder.set_id3_tag(mp3lame_encoder::Id3Tag {
                    title: title.as_bytes(),
                    artist: b"BookReader (Phonon 31M)",
                    album: title.as_bytes(),
                    year: &[],
                    comment: &[],
                    album_art: &[],
                });
                let encoder = builder
                    .build()
                    .map_err(|e| format!("Failed initializing LAME encoder: {e:?}"))?;
                let file = File::create(path)
                    .map_err(|e| format!("Failed creating MP3 file: {e}"))?;
                Ok(Self::Mp3 {
                    encoder,
                    writer: BufWriter::new(file),
                    buf: Vec::with_capacity(32_768),
                })
            }
        }
    }

    pub fn write_f32_chunk(&mut self, samples: &[f32]) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }
        match self {
            Self::Wav(w) => {
                for &s in samples {
                    let i = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                    w.write_sample(i)
                        .map_err(|e| format!("WAV write failed: {e}"))?;
                }
                Ok(())
            }
            Self::Mp3 {
                encoder,
                writer,
                buf,
            } => {
                let pcm: Vec<i16> = samples
                    .iter()
                    .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
                    .collect();
                buf.clear();
                let needed = mp3lame_encoder::max_required_buffer_size(pcm.len());
                buf.reserve(needed);
                encoder
                    .encode_to_vec(MonoPcm(&pcm), buf)
                    .map_err(|e| format!("MP3 encode failed: {e:?}"))?;
                writer
                    .write_all(buf)
                    .map_err(|e| format!("MP3 write failed: {e}"))
            }
        }
    }

    pub fn write_silence(&mut self, sample_count: usize) -> Result<(), String> {
        const CHUNK: usize = 4096;
        let zeros = vec![0.0_f32; CHUNK];
        let mut remaining = sample_count;
        while remaining > 0 {
            let take = remaining.min(CHUNK);
            self.write_f32_chunk(&zeros[..take])?;
            remaining -= take;
        }
        Ok(())
    }

    pub fn finish(self) -> Result<(), String> {
        match self {
            Self::Wav(w) => w.finalize().map_err(|e| format!("WAV finalize error: {e}")),
            Self::Mp3 {
                mut encoder,
                mut writer,
                mut buf,
            } => {
                buf.clear();
                buf.reserve(8192);
                encoder
                    .flush_to_vec::<FlushNoGap>(&mut buf)
                    .map_err(|e| format!("MP3 flush failed: {e:?}"))?;
                writer
                    .write_all(&buf)
                    .map_err(|e| format!("MP3 write failed: {e}"))?;
                writer
                    .flush()
                    .map_err(|e| format!("MP3 file flush failed: {e}"))
            }
        }
    }
}

/// Keeps the OS awake while a multi-minute export runs, restoring normal sleep policy on Drop.
pub struct SleepInhibitor {
    #[cfg(target_os = "macos")]
    child: Option<std::process::Child>,
}

impl SleepInhibitor {
    pub fn acquire() -> Self {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::Power::{
                ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
            };
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        #[cfg(target_os = "macos")]
        let child = std::process::Command::new("caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok();

        Self {
            #[cfg(target_os = "macos")]
            child,
        }
    }
}

impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows_sys::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};
            SetThreadExecutionState(ES_CONTINUOUS);
        }
        #[cfg(target_os = "macos")]
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_valid_wav_and_mp3_and_exercises_sleep_inhibitor() {
        let root = std::env::temp_dir().join(format!("bookreader_exp_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        let _sleep = SleepInhibitor::acquire();
        let tone: Vec<f32> = (0..12_000)
            .map(|i| 0.25 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 24_000.0).sin())
            .collect();

        let wav_path = root.join("test.wav");
        let mut wav_sink = AudioExportSink::create(ExportFormat::Wav, &wav_path, "Test Book").unwrap();
        wav_sink.write_f32_chunk(&tone).unwrap();
        wav_sink.write_silence(2400).unwrap();
        wav_sink.finish().unwrap();
        let wav_bytes = std::fs::read(&wav_path).unwrap();
        assert!(wav_bytes.len() > 44);
        assert_eq!(&wav_bytes[0..4], b"RIFF");
        assert_eq!(&wav_bytes[8..12], b"WAVE");

        let mp3_path = root.join("test.mp3");
        let mut mp3_sink = AudioExportSink::create(ExportFormat::Mp3, &mp3_path, "Test Book").unwrap();
        mp3_sink.write_f32_chunk(&tone).unwrap();
        mp3_sink.write_silence(2400).unwrap();
        mp3_sink.finish().unwrap();
        let mp3_bytes = std::fs::read(&mp3_path).unwrap();
        assert!(mp3_bytes.len() > 256);

        let _ = std::fs::remove_dir_all(root);
    }
}
