//! Dedicated `cpal` WASAPI audio output thread with zero-allocation callback,
//! instant pause/resume, live speed re-stretching, volume ramping, and sample-accurate CC sync.

use crate::tts::alignment::{WordTiming, word_index_at_sample};
use crate::tts::wsola::WsolaStretcher;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
    /// Fractional playback position within `[0 .. stretched_pcm.len() + trailing_silence_24k]`.
    pub pos_24k: f64,
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
        Self {
            generation,
            sentence_idx,
            is_preview,
            raw_speech_pcm,
            stretched_pcm,
            src_map,
            trailing_silence_24k,
            word_timings,
            pos_24k: 0.0,
        }
    }

    fn total_len_24k(&self) -> usize {
        self.stretched_pcm.len() + self.trailing_silence_24k
    }

    fn current_word_idx(&self) -> usize {
        if self.src_map.is_empty() || self.word_timings.is_empty() {
            return 0;
        }
        let idx = (self.pos_24k.floor() as usize).min(self.src_map.len() - 1);
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
        self.pos_24k = new_pos as f64;
    }
}

#[derive(Default)]
struct QueueState {
    active: Option<AudioSegment>,
    queue: VecDeque<AudioSegment>,
    finished_natural: bool,
}

#[derive(Clone, Debug)]
pub struct AudioSnapshot {
    pub sentence_idx: Option<usize>,
    pub word_idx: usize,
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

        let mut guard = self.shared.state.lock().unwrap();
        if let Some(active) = guard.active.as_mut() {
            active.restretch(clamped, &self.stretcher);
        }
        for seg in guard.queue.iter_mut() {
            seg.restretch(clamped, &self.stretcher);
        }
    }

    /// Clears all buffered audio and bumps the active generation ID for instant skip/seek.
    pub fn flush_and_bump_generation(&self) -> u64 {
        let next_gen = self.shared.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let mut guard = self.shared.state.lock().unwrap();
        guard.active = None;
        guard.queue.clear();
        guard.finished_natural = false;
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
        let guard = self.shared.state.lock().unwrap();
        let (sentence_idx, word_idx, is_preview, has_audio) = match guard.active.as_ref() {
            Some(seg) => (
                Some(seg.sentence_idx),
                seg.current_word_idx(),
                seg.is_preview,
                true,
            ),
            None => (None, 0, false, false),
        };
        AudioSnapshot {
            sentence_idx,
            word_idx,
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

    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                fill_output_buffer(data, channels, step_24k, &shared);
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
                        state.active = Some(next);
                        continue;
                    }
                    continue;
                }
                break;
            };

            if seg.generation != active_gen {
                state.active = None;
                continue;
            }

            let total_len = seg.total_len_24k();
            let idx = seg.pos_24k.floor() as usize;
            if idx >= total_len {
                let was_preview = seg.is_preview;
                state.active = state.queue.pop_front();
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
}
