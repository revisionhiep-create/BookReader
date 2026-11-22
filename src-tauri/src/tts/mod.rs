//! High-level TTS playback coordinator driving Phonon 31M, 2-sentence prefetch,
//! pre-TTS pipeline, pause injection, word alignment, and `cpal` playback events.

pub mod alignment;
pub mod audio;
pub mod engine;
pub mod pauses;
pub mod wsola;

use crate::models::{SentenceItem, TtsStateEvent};
use crate::storage::Storage;
use crate::text_pipeline::{ProcessedSentence, TextPipeline};
use crate::tts::alignment::align_words;
use crate::tts::audio::{AudioOutput, MODEL_SAMPLE_RATE};
use crate::tts::engine::PhononEngine;
use crate::tts::pauses::{apply_clause_pause_boost, compute_trailing_pause_ms, trim_and_fade};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, PartialEq, Eq)]
enum TransportState {
    Idle,
    Loading,
    Playing,
    Paused,
    Error(String),
}

struct SessionState {
    book_id: Option<String>,
    sentences: Vec<SentenceItem>,
    cum_words: Vec<usize>,
    total_words: usize,
    cursor_idx: usize,
    highest_enqueued_idx: Option<usize>,
    in_flight_indices: HashSet<usize>,
    transport: TransportState,
    preview_active: bool,
}

impl SessionState {
    fn new() -> Self {
        Self {
            book_id: None,
            sentences: Vec::new(),
            cum_words: vec![0],
            total_words: 0,
            cursor_idx: 0,
            highest_enqueued_idx: None,
            in_flight_indices: HashSet::new(),
            transport: TransportState::Idle,
            preview_active: false,
        }
    }
}

/// Central TTS playback & synthesis coordinator held in Tauri state.
pub struct TtsController {
    storage: Arc<Storage>,
    engine: Arc<PhononEngine>,
    audio: Arc<AudioOutput>,
    session: Arc<RwLock<SessionState>>,
    pipeline: Arc<RwLock<TextPipeline>>,
    wakeup: Arc<(Mutex<bool>, std::sync::Condvar)>,
    book_finished_flag: Arc<AtomicBool>,
}

impl TtsController {
    pub fn start(app: AppHandle, storage: Arc<Storage>) -> Result<Arc<Self>, String> {
        let settings = storage.settings();
        let engine = Arc::new(PhononEngine::new());
        if storage.paths().model_ready() {
            let _ = engine.ensure_loaded(storage.paths());
        }

        let audio = Arc::new(AudioOutput::start(settings.speed, settings.volume)?);
        let pipeline = Arc::new(RwLock::new(TextPipeline::compile(
            &settings.sanitizer,
            &storage.ignore_rules(),
            &storage.pronunciations(),
        )));

        let controller = Arc::new(Self {
            storage,
            engine,
            audio,
            session: Arc::new(RwLock::new(SessionState::new())),
            pipeline,
            wakeup: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
            book_finished_flag: Arc::new(AtomicBool::new(false)),
        });

        let synth_ctrl = Arc::clone(&controller);
        std::thread::Builder::new()
            .name("bookreader-tts-synth".to_string())
            .spawn(move || synth_ctrl.run_synth_loop())
            .map_err(|e| format!("Failed starting TTS synthesis thread: {e}"))?;

        let tick_ctrl = Arc::clone(&controller);
        let tick_app = app.clone();
        std::thread::Builder::new()
            .name("bookreader-tts-ticker".to_string())
            .spawn(move || tick_ctrl.run_ticker_loop(tick_app))
            .map_err(|e| format!("Failed starting TTS ticker thread: {e}"))?;

        Ok(controller)
    }

    pub fn engine(&self) -> &Arc<PhononEngine> {
        &self.engine
    }

    pub fn is_model_loaded(&self) -> bool {
        self.engine.is_loaded()
    }

    pub fn ensure_model_loaded(&self) -> Result<(), String> {
        self.engine.ensure_loaded(self.storage.paths())
    }

