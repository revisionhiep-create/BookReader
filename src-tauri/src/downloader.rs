//! Async downloader for Phonon 31M weights, Kyutai Pocket TTS checkpoints, and voice embeddings.

use crate::models::{AppLanguage, DownloadProgressEvent, QwenModelVariant};
use crate::paths::AppPaths;
use crate::voices::{
    EN_VOICES, POCKET_VOICES, find_pocket_voice, find_voice, pocket_voice_download_url,
    pocket_voice_id, voice_download_url,
};
use futures_util::StreamExt;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const MODEL_FILES: &[(&str, &str)] = &[
    (
        "config.json",
        "https://huggingface.co/gradium/phonon-31m-en/resolve/main/config.json",
    ),
    (
        "tokenizer.json",
        "https://huggingface.co/gradium/phonon-31m-en/resolve/main/tokenizer.json",
    ),
    (
        "default-voice.safetensors",
        "https://huggingface.co/gradium/phonon-31m-en/resolve/main/default-voice.safetensors",
    ),
    (
        "model.q8.gguf",
        "https://huggingface.co/gradium/phonon-31m-en/resolve/main/model.q8.gguf",
    ),
];

fn qwen_model_files(variant: QwenModelVariant) -> Vec<(&'static str, String, u64)> {
    let repo = variant.hf_repo();
    vec![
        (
            "config.json",
            format!("https://huggingface.co/{repo}/resolve/main/config.json"),
            3_000,
        ),
        (
            "generation_config.json",
            format!("https://huggingface.co/{repo}/resolve/main/generation_config.json"),
            300,
        ),
        (
            "tokenizer_config.json",
            format!("https://huggingface.co/{repo}/resolve/main/tokenizer_config.json"),
            5_000,
        ),
        (
            "vocab.json",
            format!("https://huggingface.co/{repo}/resolve/main/vocab.json"),
            2_800_000,
        ),
        (
            "merges.txt",
            format!("https://huggingface.co/{repo}/resolve/main/merges.txt"),
            1_700_000,
        ),
        (
            "speech_tokenizer/config.json",
            format!("https://huggingface.co/{repo}/resolve/main/speech_tokenizer/config.json"),
            2_000,
        ),
        (
            "speech_tokenizer/model.safetensors",
            format!(
                "https://huggingface.co/{repo}/resolve/main/speech_tokenizer/model.safetensors"
            ),
            682_000_000,
        ),
        (
            "model.safetensors",
            format!("https://huggingface.co/{repo}/resolve/main/model.safetensors"),
            variant.model_safetensors_est_bytes(),
        ),
    ]
}

fn pocket_model_files(lang: AppLanguage) -> Result<Vec<(&'static str, String, u64)>, String> {
    let folder = lang
        .pocket_folder()
        .ok_or_else(|| format!("Language {} does not use Pocket TTS", lang.code()))?;
    Ok(vec![
        (
            "model.safetensors",
            format!("https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main/languages/{folder}/model.safetensors"),
            219_029_196,
        ),
        (
            "tokenizer.json",
            format!("https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main/languages/{folder}/tokenizer.json"),
            246_403,
        ),
    ])
}

/// Tracks cumulative byte-weighted progress across multi-file model downloads.
struct MultiFileProgressTracker {
    file_totals: Vec<u64>,
    completed_bytes: u64,
}

impl MultiFileProgressTracker {
    fn new(estimates: Vec<u64>) -> Self {
        Self {
            file_totals: estimates,
            completed_bytes: 0,
        }
    }

    fn update_file_total(&mut self, idx: usize, actual_bytes: u64) {
        if actual_bytes > 0
            && let Some(slot) = self.file_totals.get_mut(idx)
        {
            *slot = actual_bytes;
        }
    }

    fn total_bytes(&self) -> u64 {
        self.file_totals.iter().copied().sum::<u64>().max(1)
    }

    fn snapshot(&self, current_file_done: u64) -> (u64, u64) {
        let cum_done = self.completed_bytes.saturating_add(current_file_done);
        let total = self.total_bytes().max(cum_done);
        (cum_done.min(total), total)
    }

    fn mark_file_done(&mut self, idx: usize, actual_bytes: u64) {
        if actual_bytes > 0
            && let Some(slot) = self.file_totals.get_mut(idx)
        {
            *slot = actual_bytes;
        }
        let credited = if actual_bytes > 0 {
            actual_bytes
        } else {
            self.file_totals.get(idx).copied().unwrap_or(0)
        };
        self.completed_bytes = self.completed_bytes.saturating_add(credited);
    }
}

