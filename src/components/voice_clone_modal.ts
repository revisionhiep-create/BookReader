import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Icons } from "../icons";
import { state } from "../state";
import type {
  AudioClipProbe,
  CloneVoiceResponse,
  DeleteClonedVoiceResponse,
  QwenModelStatus,
  QwenModelVariant,
  SetQwenVariantResponse,
  Settings,
  VoiceInfo,
} from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface VoiceCloneModalHandlers {
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

let qwenStatus: QwenModelStatus | null = null;
let statusRequested = false;
let probeResult: AudioClipProbe | null = null;
let draftName = "";
let draftRefText = "";
let draftStartSec = 0;
let draftEndSec = 15;
let downloadingQwen = false;
let cloningBusy = false;
let switchingVariant = false;
let previewingSlice = false;
let busyVoiceId: string | null = null;
let cloneError = "";
let maxQwenPct = 0;

export function prepareVoiceCloneModalOpen(): void {
  statusRequested = false;
  cloneError = "";
  if (!downloadingQwen && state.downloadProgress?.kind !== "qwen_model") {
    maxQwenPct = 0;
  }
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function suggestVoiceName(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const cleaned = stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 48);
}

function computeQwenProgress(): {
  pct: string;
  fileLabel: string;
  filesLabel: string;
  bytesLabel: string;
} {
  const dp = state.downloadProgress;
  if (!dp || dp.kind !== "qwen_model") {
    return {
      pct: "0.0",
      fileLabel: "Connecting to Hugging Face...",
      filesLabel: "File 1 / 8",
      bytesLabel: "",
    };
  }
  const totalFiles = Math.max(1, dp.files_total || 8);
  const doneFiles = Math.min(dp.files_done, totalFiles);
  const totalBytes = dp.bytes_total && dp.bytes_total > 0 ? dp.bytes_total : 1;
  const rawPct = dp.done ? 100 : (dp.bytes_done / totalBytes) * 100;
  maxQwenPct = dp.done ? 100 : Math.min(99.9, Math.max(maxQwenPct, rawPct));
  const bytesLabel =
    dp.bytes_total && dp.bytes_total > 1024
      ? `${formatMb(dp.bytes_done)} / ${formatMb(dp.bytes_total)} MB`
      : dp.bytes_done > 1024
        ? `${formatMb(dp.bytes_done)} MB`
        : "";
  return {
    pct: maxQwenPct.toFixed(1),
    fileLabel: dp.done ? "Loading model into GPU/CPU memory..." : dp.current_file || "Downloading...",
    filesLabel: `File ${Math.min(dp.done ? totalFiles : doneFiles + 1, totalFiles)} / ${totalFiles}`,
    bytesLabel,
  };
}

function computeTrimValid(): { spanSec: number; spanValid: boolean } {
  const spanSec = Number(Math.max(0, draftEndSec - draftStartSec).toFixed(1));
  const spanValid = probeResult !== null && spanSec >= 3.0 && spanSec <= 30.0;
  return { spanSec, spanValid };
}

function isClipTrimmed(): boolean {
  return (
    probeResult !== null &&
    (draftStartSec > 0.05 || draftEndSec < probeResult.duration_sec - 0.15)
  );
}

function syncTrimWarning(container: HTMLElement): void {
  const warnEl = container.querySelector<HTMLElement>("#clone-trim-warn");
  if (warnEl) {
    const show = isClipTrimmed() && draftRefText.trim().length > 0;
    warnEl.style.display = show ? "block" : "none";
  }
}

function syncTrimUi(container: HTMLElement, modelReady: boolean): void {
  const { spanSec, spanValid } = computeTrimValid();
  const spanEl = container.querySelector<HTMLElement>("#lbl-clone-span");
  if (spanEl) {
    const warn = spanSec < 3 || spanSec > 30 ? " — must be 3–30s" : "";
    spanEl.innerHTML = `selected <strong>${spanSec.toFixed(1)}s</strong>${warn}`;
  }
  const previewBtn = container.querySelector<HTMLButtonElement>("#btn-preview-slice");
  if (previewBtn) {
    previewBtn.disabled = !(
      modelReady &&
      spanValid &&
      !previewingSlice &&
      !downloadingQwen &&
      !cloningBusy &&
      !switchingVariant
    );
  }
  const submitBtn = container.querySelector<HTMLButtonElement>("#btn-create-clone");
  if (submitBtn) {
    submitBtn.disabled = !(
      modelReady &&
      !downloadingQwen &&
      !cloningBusy &&
      !switchingVariant &&
      probeResult !== null &&
      spanValid &&
      draftName.trim().length > 0
    );
  }
  syncTrimWarning(container);
}

function rerenderIfOpen(container: HTMLElement, handlers: VoiceCloneModalHandlers): void {
  if (state.activeModal === "voice_clone") {
    renderVoiceCloneModal(container, handlers);
  }
}

export function syncVoiceCloneDownloadProgress(container: HTMLElement): void {
  const fillEl = container.querySelector<HTMLElement>("#qwen-dl-fill");
  const fileEl = container.querySelector<HTMLElement>("#qwen-dl-file");
  const filesEl = container.querySelector<HTMLElement>("#qwen-dl-files");
  const bytesEl = container.querySelector<HTMLElement>("#qwen-dl-bytes");
  if (!fillEl && !fileEl && !filesEl) return;

  const prog = computeQwenProgress();
  if (fillEl) fillEl.style.width = `${prog.pct}%`;
  if (fileEl) fileEl.textContent = prog.fileLabel;
  if (filesEl) filesEl.textContent = prog.filesLabel;
  if (bytesEl) bytesEl.textContent = prog.bytesLabel;
}

export function renderVoiceCloneModal(
  container: HTMLElement,
  handlers: VoiceCloneModalHandlers,
): void {
  if (!statusRequested) {
    statusRequested = true;
    void invoke<QwenModelStatus>("get_qwen_model_status")
      .then((status) => {
        qwenStatus = status;
        if (state.bootstrap) {
          state.bootstrap.qwen_model_variant = status.active_variant;
          state.bootstrap.qwen_model_ready = status.model_ready;
          state.bootstrap.qwen_device_label = status.device_label;
        }
        if (state.activeModal === "voice_clone") {
          renderVoiceCloneModal(container, handlers);
        }
      })
      .catch((err) => {
        cloneError = `Could not inspect Qwen3-TTS model status: ${String(err)}`;
        if (state.activeModal === "voice_clone") {
          renderVoiceCloneModal(container, handlers);
        }
      });
  }

  const activeVariant: QwenModelVariant =
    qwenStatus?.active_variant ?? state.settings.qwen_model_variant ?? "1.7b";
  const getVariantInfo = (v: QwenModelVariant) =>
    qwenStatus?.variants.find((item) => item.variant === v);
  const activeInfo = getVariantInfo(activeVariant);

  const modelReady =
    activeInfo?.model_ready ??
    qwenStatus?.model_ready ??
    (state.bootstrap?.qwen_model_variant === activeVariant ? state.bootstrap.qwen_model_ready : false);
  const deviceLabel =
    qwenStatus?.device_label ?? state.bootstrap?.qwen_device_label ?? "Auto (GPU / CPU)";
  const sizeGb = (
    (activeInfo?.estimated_size_mb ??
      qwenStatus?.estimated_size_mb ??
      (activeVariant === "0.6b" ? 2560 : 4608)) / 1024
  ).toFixed(1);
  const activeTitle =
    activeVariant === "0.6b" ? "Qwen3-TTS 0.6B-Base" : "Qwen3-TTS 1.7B-Base";
  const activeDirFallback =
    activeVariant === "0.6b"
      ? "BookReader_Data/models/qwen3-tts-0.6b-base"
      : "BookReader_Data/models/qwen3-tts-1.7b-base";

  const clonedVoices = state.voices.filter((v) => v.is_cloned);
  const prog = computeQwenProgress();

  const { spanSec, spanValid } = computeTrimValid();
  const iclMode = draftRefText.trim().length > 0;
  const busyLock = downloadingQwen || cloningBusy || switchingVariant;
  const canSubmit =
    modelReady &&
    !busyLock &&
    probeResult !== null &&
    spanValid &&
    draftName.trim().length > 0;

  const renderVariantOption = (
    variant: QwenModelVariant,
    title: string,
    subtitle: string,
  ): string => {
    const info = getVariantInfo(variant);
    const selected = activeVariant === variant;
    const ready =
      info?.model_ready ??
      (state.bootstrap?.qwen_model_variant === variant
        ? state.bootstrap.qwen_model_ready
        : undefined);
    const pill =
      ready === undefined
        ? `<span class="status-pill missing">Checking</span>`
        : `<span class="status-pill ${ready ? "ready" : "missing"}">${ready ? "Ready" : "Missing"}</span>`;
    return `
      <button
        type="button"
        class="clone-model-option ${selected ? "active" : ""}"
        data-qwen-variant="${variant}"
        ${busyLock ? "disabled" : ""}
      >
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <strong style="font-size:12.5px;">${title}</strong>
          <span style="font-size:11px;color:var(--text-secondary);">${subtitle}</span>
        </div>
        ${pill}
      </button>
    `;
  };

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide" role="dialog" aria-label="Voice Cloning">
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:8px;">
            ${Icons.voiceClone()}
            <span class="modal-title">Voice Cloning (Qwen3-TTS)</span>
          </div>
          <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div class="setting-group">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
              <strong style="font-size:12.5px;">Model Size</strong>
              <span style="font-size:11.5px;color:var(--text-muted);">
                ${switchingVariant ? "Switching model..." : "Saved cloned voices automatically work with both 0.6B and 1.7B."}
              </span>
            </div>

            <div class="clone-model-toggle">
              ${renderVariantOption("0.6b", "0.6B · Fast", "~2.5 GB · Faster & lighter")}
              ${renderVariantOption("1.7b", "1.7B · Best Quality", "~4.5 GB · Max nuance")}
            </div>

            <div class="clone-status-banner">
              <div style="display:flex;flex-direction:column;gap:3px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <strong>${modelReady ? `${activeTitle} Detected` : `${activeTitle} Required (~${sizeGb} GB)`}</strong>
                  <span class="status-pill ${modelReady ? "ready" : "missing"}">${modelReady ? "Ready" : "Missing"}</span>
                  <span class="flag-tag">${escapeHtml(deviceLabel)}</span>
                </div>
                <span style="font-size:12px;color:var(--text-secondary);">
                  ${
                    modelReady
                      ? `Stored in ${escapeHtml(activeInfo?.model_dir || qwenStatus?.model_dir || activeDirFallback)}`
                      : `${activeTitle} + 12Hz tokenizer not found on disk. Click Download Model to install this size.`
                  }
                </span>
              </div>
              ${
                !modelReady
                  ? `<button class="btn-primary" id="btn-download-qwen" ${busyLock ? "disabled" : ""}>
                       ${downloadingQwen ? "Downloading..." : "Download Model"}
                     </button>`
                  : ""
              }
            </div>

            ${
              downloadingQwen
                ? `
              <div style="display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);">
                  <span>Downloading: <strong id="qwen-dl-file" style="color:var(--text-primary);">${escapeHtml(prog.fileLabel)}</strong></span>
                  <span style="display:flex;gap:10px;font-variant-numeric:tabular-nums;">
                    <span id="qwen-dl-bytes">${escapeHtml(prog.bytesLabel)}</span>
                    <span id="qwen-dl-files">${escapeHtml(prog.filesLabel)}</span>
                  </span>
                </div>
                <div class="progress-big">
                  <div class="progress-big-fill" id="qwen-dl-fill" style="width:${prog.pct}%"></div>
                </div>
              </div>
            `
                : ""
            }
          </div>

          <div class="setting-group" style="${modelReady ? "" : "opacity:0.55;"}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
              <strong>Create Cloned Voice</strong>
              <span style="font-size:12px;color:var(--text-secondary);">
                Recommended: <strong>5–15 seconds</strong> of clear speech (3s min, 30s max)
              </span>
            </div>

            <div class="clone-drop-row">
              <div style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;">
                <strong style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${probeResult ? escapeHtml(probeResult.filename) : "Select a reference audio clip (WAV, MP3, M4A, FLAC, OGG)"}
                </strong>
                <span style="font-size:12px;color:${
                  probeResult?.status === "too_short" ? "var(--danger)" : "var(--text-secondary)"
                };">
                  ${
                    probeResult
                      ? `${escapeHtml(probeResult.message)} (${probeResult.sample_rate} Hz)`
                      : "Best results come from 5–15s of a single clean speaker without music or echo."
                  }
                </span>
              </div>
              <button class="btn-secondary" id="btn-pick-clone-audio" ${!modelReady || busyLock ? "disabled" : ""}>
                Choose Audio...
              </button>
            </div>

            ${
              probeResult
                ? `
              <div class="setting-row" style="flex-wrap:wrap;">
                <span>Clip Window (<span id="lbl-clone-span">selected <strong>${spanSec.toFixed(1)}s</strong>${spanSec < 3 || spanSec > 30 ? " — must be 3–30s" : ""}</span>)</span>
                <div style="display:flex;align-items:center;gap:8px;">
                  <label style="font-size:12px;color:var(--text-secondary);">Start</label>
                  <input type="number" id="clone-trim-start" min="0" max="${probeResult.duration_sec.toFixed(1)}" step="0.5" value="${draftStartSec.toFixed(1)}" style="width:76px;padding:5px;" ${!modelReady || busyLock ? "disabled" : ""}/>
                  <label style="font-size:12px;color:var(--text-secondary);">End</label>
                  <input type="number" id="clone-trim-end" min="0" max="${probeResult.duration_sec.toFixed(1)}" step="0.5" value="${draftEndSec.toFixed(1)}" style="width:76px;padding:5px;" ${!modelReady || busyLock ? "disabled" : ""}/>
                  <button class="btn-secondary" id="btn-preview-slice" style="padding:5px 10px;font-size:12px;display:inline-flex;align-items:center;gap:5px;" ${!modelReady || !spanValid || previewingSlice || busyLock ? "disabled" : ""} title="Listen to the exact trimmed audio slice">
                    ${Icons.play(11)}<span>${previewingSlice ? "Loading..." : "Play Slice"}</span>
                  </button>
                </div>
              </div>
            `
                : ""
            }

            <div class="setting-row">
              <span>Voice Name</span>
              <input type="text" id="clone-voice-name" maxlength="48" placeholder="e.g. Morgan Narrator" value="${escapeAttr(draftName)}" style="width:270px;padding:7px 10px;" ${!modelReady || busyLock ? "disabled" : ""}/>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <span style="font-size:13px;">Reference Transcript <span style="color:var(--text-muted);">(Optional)</span></span>
                <span class="flag-tag" id="lbl-clone-mode">
                  ${iclMode ? "ICL Mode · Highest Fidelity" : "X-Vector Mode · Instant"}
                </span>
              </div>
              <textarea id="clone-ref-text" class="clone-textarea" rows="2" placeholder="Paste the exact words spoken inside the selected Start–End clip for highest similarity, or leave blank for fast X-Vector cloning..." ${!modelReady || busyLock ? "disabled" : ""}>${escapeHtml(draftRefText)}</textarea>
              <div id="clone-trim-warn" class="clone-warn-text" style="display:${isClipTrimmed() && iclMode ? "block" : "none"};">
                Clip is trimmed — make sure Reference Transcript matches <strong>only</strong> the exact words spoken between Start and End (any extra words at the end will be spoken before every sentence), or leave it blank for X-Vector mode.
              </div>
            </div>

            ${cloneError ? `<div class="error-text">${escapeHtml(cloneError)}</div>` : ""}

            <div style="display:flex;justify-content:flex-end;">
              <button class="btn-primary" id="btn-create-clone" ${canSubmit ? "" : "disabled"}>
                ${cloningBusy ? "Cloning Voice..." : "Clone &amp; Add Voice"}
              </button>
            </div>
          </div>

          <div class="setting-group">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong>Cloned Voices (${clonedVoices.length})</strong>
              <span style="font-size:11.5px;color:var(--text-muted);">Also selectable under Voices &rarr; Cloned</span>
            </div>
            ${
              clonedVoices.length === 0
                ? `<div style="font-size:12.5px;color:var(--text-muted);">No cloned voices yet. Upload a 5–15 second sample above to create one.</div>`
                : `
              <div style="display:flex;flex-direction:column;gap:6px;">
                ${clonedVoices.map((v) => renderClonedRow(v, busyLock)).join("")}
              </div>
            `
            }
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  container.querySelectorAll<HTMLButtonElement>("[data-qwen-variant]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextVariant = btn.dataset.qwenVariant as QwenModelVariant;
      if (busyLock || nextVariant === activeVariant) return;
      switchingVariant = true;
      cloneError = "";
      rerenderIfOpen(container, handlers);
      try {
        const res = await invoke<SetQwenVariantResponse>("set_qwen_model_variant", {
          variant: nextVariant,
        });
        state.settings = res.settings;
        qwenStatus = res.status;
        if (state.bootstrap) {
          state.bootstrap.qwen_model_variant = res.status.active_variant;
          state.bootstrap.qwen_model_ready = res.status.model_ready;
          state.bootstrap.qwen_device_label = res.status.device_label;
        }
        switchingVariant = false;
        handlers.onChanged();
        handlers.onToast(
          res.status.model_ready
            ? `Switched Voice Cloning to ${nextVariant === "0.6b" ? "Qwen3-TTS 0.6B (Fast)" : "Qwen3-TTS 1.7B (Best Quality)"}`
            : `Selected Qwen3-TTS ${nextVariant.toUpperCase()} — download required before cloning or speaking.`,
        );
        rerenderIfOpen(container, handlers);
      } catch (err) {
        switchingVariant = false;
        cloneError = `Failed switching model size: ${String(err)}`;
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelector("#btn-download-qwen")?.addEventListener("click", async () => {
    if (busyLock) return;
    const targetVariant = activeVariant;
    downloadingQwen = true;
    cloneError = "";
    maxQwenPct = 0;
    if (state.downloadProgress?.kind === "qwen_model") {
      state.downloadProgress = null;
    }
    rerenderIfOpen(container, handlers);
    try {
      qwenStatus = await invoke<QwenModelStatus>("download_qwen_model", {
        variant: targetVariant,
      });
      downloadingQwen = false;
      if (state.bootstrap) {
        state.bootstrap.qwen_model_variant = qwenStatus.active_variant;
        state.bootstrap.qwen_model_ready = qwenStatus.model_ready;
        state.bootstrap.qwen_device_label = qwenStatus.device_label;
      }
      handlers.onToast(
        `${targetVariant === "0.6b" ? "Qwen3-TTS 0.6B" : "Qwen3-TTS 1.7B"} downloaded and ready!`,
      );
      rerenderIfOpen(container, handlers);
    } catch (err) {
      downloadingQwen = false;
      cloneError = `Model download failed: ${String(err)}`;
      rerenderIfOpen(container, handlers);
    }
  });

  container.querySelector("#btn-pick-clone-audio")?.addEventListener("click", async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: "Audio Clips",
            extensions: ["wav", "mp3", "m4a", "flac", "ogg"],
          },
        ],
      });
      if (!picked || typeof picked !== "string") return;

      cloneError = "";
      probeResult = await invoke<AudioClipProbe>("probe_clone_audio", { path: picked });
      draftStartSec = Number(probeResult.recommended_start_sec.toFixed(1));
      draftEndSec = Number(probeResult.recommended_end_sec.toFixed(1));
      if (!draftName.trim()) {
        draftName = suggestVoiceName(probeResult.filename);
      }
      rerenderIfOpen(container, handlers);
    } catch (err) {
      cloneError = String(err);
      rerenderIfOpen(container, handlers);
    }
  });

  const startInput = container.querySelector<HTMLInputElement>("#clone-trim-start");
  const endInput = container.querySelector<HTMLInputElement>("#clone-trim-end");

  startInput?.addEventListener("input", () => {
    const val = Number(startInput.value);
    if (Number.isFinite(val) && probeResult) {
      draftStartSec = Math.max(0, Math.min(val, probeResult.duration_sec));
      syncTrimUi(container, modelReady);
    }
  });
  startInput?.addEventListener("change", () => {
    const val = Number(startInput.value);
    if (Number.isFinite(val) && probeResult) {
      draftStartSec = Number(Math.max(0, Math.min(val, probeResult.duration_sec)).toFixed(1));
    }
    startInput.value = draftStartSec.toFixed(1);
    syncTrimUi(container, modelReady);
  });

  endInput?.addEventListener("input", () => {
    const val = Number(endInput.value);
    if (Number.isFinite(val) && probeResult) {
      draftEndSec = Math.max(0, Math.min(val, probeResult.duration_sec));
      syncTrimUi(container, modelReady);
    }
  });
  endInput?.addEventListener("change", () => {
    const val = Number(endInput.value);
    if (Number.isFinite(val) && probeResult) {
      draftEndSec = Number(Math.max(0, Math.min(val, probeResult.duration_sec)).toFixed(1));
    }
    endInput.value = draftEndSec.toFixed(1);
    syncTrimUi(container, modelReady);
  });

  container.querySelector("#btn-preview-slice")?.addEventListener("click", async () => {
    if (!probeResult || previewingSlice) return;
    try {
      previewingSlice = true;
      rerenderIfOpen(container, handlers);
      await invoke("preview_clone_slice", {
        path: probeResult.path,
        trimStartSec: draftStartSec,
        trimEndSec: draftEndSec,
      });
      previewingSlice = false;
      rerenderIfOpen(container, handlers);
    } catch (err) {
      previewingSlice = false;
      handlers.onToast(`Slice preview failed: ${String(err)}`);
      rerenderIfOpen(container, handlers);
    }
  });

  container.querySelector<HTMLInputElement>("#clone-voice-name")?.addEventListener("input", (e) => {
    draftName = (e.target as HTMLInputElement).value;
    syncTrimUi(container, modelReady);
  });

  container.querySelector<HTMLTextAreaElement>("#clone-ref-text")?.addEventListener("input", (e) => {
    draftRefText = (e.target as HTMLTextAreaElement).value;
    const lbl = container.querySelector<HTMLElement>("#lbl-clone-mode");
    if (lbl) {
      lbl.textContent =
        draftRefText.trim().length > 0
          ? "ICL Mode · Highest Fidelity"
          : "X-Vector Mode · Instant";
    }
    syncTrimWarning(container);
  });

  container.querySelector("#btn-create-clone")?.addEventListener("click", async () => {
    if (!probeResult || !draftName.trim()) return;
    cloningBusy = true;
    cloneError = "";
    rerenderIfOpen(container, handlers);
    try {
      const res = await invoke<CloneVoiceResponse>("create_cloned_voice", {
        req: {
          name: draftName.trim(),
          audio_path: probeResult.path,
          ref_text: draftRefText.trim() ? draftRefText.trim() : null,
          trim_start_sec: draftStartSec,
          trim_end_sec: draftEndSec,
        },
      });
      state.voices = res.voices;
      qwenStatus = await invoke<QwenModelStatus>("get_qwen_model_status");
      cloningBusy = false;
      probeResult = null;
      draftName = "";
      draftRefText = "";
      draftStartSec = 0;
      draftEndSec = 15;
      handlers.onChanged();
      handlers.onToast(`Added "${res.created.name}" to Cloned Voices`);
      rerenderIfOpen(container, handlers);
    } catch (err) {
      cloningBusy = false;
      cloneError = String(err);
      rerenderIfOpen(container, handlers);
    }
  });

  container.querySelectorAll<HTMLButtonElement>("[data-clone-preview]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (busyLock || busyVoiceId !== null) return;
      const vid = btn.dataset.clonePreview!;
      try {
        busyVoiceId = vid;
        rerenderIfOpen(container, handlers);
        await invoke("tts_preview_text", {
          text: "The quick brown fox reads smoothly across every page.",
          voiceId: vid,
        });
        busyVoiceId = null;
        rerenderIfOpen(container, handlers);
      } catch (err) {
        busyVoiceId = null;
        handlers.onToast(`Preview failed: ${String(err)}`);
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-clone-use]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (busyLock || busyVoiceId !== null) return;
      const vid = btn.dataset.cloneUse!;
      try {
        busyVoiceId = vid;
        rerenderIfOpen(container, handlers);
        state.settings = await invoke<Settings>("select_voice", { voiceId: vid });
        state.voices = await invoke<VoiceInfo[]>("list_voices");
        busyVoiceId = null;
        handlers.onChanged();
        rerenderIfOpen(container, handlers);
      } catch (err) {
        busyVoiceId = null;
        handlers.onToast(`Voice error: ${String(err)}`);
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-clone-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (busyLock || busyVoiceId !== null) return;
      const vid = btn.dataset.cloneDelete!;
      try {
        busyVoiceId = vid;
        rerenderIfOpen(container, handlers);
        const res = await invoke<DeleteClonedVoiceResponse>("delete_cloned_voice", {
          voiceId: vid,
        });
        state.voices = res.voices;
        state.settings = res.settings;
        busyVoiceId = null;
        handlers.onChanged();
        handlers.onToast("Cloned voice removed");
        rerenderIfOpen(container, handlers);
      } catch (err) {
        busyVoiceId = null;
        handlers.onToast(`Delete error: ${String(err)}`);
        rerenderIfOpen(container, handlers);
      }
    });
  });
}

function renderClonedRow(v: VoiceInfo, modalBusy: boolean): string {
  const isActive = state.settings.voice_id === v.voice_id;
  const isBusy = modalBusy || busyVoiceId !== null;
  return `
    <div class="book-row">
      <div style="min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;">
          <strong style="font-size:13px;">${escapeHtml(v.name)}</strong>
          <span class="flag-tag">${escapeHtml(v.age)}</span>
        </div>
        <div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px;">
          ${escapeHtml(v.description)}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <button class="icon-btn" data-clone-preview="${escapeAttr(v.voice_id)}" title="Preview cloned voice" ${isBusy ? "disabled" : ""}>
          ${Icons.play(13)}
        </button>
        <button class="chip ${isActive ? "active" : ""}" data-clone-use="${escapeAttr(v.voice_id)}" ${isBusy ? "disabled" : ""}>
          ${isActive ? "Active" : "Use"}
        </button>
        <button class="icon-btn" data-clone-delete="${escapeAttr(v.voice_id)}" title="Delete cloned voice" ${isBusy ? "disabled" : ""}>
          ${Icons.trash()}
        </button>
      </div>
    </div>
  `;
}
