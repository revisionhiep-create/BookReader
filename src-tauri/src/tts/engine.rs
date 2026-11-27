//! Unified multi-engine TTS dispatcher routing across Phonon 31M (EN),
//! Kyutai Pocket TTS (FR/DE/ES/PT/IT/NL), and Qwen3-TTS Base voice cloning.

use crate::models::{AppLanguage, ClonedVoiceMeta, QwenModelVariant};
use crate::paths::AppPaths;
use crate::tts::pocket_engine::PocketEngine;
use crate::tts::qwen_engine::QwenCloneEngine;
use ptts::checkpoint::read_config;
use ptts::preprocess::Lang;
use ptts::synth::{DeviceKind, Quant, SpeechOptions, Synth, SynthBuilder};
use std::sync::RwLock;

/// Thread-safe lazy wrapper around Phonon 31M, Kyutai Pocket TTS, and Qwen3-TTS cloner.
pub struct PhononEngine {
    synth: RwLock<Option<Synth>>,
    pocket: PocketEngine,
    qwen: QwenCloneEngine,
}

impl PhononEngine {
    pub fn new() -> Self {
        Self {
            synth: RwLock::new(None),
            pocket: PocketEngine::new(),
            qwen: QwenCloneEngine::new(),
        }
    }

    pub fn pocket(&self) -> &PocketEngine {
        &self.pocket
    }

    pub fn qwen(&self) -> &QwenCloneEngine {
        &self.qwen
    }

    pub fn is_loaded(&self) -> bool {
        self.synth.read().unwrap().is_some()
    }

    pub fn unload_phonon(&self) {
        *self.synth.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn unload_pocket(&self) {
        self.pocket.unload();
    }

    pub fn unload_qwen(&self) {
        self.qwen.unload();
    }

    /// Loads whichever TTS engine is needed for `voice_id` and `qwen_variant`.
    pub fn ensure_engine_for_voice(
        &self,
        paths: &AppPaths,
        qwen_variant: QwenModelVariant,
        voice_id: &str,
    ) -> Result<(), String> {
        if AppPaths::is_cloned_voice_id(voice_id) {
            self.qwen.ensure_loaded(paths, qwen_variant)
        } else if let Some((lang, _slug)) = AppPaths::parse_pocket_voice_id(voice_id) {
            self.pocket.ensure_loaded(paths, lang)
        } else {
            self.ensure_loaded(paths)
        }
    }

    /// Loads `gradium/phonon-31m-en` (`model.q8.gguf`) from `BookReader_Data/models/phonon-31m-en/`.
    pub fn ensure_loaded(&self, paths: &AppPaths) -> Result<(), String> {
        if self.is_loaded() {
            return Ok(());
        }
        if !paths.model_ready() {
            return Err("Phonon 31M model files are not downloaded yet".to_string());
        }

        let cfg = read_config(paths.models_dir.join("config.json"))
            .map_err(|e| format!("Failed reading Phonon config.json: {e}"))?;
        let weights = paths.models_dir.join("model.q8.gguf");
        let tokenizer = paths.models_dir.join("tokenizer.json");
        let default_voice = paths.models_dir.join("default-voice.safetensors");

        let built = SynthBuilder::new(cfg, weights, Lang::En)
            .tokenizer_file(tokenizer)
            .quant(Quant::Q80)
            .device(DeviceKind::Cpu)
            .add_voice("default", default_voice)
            .build()
            .map_err(|e| format!("Failed loading Phonon 31M engine: {e}"))?;

        let mut guard = self.synth.write().unwrap();
        if guard.is_none() {
            *guard = Some(built);
        }
        Ok(())
    }

    /// Ensures `voice_id` is registered with the running `Synth` instance.
    pub fn ensure_voice_registered(&self, paths: &AppPaths, voice_id: &str) -> Result<String, String> {
        self.ensure_loaded(paths)?;

        if voice_id == "default" {
            return Ok("default".to_string());
        }

        let voice_path = paths.voice_path(voice_id)?;
        if !voice_path.is_file() {
            return Err(format!("Voice {voice_id} is not downloaded yet"));
        }

        // Fast check under read lock first
        {
            let guard = self.synth.read().unwrap();
            let synth = guard.as_ref().ok_or("Engine not loaded")?;
            if synth.voices().iter().any(|v| v == voice_id) {
                return Ok(voice_id.to_string());
            }
        }

        // Register under write lock
        let mut guard = self.synth.write().unwrap();
        let synth = guard.as_mut().ok_or("Engine not loaded")?;
        if !synth.voices().iter().any(|v| v == voice_id) {
            synth
                .add_voice_file(voice_id, &voice_path)
                .map_err(|e| format!("Failed registering voice {voice_id}: {e}"))?;
        }
        Ok(voice_id.to_string())
    }

    /// Synthesizes one cleaned sentence into 24 kHz mono PCM using the engine matching `voice_id`.
    pub fn synthesize(
        &self,
        paths: &AppPaths,
        tts_language: AppLanguage,
        qwen_variant: QwenModelVariant,
        cloned_meta: Option<&ClonedVoiceMeta>,
        text: &str,
        voice_id: &str,
    ) -> Result<Vec<f32>, String> {
        if AppPaths::is_cloned_voice_id(voice_id) {
            return self.qwen.synthesize(
                paths,
                qwen_variant,
                tts_language,
                text,
                voice_id,
                cloned_meta,
            );
        }
        if let Some((lang, slug)) = AppPaths::parse_pocket_voice_id(voice_id) {
            return self.pocket.synthesize(paths, lang, slug, text);
        }

        let active_voice = self
            .ensure_voice_registered(paths, voice_id)
            .unwrap_or_else(|_| "default".to_string());

        let guard = self.synth.read().unwrap();
        let synth = guard.as_ref().ok_or("Phonon engine is not loaded")?;
        let opts = SpeechOptions::default().voice(&active_voice);
        synth
            .say_with(text, &opts)
            .map_err(|e| format!("Phonon synthesis failed: {e}"))
    }
}
