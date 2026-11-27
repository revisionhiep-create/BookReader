//! Native pure-Rust Kyutai Pocket TTS engine for FR, DE, ES, PT, IT, and NL
//! built directly on `ptts 0.7.1`, `xn 0.2.15`, and `safetensors 0.7` (CPU f32).

use crate::models::AppLanguage;
use crate::paths::AppPaths;
use ptts::flow_lm::{FlowLMConfig, FlowType, NormalRng, StepInput, TimeRmsNorm};
use ptts::loader::load_weights;
use ptts::mimi::MimiConfig;
use ptts::plan::{self, EosPolicy};
use ptts::preprocess::Normalize;
use ptts::tok::Tok;
use ptts::transformer::LayerAttentionState;
use ptts::tts_model::{MAX_TOKENS_PER_CHUNK, TTSConfig, TTSModel};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Mutex, RwLock};
use xn::{CpuDevice, Tensor, Unquantized};

const POCKET_NUM_LAYERS: usize = 6;
const POCKET_NUM_HEADS: usize = 16;
const POCKET_HEAD_DIM: usize = 64;
const POCKET_TEMPERATURE: f32 = 0.7;
const POCKET_SEED: u64 = 4242424242424242;

/// Precomputed Flow-LM KV-cache tensors for one transformer layer of a Pocket TTS speaker.
#[derive(Clone, Debug)]
pub struct PocketLayerKv {
    pub k: Tensor<f32, CpuDevice>,
    pub v: Tensor<f32, CpuDevice>,
    pub len: usize,
}

/// Precomputed Flow-LM KV-cache prompt for a Pocket TTS speaker embedding.
#[derive(Clone, Debug)]
pub struct PocketVoiceKvCache {
    pub layers: Vec<PocketLayerKv>,
    pub prompt_len: usize,
}

struct LoadedPocket {
    lang: AppLanguage,
    model: TTSModel<Unquantized<f32, CpuDevice>>,
    cfg: TTSConfig,
    voice_cache: HashMap<String, PocketVoiceKvCache>,
}

/// Thread-safe lazy wrapper holding at most one loaded Kyutai Pocket TTS language checkpoint.
pub struct PocketEngine {
    inner: Mutex<Option<LoadedPocket>>,
    loaded_lang: RwLock<Option<AppLanguage>>,
}

