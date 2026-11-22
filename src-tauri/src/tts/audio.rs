//! Dedicated `cpal` WASAPI audio output thread with zero-allocation callback,
//! instant pause/resume, live speed re-stretching, volume ramping, and sample-accurate CC sync.

use crate::tts::alignment::{WordTiming, word_index_at_sample};
use crate::tts::wsola::WsolaStretcher;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, OutputCallbackInfo, Sample, SampleFormat, SizedSample, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const MODEL_SAMPLE_RATE: u32 = 24_000;

/// One sentence (or preview clip) queued for playback.
pub struct AudioSegment {
    pub generation: u64,
    pub sentence_idx: usize,
    pub is_preview: bool,
    pub raw_speech_pcm: Vec<f32>,
    pub stretched_pcm: Vec<f32>,
    pub src_map: Vec<usize>,
    pub trailing_silence_24k: usize,
    pub word_timings: Vec<WordTiming>,
    pub word_starts_ms: Arc<Vec<u32>>,
    pub speech_duration_ms: u32,
    /// Fractional write cursor within `[0 .. stretched_pcm.len() + trailing_silence_24k]`.
    pub pos_24k: f64,
}

fn compute_word_starts_ms(word_timings: &[WordTiming], src_map: &[usize]) -> (Vec<u32>, u32) {
    let speech_duration_ms = ((src_map.len() as f64) * 1000.0 / f64::from(MODEL_SAMPLE_RATE))
        .round()
        .clamp(0.0, f64::from(u32::MAX)) as u32;
    if word_timings.is_empty() || src_map.is_empty() {
        return (Vec::new(), speech_duration_ms);
    }

    let mut starts = Vec::with_capacity(word_timings.len());
    let mut cursor = 0usize;
    let mut prev_ms = 0u32;
    for t in word_timings {
        while cursor < src_map.len() && src_map[cursor] < t.start_sample {
            cursor += 1;
        }
        let out_idx = cursor.min(src_map.len() - 1);
        let ms = ((out_idx as f64) * 1000.0 / f64::from(MODEL_SAMPLE_RATE))
            .round()
            .clamp(0.0, f64::from(speech_duration_ms)) as u32;
        let mono_ms = ms.max(prev_ms);
        starts.push(mono_ms);
        prev_ms = mono_ms;
    }
    (starts, speech_duration_ms)
}

impl AudioSegment {
    pub fn new(
        generation: u64,
        sentence_idx: usize,
        is_preview: bool,
        raw_speech_pcm: Vec<f32>,
        trailing_silence_24k: usize,
        word_timings: Vec<WordTiming>,
        speed: f32,
        stretcher: &WsolaStretcher,
    ) -> Self {
        let (stretched_pcm, src_map) = stretcher.stretch(&raw_speech_pcm, speed);
        let (word_starts_ms, speech_duration_ms) = compute_word_starts_ms(&word_timings, &src_map);
        Self {
            generation,
            sentence_idx,
            is_preview,
            raw_speech_pcm,
            stretched_pcm,
            src_map,
            trailing_silence_24k,
            word_timings,
            word_starts_ms: Arc::new(word_starts_ms),
            speech_duration_ms,
            pos_24k: 0.0,
        }
    }

    fn total_len_24k(&self) -> usize {
        self.stretched_pcm.len() + self.trailing_silence_24k
    }

    #[cfg(test)]
    fn current_word_idx(&self) -> usize {
        self.current_word_idx_at(self.pos_24k)
    }

    fn current_word_idx_at(&self, pos_24k: f64) -> usize {
        if self.src_map.is_empty() || self.word_timings.is_empty() {
            return 0;
        }
        let idx = (pos_24k.floor().max(0.0) as usize).min(self.src_map.len() - 1);
        let src_sample = self.src_map[idx];
        word_index_at_sample(&self.word_timings, src_sample)
    }

