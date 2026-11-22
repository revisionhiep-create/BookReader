//! Async downloader for Phonon 31M weights and the 37 EN voice embeddings.

use crate::models::DownloadProgressEvent;
use crate::paths::AppPaths;
use crate::voices::{EN_VOICES, find_voice, voice_download_url};
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

/// Guards against duplicate concurrent downloads of the same model or voice ID.
pub struct DownloadManager {
    client: reqwest::Client,
    in_flight: Mutex<HashSet<String>>,
}

impl DownloadManager {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .user_agent("BookReader/1.0")
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

    /// Downloads Phonon 31M (`q8` GGUF + config + tokenizer + default voice) and the active voice.
    pub async fn download_phonon_model(
        &self,
        app: &AppHandle,
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

        let _ = app.emit(
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
        Ok(())
    }

    /// Downloads one voice `.safetensors` file on demand if missing.
    pub async fn download_voice(
        &self,
        app: &AppHandle,
        paths: &AppPaths,
        voice_id: &str,
    ) -> Result<(), String> {
        if voice_id == "default" || paths.is_voice_downloaded(voice_id) {
            return Ok(());
        }
        if find_voice(voice_id).is_none() {
            return Err(format!("Unknown English voice ID: {voice_id}"));
        }
        self.wait_if_voice_busy(paths, voice_id).await;
        if paths.is_voice_downloaded(voice_id) {
            return Ok(());
        }
        self.download_single_voice_inner(app, paths, voice_id, 0, 1)
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

    /// Downloads all missing voices from the 37 EN voice catalog.
    pub async fn download_all_voices(&self, app: &AppHandle, paths: &AppPaths) -> Result<(), String> {
        let _guard = self.acquire_slot("__all_voices__")?;
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
            self.download_single_voice_inner(app, paths, voice.voice_id, idx, total)
                .await?;
        }

        let _ = app.emit(
            "download:progress",
            DownloadProgressEvent {
                kind: "voices_all".to_string(),
                item_id: "all".to_string(),
                current_file: "All 37 English voices ready".to_string(),
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
        app: &AppHandle,
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
        app: &AppHandle,
        kind: &str,
        item_id: &str,
        label: &str,
        url: &str,
        dest: &Path,
        file_idx: usize,
        total_files: usize,
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
                let _ = app.emit(
                    "download:progress",
                    DownloadProgressEvent {
                        kind: kind.to_string(),
                        item_id: item_id.to_string(),
                        current_file: label.to_string(),
                        bytes_done,
                        bytes_total: total_bytes,
                        files_done: file_idx,
                        files_total: total_files,
                        done: false,
                        error: None,
                    },
                );
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

        let _ = app.emit(
            "download:progress",
            DownloadProgressEvent {
                kind: kind.to_string(),
                item_id: item_id.to_string(),
                current_file: label.to_string(),
                bytes_done,
                bytes_total: total_bytes.or(Some(bytes_done)),
                files_done: file_idx + 1,
                files_total: total_files,
                done: false,
                error: None,
            },
        );
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
}
