import { tr } from "../i18n";
import { invoke, saveDialog } from "../tauri_bridge";
import { Icons } from "../icons";
import { formatDuration, isAndroidPlatform, state } from "../state";
import type { ExportFormat, ExportScope } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface ExportModalHandlers {
  onClose: () => void;
  onToast: (msg: string) => void;
}

let draftFormat: ExportFormat = "mp3";
let draftScope: ExportScope = "entire_book";
let draftStart = 1;
let draftEnd = 50;

function translateExportStatus(status: string): string {
  switch (status) {
    case "preparing":
      return tr("export_status_preparing");
    case "running":
      return tr("export_status_running");
    case "finalizing":
      return tr("export_status_finalizing");
    case "completed":
      return tr("export_status_completed");
    case "cancelled":
      return tr("export_status_cancelled");
    case "error":
      return tr("export_status_error");
    default:
      return status.toUpperCase();
  }
}

export function renderExportModal(container: HTMLElement, handlers: ExportModalHandlers): void {
  const book = state.activeBook;
  const totalSents = state.sentences.length;
  if (draftEnd > totalSents && totalSents > 0) draftEnd = totalSents;

  const prog = state.exportProgress;
  const isActive = prog && ["preparing", "running", "finalizing"].includes(prog.status);
  const sentNoun = totalSents === 1 ? tr("common_sentence_singular") : tr("common_sentence_plural");

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card mobile-page" role="dialog" aria-label="${escapeAttr(tr("export_aria_label"))}">
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(tr("export_title"))}</span>
          <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          ${
            !book || totalSents === 0
              ? `<div style="color:var(--text-secondary);">${escapeHtml(tr("export_empty_book"))}</div>`
              : `
              <div class="setting-group">
                <div class="setting-row">
                  <span>${escapeHtml(tr("export_book_label"))}</span>
                  <strong>${escapeHtml(tr("export_book_sentences", { title: book.title, count: totalSents, noun: sentNoun }))}</strong>
                </div>
                <div class="setting-row">
                  <span>${escapeHtml(tr("export_format_label"))}</span>
                  <select id="exp-format" ${isActive ? "disabled" : ""}>
                    <option value="mp3" ${draftFormat === "mp3" ? "selected" : ""}>${escapeHtml(tr("export_format_mp3"))}</option>
                    <option value="wav" ${draftFormat === "wav" ? "selected" : ""}>${escapeHtml(tr("export_format_wav"))}</option>
                  </select>
                </div>
                <div class="setting-row">
                  <span>${escapeHtml(tr("export_scope_label"))}</span>
                  <select id="exp-scope" ${isActive ? "disabled" : ""}>
                    <option value="entire_book" ${draftScope === "entire_book" ? "selected" : ""}>${escapeHtml(tr("export_scope_entire", { total: totalSents }))}</option>
                    <option value="range" ${draftScope === "range" ? "selected" : ""}>${escapeHtml(tr("export_scope_range"))}</option>
                  </select>
                </div>
                ${
                  draftScope === "range"
                    ? `
                  <div class="setting-row">
                    <span>${escapeHtml(tr("export_range_label"))}</span>
                    <div style="display:flex;gap:8px;align-items:center;">
                      <input type="number" id="exp-start" min="1" max="${totalSents}" value="${draftStart}" style="width:82px;padding:5px;" ${isActive ? "disabled" : ""}/>
                      <span>${escapeHtml(tr("export_range_to"))}</span>
                      <input type="number" id="exp-end" min="1" max="${totalSents}" value="${draftEnd}" style="width:82px;padding:5px;" ${isActive ? "disabled" : ""}/>
                    </div>
                  </div>
                `
                    : ""
                }
              </div>

              ${
                prog
                  ? `
                <div class="setting-group">
                  <div style="display:flex;justify-content:space-between;font-size:12.5px;">
                    <strong>${escapeHtml(tr("export_status_label", { status: translateExportStatus(prog.status) }))}</strong>
                    <span>${prog.completed_sentences} / ${prog.total_sentences} (${prog.percent.toFixed(1)}%)</span>
                  </div>
                  <div class="progress-big">
                    <div class="progress-big-fill" style="width:${prog.percent.toFixed(1)}%"></div>
                  </div>
                  <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums;">
                    <span>${escapeHtml(tr("export_elapsed", { time: formatDuration(prog.elapsed_sec) }))}</span>
                    <span>${escapeHtml(tr("export_eta", { time: prog.eta_sec != null ? formatDuration(prog.eta_sec) : "—" }))}</span>
                    <span>${escapeHtml(tr("export_speed", { speed: prog.realtime_factor.toFixed(1) }))}</span>
                    <span>${escapeHtml(tr("export_size", { size: formatBytes(prog.bytes_written) }))}</span>
                  </div>
                  ${prog.error ? `<div class="error-text">${escapeHtml(prog.error)}</div>` : ""}
                  ${
                    prog.status === "completed" && !isAndroidPlatform()
                      ? `<div style="display:flex;justify-content:flex-end;">
                           <button class="btn-secondary" id="btn-open-export-dir">${escapeHtml(tr("export_open_folder"))}</button>
                         </div>`
                      : ""
                  }
                </div>
              `
                  : ""
              }
            `
          }
        </div>

        <div class="modal-footer" style="flex-direction:row;justify-content:flex-end;">
          ${
            isActive
              ? `<button class="btn-secondary" id="btn-cancel-export">${escapeHtml(tr("export_cancel_btn"))}</button>`
              : `<button class="btn-primary" id="btn-start-export" ${!book || totalSents === 0 ? "disabled" : ""}>${escapeHtml(tr("export_start_btn"))}</button>`
          }
        </div>
      </div>
    </div>
  `;

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  container.querySelector<HTMLSelectElement>("#exp-format")?.addEventListener("change", (e) => {
    draftFormat = (e.target as HTMLSelectElement).value as ExportFormat;
  });
  container.querySelector<HTMLSelectElement>("#exp-scope")?.addEventListener("change", (e) => {
    draftScope = (e.target as HTMLSelectElement).value as ExportScope;
    renderExportModal(container, handlers);
  });
  container.querySelector<HTMLInputElement>("#exp-start")?.addEventListener("change", (e) => {
    draftStart = Math.max(1, parseInt((e.target as HTMLInputElement).value || "1", 10));
  });
  container.querySelector<HTMLInputElement>("#exp-end")?.addEventListener("change", (e) => {
    draftEnd = Math.max(1, parseInt((e.target as HTMLInputElement).value || String(totalSents), 10));
  });

  container.querySelector("#btn-cancel-export")?.addEventListener("click", async () => {
    await invoke("cancel_audio_export");
  });

  container.querySelector("#btn-open-export-dir")?.addEventListener("click", async () => {
    if (prog?.output_path) {
      try {
        await invoke("open_folder_in_explorer", { path: prog.output_path });
      } catch (err) {
        handlers.onToast(tr("export_err_open_folder", { error: String(err) }));
      }
    }
  });

  container.querySelector("#btn-start-export")?.addEventListener("click", async () => {
    if (!book) return;
    const ext = draftFormat;
    const safeTitle = book.title.replace(/[\\/:*?"<>|]/g, "_");
    try {
      const outputPath = await saveDialog({
        defaultPath: `${safeTitle}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!outputPath) return;

      await invoke("start_audio_export", {
        req: {
          book_id: book.id,
          book_title: book.title,
          format: draftFormat,
          scope: draftScope,
          start_sentence: Math.max(0, draftStart - 1),
          end_sentence: Math.max(0, draftEnd - 1),
          voice_id: state.settings.voice_id,
          speed: state.settings.speed,
          output_path: outputPath,
          sentences: state.sentences,
        },
      });
    } catch (err) {
      handlers.onToast(tr("toast_export_error", { error: String(err) }));
    }
  });
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