    fn restretch(&mut self, new_speed: f32, stretcher: &WsolaStretcher) {
        if self.raw_speech_pcm.is_empty() {
            return;
        }
        let in_silence = (self.pos_24k as usize) >= self.stretched_pcm.len();
        let cur_src = if !self.src_map.is_empty() {
            let idx = (self.pos_24k.floor() as usize).min(self.src_map.len() - 1);
            self.src_map[idx]
        } else {
            0
        };
        let silence_offset = if in_silence {
            (self.pos_24k as usize).saturating_sub(self.stretched_pcm.len())
        } else {
            0
        };

        let (new_pcm, new_map) = stretcher.stretch(&self.raw_speech_pcm, new_speed);
        let (new_starts, new_dur) = compute_word_starts_ms(&self.word_timings, &new_map);
        let new_pos = if in_silence {
            new_pcm.len() + silence_offset.min(self.trailing_silence_24k)
        } else if !new_map.is_empty() {
            new_map
                .iter()
                .position(|&s| s >= cur_src)
                .unwrap_or(new_map.len() - 1)
        } else {
            0
        };

        self.stretched_pcm = new_pcm;
        self.src_map = new_map;
        self.word_starts_ms = Arc::new(new_starts);
        self.speech_duration_ms = new_dur;
        self.pos_24k = new_pos as f64;
    }

    fn restretch_preserving_heard(
        &mut self,
        new_speed: f32,
        prev_heard_24k: f64,
        stretcher: &WsolaStretcher,
    ) -> f64 {
        if self.raw_speech_pcm.is_empty() {
            self.restretch(new_speed, stretcher);
            return 0.0;
        }
        let heard_u = prev_heard_24k.max(0.0) as usize;
        let heard_in_silence = heard_u >= self.stretched_pcm.len();
        let heard_src = if !self.src_map.is_empty() {
            let idx = (prev_heard_24k.floor().max(0.0) as usize).min(self.src_map.len() - 1);
            self.src_map[idx]
        } else {
            0
        };
        let heard_silence_offset = if heard_in_silence {
            heard_u.saturating_sub(self.stretched_pcm.len())
        } else {
            0
        };

        self.restretch(new_speed, stretcher);

        let mapped = if heard_in_silence {
            (self.stretched_pcm.len() + heard_silence_offset.min(self.trailing_silence_24k)) as f64
        } else if !self.src_map.is_empty() {
            self.src_map
                .iter()
                .position(|&s| s >= heard_src)
                .unwrap_or(self.src_map.len() - 1) as f64
        } else {
            0.0
        };
        mapped.clamp(0.0, self.pos_24k.max(0.0))
    }
}

fn update_smoothed_latency(prev: Option<f64>, raw: f64) -> f64 {
    let clamped = if raw.is_finite() {
        raw.clamp(0.0, 0.25)
    } else {
        0.0
    };
    match prev {
        None => clamped,
        Some(s) => {
            let delta = (clamped - s).clamp(-0.025, 0.025);
            (s + delta * 0.20).clamp(0.0, 0.25)
        }
    }
}

#[derive(Clone, Debug)]
struct PlaybackAnchor {
    callback_at: Instant,
    delay_sec: f64,
    pos_24k: f64,
    generation: u64,
    sentence_idx: usize,
}

#[derive(Default)]
struct QueueState {
    active: Option<AudioSegment>,
    queue: VecDeque<AudioSegment>,
    finished_natural: bool,
    anchor: Option<PlaybackAnchor>,
    paused_heard_24k: Option<(u64, usize, f64)>,
    max_heard_24k: Option<(u64, usize, f64)>,
}

