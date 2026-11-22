//! Native Rust Qwen3-TTS Base voice-cloning engine built on `qwen_tts` + `candle-core`.

use crate::models::{AudioClipProbe, CloneVoiceRequest, ClonedVoiceMeta, QwenModelVariant};
use crate::paths::AppPaths;
use crate::storage::now_unix_secs;
use candle_core::{DType, Device, Tensor};
use hound::{SampleFormat, WavSpec, WavWriter};
use qwen_tts::audio::utils::{AudioInput, load_audio};
use qwen_tts::io::voice_prompt::{load_voice_prompt, save_voice_prompt};
use qwen_tts::model::Model;
use qwen_tts::model::loader::{LoaderConfig, ModelLoader};
use qwen_tts::model::options::VoiceCloneOptions;
use qwen_tts::model::voice_clone::VoiceClonePromptItem;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};

pub const QWEN_SAMPLE_RATE: u32 = 24_000;
pub const MIN_REF_DURATION_SEC: f32 = 3.0;
pub const RECOMMENDED_MAX_REF_SEC: f32 = 15.0;
pub const HARD_MAX_REF_SEC: f32 = 30.0;
const REF_TRAILING_SILENCE_MS: usize = 120;
const REF_EDGE_FADE_MS: usize = 10;

static CUDA_AVAILABLE: OnceLock<bool> = OnceLock::new();