/// Guards against duplicate concurrent downloads of the same model or voice ID.
pub struct DownloadManager {
    client: reqwest::Client,
    in_flight: Mutex<HashSet<String>>,
}

impl DownloadManager {
    pub fn new() -> Result<Self, String> {
        #[allow(unused_mut)]
        let mut builder = reqwest::Client::builder()
            .user_agent("BookReader/1.0")
            .connect_timeout(std::time::Duration::from_secs(20));

        #[cfg(target_os = "android")]
        {
            let roots: Vec<reqwest::Certificate> = webpki_root_certs::TLS_SERVER_ROOT_CERTS
                .iter()
                .filter_map(|der| reqwest::Certificate::from_der(der.as_ref()).ok())
                .collect();
            if roots.is_empty() {
                return Err("Failed to load bundled WebPKI root certificates".to_string());
            }
            builder = builder.tls_certs_only(roots);
        }

        let client = builder
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
        Ok(Self {
            client,
            in_flight: Mutex::new(HashSet::new()),
        })
    }

    fn acquire_slot(&self, key: &str) -> Result<SlotGuard<'_>, String> {
        let mut guard = self.in_flight.lock().unwrap();
        if !guard.insert(key.to_string()) {
            return Err(format!("Download already in progress for {key}"));
        }
        Ok(SlotGuard {
            set: &self.in_flight,
            key: key.to_string(),
        })
    }

    /// Downloads Phonon 31M (`en`) or Kyutai Pocket TTS (`fr|de|es|pt|it|nl`) and its flagship voice.
    pub async fn download_language_model(
        &self,
        app: &AppHandle,
        paths: &AppPaths,
        lang: AppLanguage,
        default_voice_id: Option<&str>,
    ) -> Result<(), String> {
        if lang == AppLanguage::En {
            let vid = default_voice_id.unwrap_or_else(|| lang.default_voice_id());
            self.download_phonon_model_inner(Some(app), paths, Some(vid))
                .await
        } else {
            self.download_pocket_model_inner(Some(app), paths, lang, default_voice_id)
                .await
        }
    }

    /// Headless variant of [`Self::download_language_model`] used by tests and self-tests.
    #[allow(dead_code)]
    pub async fn download_language_model_headless(
        &self,
        paths: &AppPaths,
        lang: AppLanguage,
        default_voice_id: Option<&str>,
    ) -> Result<(), String> {
        if lang == AppLanguage::En {
            self.download_phonon_model_inner(None, paths, default_voice_id)
                .await
        } else {
            self.download_pocket_model_inner(None, paths, lang, default_voice_id)
                .await
        }
    }

    /// Downloads Phonon 31M (`q8` GGUF + config + tokenizer + default voice) and the active voice.
    #[allow(dead_code)]
    pub async fn download_phonon_model(
        &self,
        app: &AppHandle,
        paths: &AppPaths,
        default_voice_id: Option<&str>,
    ) -> Result<(), String> {
        self.download_phonon_model_inner(Some(app), paths, default_voice_id)
            .await
    }

    /// Headless variant used by `--self-test-live-tts` when no Tauri window/AppHandle exists.
    pub async fn download_phonon_model_headless(
        &self,
        paths: &AppPaths,
        default_voice_id: Option<&str>,
    ) -> Result<(), String> {
        self.download_phonon_model_inner(None, paths, default_voice_id)
            .await
    }

    async fn download_pocket_model_inner(
        &self,
        app: Option<&AppHandle>,
        paths: &AppPaths,
        lang: AppLanguage,
        default_voice_id: Option<&str>,
    ) -> Result<(), String> {
        let _guard = self.acquire_slot(&format!("__model_{}__", lang.code()))?;
        let files = pocket_model_files(lang)?;
        let total_files = files.len();
        let target_dir = paths.pocket_model_dir(lang)?;
        let item_id = lang.model_id();
        let mut tracker =
            MultiFileProgressTracker::new(files.iter().map(|(_, _, est)| *est).collect());

        for (idx, (filename, _, _)) in files.iter().enumerate() {
            let dest = target_dir.join(filename);
            if let Ok(meta) = std::fs::metadata(&dest)
                && meta.is_file()
                && meta.len() > 0
            {
                tracker.update_file_total(idx, meta.len());
            }
        }

        if let Some(app_handle) = app {
            let _ = app_handle.emit(
                "download:progress",
                DownloadProgressEvent {
                    kind: "model".to_string(),
                    item_id: item_id.to_string(),
                    current_file: files[0].0.to_string(),
                    bytes_done: 0,
                    bytes_total: Some(tracker.total_bytes()),
                    files_done: 0,
                    files_total: total_files,
                    done: false,
                    error: None,
                },
            );
        }

        for (idx, (filename, url, _)) in files.iter().enumerate() {
            let dest = target_dir.join(filename);
            if let Ok(meta) = std::fs::metadata(&dest)
                && meta.is_file()
                && meta.len() > 0
            {
                tracker.mark_file_done(idx, meta.len());
                continue;
            }
            self.download_file_inner(
                app,
                "model",
                item_id,
                filename,
                url,
                &dest,
                idx,
                total_files,
                Some(&mut tracker),
            )
            .await?;
        }

        let target_vid = default_voice_id.unwrap_or_else(|| lang.default_voice_id());
        if let Some((vlang, slug)) = AppPaths::parse_pocket_voice_id(target_vid)
            && vlang == lang
            && find_pocket_voice(slug).is_some()
            && !paths.is_voice_downloaded(target_vid)
        {
            self.download_single_pocket_voice_inner(app, paths, lang, slug, target_vid, 0, 1)
                .await?;
        }

        let (_, cum_total) = tracker.snapshot(0);
        if let Some(app_handle) = app {
            let _ = app_handle.emit(
                "download:progress",
                DownloadProgressEvent {
                    kind: "model".to_string(),
                    item_id: item_id.to_string(),
                    current_file: "Complete".to_string(),
                    bytes_done: cum_total,
                    bytes_total: Some(cum_total),
                    files_done: total_files,
                    files_total: total_files,
                    done: true,
                    error: None,
                },
            );
        }
        Ok(())
    }

    async fn download_phonon_model_inner(
        &self,
        app: Option<&AppHandle>,
        paths: &AppPaths,
        default_voice_id: Option<&str>,
    ) -> Result<(), String> {
        let _guard = self.acquire_slot("__model__")?;
        let total_files = MODEL_FILES.len();

        for (idx, (filename, url)) in MODEL_FILES.iter().enumerate() {
            let dest = paths.models_dir.join(filename);
            if dest.is_file()
                && std::fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false)
            {
                continue;
            }
            self.download_file(
                app,
                "model",
                "phonon-31m-en",
                filename,
                url,
                &dest,
                idx,
                total_files,
            )
            .await?;
        }

        if let Some(vid) = default_voice_id
            && vid != "default"
            && find_voice(vid).is_some()
            && !paths.is_voice_downloaded(vid)
        {
            let _ = self.download_single_voice_inner(app, paths, vid, 0, 1).await;
        }

        if let Some(app_handle) = app {
            let _ = app_handle.emit(
                "download:progress",
                DownloadProgressEvent {
                    kind: "model".to_string(),
                    item_id: "phonon-31m-en".to_string(),
                    current_file: "Complete".to_string(),
                    bytes_done: 1,
                    bytes_total: Some(1),
                    files_done: total_files,
                    files_total: total_files,
                    done: true,
                    error: None,
                },
            );
        }
        Ok(())
    }

    /// Downloads Qwen3-TTS (`0.6b` or `1.7b`) weights + 12Hz speech tokenizer into its variant folder.
    pub async fn download_qwen_model(
        &self,
        app: &AppHandle,
        paths: &AppPaths,
        variant: QwenModelVariant,
    ) -> Result<(), String> {
        let _guard = self.acquire_slot("__qwen_model__")?;
        let files = qwen_model_files(variant);
        let total_files = files.len();
        let target_dir = paths.qwen_model_dir(variant);
        let item_id = variant.as_id();
        let mut tracker = MultiFileProgressTracker::new(files.iter().map(|(_, _, est)| *est).collect());

        for (idx, (rel_path, _, _)) in files.iter().enumerate() {
            let dest = target_dir.join(rel_path);
            if let Ok(meta) = std::fs::metadata(&dest)
                && meta.is_file()
                && meta.len() > 0
            {
                tracker.update_file_total(idx, meta.len());
            }
        }

        let _ = app.emit(
            "download:progress",
            DownloadProgressEvent {
                kind: "qwen_model".to_string(),
                item_id: item_id.to_string(),
                current_file: files[0].0.to_string(),
                bytes_done: 0,
                bytes_total: Some(tracker.total_bytes()),
                files_done: 0,
                files_total: total_files,
                done: false,
                error: None,
            },
        );

        for (idx, (rel_path, url, _)) in files.iter().enumerate() {
            let dest = target_dir.join(rel_path);
            if let Ok(meta) = std::fs::metadata(&dest)
                && meta.is_file()
                && meta.len() > 0
            {
                tracker.mark_file_done(idx, meta.len());
                let (cum_done, cum_total) = tracker.snapshot(0);
                let _ = app.emit(
                    "download:progress",
                    DownloadProgressEvent {
                        kind: "qwen_model".to_string(),
                        item_id: item_id.to_string(),
                        current_file: (*rel_path).to_string(),
                        bytes_done: cum_done,
                        bytes_total: Some(cum_total),
                        files_done: idx,
                        files_total: total_files,
                        done: false,
                        error: None,
                    },
                );
                continue;
            }
            self.download_file_inner(
                Some(app),
                "qwen_model",
                item_id,
                rel_path,
                url,
                &dest,
                idx,
                total_files,
                Some(&mut tracker),
            )
            .await?;
        }

        let (_, cum_total) = tracker.snapshot(0);
        let _ = app.emit(
            "download:progress",
            DownloadProgressEvent {
                kind: "qwen_model".to_string(),
                item_id: item_id.to_string(),
                current_file: "Complete".to_string(),
                bytes_done: cum_total,
                bytes_total: Some(cum_total),
                files_done: total_files,
                files_total: total_files,
                done: true,
                error: None,
            },
        );
        Ok(())
    }

    /// Downloads one voice `.safetensors` file on demand if missing (Phonon EN or Pocket TTS).
    pub async fn download_voice(
        &self,
        app: &AppHandle,
        paths: &AppPaths,
        voice_id: &str,
    ) -> Result<(), String> {
        if voice_id == "default" || paths.is_voice_downloaded(voice_id) {
            return Ok(());
        }
        if let Some((lang, slug)) = AppPaths::parse_pocket_voice_id(voice_id) {
            if find_pocket_voice(slug).is_none() {
                return Err(format!("Unknown Pocket TTS voice ID: {voice_id}"));
            }
            self.wait_if_voice_busy(paths, voice_id).await;
            if paths.is_voice_downloaded(voice_id) {
                return Ok(());
            }
            self.download_single_pocket_voice_inner(Some(app), paths, lang, slug, voice_id, 0, 1)
                .await?;
            let _ = app.emit(
                "download:progress",
                DownloadProgressEvent {
                    kind: "voice".to_string(),
                    item_id: voice_id.to_string(),
                    current_file: format!("{slug}.safetensors"),
                    bytes_done: 1,
                    bytes_total: Some(1),
                    files_done: 1,
                    files_total: 1,
                    done: true,
                    error: None,
                },
            );
            return Ok(());
        }
        if find_voice(voice_id).is_none() {
            return Err(format!("Unknown English voice ID: {voice_id}"));
        }
        self.wait_if_voice_busy(paths, voice_id).await;
        if paths.is_voice_downloaded(voice_id) {
            return Ok(());
        }
        self.download_single_voice_inner(Some(app), paths, voice_id, 0, 1)
            .await?;
        let _ = app.emit(
            "download:progress",
            DownloadProgressEvent {
                kind: "voice".to_string(),
                item_id: voice_id.to_string(),
                current_file: format!("{voice_id}.safetensors"),
                bytes_done: 1,
                bytes_total: Some(1),
                files_done: 1,
                files_total: 1,
                done: true,
                error: None,
            },
        );
        Ok(())
    }

    /// Downloads all missing voices for `lang` (37 Phonon EN voices or 27 Pocket voices).
    pub async fn download_all_voices_for_language(
        &self,
        app: &AppHandle,
        paths: &AppPaths,
        lang: AppLanguage,
    ) -> Result<(), String> {
        let _guard = self.acquire_slot(&format!("__all_voices_{}__", lang.code()))?;
        if lang == AppLanguage::En {
            let pending: Vec<_> = EN_VOICES
                .iter()
                .filter(|v| !paths.is_voice_downloaded(v.voice_id))
                .collect();
            let total = pending.len();

            for (idx, voice) in pending.iter().enumerate() {
                self.wait_if_voice_busy(paths, voice.voice_id).await;
                if paths.is_voice_downloaded(voice.voice_id) {
                    continue;
                }
                self.download_single_voice_inner(Some(app), paths, voice.voice_id, idx, total)
                    .await?;
            }

            let _ = app.emit(
                "download:progress",
                DownloadProgressEvent {
                    kind: "voices_all".to_string(),
                    item_id: lang.code().to_string(),
                    current_file: "All 37 English voices ready".to_string(),
                    bytes_done: 1,
                    bytes_total: Some(1),
                    files_done: total,
                    files_total: total,
                    done: true,
                    error: None,
                },
            );
            return Ok(());
        }

        let pending: Vec<(String, &'static str)> = POCKET_VOICES
            .iter()
            .filter_map(|v| {
                let vid = pocket_voice_id(lang, v.slug);
                (!paths.is_voice_downloaded(&vid)).then_some((vid, v.slug))
            })
            .collect();
        let total = pending.len();

        for (idx, (vid, slug)) in pending.iter().enumerate() {
            self.wait_if_voice_busy(paths, vid).await;
            if paths.is_voice_downloaded(vid) {
                continue;
            }
            self.download_single_pocket_voice_inner(Some(app), paths, lang, slug, vid, idx, total)
                .await?;
        }

        let _ = app.emit(
            "download:progress",
            DownloadProgressEvent {
                kind: "voices_all".to_string(),
                item_id: lang.code().to_string(),
                current_file: format!("All 27 {} voices ready", lang.code()),
                bytes_done: 1,
                bytes_total: Some(1),
                files_done: total,
                files_total: total,
                done: true,
                error: None,
            },
        );
        Ok(())
    }

    async fn download_single_pocket_voice_inner(
        &self,
        app: Option<&AppHandle>,
        paths: &AppPaths,
        lang: AppLanguage,
        slug: &str,
        voice_id: &str,
        file_idx: usize,
        total_files: usize,
    ) -> Result<(), String> {
        let _voice_guard = self.acquire_slot(&format!("voice:{voice_id}"))?;
        let dest = paths.pocket_voice_path(lang, slug)?;
        if dest.is_file()
            && std::fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false)
        {
            return Ok(());
        }
        let url = pocket_voice_download_url(lang, slug)?;
        self.download_file(
            app,
            "voice",
            voice_id,
            &format!("{slug}.safetensors"),
            &url,
            &dest,
            file_idx,
            total_files,
        )
        .await
    }

    async fn wait_if_voice_busy(&self, paths: &AppPaths, voice_id: &str) {
        let key = format!("voice:{voice_id}");
        for _ in 0..120 {
            let busy = self.in_flight.lock().unwrap().contains(&key);
            if !busy || paths.is_voice_downloaded(voice_id) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(125)).await;
        }
    }

    async fn download_single_voice_inner(
        &self,
        app: Option<&AppHandle>,
        paths: &AppPaths,
        voice_id: &str,
        file_idx: usize,
        total_files: usize,
    ) -> Result<(), String> {
        let _voice_guard = self.acquire_slot(&format!("voice:{voice_id}"))?;
        let dest = paths.voice_path(voice_id)?;
        if dest.is_file()
            && std::fs::metadata(&dest).map(|m| m.len() > 0).unwrap_or(false)
        {
            return Ok(());
        }
        let url = voice_download_url(voice_id);
        self.download_file(
            app,
            "voice",
            voice_id,
            &format!("{voice_id}.safetensors"),
            &url,
            &dest,
            file_idx,
            total_files,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_file(
        &self,
        app: Option<&AppHandle>,
        kind: &str,
        item_id: &str,
        label: &str,
        url: &str,
        dest: &Path,
        file_idx: usize,
        total_files: usize,
    ) -> Result<(), String> {
        self.download_file_inner(
            app,
            kind,
            item_id,
            label,
            url,
            dest,
            file_idx,
            total_files,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_file_inner(
        &self,
        app: Option<&AppHandle>,
        kind: &str,
        item_id: &str,
        label: &str,
        url: &str,
        dest: &Path,
        file_idx: usize,
        total_files: usize,
        mut tracker: Option<&mut MultiFileProgressTracker>,
    ) -> Result<(), String> {
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Network error downloading {label}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {} downloading {label}", resp.status()));
        }
        let total_bytes = resp.content_length();
        if let (Some(t), Some(len)) = (tracker.as_deref_mut(), total_bytes) {
            t.update_file_total(file_idx, len);
        }

        let part = dest.with_extension("part");
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed creating dir {}: {e}", parent.display()))?;
        }

        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("Failed creating {}: {e}", part.display()))?;

        let mut stream = resp.bytes_stream();
        let mut bytes_done: u64 = 0;
        let mut last_emit = std::time::Instant::now();

        while let Some(chunk_res) = stream.next().await {
            let chunk = match chunk_res {
                Ok(c) => c,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&part).await;
                    return Err(format!("Stream error downloading {label}: {e}"));
                }
            };
            if let Err(e) = file.write_all(&chunk).await {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("Write error for {label}: {e}"));
            }
            bytes_done += chunk.len() as u64;
            if last_emit.elapsed().as_millis() >= 80 {
                let (emit_done, emit_total) = if let Some(t) = tracker.as_deref() {
                    let (d, tot) = t.snapshot(bytes_done);
                    (d, Some(tot))
                } else {
                    (bytes_done, total_bytes)
                };
                if let Some(app_handle) = app {
                    let _ = app_handle.emit(
                        "download:progress",
                        DownloadProgressEvent {
                            kind: kind.to_string(),
                            item_id: item_id.to_string(),
                            current_file: label.to_string(),
                            bytes_done: emit_done,
                            bytes_total: emit_total,
                            files_done: file_idx,
                            files_total: total_files,
                            done: false,
                            error: None,
                        },
                    );
                }
                last_emit = std::time::Instant::now();
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Flush error for {label}: {e}"))?;
        drop(file);

        std::fs::rename(&part, dest).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("Failed finalizing {}: {e}", dest.display())
        })?;

        let (emit_done, emit_total, emit_files_done) = if let Some(t) = tracker.as_deref_mut() {
            t.mark_file_done(file_idx, bytes_done);
            let (d, tot) = t.snapshot(0);
            (d, Some(tot), file_idx)
        } else {
            (bytes_done, total_bytes.or(Some(bytes_done)), file_idx + 1)
        };

        if let Some(app_handle) = app {
            let _ = app_handle.emit(
                "download:progress",
                DownloadProgressEvent {
                    kind: kind.to_string(),
                    item_id: item_id.to_string(),
                    current_file: label.to_string(),
                    bytes_done: emit_done,
                    bytes_total: emit_total,
                    files_done: emit_files_done,
                    files_total: total_files,
                    done: false,
                    error: None,
                },
            );
        }
        Ok(())
    }
}