impl PocketEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            loaded_lang: RwLock::new(None),
        }
    }

    #[allow(dead_code)]
    pub fn is_loaded(&self) -> bool {
        self.loaded_language().is_some()
    }

    pub fn loaded_language(&self) -> Option<AppLanguage> {
        *self
            .loaded_lang
            .read()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_language_loaded(&self, lang: AppLanguage) -> bool {
        lang != AppLanguage::En && self.loaded_language() == Some(lang)
    }

    /// Drops the currently loaded Pocket TTS checkpoint (if any) to reclaim RAM.
    pub fn unload(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
        *self
            .loaded_lang
            .write()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Loads the Pocket TTS checkpoint for `lang`, dropping any previously loaded language first.
    pub fn ensure_loaded(&self, paths: &AppPaths, lang: AppLanguage) -> Result<(), String> {
        if lang == AppLanguage::En {
            return Err("English uses Phonon 31M, not Kyutai Pocket TTS".to_string());
        }
        if self.is_language_loaded(lang) {
            return Ok(());
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let _ = self.ensure_loaded_locked(&mut guard, paths, lang)?;
        Ok(())
    }

    fn ensure_loaded_locked<'a>(
        &self,
        guard: &'a mut Option<LoadedPocket>,
        paths: &AppPaths,
        lang: AppLanguage,
    ) -> Result<&'a mut LoadedPocket, String> {
        if lang == AppLanguage::En {
            return Err("English uses Phonon 31M, not Kyutai Pocket TTS".to_string());
        }
        if guard.as_ref().is_some_and(|l| l.lang != lang) {
            *guard = None;
            *self
                .loaded_lang
                .write()
                .unwrap_or_else(|e| e.into_inner()) = None;
        }
        if guard.is_none() {
            if !paths.language_model_ready(lang) {
                return Err(format!(
                    "Pocket TTS ({}) model files are not downloaded yet",
                    lang.code()
                ));
            }
            let model_dir = paths.pocket_model_dir(lang)?;
            let weights_path = model_dir.join("model.safetensors");
            let tokenizer_path = model_dir.join("tokenizer.json");

            let cfg = pocket_tts_config();
            let vb = load_weights::<Unquantized<f32, CpuDevice>>(&weights_path, &CpuDevice)
                .map_err(|e| format!("Failed loading Pocket TTS weights ({}): {e}", lang.code()))?;
            let tok = Tok::open(&tokenizer_path)
                .map_err(|e| format!("Failed loading Pocket TTS tokenizer ({}): {e}", lang.code()))?;
            let model = TTSModel::<Unquantized<f32, CpuDevice>>::load(
                &vb,
                Box::new(tok),
                &cfg,
                &HashMap::new(),
            )
            .map_err(|e| format!("Failed initializing Pocket TTS model ({}): {e}", lang.code()))?;

            *self
                .loaded_lang
                .write()
                .unwrap_or_else(|e| e.into_inner()) = Some(lang);
            *guard = Some(LoadedPocket {
                lang,
                model,
                cfg,
                voice_cache: HashMap::new(),
            });
        }
        guard
            .as_mut()
            .ok_or_else(|| "Pocket TTS engine is not loaded".to_string())
    }

    /// Synthesizes text into 24 kHz mono PCM using Kyutai Pocket TTS for `lang` and speaker `slug`.
    pub fn synthesize(
        &self,
        paths: &AppPaths,
        lang: AppLanguage,
        slug: &str,
        text: &str,
    ) -> Result<Vec<f32>, String> {
        let prepared = preprocess_pocket_text(text, lang);
        if prepared.is_empty() {
            return Ok(Vec::new());
        }

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.ensure_loaded_locked(&mut guard, paths, lang)?;

        let voice_kv = if let Some(cached) = loaded.voice_cache.get(slug) {
            cached.clone()
        } else {
            let voice_path = paths.pocket_voice_path(lang, slug)?;
            if !voice_path.is_file() {
                return Err(format!("Pocket voice {lang:?}:{slug} is not downloaded yet"));
            }
            let parsed = load_pocket_voice_kv(&voice_path)?;
            loaded.voice_cache.insert(slug.to_string(), parsed.clone());
            parsed
        };

        let tokenizer = loaded
            .model
            .flow_lm
            .conditioner
            .tokenizer
            .as_deref()
            .ok_or_else(|| "Pocket TTS tokenizer missing from loaded model".to_string())?;

        let raw_chunks = plan::chunks(
            tokenizer,
            &prepared,
            Normalize::OFF,
            MAX_TOKENS_PER_CHUNK,
            loaded.cfg.mimi.frame_rate,
        )
        .map_err(|e| format!("Pocket TTS chunk planning failed: {e}"))?;

        let chunks = plan::fit_or_error(
            raw_chunks,
            plan::MAX_FIT_TOKENS,
            tokenizer,
            loaded.cfg.mimi.frame_rate,
        )
        .map_err(|e| format!("Pocket TTS chunk fitting failed: {e}"))?;

        let mut pcm = Vec::new();
        let mut rng = NormalRng::new(POCKET_TEMPERATURE, POCKET_SEED)
            .map_err(|e| format!("Failed initializing Pocket RNG: {e}"))?;

        for chunk in chunks {
            let seq_budget = voice_kv.prompt_len + chunk.tokens.len() + chunk.frame_budget + 8;
            let mut state = loaded
                .model
                .init_flow_lm_state(1, seq_budget)
                .map_err(|e| format!("Failed initializing Pocket flow state: {e}"))?;

            if state.flow_lm_state.transformer_state.layer_states.len() != voice_kv.layers.len() {
                return Err(format!(
                    "Pocket layer count mismatch: model has {}, voice cache has {}",
                    state.flow_lm_state.transformer_state.layer_states.len(),
                    voice_kv.layers.len()
                ));
            }

            for (layer_state, kv) in state
                .flow_lm_state
                .transformer_state
                .layer_states
                .iter_mut()
                .zip(voice_kv.layers.iter())
            {
                let LayerAttentionState::FlowLm(mha) = layer_state else {
                    return Err("Unexpected Mimi layer state inside Pocket Flow-LM".to_string());
                };
                if kv.len > 0 {
                    mha.k_cache
                        .slice_set(&kv.k, 1usize, 0)
                        .map_err(|e| format!("Failed writing Pocket k_cache: {e}"))?;
                    mha.v_cache
                        .slice_set(&kv.v, 1usize, 0)
                        .map_err(|e| format!("Failed writing Pocket v_cache: {e}"))?;
                    mha.current_end = kv.len;
                }
            }

            loaded
                .model
                .prompt_text(&mut state, &chunk.tokens)
                .map_err(|e| format!("Pocket TTS prompt_text failed: {e}"))?;

            let mut mimi_state = loaded
                .model
                .init_mimi_state(1)
                .map_err(|e| format!("Failed initializing Pocket Mimi state: {e}"))?;
            let mut prev_latent: Option<Tensor<f32, CpuDevice>> = None;
            let mut eos = EosPolicy::new(chunk.frames_after_eos);

            for _ in 0..chunk.frame_budget {
                let input = match prev_latent.as_ref() {
                    None => StepInput::Bos { batch: 1 },
                    Some(t) => StepInput::Latent(t),
                };
                let (latent, eos_logit) = loaded
                    .model
                    .generate_step_parts(&mut state, input, &mut rng)
                    .map_err(|e| format!("Pocket TTS generate_step failed: {e}"))?;

                let audio = loaded
                    .model
                    .decode_latent(&latent, &mut mimi_state)
                    .map_err(|e| format!("Pocket TTS Mimi decode failed: {e}"))?;
                let samples = audio
                    .narrow(0, ..1)
                    .and_then(|t| t.contiguous())
                    .and_then(|t| t.to_vec())
                    .map_err(|e| format!("Failed reading Pocket PCM frame: {e}"))?;
                pcm.extend_from_slice(&samples);

                let eos_vals = eos_logit
                    .to_vec()
                    .map_err(|e| format!("Failed reading Pocket EOS logit: {e}"))?;
                let is_eos = loaded.model.eos_from_logit(&eos_vals);
                if eos.should_stop(is_eos) {
                    break;
                }
                prev_latent = Some(latent);
            }
        }

        Ok(pcm)
    }
}