#[cfg(all(target_os = "windows", feature = "qwen-cuda"))]
fn cuda_dlls_present() -> bool {
    let runtime_dlls = option_env!("BOOKREADER_CUDA_DLLS")
        .unwrap_or("cublas64_13.dll,cublasLt64_13.dll,curand64_10.dll,nvrtc64_130_0.dll");
    let candidates = std::iter::once("nvcuda.dll").chain(
        runtime_dlls
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    );

    for dll in candidates {
        let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a valid NUL-terminated UTF-16 buffer for the duration of `LoadLibraryW`;
        // a non-null handle is immediately balanced by `FreeLibrary`.
        let handle =
            unsafe { windows_sys::Win32::System::LibraryLoader::LoadLibraryW(wide.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        // SAFETY: `handle` was just returned non-null by `LoadLibraryW`.
        unsafe { windows_sys::Win32::Foundation::FreeLibrary(handle) };
    }
    true
}

fn cuda_available() -> bool {
    *CUDA_AVAILABLE.get_or_init(|| {
        #[cfg(feature = "qwen-cuda")]
        {
            #[cfg(target_os = "windows")]
            if !cuda_dlls_present() {
                tracing::info!(
                    "CUDA runtime DLLs not found on this machine; Qwen3-TTS will use CPU fallback"
                );
                return false;
            }
            Device::new_cuda(0).is_ok()
        }
        #[cfg(not(feature = "qwen-cuda"))]
        {
            false
        }
    })
}

struct LoadedQwen {
    variant: QwenModelVariant,
    model: Model,
    device: Device,
    dtype: DType,
    device_label: String,
    prompt_cache: HashMap<String, VoiceClonePromptItem>,
}

/// Thread-safe lazy wrapper around the Qwen3-TTS Base voice-cloning model.
pub struct QwenCloneEngine {
    inner: Mutex<Option<LoadedQwen>>,
    loaded: AtomicBool,
    loaded_variant: RwLock<Option<QwenModelVariant>>,
    active_device_label: RwLock<Option<String>>,
    pending_evictions: Mutex<HashSet<String>>,
}

impl QwenCloneEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            loaded: AtomicBool::new(false),
            loaded_variant: RwLock::new(None),
            active_device_label: RwLock::new(None),
            pending_evictions: Mutex::new(HashSet::new()),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded.load(Ordering::Acquire)
    }

    pub fn loaded_variant(&self) -> Option<QwenModelVariant> {
        *self
            .loaded_variant
            .read()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_variant_loaded(&self, variant: QwenModelVariant) -> bool {
        self.is_loaded() && self.loaded_variant() == Some(variant)
    }

    pub fn detect_device_label() -> String {
        if cuda_available() {
            "CUDA GPU (BF16)".to_string()
        } else {
            "CPU Fallback (F32)".to_string()
        }
    }

    pub fn device_label(&self) -> String {
        if let Some(label) = self
            .active_device_label
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            return label.clone();
        }
        Self::detect_device_label()
    }

    fn select_device_and_dtype() -> (Device, DType, String) {
        #[cfg(feature = "qwen-cuda")]
        if cuda_available() {
            match Device::new_cuda(0) {
                Ok(dev) => return (dev, DType::BF16, "CUDA GPU (BF16)".to_string()),
                Err(err) => {
                    tracing::warn!(error = %err, "CUDA unavailable for Qwen3-TTS; falling back to CPU F32");
                }
            }
        }
        (Device::Cpu, DType::F32, "CPU Fallback (F32)".to_string())
    }

    fn mark_loaded(&self, variant: QwenModelVariant, label: &str) {
        *self
            .loaded_variant
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(variant);
        *self
            .active_device_label
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(label.to_string());
        self.loaded.store(true, Ordering::Release);
    }

    fn mark_unloaded(&self) {
        self.loaded.store(false, Ordering::Release);
        *self
            .loaded_variant
            .write()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .active_device_label
            .write()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn drain_evictions(&self, loaded: &mut LoadedQwen) {
        let mut pending = self
            .pending_evictions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for id in pending.drain() {
            loaded.prompt_cache.remove(&id);
        }
    }

    fn load_unlocked(paths: &AppPaths, variant: QwenModelVariant) -> Result<LoadedQwen, String> {
        if !paths.qwen_model_ready_for(variant) {
            return Err(format!(
                "{} model files are not downloaded yet. Download them in Voice Cloning.",
                variant.display_name()
            ));
        }

        let (device, dtype, device_label) = Self::select_device_and_dtype();
        let loader = ModelLoader::from_local_dir(paths.qwen_model_dir(variant))
            .map_err(|e| format!("Failed opening {} model directory: {e}", variant.display_name()))?;
        let cfg = LoaderConfig {
            dtype,
            load_tokenizer: true,
            load_text_tokenizer: true,
            load_generate_config: true,
            use_flash_attn: false,
        };
        let model = loader
            .load_tts_model(&device, &cfg)
            .map_err(|e| format!("Failed loading {} model: {e}", variant.display_name()))?;

        Ok(LoadedQwen {
            variant,
            model,
            device,
            dtype,
            device_label,
            prompt_cache: HashMap::new(),
        })
    }

    fn ensure_loaded_locked<'a>(
        &self,
        guard: &'a mut Option<LoadedQwen>,
        paths: &AppPaths,
        variant: QwenModelVariant,
    ) -> Result<&'a mut LoadedQwen, String> {
        if guard.as_ref().is_some_and(|l| l.variant != variant) {
            // Release old model weights & VRAM before allocating the newly selected model size.
            *guard = None;
            self.mark_unloaded();
        }
        if guard.is_none() {
            let loaded = Self::load_unlocked(paths, variant)?;
            self.mark_loaded(variant, &loaded.device_label);
            *guard = Some(loaded);
        }
        let loaded = guard.as_mut().ok_or("Qwen3-TTS engine is not loaded")?;
        self.drain_evictions(loaded);
        Ok(loaded)
    }

    /// Ensures the requested Qwen3-TTS variant is loaded into memory/VRAM.
    pub fn ensure_loaded(&self, paths: &AppPaths, variant: QwenModelVariant) -> Result<(), String> {
        if self.is_variant_loaded(variant) {
            return Ok(());
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let _ = self.ensure_loaded_locked(&mut guard, paths, variant)?;
        Ok(())
    }

    /// Creates a reusable Qwen3-TTS voice-clone prompt from a reference audio clip.
    pub fn clone_voice(
        &self,
        paths: &AppPaths,
        variant: QwenModelVariant,
        req: &CloneVoiceRequest,
    ) -> Result<ClonedVoiceMeta, String> {
        let clean_name = req.name.trim().to_string();
        if clean_name.is_empty() || clean_name.chars().count() > 48 {
            return Err("Voice name must be between 1 and 48 characters.".to_string());
        }

        let clean_ref_text = req
            .ref_text
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);

        let src_path = Path::new(&req.audio_path);
        let (normalized, duration_sec) = decode_reference_slice(
            src_path,
            req.trim_start_sec,
            req.trim_end_sec,
        )?;

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.ensure_loaded_locked(&mut guard, paths, variant)?;

        let ref_tensor = Tensor::from_vec(normalized.clone(), (normalized.len(),), &loaded.device)
            .map_err(|e| format!("Failed transferring reference audio tensor: {e}"))?;

        let x_vector_only = clean_ref_text.is_none();
        let prompt = loaded
            .model
            .create_voice_clone_prompt_from_audio(&ref_tensor, clean_ref_text.clone(), x_vector_only)
            .map_err(|e| format!("Voice cloning extraction failed: {e}"))?;

        let short_id = &uuid::Uuid::new_v4().simple().to_string()[..12];
        let voice_id = format!("clone_{short_id}");

        let prompt_path = paths.cloned_voice_prompt_path_for(&voice_id, variant)?;
        let ref_wav_path = paths.cloned_voice_ref_wav_path(&voice_id)?;

        write_mono_wav_f32(&ref_wav_path, &normalized, QWEN_SAMPLE_RATE)?;
        save_voice_prompt(
            &prompt,
            &prompt_path,
            prompt.x_vector_only_mode,
            prompt.ref_text.as_deref(),
        )
        .map_err(|e| {
            let _ = std::fs::remove_file(&ref_wav_path);
            format!("Failed saving cloned voice prompt: {e}")
        })?;

        let icl_mode = prompt.icl_mode;
        loaded.prompt_cache.insert(voice_id.clone(), prompt);

        let src_name = src_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("clip");
        let description = format!(
            "Cloned via Qwen3-TTS ({}, {duration_sec:.1}s from {src_name}).",
            if icl_mode { "ICL" } else { "X-Vector" }
        );

        Ok(ClonedVoiceMeta {
            voice_id,
            name: clean_name,
            description,
            ref_text: clean_ref_text,
            icl_mode,
            duration_sec,
            created_at: now_unix_secs(),
        })
    }

    /// Synthesizes one cleaned sentence into 24 kHz mono PCM using a saved cloned voice.
    pub fn synthesize(
        &self,
        paths: &AppPaths,
        variant: QwenModelVariant,
        text: &str,
        voice_id: &str,
        voice_meta: Option<&ClonedVoiceMeta>,
    ) -> Result<Vec<f32>, String> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.ensure_loaded_locked(&mut guard, paths, variant)?;

        let prompt = if let Some(cached) = loaded.prompt_cache.get(voice_id) {
            cached.clone()
        } else {
            let variant_prompt_path = paths.cloned_voice_prompt_path_for(voice_id, variant)?;
            let legacy_prompt_path = (variant == QwenModelVariant::Quality1_7B)
                .then(|| paths.cloned_voice_prompt_path(voice_id).ok())
                .flatten();

            let loaded_prompt = if variant_prompt_path.is_file() {
                load_voice_prompt(&variant_prompt_path, &loaded.device, loaded.dtype)
                    .map_err(|e| format!("Failed loading cloned voice {voice_id}: {e}"))?
            } else if let Some(ref legacy) = legacy_prompt_path
                && legacy.is_file()
            {
                load_voice_prompt(legacy, &loaded.device, loaded.dtype)
                    .map_err(|e| format!("Failed loading legacy cloned voice {voice_id}: {e}"))?
            } else {
                let ref_wav_path = paths.cloned_voice_ref_wav_path(voice_id)?;
                if !ref_wav_path.is_file() {
                    return Err(format!("Cloned voice files are missing for {voice_id}"));
                }
                let audio = load_audio(
                    AudioInput::FilePath(ref_wav_path.to_string_lossy().into_owned()),
                    Some(QWEN_SAMPLE_RATE),
                )
                .map_err(|e| format!("Failed reading cloned reference audio for {voice_id}: {e}"))?;
                let sample_len = audio.samples.len();
                let ref_tensor =
                    Tensor::from_vec(audio.samples, (sample_len,), &loaded.device)
                        .map_err(|e| format!("Failed preparing reference tensor for {voice_id}: {e}"))?;
                let clean_ref_text = voice_meta
                    .filter(|m| m.icl_mode)
                    .and_then(|m| m.ref_text.as_deref())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string);
                let x_vector_only = clean_ref_text.is_none();
                let prompt = loaded
                    .model
                    .create_voice_clone_prompt_from_audio(&ref_tensor, clean_ref_text, x_vector_only)
                    .map_err(|e| {
                        format!(
                            "Failed rebuilding cloned voice {voice_id} for {}: {e}",
                            variant.display_name()
                        )
                    })?;
                let _ = save_voice_prompt(
                    &prompt,
                    &variant_prompt_path,
                    prompt.x_vector_only_mode,
                    prompt.ref_text.as_deref(),
                );
                prompt
            };
            loaded
                .prompt_cache
                .insert(voice_id.to_string(), loaded_prompt.clone());
            loaded_prompt
        };

        let est_tokens = text.chars().count().saturating_mul(6).clamp(160, 1024);
        let opts = VoiceCloneOptions {
            max_new_tokens: Some(est_tokens),
            ..Default::default()
        };

        let result = loaded
            .model
            .generate_voice_clone_from_text(text, &prompt, "english", Some(opts))
            .map_err(|e| format!("Qwen3-TTS synthesis failed: {e}"))?;

        let samples = result
            .audio
            .flatten_all()
            .and_then(|t| t.to_dtype(DType::F32))
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| format!("Failed reading Qwen3-TTS audio output: {e}"))?;

        if result.sample_rate != QWEN_SAMPLE_RATE as usize && result.sample_rate > 0 {
            Ok(resample_linear(&samples, result.sample_rate as u32, QWEN_SAMPLE_RATE))
        } else {
            Ok(samples)
        }
    }

    pub fn evict_cached_voice(&self, voice_id: &str) {
        if let Ok(mut guard) = self.inner.try_lock() {
            if let Some(loaded) = guard.as_mut() {
                loaded.prompt_cache.remove(voice_id);
            }
            self.pending_evictions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(voice_id);
        } else {
            self.pending_evictions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(voice_id.to_string());
        }
    }
}