    /// Recompiles pre-TTS rules and flushes buffered future audio so changes apply right away.
    pub fn refresh_pipeline(&self) {
        let settings = self.storage.settings();
        let compiled = TextPipeline::compile(
            &settings.sanitizer,
            &self.storage.ignore_rules(),
            &self.storage.pronunciations(),
        );
        *self.pipeline.write().unwrap() = compiled;

        let (is_playing, is_paused, cur) = {
            let s = self.session.read().unwrap();
            (
                matches!(s.transport, TransportState::Playing | TransportState::Loading),
                matches!(s.transport, TransportState::Paused),
                s.cursor_idx,
            )
        };
        if is_playing {
            // Re-queue immediately from active sentence so edited rules/voice take effect
            self.play_from(cur);
        } else if is_paused {
            // Clear buffered audio while paused so pressing Resume re-synthesizes with updated voice/rules
            self.audio.flush_and_bump_generation();
            let mut s = self.session.write().unwrap();
            s.highest_enqueued_idx = None;
            s.in_flight_indices.clear();
        }
    }

    /// Registers a document's sentence list for playback and time estimation.
    pub fn load_document(
        &self,
        book_id: String,
        sentences: Vec<SentenceItem>,
        start_sentence_idx: usize,
        stop_playback: bool,
    ) {
        if stop_playback {
            self.stop();
        }
        let mut cum_words = Vec::with_capacity(sentences.len() + 1);
        cum_words.push(0usize);
        let mut acc = 0usize;
        for s in &sentences {
            acc += s.text.split_whitespace().count();
            cum_words.push(acc);
        }

        let mut sess = self.session.write().unwrap();
        let clamped_idx = if sentences.is_empty() {
            0
        } else {
            start_sentence_idx.min(sentences.len() - 1)
        };
        sess.book_id = Some(book_id);
        sess.sentences = sentences;
        sess.cum_words = cum_words;
        sess.total_words = acc;
        sess.cursor_idx = clamped_idx;
        sess.highest_enqueued_idx = None;
        sess.in_flight_indices.clear();
        if stop_playback {
            sess.transport = TransportState::Idle;
        }
    }

    /// Updates the PDF sentence list cleanly after a header/footer ignore margin change.
    pub fn update_sentences_preserving_pos(&self, sentences: Vec<SentenceItem>, new_cursor: usize) {
        let (was_playing, book_id) = {
            let s = self.session.read().unwrap();
            (
                matches!(s.transport, TransportState::Playing | TransportState::Loading),
                s.book_id.clone(),
            )
        };
        let Some(bid) = book_id else {
            return;
        };
        self.load_document(bid, sentences, new_cursor, true);
        if was_playing {
            self.play_from(new_cursor);
        }
    }

    pub fn play_from(&self, sentence_idx: usize) {
        let total = {
            let s = self.session.read().unwrap();
            s.sentences.len()
        };
        if total == 0 {
            return;
        }

        self.audio.flush_and_bump_generation();
        self.audio.set_paused(false);

        {
            let mut s = self.session.write().unwrap();
            s.cursor_idx = sentence_idx.min(total - 1);
            s.highest_enqueued_idx = None;
            s.in_flight_indices.clear();
            s.preview_active = false;
            s.transport = TransportState::Loading;
        }
        self.notify_worker();
    }

    pub fn pause(&self) {
        self.audio.set_paused(true);
        let mut s = self.session.write().unwrap();
        if matches!(
            s.transport,
            TransportState::Playing | TransportState::Loading
        ) {
            s.transport = TransportState::Paused;
            if let Some(ref bid) = s.book_id {
                let page = s.sentences.get(s.cursor_idx).and_then(|it| it.page);
                let _ = self.storage.update_book_progress(
                    bid,
                    s.cursor_idx,
                    page,
                    None,
                    None,
                    None,
                );
            }
        }
    }

    pub fn resume(&self) {
        let (has_audio, total, cursor) = {
            let s = self.session.read().unwrap();
            (self.audio.snapshot().has_audio, s.sentences.len(), s.cursor_idx)
        };
        if total == 0 {
            return;
        }
        if !has_audio {
            self.play_from(cursor);
            return;
        }
        self.audio.set_paused(false);
        {
            let mut s = self.session.write().unwrap();
            s.transport = TransportState::Playing;
        }
        self.notify_worker();
    }