impl QueueState {
    fn current_heard_pos_24k(&mut self, paused: bool, now: Instant) -> f64 {
        let Some(seg) = self.active.as_ref() else {
            return 0.0;
        };
        let seg_max = (seg.total_len_24k() as f64).min(seg.pos_24k.max(0.0));
        let raw_heard = if paused {
            if let Some((seg_gen, sid, heard)) = self.paused_heard_24k
                && seg_gen == seg.generation
                && sid == seg.sentence_idx
            {
                heard.clamp(0.0, seg_max)
            } else {
                seg_max
            }
        } else if let Some(ref a) = self.anchor
            && a.generation == seg.generation
            && a.sentence_idx == seg.sentence_idx
        {
            let elapsed_sec = now.saturating_duration_since(a.callback_at).as_secs_f64();
            let est = a.pos_24k + (elapsed_sec - a.delay_sec) * f64::from(MODEL_SAMPLE_RATE);
            est.clamp(0.0, seg_max)
        } else if let Some((seg_gen, sid, heard)) = self.paused_heard_24k
            && seg_gen == seg.generation
            && sid == seg.sentence_idx
        {
            heard.clamp(0.0, seg_max)
        } else {
            0.0
        };

        let heard = match self.max_heard_24k {
            Some((g, sid, prev_max)) if g == seg.generation && sid == seg.sentence_idx => {
                raw_heard.max(prev_max).min(seg_max)
            }
            _ => raw_heard,
        };
        self.max_heard_24k = Some((seg.generation, seg.sentence_idx, heard));
        heard
    }
}

#[derive(Clone, Debug)]
pub struct AudioSnapshot {
    pub sentence_idx: Option<usize>,
    pub word_idx: usize,
    pub playback_ms: u32,
    pub sentence_duration_ms: u32,
    pub word_starts_ms: Arc<Vec<u32>>,
    pub is_preview: bool,
    pub has_audio: bool,
    pub queued_count: usize,
    pub finished_natural: bool,
}

struct AudioShared {
    state: Mutex<QueueState>,
    paused: AtomicBool,
    generation: AtomicU64,
    volume_bits: AtomicU32,
    speed_bits: AtomicU32,
    device_sample_rate: AtomicU32,
}

/// Handle to the background `cpal` audio playback stream.
pub struct AudioOutput {
    shared: Arc<AudioShared>,
    stretcher: WsolaStretcher,
}

impl AudioOutput {
    /// Starts the dedicated audio playback thread and opens the default output device.
    pub fn start(initial_speed: f32, initial_volume: f32) -> Result<Self, String> {
        let shared = Arc::new(AudioShared {
            state: Mutex::new(QueueState::default()),
            paused: AtomicBool::new(true),
            generation: AtomicU64::new(1),
            volume_bits: AtomicU32::new(initial_volume.clamp(0.0, 1.0).to_bits()),
            speed_bits: AtomicU32::new(initial_speed.clamp(0.5, 3.0).to_bits()),
            device_sample_rate: AtomicU32::new(48_000),
        });

        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let thread_shared = Arc::clone(&shared);

        std::thread::Builder::new()
            .name("bookreader-audio".to_string())
            .spawn(move || {
                if let Err(err) = run_audio_thread(thread_shared, ready_tx) {
                    tracing::error!(error = %err, "Audio thread terminated");
                }
            })
            .map_err(|e| format!("Failed spawning audio thread: {e}"))?;

        ready_rx
            .recv()
            .map_err(|_| "Audio initialization channel closed".to_string())??;

        Ok(Self {
            shared,
            stretcher: WsolaStretcher::new(MODEL_SAMPLE_RATE),
        })
    }

    pub fn generation(&self) -> u64 {
        self.shared.generation.load(Ordering::Acquire)
    }

    pub fn current_speed(&self) -> f32 {
        f32::from_bits(self.shared.speed_bits.load(Ordering::Acquire))
    }