/// Decodes, trims, normalizes, and fades a reference audio slice to 24 kHz mono PCM.
pub fn decode_reference_slice(
    path: &Path,
    start_sec: Option<f32>,
    end_sec: Option<f32>,
) -> Result<(Vec<f32>, f32), String> {
    if !path.is_file() {
        return Err(format!("Reference audio file not found: {}", path.display()));
    }
    let path_str = path.to_string_lossy().into_owned();
    let audio = load_audio(AudioInput::FilePath(path_str), Some(QWEN_SAMPLE_RATE))
        .map_err(|e| format!("Failed decoding reference audio: {e}"))?;
    slice_and_normalize_reference(&audio.samples, audio.sample_rate, start_sec, end_sec)
}

/// Decodes an audio file and computes recommended clip bounds.
pub fn probe_audio_clip(path: &Path) -> Result<AudioClipProbe, String> {
    if !path.is_file() {
        return Err(format!("Audio file not found: {}", path.display()));
    }
    let path_str = path.to_string_lossy().into_owned();
    let audio = load_audio(AudioInput::FilePath(path_str.clone()), Some(QWEN_SAMPLE_RATE))
        .map_err(|e| format!("Could not decode audio file: {e}"))?;

    let duration_sec = audio.duration_secs();
    let (status, start, end, message) = classify_clip_duration(duration_sec);
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio")
        .to_string();

    Ok(AudioClipProbe {
        path: path_str,
        filename,
        duration_sec,
        sample_rate: audio.sample_rate,
        recommended_start_sec: start,
        recommended_end_sec: end,
        status: status.to_string(),
        message,
    })
}