    pub fn toggle_play_pause(&self) {
        let transport = self.session.read().unwrap().transport.clone();
        match transport {
            TransportState::Playing | TransportState::Loading => self.pause(),
            TransportState::Paused | TransportState::Idle | TransportState::Error(_) => {
                self.resume()
            }
        }
    }

    pub fn stop(&self) {
        self.audio.set_paused(true);
        self.audio.flush_and_bump_generation();
        let mut s = self.session.write().unwrap();
        s.highest_enqueued_idx = None;
        s.in_flight_indices.clear();
        s.preview_active = false;
        s.transport = TransportState::Idle;
    }

    pub fn step_sentence(&self, delta: isize) {
        let target_idx = {
            let s = self.session.read().unwrap();
            if s.sentences.is_empty() {
                return;
            }
            let pipe = self.pipeline.read().unwrap();
            let mut idx = (s.cursor_idx as isize + delta).clamp(0, s.sentences.len() as isize - 1);
            // Skip past silent decorative dividers when stepping with arrow keys
            while idx > 0 && idx < s.sentences.len() as isize - 1 {
                if let ProcessedSentence::Skip { .. } = pipe.process(&s.sentences[idx as usize].text)
                {
                    idx += if delta >= 0 { 1 } else { -1 };
                } else {
                    break;
                }
            }
            idx.clamp(0, s.sentences.len() as isize - 1) as usize
        };

        let was_active = matches!(
            self.session.read().unwrap().transport,
            TransportState::Playing | TransportState::Loading
        );

        if was_active {
            self.play_from(target_idx);
        } else {
            self.audio.flush_and_bump_generation();
            let mut s = self.session.write().unwrap();
            s.cursor_idx = target_idx;
            s.highest_enqueued_idx = None;
            s.in_flight_indices.clear();
            if let Some(ref bid) = s.book_id {
                let page = s.sentences.get(target_idx).and_then(|it| it.page);
                let _ = self
                    .storage
                    .update_book_progress(bid, target_idx, page, None, None, None);
            }
        }
    }

    pub fn set_speed(&self, speed: f32) {
        self.audio.set_speed(speed);
    }

    pub fn set_volume(&self, volume: f32) {
        self.audio.set_volume(volume);
    }

    pub fn current_state_event(&self) -> TtsStateEvent {
        let snap = self.audio.snapshot();
        let s = self.session.read().unwrap();
        let speed = self.audio.current_speed().max(0.5);
        let total_sentences = s.sentences.len();
        let active_idx = if !snap.is_preview {
            snap.sentence_idx.unwrap_or(s.cursor_idx)
        } else {
            s.cursor_idx
        };

        let (elapsed_est_sec, remaining_est_sec) =
            estimate_times(&s.cum_words, active_idx, total_sentences, speed);

        let (status, error) = match &s.transport {
            TransportState::Idle => ("idle".to_string(), None),
            TransportState::Loading => ("loading".to_string(), None),
            TransportState::Playing => ("playing".to_string(), None),
            TransportState::Paused => ("paused".to_string(), None),
            TransportState::Error(msg) => ("error".to_string(), Some(msg.clone())),
        };

        TtsStateEvent {
            status,
            book_id: s.book_id.clone(),
            sentence_idx: active_idx,
            word_idx: if snap.is_preview { 0 } else { snap.word_idx },
            total_sentences,
            elapsed_est_sec,
            remaining_est_sec,
            error,
        }
    }

    /// Synthesizes and plays a short spoken preview (used by Pronunciation `▶` & Voice Picker).
    pub fn preview_text(&self, raw_text: &str, voice_id: Option<&str>) -> Result<(), String> {
        let settings = self.storage.settings();
        let active_voice = voice_id.unwrap_or(&settings.voice_id).to_string();
        let pipe = self.pipeline.read().unwrap().clone();
        let spoken = match pipe.process(raw_text) {
            ProcessedSentence::Speak(t) => t,
            ProcessedSentence::Skip { .. } => raw_text.trim().to_string(),
        };
        if spoken.is_empty() {
            return Ok(());
        }

        let pcm_raw = self.engine.synthesize(self.storage.paths(), &spoken, &active_voice)?;
        let pcm = trim_and_fade(&pcm_raw, MODEL_SAMPLE_RATE);
        if pcm.is_empty() {
            return Ok(());
        }

        // Pause book playback cleanly while playing short preview
        self.pause();
        let generation = self.audio.flush_and_bump_generation();
        self.audio.set_paused(false);
        {
            let mut s = self.session.write().unwrap();
            s.preview_active = true;
            s.highest_enqueued_idx = None;
            s.in_flight_indices.clear();
        }
        self.audio
            .enqueue_speech(generation, 0, true, pcm, 0, Vec::new());
        Ok(())
    }