/// Official `TTSConfig` matching `kyutai/pocket-tts-without-voice-cloning` checkpoints.
pub fn pocket_tts_config() -> TTSConfig {
    TTSConfig {
        flow_lm: FlowLMConfig {
            d_model: 1024,
            num_heads: 16,
            num_layers: 6,
            dim_feedforward: 4096,
            max_period: 10000.0,
            n_bins: 4000,
            lut_dim: 1024,
            flow_dim: 512,
            flow_depth: 6,
            ldim: 32,
            gelu: None, // With `model_id: None`, `default_gelu()` selects `Gelu::Tanh`.
            time_rms_norm: TimeRmsNorm::RmsVar,
            flow_type: FlowType::Lsd,
            z_dim: None,
            attn_dim: None,
            num_kv_heads: None,
        },
        mimi: MimiConfig {
            channels: 1,
            sample_rate: 24000,
            frame_rate: 12.5,
            dimension: 512,
            quantizer_dimension: 32,
            quantizer_output_dimension: 512,
            n_filters: 64,
            n_residual_layers: 1,
            ratios: vec![6, 5, 4],
            kernel_size: 7,
            last_kernel_size: 3,
            residual_kernel_size: 3,
            dilation_base: 2,
            compress: 2,
            transformer_d_model: 512,
            transformer_num_heads: 8,
            transformer_num_layers: 2,
            transformer_layer_scale: 0.01,
            transformer_context: 250,
            transformer_max_period: 10000.0,
            transformer_dim_feedforward: 2048,
            downsample_channel_wise: false,
            decoder_dimension: None,
            inner_dim: Some(32),
            gelu: None,
        },
        lsd_decode_steps: 1,
        eos_threshold: -4.0,
        model_id: None,
        audio_prompt_min_duration: 10.0,
        audio_prompt_max_duration: 10.0,
        cfg_null_audio_empty: false,
        cfg_null_text_empty: false,
        prefix_sinks: BTreeMap::new(),
        speaker_mimi: None,
        conditioners: Vec::new(),
        fuser: None,
        voices: Vec::new(),
        languages: Vec::new(),
        embeddings_ext: None,
        audio_delay: 0,
    }
}