/// Classifies clip duration relative to Qwen3-TTS's 5–15s sweet spot (3s min, 30s max).
pub fn classify_clip_duration(duration_sec: f32) -> (&'static str, f32, f32, String) {
    if duration_sec < MIN_REF_DURATION_SEC {
        (
            "too_short",
            0.0,
            duration_sec,
            format!(
                "Clip is {duration_sec:.1}s. Needs at least 3.0s (5–15s clean speech recommended)."
            ),
        )
    } else if duration_sec <= RECOMMENDED_MAX_REF_SEC {
        (
            "optimal",
            0.0,
            duration_sec,
            format!(
                "Optimal length ({duration_sec:.1}s). Full clip selected."
            ),
        )
    } else if duration_sec <= HARD_MAX_REF_SEC {
        (
            "optimal",
            0.0,
            duration_sec,
            format!(
                "Clip is {duration_sec:.1}s. Full clip selected (5–15s is fastest, up to 30s supported)."
            ),
        )
    } else {
        (
            "will_trim",
            0.0,
            RECOMMENDED_MAX_REF_SEC,
            format!(
                "Clip is {duration_sec:.1}s (exceeds 30s max). First 15.0s selected — match any transcript to that exact slice."
            ),
        )
    }
}

/// Trims to the chosen window, removes DC offset, rejects silence, peak-normalizes to 0.92,
/// and adds soft edge fades plus trailing silence for clean ICL continuation boundaries.
pub fn slice_and_normalize_reference(
    samples: &[f32],
    sample_rate: u32,
    start_sec: Option<f32>,
    end_sec: Option<f32>,
) -> Result<(Vec<f32>, f32), String> {
    if sample_rate == 0 || samples.is_empty() {
        return Err("Reference audio contains no samples.".to_string());
    }

    let total_sec = samples.len() as f32 / sample_rate as f32;
    let start = start_sec.unwrap_or(0.0).max(0.0);
    let end = end_sec
        .unwrap_or_else(|| total_sec.min(HARD_MAX_REF_SEC))
        .min(total_sec);

    let span_sec = end - start;
    if span_sec < MIN_REF_DURATION_SEC - 0.01 {
        return Err(format!(
            "Selected audio range is too short ({span_sec:.2}s). Please use at least 3.0s (5–15s recommended)."
        ));
    }
    if span_sec > HARD_MAX_REF_SEC + 0.05 {
        return Err(format!(
            "Selected audio range is too long ({span_sec:.2}s). Please trim to 30.0s or less (5–15s recommended)."
        ));
    }

    let start_idx = ((start * sample_rate as f32).round() as usize).min(samples.len());
    let end_idx = ((end * sample_rate as f32).round() as usize)
        .max(start_idx)
        .min(samples.len());

    let slice = &samples[start_idx..end_idx];
    if slice.len() < (sample_rate as usize * 3).saturating_sub(240) {
        return Err("Reference audio has fewer than 3 seconds of samples.".to_string());
    }

    let mean = slice.iter().map(|&s| f64::from(s)).sum::<f64>() / slice.len() as f64;
    let mut out: Vec<f32> = slice.iter().map(|&s| (f64::from(s) - mean) as f32).collect();

    let peak = out.iter().fold(0.0f32, |acc, &s| acc.max(s.abs()));
    if peak < 1e-4 {
        return Err("Reference audio is silent. Please pick a clip with clear speech.".to_string());
    }

    let gain = (0.92 / peak).min(20.0);
    for s in &mut out {
        *s = (*s * gain).clamp(-1.0, 1.0);
    }

    let actual_dur = out.len() as f32 / sample_rate as f32;
    let fade_len = ((sample_rate as usize) * REF_EDGE_FADE_MS / 1000).min(out.len() / 4);
    if fade_len > 0 {
        for (i, sample) in out.iter_mut().take(fade_len).enumerate() {
            *sample *= (i as f32 + 1.0) / (fade_len as f32 + 1.0);
        }
        let len = out.len();
        for i in 0..fade_len {
            out[len - 1 - i] *= (i as f32 + 1.0) / (fade_len as f32 + 1.0);
        }
    }

    let silence_samples = (sample_rate as usize * REF_TRAILING_SILENCE_MS) / 1000;
    out.resize(out.len() + silence_samples, 0.0);

    Ok((out, actual_dur))
}