    fn notify_worker(&self) {
        let (lock, cv) = &*self.wakeup;
        let mut ready = lock.lock().unwrap();
        *ready = true;
        cv.notify_all();
    }

    fn run_synth_loop(&self) {
        loop {
            // Wait until active playback needs lookahead sentences synthesized
            {
                let (lock, cv) = &*self.wakeup;
                let mut guard = lock.lock().unwrap();
                while !*guard {
                    let s = self.session.read().unwrap();
                    let active = matches!(
                        s.transport,
                        TransportState::Playing | TransportState::Loading
                    );
                    let snap = self.audio.snapshot();
                    let need_more = active
                        && !s.sentences.is_empty()
                        && snap.queued_count < 2
                        && s.highest_enqueued_idx
                            .map(|h| h + 1 < s.sentences.len())
                            .unwrap_or(true);
                    if need_more {
                        break;
                    }
                    let (g, _) = cv.wait_timeout(guard, Duration::from_millis(80)).unwrap();
                    guard = g;
                }
                *guard = false;
            }

            // Pick next sentence index to synthesize (current + up to 2 ahead)
            let work = {
                let mut s = self.session.write().unwrap();
                if !matches!(
                    s.transport,
                    TransportState::Playing | TransportState::Loading
                ) || s.sentences.is_empty()
                {
                    continue;
                }
                let snap = self.audio.snapshot();
                if snap.queued_count >= 2 {
                    continue;
                }

                let next_idx = match s.highest_enqueued_idx {
                    None => s.cursor_idx,
                    Some(h) => h + 1,
                };
                if next_idx >= s.sentences.len() || s.in_flight_indices.contains(&next_idx) {
                    continue;
                }
                s.in_flight_indices.insert(next_idx);
                let sentence = s.sentences[next_idx].clone();
                let generation = self.audio.generation();
                Some((next_idx, sentence, generation))
            };

            let Some((idx, sentence, generation)) = work else {
                continue;
            };

            let settings = self.storage.settings();
            let pipe = self.pipeline.read().unwrap().clone();
            let processed = pipe.process(&sentence.text);

            let speed = self.audio.current_speed();
            let result = match processed {
                ProcessedSentence::Skip { is_section_break } => {
                    let mut dummy = sentence.clone();
                    if is_section_break {
                        dummy.is_section_break = true;
                    }
                    let pause_ms = compute_trailing_pause_ms(&dummy, &settings.pauses, speed);
                    Ok((Vec::new(), pause_ms, Vec::new()))
                }
                ProcessedSentence::Speak(spoken_text) => {
                    match self
                        .engine
                        .synthesize(self.storage.paths(), &spoken_text, &settings.voice_id)
                    {
                        Ok(raw_pcm) => {
                            let trimmed = trim_and_fade(&raw_pcm, MODEL_SAMPLE_RATE);
                            let boosted = apply_clause_pause_boost(
                                trimmed,
                                &spoken_text,
                                settings.pauses.comma_extra_ms,
                                settings.pauses.semicolon_extra_ms,
                                MODEL_SAMPLE_RATE,
                            );
                            let timings = align_words(&sentence.text, &boosted, MODEL_SAMPLE_RATE);
                            let pause_ms =
                                compute_trailing_pause_ms(&sentence, &settings.pauses, speed);
                            Ok((boosted, pause_ms, timings))
                        }
                        Err(err) => Err(err),
                    }
                }
            };

            // Check if generation was cancelled while synthesizing
            if generation != self.audio.generation() {
                let mut s = self.session.write().unwrap();
                s.in_flight_indices.remove(&idx);
                continue;
            }

            match result {
                Ok((pcm, pause_ms, timings)) => {
                    self.audio
                        .enqueue_speech(generation, idx, false, pcm, pause_ms, timings);
                    let mut s = self.session.write().unwrap();
                    s.in_flight_indices.remove(&idx);
                    s.highest_enqueued_idx = Some(
                        s.highest_enqueued_idx
                            .map(|h| h.max(idx))
                            .unwrap_or(idx),
                    );
                    if matches!(s.transport, TransportState::Loading) {
                        s.transport = TransportState::Playing;
                    }
                }
                Err(err) => {
                    self.audio.set_paused(true);
                    let mut s = self.session.write().unwrap();
                    s.in_flight_indices.remove(&idx);
                    s.transport = TransportState::Error(err);
                }
            }
        }
    }

