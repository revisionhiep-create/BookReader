import { getLanguageMeta, tr } from "../i18n";
import { invoke, openDialog } from "../tauri_bridge";
import { Icons } from "../icons";
import { state, syncServerSettings } from "../state";
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
let probingAudio = false;
let busyVoiceId: string | null = null;
let cloneError = "";
let maxQwenPct = 0;
let statusReqSeq = 0;

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
      fileLabel: tr("clone_dl_connecting"),
      filesLabel: tr("setup_file_progress", { current: 1, total: 8 }),
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
    fileLabel: dp.done ? tr("clone_dl_loading_mem") : dp.current_file || tr("clone_dl_downloading"),
    filesLabel: tr("setup_file_progress", {
      current: Math.min(dp.done ? totalFiles : doneFiles + 1, totalFiles),
      total: totalFiles,
    }),
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
    const warn = spanSec < 3 || spanSec > 30 ? tr("clone_span_rule") : "";
    spanEl.innerHTML = `${escapeHtml(tr("clone_selected_span", { sec: spanSec.toFixed(1) }))}${escapeHtml(warn)}`;
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
  if (fileEl) fileEl.textContent = tr("setup_downloading_file", { file: prog.fileLabel });
  if (filesEl) filesEl.textContent = prog.filesLabel;
  if (bytesEl) bytesEl.textContent = prog.bytesLabel;
}