/// Loads a precomputed Pocket TTS speaker KV-cache `.safetensors` file from disk.
pub fn load_pocket_voice_kv(path: &Path) -> Result<PocketVoiceKvCache, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Failed reading Pocket voice {}: {e}", path.display()))?;
    parse_pocket_voice_safetensors(&bytes)
}

/// Parses precomputed `transformer.layers.{0..5}.self_attn/{offset,pad,cache}` tensors.
pub fn parse_pocket_voice_safetensors(bytes: &[u8]) -> Result<PocketVoiceKvCache, String> {
    let st = safetensors::SafeTensors::deserialize(bytes)
        .map_err(|e| format!("Invalid Pocket voice safetensors: {e}"))?;

    let mut layers = Vec::with_capacity(POCKET_NUM_LAYERS);
    let mut expected_prompt_len: Option<usize> = None;

    for idx in 0..POCKET_NUM_LAYERS {
        let offset_key = format!("transformer.layers.{idx}.self_attn/offset");
        let pad_key = format!("transformer.layers.{idx}.self_attn/pad");
        let cache_key = format!("transformer.layers.{idx}.self_attn/cache");

        let offset = read_scalar_i64_tensor(&st, &offset_key)?;
        let pad = if st.names().iter().any(|n| *n == pad_key) {
            read_scalar_i64_tensor(&st, &pad_key)?
        } else {
            0
        };
        if offset < 0 || pad < 0 || pad > offset {
            return Err(format!(
                "Invalid Pocket voice KV bounds in layer {idx}: pad={pad}, offset={offset}"
            ));
        }
        let offset = offset as usize;
        let pad = pad as usize;

        let cache_view = st
            .tensor(&cache_key)
            .map_err(|e| format!("Missing Pocket voice tensor {cache_key}: {e}"))?;
        if cache_view.dtype() != safetensors::Dtype::F32 {
            return Err(format!(
                "Expected F32 for {cache_key}, got {:?}",
                cache_view.dtype()
            ));
        }
        let shape = cache_view.shape();
        if shape.len() != 5
            || shape[0] != 2
            || shape[1] != 1
            || shape[3] != POCKET_NUM_HEADS
            || shape[4] != POCKET_HEAD_DIM
        {
            return Err(format!(
                "Unexpected shape for {cache_key}: {shape:?}, expected [2, 1, cap, {POCKET_NUM_HEADS}, {POCKET_HEAD_DIM}]"
            ));
        }
        let cap = shape[2];
        if offset > cap {
            return Err(format!(
                "Pocket voice offset {offset} exceeds cache capacity {cap} in layer {idx}"
            ));
        }

        let len = offset - pad;
        if let Some(prev) = expected_prompt_len {
            if prev != len {
                return Err(format!(
                    "Pocket voice prompt length mismatch across layers: layer 0 has {prev}, layer {idx} has {len}"
                ));
            }
        } else {
            expected_prompt_len = Some(len);
        }

        let raw = cache_view.data();
        let step_floats = POCKET_NUM_HEADS * POCKET_HEAD_DIM;
        let expected_bytes = 2 * cap * step_floats * 4;
        if raw.len() != expected_bytes {
            return Err(format!(
                "Pocket voice buffer size mismatch for {cache_key}: got {}, expected {expected_bytes}",
                raw.len()
            ));
        }

        let read_slice = |slot: usize| -> Vec<f32> {
            let start_floats = slot * cap * step_floats + pad * step_floats;
            let end_floats = start_floats + len * step_floats;
            raw[start_floats * 4..end_floats * 4]
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect()
        };

        let k_vec = read_slice(0);
        let v_vec = read_slice(1);
        let target_shape = (1, len, POCKET_NUM_HEADS, POCKET_HEAD_DIM);
        let k = Tensor::from_vec(k_vec, target_shape, &CpuDevice)
            .map_err(|e| format!("Failed creating Pocket k tensor: {e}"))?;
        let v = Tensor::from_vec(v_vec, target_shape, &CpuDevice)
            .map_err(|e| format!("Failed creating Pocket v tensor: {e}"))?;

        layers.push(PocketLayerKv { k, v, len });
    }

    Ok(PocketVoiceKvCache {
        layers,
        prompt_len: expected_prompt_len.unwrap_or(0),
    })
}