struct SlotGuard<'a> {
    set: &'a Mutex<HashSet<String>>,
    key: String,
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_guard_prevents_concurrent_same_voice_download_and_releases_on_drop() {
        let mgr = DownloadManager::new().unwrap();
        let g1 = mgr.acquire_slot("voice:Easton").unwrap();
        assert!(mgr.acquire_slot("voice:Easton").is_err());
        assert!(mgr.acquire_slot("voice:Zoey").is_ok());
        drop(g1);
        assert!(mgr.acquire_slot("voice:Easton").is_ok());
    }

    #[test]
    fn qwen_progress_tracker_stays_monotonic_across_all_eight_files() {
        for variant in QwenModelVariant::all() {
            let files = qwen_model_files(variant);
            assert_eq!(files.len(), 8);
            let mut tracker = MultiFileProgressTracker::new(files.iter().map(|(_, _, est)| *est).collect());
            tracker.update_file_total(0, 2_800);
            tracker.update_file_total(3, 2_770_000);

            let mut prev_frac = 0.0_f64;
            for (idx, (_, url, est)) in files.iter().enumerate() {
                assert!(url.contains(variant.hf_repo()));
                let actual = match idx {
                    0 => 2_800,
                    3 => 2_770_000,
                    6 => 690_000_000,
                    7 => *est + 2_000_000,
                    _ => *est,
                };
                tracker.update_file_total(idx, actual);
                let (d_mid, t_mid) = tracker.snapshot(actual / 2);
                assert!(d_mid <= t_mid);
                let frac_mid = d_mid as f64 / t_mid as f64;
                assert!(frac_mid + 1e-6 >= prev_frac);
                prev_frac = frac_mid;

                tracker.mark_file_done(idx, actual);
                let (d_end, t_end) = tracker.snapshot(0);
                assert!(d_end <= t_end);
                let frac_end = d_end as f64 / t_end as f64;
                assert!(frac_end + 1e-6 >= prev_frac);
                prev_frac = frac_end;
            }
            let (final_done, final_total) = tracker.snapshot(0);
            assert_eq!(final_done, final_total);
        }
    }
}