    pub fn set_paused(&self, paused: bool) {
        let mut guard = self.shared.state.lock().unwrap();
        if paused {
            let was_paused = self.shared.paused.load(Ordering::Acquire);
            let heard = guard.current_heard_pos_24k(was_paused, Instant::now());
            guard.paused_heard_24k = guard
                .active
                .as_ref()
                .map(|seg| (seg.generation, seg.sentence_idx, heard));
            guard.anchor = None;
        } else {
            guard.anchor = None;
        }
        self.shared.paused.store(paused, Ordering::Release);
    }

    pub fn set_volume(&self, volume: f32) {
        self.shared
            .volume_bits
            .store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    }

    /// Updates playback speed and live-stretches currently buffered speech smoothly.
    pub fn set_speed(&self, new_speed: f32) {
        let clamped = new_speed.clamp(0.5, 3.0);
        self.shared.speed_bits.store(clamped.to_bits(), Ordering::Release);
        let was_paused = self.shared.paused.load(Ordering::Acquire);

        let mut guard = self.shared.state.lock().unwrap();
        let prev_heard = guard.current_heard_pos_24k(was_paused, Instant::now());
        let new_heard = guard.active.as_mut().map(|active| {
            let mapped = active.restretch_preserving_heard(clamped, prev_heard, &self.stretcher);
            (active.generation, active.sentence_idx, mapped)
        });
        for seg in guard.queue.iter_mut() {
            seg.restretch(clamped, &self.stretcher);
        }
        guard.anchor = None;
        guard.paused_heard_24k = new_heard;
        guard.max_heard_24k = new_heard;
    }

    /// Clears all buffered audio and bumps the active generation ID for instant skip/seek.
    pub fn flush_and_bump_generation(&self) -> u64 {
        let next_gen = self.shared.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let mut guard = self.shared.state.lock().unwrap();
        guard.active = None;
        guard.queue.clear();
        guard.finished_natural = false;
        guard.anchor = None;
        guard.paused_heard_24k = None;
        guard.max_heard_24k = None;
        next_gen
    }

    /// Enqueues a synthesized speech segment if its generation is still current.
    pub fn enqueue_speech(
        &self,
        generation: u64,
        sentence_idx: usize,
        is_preview: bool,
        raw_speech_pcm: Vec<f32>,
        trailing_silence_ms: u32,
        word_timings: Vec<WordTiming>,
    ) {
        if generation != self.generation() {
            return;
        }
        let speed = self.current_speed();
        let silence_samples = ((MODEL_SAMPLE_RATE as u64 * trailing_silence_ms as u64) / 1000) as usize;
        let seg = AudioSegment::new(
            generation,
            sentence_idx,
            is_preview,
            raw_speech_pcm,
            silence_samples,
            word_timings,
            speed,
            &self.stretcher,
        );

        let mut guard = self.shared.state.lock().unwrap();
        if generation != self.generation() {
            return;
        }
        guard.finished_natural = false;
        if guard.active.is_none() {
            guard.active = Some(seg);
        } else {
            guard.queue.push_back(seg);
        }
    }

    pub fn snapshot(&self) -> AudioSnapshot {
        let paused = self.shared.paused.load(Ordering::Acquire);
        let mut guard = self.shared.state.lock().unwrap();
        let heard_pos = guard.current_heard_pos_24k(paused, Instant::now());
        let (sentence_idx, word_idx, playback_ms, sentence_duration_ms, word_starts_ms, is_preview, has_audio) =
            match guard.active.as_ref() {
                Some(seg) => (
                    Some(seg.sentence_idx),
                    seg.current_word_idx_at(heard_pos),
                    ((heard_pos * 1000.0) / f64::from(MODEL_SAMPLE_RATE))
                        .round()
                        .clamp(0.0, f64::from(u32::MAX)) as u32,
                    seg.speech_duration_ms,
                    Arc::clone(&seg.word_starts_ms),
                    seg.is_preview,
                    true,
                ),
                None => (None, 0, 0, 0, Arc::new(Vec::new()), false, false),
            };
        AudioSnapshot {
            sentence_idx,
            word_idx,
            playback_ms,
            sentence_duration_ms,
            word_starts_ms,
            is_preview,
            has_audio,
            queued_count: guard.queue.len(),
            finished_natural: guard.finished_natural,
        }
    }
}