fn write_mono_wav_f32(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating voice dir {}: {e}", parent.display()))?;
    }
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer =
        WavWriter::create(path, spec).map_err(|e| format!("Failed creating WAV: {e}"))?;
    for &s in samples {
        let q = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        writer
            .write_sample(q)
            .map_err(|e| format!("Failed writing WAV sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Failed finalizing WAV: {e}"))
}

fn resample_linear(input: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
    if input.is_empty() || from_sr == 0 || from_sr == to_sr {
        return input.to_vec();
    }
    let ratio = f64::from(to_sr) / f64::from(from_sr);
    let out_len = ((input.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = (i as f64) / ratio;
        let idx = (src_pos.floor() as usize).min(input.len() - 1);
        let next = (idx + 1).min(input.len() - 1);
        let frac = (src_pos - idx as f64) as f32;
        out.push(input[idx] * (1.0 - frac) + input[next] * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_wave(secs: f32, sr: u32, amp: f32, dc: f32) -> Vec<f32> {
        let n = (secs * sr as f32) as usize;
        (0..n)
            .map(|i| dc + amp * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / sr as f32).sin())
            .collect()
    }

    #[test]
    fn rejects_short_silent_and_overlong_reference_clips() {
        let short = sine_wave(2.0, QWEN_SAMPLE_RATE, 0.4, 0.0);
        assert!(slice_and_normalize_reference(&short, QWEN_SAMPLE_RATE, None, None).is_err());

        let silent = vec![0.0f32; QWEN_SAMPLE_RATE as usize * 5];
        assert!(slice_and_normalize_reference(&silent, QWEN_SAMPLE_RATE, None, None).is_err());

        let long = sine_wave(35.0, QWEN_SAMPLE_RATE, 0.4, 0.0);
        assert!(
            slice_and_normalize_reference(&long, QWEN_SAMPLE_RATE, Some(0.0), Some(32.0)).is_err()
        );
    }

    #[test]
    fn slices_removes_dc_and_normalizes_valid_clip() {
        let clip = sine_wave(14.0, QWEN_SAMPLE_RATE, 0.2, 0.15);
        let (out, dur) =
            slice_and_normalize_reference(&clip, QWEN_SAMPLE_RATE, Some(1.0), Some(7.5)).unwrap();
        assert!((dur - 6.5).abs() < 0.05);
        let pad_len = (QWEN_SAMPLE_RATE as usize * REF_TRAILING_SILENCE_MS) / 1000;
        assert_eq!(out.len(), (6.5 * QWEN_SAMPLE_RATE as f32) as usize + pad_len);
        assert!(out[out.len() - pad_len..].iter().all(|&s| s == 0.0));
        let speech = &out[..out.len() - pad_len];
        let mean: f32 = speech.iter().sum::<f32>() / speech.len() as f32;
        let peak = speech.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        assert!(mean.abs() < 1e-3);
        assert!((peak - 0.92).abs() < 0.02);
    }

    #[test]
    fn classifies_clip_durations_accurately() {
        assert_eq!(classify_clip_duration(1.8).0, "too_short");
        assert_eq!(classify_clip_duration(12.5).0, "optimal");
        assert_eq!(classify_clip_duration(12.5).1, 0.0);
        assert!((classify_clip_duration(12.5).2 - 12.5).abs() < 1e-4);
        assert_eq!(classify_clip_duration(18.0).0, "optimal");
        assert!((classify_clip_duration(18.0).2 - 18.0).abs() < 1e-4);
        let (status, start, end, _) = classify_clip_duration(45.0);
        assert_eq!(status, "will_trim");
        assert_eq!((start, end), (0.0, 15.0));
    }

    #[test]
    fn metadata_and_eviction_do_not_block_while_engine_mutex_is_held() {
        let engine = QwenCloneEngine::new();
        let _busy_guard = engine.inner.lock().unwrap();

        assert!(!engine.is_loaded());
        assert_eq!(engine.loaded_variant(), None);
        assert!(!engine.is_variant_loaded(QwenModelVariant::Fast0_6B));
        assert!(!engine.is_variant_loaded(QwenModelVariant::Quality1_7B));
        let label = engine.device_label();
        assert!(!label.is_empty());

        engine.evict_cached_voice("clone_abc123");
        let pending = engine.pending_evictions.lock().unwrap();
        assert!(pending.contains("clone_abc123"));
    }
}