export function renderVoiceCloneModal(
  container: HTMLElement,
  handlers: VoiceCloneModalHandlers,
): void {
  if (!statusRequested) {
    statusRequested = true;
    const reqId = ++statusReqSeq;
    void invoke<QwenModelStatus>("get_qwen_model_status")
      .then((status) => {
        if (reqId !== statusReqSeq) return;
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
        if (reqId !== statusReqSeq) return;
        cloneError = tr("clone_err_inspect", { error: String(err) });
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
    qwenStatus?.device_label ?? state.bootstrap?.qwen_device_label ?? tr("clone_device_auto");
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
        ? `<span class="status-pill missing">${escapeHtml(tr("common_checking"))}</span>`
        : `<span class="status-pill ${ready ? "ready" : "missing"}">${escapeHtml(ready ? tr("common_ready") : tr("common_missing"))}</span>`;
    return `
      <button
        type="button"
        class="clone-model-option ${selected ? "active" : ""}"
        data-qwen-variant="${variant}"
        ${busyLock ? "disabled" : ""}
      >
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
          <strong style="font-size:12.5px;">${escapeHtml(title)}</strong>
          <span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(subtitle)}</span>
        </div>
        ${pill}
      </button>
    `;
  };

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide" role="dialog" aria-label="${escapeAttr(tr("clone_aria_label"))}">
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:8px;">
            ${Icons.voiceClone()}
            <span class="modal-title">${escapeHtml(tr("clone_title"))}</span>
          </div>
          <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div class="setting-group">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
              <strong style="font-size:12.5px;">${escapeHtml(tr("clone_model_size"))}</strong>
              <span style="font-size:11.5px;color:var(--text-muted);">
                ${escapeHtml(switchingVariant ? tr("clone_switching_model") : tr("clone_model_compat_hint"))}
              </span>
            </div>

            <div class="clone-model-toggle">
              ${renderVariantOption("0.6b", tr("clone_opt_fast_title"), tr("clone_opt_fast_sub"))}
              ${renderVariantOption("1.7b", tr("clone_opt_best_title"), tr("clone_opt_best_sub"))}
            </div>

            <div class="clone-status-banner">
              <div style="display:flex;flex-direction:column;gap:3px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <strong>${escapeHtml(
                    modelReady
                      ? tr("clone_detected", { title: activeTitle })
                      : tr("clone_required", { title: activeTitle, size: sizeGb }),
                  )}</strong>
                  <span class="status-pill ${modelReady ? "ready" : "missing"}">${escapeHtml(modelReady ? tr("common_ready") : tr("common_missing"))}</span>
                  <span class="flag-tag">${escapeHtml(deviceLabel)}</span>
                </div>
                <span style="font-size:12px;color:var(--text-secondary);">
                  ${
                    modelReady
                      ? escapeHtml(tr("clone_stored_in", { path: activeInfo?.model_dir || qwenStatus?.model_dir || activeDirFallback }))
                      : escapeHtml(tr("clone_not_found", { title: activeTitle }))
                  }
                </span>
              </div>
              ${
                !modelReady
                  ? `<button class="btn-primary" id="btn-download-qwen" ${busyLock ? "disabled" : ""}>
                       ${escapeHtml(downloadingQwen ? tr("common_downloading") : tr("clone_download_model"))}
                     </button>`
                  : ""
              }
            </div>

            ${
              downloadingQwen
                ? `
              <div style="display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);">
                  <span id="qwen-dl-file">${escapeHtml(tr("setup_downloading_file", { file: prog.fileLabel }))}</span>
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
              <strong>${escapeHtml(tr("clone_create_title"))}</strong>
              <span style="font-size:12px;color:var(--text-secondary);">
                ${escapeHtml(tr("clone_recommended_len"))}
              </span>
            </div>

            <div class="clone-drop-row">
              <div style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;">
                <strong style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${probeResult ? escapeHtml(probeResult.filename) : escapeHtml(tr("clone_select_audio"))}
                </strong>
                <span style="font-size:12px;color:${
                  probeResult?.status === "too_short" ? "var(--danger)" : "var(--text-secondary)"
                };">
                  ${
                    probeResult
                      ? `${escapeHtml(probeResult.message)} (${probeResult.sample_rate} Hz)`
                      : escapeHtml(tr("clone_best_results"))
                  }
                </span>
              </div>
              <button class="btn-secondary" id="btn-pick-clone-audio" ${!modelReady || busyLock || probingAudio ? "disabled" : ""}>
                ${escapeHtml(tr("clone_choose_audio"))}
              </button>
            </div>

            ${
              probeResult
                ? `
              <div class="setting-row" style="flex-wrap:wrap;">
                <span>${escapeHtml(tr("clone_clip_window"))} (<span id="lbl-clone-span">${escapeHtml(tr("clone_selected_span", { sec: spanSec.toFixed(1) }))}${escapeHtml(spanSec < 3 || spanSec > 30 ? tr("clone_span_rule") : "")}</span>)</span>
                <div style="display:flex;align-items:center;gap:8px;">
                  <label style="font-size:12px;color:var(--text-secondary);">${escapeHtml(tr("clone_trim_start"))}</label>
                  <input type="number" id="clone-trim-start" min="0" max="${probeResult.duration_sec.toFixed(1)}" step="0.5" value="${draftStartSec.toFixed(1)}" style="width:76px;padding:5px;" ${!modelReady || busyLock ? "disabled" : ""}/>
                  <label style="font-size:12px;color:var(--text-secondary);">${escapeHtml(tr("clone_trim_end"))}</label>
                  <input type="number" id="clone-trim-end" min="0" max="${probeResult.duration_sec.toFixed(1)}" step="0.5" value="${draftEndSec.toFixed(1)}" style="width:76px;padding:5px;" ${!modelReady || busyLock ? "disabled" : ""}/>
                  <button class="btn-secondary" id="btn-preview-slice" style="padding:5px 10px;font-size:12px;display:inline-flex;align-items:center;gap:5px;" ${!modelReady || !spanValid || previewingSlice || busyLock ? "disabled" : ""} title="${escapeAttr(tr("clone_play_slice_tooltip"))}">
                    ${Icons.play(11)}<span>${escapeHtml(previewingSlice ? tr("common_loading") : tr("clone_play_slice"))}</span>
                  </button>
                </div>
              </div>
            `
                : ""
            }

            <div class="setting-row">
              <span>${escapeHtml(tr("clone_voice_name"))}</span>
              <input type="text" id="clone-voice-name" maxlength="48" placeholder="${escapeAttr(tr("clone_voice_name_placeholder"))}" value="${escapeAttr(draftName)}" style="width:270px;padding:7px 10px;" ${!modelReady || busyLock ? "disabled" : ""}/>
            </div>

            <div style="display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <span style="font-size:13px;">${escapeHtml(tr("clone_ref_transcript"))} <span style="color:var(--text-muted);">${escapeHtml(tr("clone_optional"))}</span></span>
                <span class="flag-tag" id="lbl-clone-mode">
                  ${escapeHtml(iclMode ? tr("clone_mode_icl") : tr("clone_mode_xvec"))}
                </span>
              </div>
              <textarea id="clone-ref-text" class="clone-textarea" rows="2" placeholder="${escapeAttr(tr("clone_ref_placeholder"))}" ${!modelReady || busyLock ? "disabled" : ""}>${escapeHtml(draftRefText)}</textarea>
              <div id="clone-trim-warn" class="clone-warn-text" style="display:${isClipTrimmed() && iclMode ? "block" : "none"};">
                ${escapeHtml(tr("clone_trim_warn"))}
              </div>
            </div>

            ${cloneError ? `<div class="error-text">${escapeHtml(cloneError)}</div>` : ""}

            <div style="display:flex;justify-content:flex-end;">
              <button class="btn-primary" id="btn-create-clone" ${canSubmit ? "" : "disabled"}>
                ${escapeHtml(cloningBusy ? tr("clone_creating") : tr("clone_create_btn"))}
              </button>
            </div>
          </div>

          <div class="setting-group">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong>${escapeHtml(tr("clone_list_title", { count: clonedVoices.length }))}</strong>
              <span style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(tr("clone_list_hint"))}</span>
            </div>
            ${
              clonedVoices.length === 0
                ? `<div style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(tr("clone_list_empty"))}</div>`
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
            ? tr("clone_toast_switched_ready", {
                variant: `Qwen3-TTS ${tr(nextVariant === "0.6b" ? "clone_opt_fast_title" : "clone_opt_best_title")}`,
              })
            : tr("clone_toast_switched_need_dl", { variant: nextVariant.toUpperCase() }),
        );
        rerenderIfOpen(container, handlers);
      } catch (err) {
        switchingVariant = false;
        cloneError = tr("clone_err_switch", { error: String(err) });
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
        tr("clone_toast_dl_ready", {
          variant: `Qwen3-TTS ${tr(targetVariant === "0.6b" ? "clone_opt_fast_title" : "clone_opt_best_title")}`,
        }),
      );
      rerenderIfOpen(container, handlers);
    } catch (err) {
      downloadingQwen = false;
      cloneError = tr("clone_err_dl", { error: String(err) });
      rerenderIfOpen(container, handlers);
    }
  });

  container.querySelector("#btn-pick-clone-audio")?.addEventListener("click", async () => {
    if (probingAudio || busyLock) return;
    probingAudio = true;
    rerenderIfOpen(container, handlers);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [
          {
            name: tr("clone_audio_clips_filter"),
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
    } catch (err) {
      cloneError = String(err);
    } finally {
      probingAudio = false;
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
      handlers.onToast(tr("clone_err_slice", { error: String(err) }));
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
          ? tr("clone_mode_icl")
          : tr("clone_mode_xvec");
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
      try {
        qwenStatus = await invoke<QwenModelStatus>("get_qwen_model_status");
      } catch {
        // Ignore non-fatal status refresh failure after successful clone.
      }
      cloningBusy = false;
      probeResult = null;
      draftName = "";
      draftRefText = "";
      draftStartSec = 0;
      draftEndSec = 15;
      handlers.onChanged();
      handlers.onToast(tr("clone_toast_added", { name: res.created.name }));
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
          text: getLanguageMeta(state.settings.tts_language ?? "en").samplePreviewText,
          voiceId: vid,
        });
        busyVoiceId = null;
        rerenderIfOpen(container, handlers);
      } catch (err) {
        busyVoiceId = null;
        handlers.onToast(tr("voices_toast_preview_err", { error: String(err) }));
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
        const nextSettings = await invoke<Settings>("select_voice", { voiceId: vid });
        syncServerSettings(nextSettings);
        state.voices = await invoke<VoiceInfo[]>("list_voices");
        busyVoiceId = null;
        handlers.onChanged();
        rerenderIfOpen(container, handlers);
      } catch (err) {
        busyVoiceId = null;
        handlers.onToast(tr("voices_toast_voice_err", { error: String(err) }));
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
        syncServerSettings(res.settings);
        busyVoiceId = null;
        handlers.onChanged();
        handlers.onToast(tr("voices_toast_clone_deleted"));
        rerenderIfOpen(container, handlers);
      } catch (err) {
        busyVoiceId = null;
        handlers.onToast(tr("voices_toast_delete_err", { error: String(err) }));
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
        <button class="icon-btn" data-clone-preview="${escapeAttr(v.voice_id)}" title="${escapeAttr(tr("clone_preview_tooltip"))}" ${isBusy ? "disabled" : ""}>
          ${Icons.play(13)}
        </button>
        <button class="chip ${isActive ? "active" : ""}" data-clone-use="${escapeAttr(v.voice_id)}" ${isBusy ? "disabled" : ""}>
          ${escapeHtml(isActive ? tr("common_active") : tr("common_use"))}
        </button>
        <button class="icon-btn" data-clone-delete="${escapeAttr(v.voice_id)}" title="${escapeAttr(tr("clone_delete_tooltip"))}" ${isBusy ? "disabled" : ""}>
          ${Icons.trash()}
        </button>
      </div>
    </div>
  `;
}