fn read_scalar_i64_tensor(st: &safetensors::SafeTensors<'_>, key: &str) -> Result<i64, String> {
    let view = st
        .tensor(key)
        .map_err(|e| format!("Missing Pocket voice tensor {key}: {e}"))?;
    if view.dtype() != safetensors::Dtype::I64 {
        return Err(format!("Expected I64 for {key}, got {:?}", view.dtype()));
    }
    let bytes = view.data();
    if bytes.len() != 8 {
        return Err(format!(
            "Expected 8 bytes for scalar I64 {key}, got {}",
            bytes.len()
        ));
    }
    Ok(i64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

/// Applies language-aware `ptts::preprocess::Normalize` plus Kyutai Pocket TTS YAML
/// character replacements (quotes, brackets, dashes, semicolons, Spanish inverted marks)
/// and ensures clean terminal punctuation.
pub fn preprocess_pocket_text(text: &str, lang: AppLanguage) -> String {
    let pre_cleaned: String = text
        .chars()
        .map(|c| match c {
            '¿' | '¡' => ' ',
            '<' | '>' => ' ',
            _ => c,
        })
        .collect();

    let normalized = Normalize::for_lang(lang.ptts_lang()).apply(&pre_cleaned);

    let mut mapped = String::with_capacity(normalized.len());
    for ch in normalized.chars() {
        match ch {
            // Strip quotes/guillemets/inverted marks/brackets not spoken
            '"' | '«' | '»' | '‹' | '›' | '„' | '“' | '”' | '¿' | '¡' | '<' | '>' | '[' | ']'
            | '{' | '}' => {
                mapped.push(' ');
            }
            '(' | ')' | ';' => {
                mapped.push_str(", ");
            }
            '—' | '–' | '―' | '‒' => {
                mapped.push_str(", ");
            }
            '‐' | '‑' => {
                mapped.push('-');
            }
            '…' => {
                mapped.push('.');
            }
            '‘' | '’' | '‚' | '‛' | '′' | '´' | '`' => {
                mapped.push('\'');
            }
            c if c.is_whitespace() => {
                mapped.push(' ');
            }
            c => mapped.push(c),
        }
    }

    // Collapse whitespace and tidy spaces before punctuation
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cleaned = String::with_capacity(collapsed.len() + 1);
    for ch in collapsed.chars() {
        if matches!(ch, '.' | ',' | '!' | '?') && cleaned.ends_with(' ') {
            cleaned.pop();
        }
        if ch == ',' && cleaned.ends_with(',') {
            continue;
        }
        cleaned.push(ch);
    }

    let trimmed = cleaned.trim().trim_matches('\'').trim().to_string();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut out = trimmed;
    if !out.ends_with(['.', '!', '?']) {
        if out.chars().last().is_some_and(|c| c.is_alphanumeric()) {
            out.push('.');
        } else {
            // Trim trailing comma/colon/dash before closing period
            while out
                .chars()
                .last()
                .is_some_and(|c| matches!(c, ',' | ':' | ';' | '-' | '\''))
            {
                out.pop();
            }
            let t = out.trim_end().to_string();
            if t.is_empty() {
                return String::new();
            }
            out = t;
            if !out.ends_with(['.', '!', '?']) {
                out.push('.');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use safetensors::tensor::{Dtype as StDtype, TensorView};

    fn make_test_pocket_voice_bytes(cap: usize, pad: i64, offset: i64) -> Vec<u8> {
        let mut tensors: Vec<(String, Vec<u8>, Vec<usize>, StDtype)> = Vec::new();
        let step = POCKET_NUM_HEADS * POCKET_HEAD_DIM;

        for idx in 0..POCKET_NUM_LAYERS {
            tensors.push((
                format!("transformer.layers.{idx}.self_attn/offset"),
                offset.to_le_bytes().to_vec(),
                vec![1],
                StDtype::I64,
            ));
            tensors.push((
                format!("transformer.layers.{idx}.self_attn/pad"),
                pad.to_le_bytes().to_vec(),
                vec![1],
                StDtype::I64,
            ));

            let mut cache = vec![0.0_f32; 2 * cap * step];
            for pos in 0..cap {
                let k_val = (idx as f32) * 100.0 + (pos as f32) + 0.25;
                let v_val = (idx as f32) * 100.0 + (pos as f32) + 0.75;
                for h in 0..step {
                    cache[pos * step + h] = k_val;
                    cache[cap * step + pos * step + h] = v_val;
                }
            }
            let raw_bytes: Vec<u8> = cache.into_iter().flat_map(f32::to_le_bytes).collect();
            tensors.push((
                format!("transformer.layers.{idx}.self_attn/cache"),
                raw_bytes,
                vec![2, 1, cap, POCKET_NUM_HEADS, POCKET_HEAD_DIM],
                StDtype::F32,
            ));
        }

        let views: Vec<(&str, TensorView<'_>)> = tensors
            .iter()
            .map(|(name, bytes, shape, dtype)| {
                (
                    name.as_str(),
                    TensorView::new(*dtype, shape.clone(), bytes.as_slice()).unwrap(),
                )
            })
            .collect();
        safetensors::tensor::serialize(views, None).unwrap()
    }

    #[test]
    fn parses_pocket_voice_kv_cache_slices_and_respects_pad_and_offset() {
        let bytes = make_test_pocket_voice_bytes(10, 2, 7);
        let parsed = parse_pocket_voice_safetensors(&bytes).unwrap();
        assert_eq!(parsed.prompt_len, 5);
        assert_eq!(parsed.layers.len(), 6);
        assert_eq!(parsed.layers[0].k.dims(), [1, 5, 16, 64]);
        assert_eq!(parsed.layers[0].v.dims(), [1, 5, 16, 64]);

        let k0 = parsed.layers[0].k.to_vec().unwrap();
        let v0 = parsed.layers[0].v.to_vec().unwrap();
        // First filled frame corresponds to pad=2 (2.25 for k, 2.75 for v)
        assert!((k0[0] - 2.25).abs() < 1e-5);
        assert!((v0[0] - 2.75).abs() < 1e-5);
        // Layer 3 last frame corresponds to offset-1=6 (306.25 for k)
        let k3 = parsed.layers[3].k.to_vec().unwrap();
        assert!((k3[4 * 16 * 64] - 306.25).abs() < 1e-5);
    }

    #[test]
    fn rejects_invalid_pocket_voice_bounds() {
        let bad = make_test_pocket_voice_bytes(8, 5, 3);
        assert!(parse_pocket_voice_safetensors(&bad).is_err());

        let oob = make_test_pocket_voice_bytes(8, 0, 9);
        assert!(parse_pocket_voice_safetensors(&oob).is_err());
    }

    #[test]
    fn preprocesses_pocket_text_across_languages() {
        let es = preprocess_pocket_text("¡Hola mundo! ¿Cómo estás hoy?", AppLanguage::Es);
        assert!(!es.contains('¡'));
        assert!(!es.contains('¿'));
        assert_eq!(es, "Hola mundo! Cómo estás hoy?");

        let fr = preprocess_pocket_text("«Bonjour» — dit-elle ; c'est 50 %", AppLanguage::Fr);
        assert!(!fr.contains('«'));
        assert!(!fr.contains('»'));
        assert!(!fr.contains('—'));
        assert!(!fr.contains(';'));
        assert!(fr.contains("c'est"));
        assert!(fr.ends_with('.'));

        let de = preprocess_pocket_text("Hallo Welt (ohne Punkt)", AppLanguage::De);
        assert!(!de.contains('('));
        assert!(!de.contains(')'));
        assert!(de.ends_with('.'));
    }

    #[test]
    fn pocket_config_uses_tanh_rmsvar_and_inner_dim_32() {
        let cfg = pocket_tts_config();
        assert!(cfg.model_id.is_none());
        assert_eq!(cfg.default_gelu(), ptts::transformer::Gelu::Tanh);
        assert_eq!(cfg.flow_lm.time_rms_norm, TimeRmsNorm::RmsVar);
        assert_eq!(cfg.mimi.inner_dim, Some(32));
        assert_eq!(cfg.lsd_decode_steps, 1);
        assert!((cfg.eos_threshold + 4.0).abs() < 1e-5);
        assert_eq!(cfg.mimi.sample_rate, 24000);
        assert!((cfg.mimi.frame_rate - 12.5).abs() < 1e-6);
        assert_eq!(cfg.mimi.transformer_context, 250);
    }
}