    fn run_ticker_loop(&self, app: AppHandle) {
        let mut last_persisted = Instant::now();
        let mut last_emitted_state: Option<(String, usize, usize)> = None;

        loop {
            std::thread::sleep(Duration::from_millis(35));

            let snap = self.audio.snapshot();
            let mut should_notify_worker = false;

            {
                let mut s = self.session.write().unwrap();

                // Detect when a preview finishes
                if s.preview_active && !snap.has_audio {
                    s.preview_active = false;
                    self.audio.set_paused(true);
                    s.transport = TransportState::Paused;
                }

                // Update cursor to active audio segment's sentence index
                if !snap.is_preview
                    && let Some(active_idx) = snap.sentence_idx
                    && matches!(s.transport, TransportState::Playing)
                {
                    s.cursor_idx = active_idx;
                }

                // Transition cleanly to Idle once the final sentence finishes playing
                if matches!(s.transport, TransportState::Playing)
                    && snap.finished_natural
                    && !snap.has_audio
                    && s.in_flight_indices.is_empty()
                    && s.highest_enqueued_idx
                        .is_some_and(|h| h + 1 >= s.sentences.len())
                {
                    s.transport = TransportState::Idle;
                    self.audio.set_paused(true);
                    self.book_finished_flag.store(true, Ordering::Release);
                }

                if matches!(
                    s.transport,
                    TransportState::Playing | TransportState::Loading
                ) && snap.queued_count < 2
                {
                    should_notify_worker = true;
                }
            }

            if should_notify_worker {
                self.notify_worker();
            }

            let evt = self.current_state_event();
            let key = (evt.status.clone(), evt.sentence_idx, evt.word_idx);
            let changed = last_emitted_state.as_ref() != Some(&key);
            if changed || matches!(evt.status.as_str(), "playing" | "loading") {
                let _ = app.emit("tts:state", &evt);
                last_emitted_state = Some(key);
            }

            if last_persisted.elapsed() >= Duration::from_secs(2)
                && matches!(evt.status.as_str(), "playing")
                && let Some(ref bid) = evt.book_id
            {
                let page = {
                    let s = self.session.read().unwrap();
                    s.sentences.get(evt.sentence_idx).and_then(|it| it.page)
                };
                let _ = self.storage.update_book_progress(
                    bid,
                    evt.sentence_idx,
                    page,
                    None,
                    None,
                    None,
                );
                last_persisted = Instant::now();
            }
        }
    }
}

/// Estimates elapsed and remaining book listening duration dynamically based on word counts & speed.
pub fn estimate_times(
    cum_words: &[usize],
    sentence_idx: usize,
    total_sentences: usize,
    speed: f32,
) -> (f64, f64) {
    if cum_words.len() <= 1 || total_sentences == 0 {
        return (0.0, 0.0);
    }
    let idx = sentence_idx.min(total_sentences);
    let done_words = cum_words[idx] as f64;
    let total_words = *cum_words.last().unwrap_or(&0) as f64;
    let rem_words = (total_words - done_words).max(0.0);

    // Empirical natural narration pace (~2.65 words/sec at 1.0x) + ~0.48s average sentence pause
    let wps = 2.65 * (speed.max(0.5) as f64);
    let pause_per_sent = 0.48 / (speed.max(0.5) as f64).powf(0.75);

    let elapsed = done_words / wps + (idx as f64) * pause_per_sent;
    let remaining = rem_words / wps + ((total_sentences - idx) as f64) * pause_per_sent;
    (elapsed, remaining)
}