fn run_audio_thread(
    shared: Arc<AudioShared>,
    ready_tx: std::sync::mpsc::SyncSender<Result<(), String>>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            let err = "No default audio output device found".to_string();
            let _ = ready_tx.send(Err(err.clone()));
            return Err(err);
        }
    };
    let supported = match device.default_output_config() {
        Ok(cfg) => cfg,
        Err(e) => {
            let err = format!("Failed querying audio device config: {e}");
            let _ = ready_tx.send(Err(err.clone()));
            return Err(err);
        }
    };

    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    shared
        .device_sample_rate
        .store(config.sample_rate.max(8000), Ordering::Release);

    let stream = match sample_format {
        SampleFormat::F32 => build_typed_stream::<f32>(&device, config, Arc::clone(&shared)),
        SampleFormat::I16 => build_typed_stream::<i16>(&device, config, Arc::clone(&shared)),
        SampleFormat::I32 => build_typed_stream::<i32>(&device, config, Arc::clone(&shared)),
        SampleFormat::U16 => build_typed_stream::<u16>(&device, config, Arc::clone(&shared)),
        other => Err(format!("Unsupported output sample format: {other}")),
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    if let Err(e) = stream.play() {
        let err = format!("Failed starting audio output stream: {e}");
        let _ = ready_tx.send(Err(err.clone()));
        return Err(err);
    }

    let _ = ready_tx.send(Ok(()));

    // Keep the !Send cpal::Stream alive on this dedicated thread for app lifetime
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

fn build_typed_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    shared: Arc<AudioShared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels.max(1) as usize;
    let out_rate = config.sample_rate.max(8000) as f64;
    let step_24k = MODEL_SAMPLE_RATE as f64 / out_rate;
    let mut smoothed_latency: Option<f64> = None;

    device
        .build_output_stream(
            config,
            move |data: &mut [T], info: &OutputCallbackInfo| {
                let ts = info.timestamp();
                let raw_latency = ts.playback.duration_since(ts.callback).as_secs_f64();
                let latency_sec = update_smoothed_latency(smoothed_latency, raw_latency);
                smoothed_latency = Some(latency_sec);
                fill_output_buffer(data, channels, step_24k, latency_sec, &shared);
            },
            |err| {
                tracing::warn!(error = %err, "Audio stream error");
            },
            None,
        )
        .map_err(|e| format!("Failed creating output stream: {e}"))
}

fn fill_output_buffer<T>(
    output: &mut [T],
    channels: usize,
    step_24k: f64,
    latency_sec: f64,
    shared: &AudioShared,
) where
    T: Sample + FromSample<f32>,
{
    if shared.paused.load(Ordering::Acquire) {
        let zero = T::from_sample(0.0_f32);
        output.fill(zero);
        return;
    }

    let volume = f32::from_bits(shared.volume_bits.load(Ordering::Acquire));
    let active_gen = shared.generation.load(Ordering::Acquire);

    let Ok(mut state) = shared.state.try_lock() else {
        let zero = T::from_sample(0.0_f32);
        output.fill(zero);
        return;
    };

    for frame in output.chunks_mut(channels) {
        let mut mono = 0.0_f32;

        loop {
            let Some(seg) = state.active.as_mut() else {
                if let Some(next) = state.queue.pop_front() {
                    if next.generation == active_gen {
                        state.max_heard_24k = None;
                        state.active = Some(next);
                        continue;
                    }
                    continue;
                }
                break;
            };

            if seg.generation != active_gen {
                state.active = None;
                state.max_heard_24k = None;
                continue;
            }

            let total_len = seg.total_len_24k();
            let idx = seg.pos_24k.floor() as usize;
            if idx >= total_len {
                let was_preview = seg.is_preview;
                state.active = state.queue.pop_front();
                state.max_heard_24k = None;
                if state.active.is_none() && !was_preview {
                    state.finished_natural = true;
                }
                continue;
            }

            if idx < seg.stretched_pcm.len() {
                let frac = (seg.pos_24k - idx as f64) as f32;
                let s0 = seg.stretched_pcm[idx];
                let s1 = if idx + 1 < seg.stretched_pcm.len() {
                    seg.stretched_pcm[idx + 1]
                } else {
                    0.0
                };
                mono = (s0 + (s1 - s0) * frac) * volume;
            } else {
                mono = 0.0;
            }

            seg.pos_24k += step_24k;
            break;
        }

        let sample = T::from_sample(mono.clamp(-1.0, 1.0));
        for ch in frame.iter_mut() {
            *ch = sample;
        }
    }

    if let Some((pos_24k, generation, sentence_idx)) = state
        .active
        .as_ref()
        .map(|seg| (seg.pos_24k, seg.generation, seg.sentence_idx))
    {
        let num_frames = output.len() / channels.max(1);
        let chunk_dur_sec = (num_frames as f64 * step_24k) / f64::from(MODEL_SAMPLE_RATE);
        state.paused_heard_24k = None;
        state.anchor = Some(PlaybackAnchor {
            callback_at: Instant::now(),
            delay_sec: latency_sec + chunk_dur_sec,
            pos_24k,
            generation,
            sentence_idx,
        });
    } else {
        state.anchor = None;
        state.paused_heard_24k = None;
        state.max_heard_24k = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    impl AudioOutput {
        fn new_headless(initial_speed: f32, initial_volume: f32) -> Self {
            Self {
                shared: Arc::new(AudioShared {
                    state: Mutex::new(QueueState::default()),
                    paused: AtomicBool::new(true),
                    generation: AtomicU64::new(1),
                    volume_bits: AtomicU32::new(initial_volume.to_bits()),
                    speed_bits: AtomicU32::new(initial_speed.to_bits()),
                    device_sample_rate: AtomicU32::new(48_000),
                }),
                stretcher: WsolaStretcher::new(MODEL_SAMPLE_RATE),
            }
        }
    }

    #[test]
    fn flush_bumps_generation_clears_queue_and_rejects_stale_segments() {
        let out = AudioOutput::new_headless(1.0, 1.0);
        let g1 = out.generation();
        out.enqueue_speech(g1, 0, false, vec![0.1; 1000], 200, Vec::new());
        out.enqueue_speech(g1, 1, false, vec![0.1; 1000], 200, Vec::new());

        let snap_before = out.snapshot();
        assert!(snap_before.has_audio);
        assert_eq!(snap_before.queued_count, 1);

        let g2 = out.flush_and_bump_generation();
        assert!(g2 > g1);
        let snap_after = out.snapshot();
        assert!(!snap_after.has_audio);
        assert_eq!(snap_after.queued_count, 0);

        // Stale generation from before flush must be silently dropped
        out.enqueue_speech(g1, 2, false, vec![0.1; 1000], 200, Vec::new());
        assert!(!out.snapshot().has_audio);
    }

    #[test]
    fn computes_monotonic_word_starts_ms_for_stretched_audio() {
        let raw_len = 24_000_usize; // 1.0s raw @ 24 kHz
        let pcm: Vec<f32> = (0..raw_len)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * 180.0 * i as f32 / 24_000.0).sin())
            .collect();
        let timings = vec![
            WordTiming { word_index: 0, start_sample: 0, end_sample: 6_000 },
            WordTiming { word_index: 1, start_sample: 6_000, end_sample: 12_000 },
            WordTiming { word_index: 2, start_sample: 12_000, end_sample: 18_000 },
            WordTiming { word_index: 3, start_sample: 18_000, end_sample: 24_000 },
        ];

        let stretcher = WsolaStretcher::new(MODEL_SAMPLE_RATE);
        let seg = AudioSegment::new(1, 0, false, pcm, 4_800, timings, 1.25, &stretcher);
        assert_eq!(seg.word_starts_ms.len(), 4);
        assert_eq!(seg.word_starts_ms[0], 0);
        // Stretched 1.25x => ~800 ms total; words spaced monotonically around 0, ~200, ~400, ~600 ms
        assert!(seg.speech_duration_ms >= 740 && seg.speech_duration_ms <= 860);
        assert!(seg.word_starts_ms.windows(2).all(|w| w[1] > w[0]));
        assert_eq!(seg.current_word_idx(), 0);
    }

    #[test]
    fn playback_anchor_interpolates_with_latency_compensation_and_freezes_on_pause() {
        let out = AudioOutput::new_headless(1.0, 1.0);
        let seg_gen = out.generation();
        let timings = vec![
            WordTiming { word_index: 0, start_sample: 0, end_sample: 600 },
            WordTiming { word_index: 1, start_sample: 600, end_sample: 24_000 },
        ];
        out.enqueue_speech(seg_gen, 3, false, vec![0.25; 24_000], 0, timings);
        out.set_paused(false);

        // Simulate 10 ms @ 48 kHz stereo (480 frames, step = 0.5 => 240 source samples = 10 ms)
        // with 50 ms of hardware DAC buffering latency.
        let mut buf = vec![0.0_f32; 480 * 2];
        fill_output_buffer(&mut buf, 2, 0.5, 0.050, &out.shared);

        // Immediately after writing, DAC has not played frame 0 yet => heard position stays at 0 ms.
        let snap_now = out.snapshot();
        assert_eq!(snap_now.playback_ms, 0);
        assert_eq!(snap_now.word_idx, 0);

        // Backdate callback by 55 ms => 5 ms past DAC latency => heard position ~5 ms (120 samples).
        {
            let mut guard = out.shared.state.lock().unwrap();
            let a = guard.anchor.as_mut().unwrap();
            a.callback_at = Instant::now() - std::time::Duration::from_millis(55);
        }
        let mid_snap = out.snapshot();
        assert!(mid_snap.playback_ms >= 4 && mid_snap.playback_ms <= 9);

        // Write 30 ms more (1440 frames = 720 samples @ 24kHz -> pos_24k = 960 = 40ms), backdate 85ms
        let mut buf2 = vec![0.0_f32; 1440 * 2];
        fill_output_buffer(&mut buf2, 2, 0.5, 0.050, &out.shared);
        {
            let mut guard = out.shared.state.lock().unwrap();
            let a = guard.anchor.as_mut().unwrap();
            a.callback_at = Instant::now() - std::time::Duration::from_millis(85);
        }
        let word1_snap = out.snapshot();
        assert!(word1_snap.playback_ms >= 25 && word1_snap.playback_ms <= 40);
        assert_eq!(word1_snap.word_idx, 1);

        // Pausing twice must freeze the heard position without resetting it to 0.
        out.set_paused(true);
        let frozen_ms = out.snapshot().playback_ms;
        assert!(frozen_ms >= 25);
        out.set_paused(true);
        assert_eq!(out.snapshot().playback_ms, frozen_ms);
    }

    #[test]
    fn heard_position_stays_monotonic_across_wasapi_latency_spikes() {
        let out = AudioOutput::new_headless(1.0, 1.0);
        let seg_gen = out.generation();
        let timings = vec![
            WordTiming { word_index: 0, start_sample: 0, end_sample: 2_400 },
            WordTiming { word_index: 1, start_sample: 2_400, end_sample: 7_200 },
            WordTiming { word_index: 2, start_sample: 7_200, end_sample: 24_000 },
        ];
        out.enqueue_speech(seg_gen, 0, false, vec![0.25; 24_000], 0, timings);
        out.set_paused(false);

        let lat0 = update_smoothed_latency(None, 0.040);
        assert!((lat0 - 0.040).abs() < 1e-6);

        // Write 160 ms (7680 stereo frames @ 48 kHz -> 3840 samples @ 24 kHz)
        let mut buf1 = vec![0.0_f32; 7_680 * 2];
        fill_output_buffer(&mut buf1, 2, 0.5, lat0, &out.shared);
        {
            let mut guard = out.shared.state.lock().unwrap();
            let a = guard.anchor.as_mut().unwrap();
            a.callback_at = Instant::now() - std::time::Duration::from_millis(190);
        }
        let snap1 = out.snapshot();
        assert!(snap1.playback_ms >= 145 && snap1.playback_ms <= 160);
        assert_eq!(snap1.word_idx, 1);

        // A raw 450 ms WASAPI latency spike is strongly damped by the slew limiter.
        let spike_lat = update_smoothed_latency(Some(lat0), 0.450);
        assert!(spike_lat <= 0.046);

        // Even a direct 250 ms raw latency jump must never regress playback_ms or word_idx.
        let mut buf2 = vec![0.0_f32; 480 * 2];
        fill_output_buffer(&mut buf2, 2, 0.5, 0.250, &out.shared);
        let snap_after_spike = out.snapshot();
        assert!(snap_after_spike.playback_ms >= snap1.playback_ms);
        assert!(snap_after_spike.word_idx >= snap1.word_idx);

        // Subsequent playback continues advancing cleanly to word 2.
        let mut buf3 = vec![0.0_f32; 9_600 * 2];
        fill_output_buffer(&mut buf3, 2, 0.5, 0.040, &out.shared);
        {
            let mut guard = out.shared.state.lock().unwrap();
            let a = guard.anchor.as_mut().unwrap();
            a.callback_at = Instant::now() - std::time::Duration::from_millis(250);
        }
        let snap_final = out.snapshot();
        assert!(snap_final.playback_ms > snap_after_spike.playback_ms);
        assert_eq!(snap_final.word_idx, 2);
    }

    #[test]
    fn restretch_preserves_heard_position_without_dropping_to_zero() {
        let out = AudioOutput::new_headless(1.0, 1.0);
        let seg_gen = out.generation();
        let pcm: Vec<f32> = (0..24_000)
            .map(|i| 0.25 * (2.0 * std::f32::consts::PI * 180.0 * i as f32 / 24_000.0).sin())
            .collect();
        let timings = vec![
            WordTiming { word_index: 0, start_sample: 0, end_sample: 4_800 },
            WordTiming { word_index: 1, start_sample: 4_800, end_sample: 14_400 },
            WordTiming { word_index: 2, start_sample: 14_400, end_sample: 24_000 },
        ];
        out.enqueue_speech(seg_gen, 0, false, pcm, 0, timings);
        out.set_paused(false);

        // Write 300 ms (14,400 stereo frames @ 48 kHz -> 7,200 samples @ 24 kHz)
        let mut buf = vec![0.0_f32; 14_400 * 2];
        fill_output_buffer(&mut buf, 2, 0.5, 0.040, &out.shared);
        {
            let mut guard = out.shared.state.lock().unwrap();
            let a = guard.anchor.as_mut().unwrap();
            a.callback_at = Instant::now() - std::time::Duration::from_millis(320);
        }
        let before = out.snapshot();
        assert!(before.playback_ms >= 270 && before.playback_ms <= 290);
        assert_eq!(before.word_idx, 1);

        // Immediately after set_speed(1.5), snapshot must retain heard position inside word 1.
        out.set_speed(1.5);
        let after = out.snapshot();
        assert!(after.playback_ms >= 150, "expected >= 150ms, got {}", after.playback_ms);
        assert_eq!(after.word_idx, 1);
    }
}
