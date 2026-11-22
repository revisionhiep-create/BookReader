import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Icons } from "../icons";
import { formatDuration, state } from "../state";
import type { ExportFormat, ExportScope } from "../types";
import { escapeHtml } from "./sidebar";

export interface ExportModalHandlers {
  onClose: () => void;
  onToast: (msg: string) => void;
}

let draftFormat: ExportFormat = "mp3";
let draftScope: ExportScope = "entire_book";
let draftStart = 1;
let draftEnd = 50;

export function renderExportModal(container: HTMLElement, handlers: ExportModalHandlers): void {
  const book = state.activeBook;
  const totalSents = state.sentences.length;
  if (draftEnd > totalSents && totalSents > 0) draftEnd = totalSents;

  const prog = state.exportProgress;
  const isActive = prog && ["preparing", "running", "finalizing"].includes(prog.status);

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card" role="dialog" aria-label="Export Audio">
        <div class="modal-header">
          <span class="modal-title">Export Audiobook (WAV / MP3)</span>
          <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          ${
            !book || totalSents === 0
              ? `<div style="color:var(--text-secondary);">Open a book first to export audio.</div>`
              : `
              <div class="setting-group">
                <div class="setting-row">
                  <span>Book</span>
                  <strong>${escapeHtml(book.title)} (${totalSents} sentences)</strong>
                </div>
                <div class="setting-row">
                  <span>Format</span>
                  <select id="exp-format" ${isActive ? "disabled" : ""}>
                    <option value="mp3" ${draftFormat === "mp3" ? "selected" : ""}>MP3 (128 kbps Mono)</option>
                    <option value="wav" ${draftFormat === "wav" ? "selected" : ""}>WAV (24 kHz 16-bit PCM)</option>
                  </select>
                </div>
                <div class="setting-row">
                  <span>Scope</span>
                  <select id="exp-scope" ${isActive ? "disabled" : ""}>
                    <option value="entire_book" ${draftScope === "entire_book" ? "selected" : ""}>Entire Book (1 - ${totalSents})</option>
                    <option value="range" ${draftScope === "range" ? "selected" : ""}>Sentence Range</option>
                  </select>
                </div>
                ${
                  draftScope === "range"
                    ? `
                  <div class="setting-row">
                    <span>From / To Sentence</span>
                    <div style="display:flex;gap:8px;align-items:center;">
                      <input type="number" id="exp-start" min="1" max="${totalSents}" value="${draftStart}" style="width:82px;padding:5px;" ${isActive ? "disabled" : ""}/>
                      <span>to</span>
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
                    <strong>Status: ${escapeHtml(prog.status.toUpperCase())}</strong>
                    <span>${prog.completed_sentences} / ${prog.total_sentences} (${prog.percent.toFixed(1)}%)</span>
                  </div>
                  <div class="progress-big">
                    <div class="progress-big-fill" style="width:${prog.percent.toFixed(1)}%"></div>
                  </div>
                  <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums;">
                    <span>Elapsed: ${formatDuration(prog.elapsed_sec)}</span>
                    <span>ETA: ${prog.eta_sec != null ? formatDuration(prog.eta_sec) : "—"}</span>
                    <span>Speed: ${prog.realtime_factor.toFixed(1)}x</span>
                    <span>Size: ${formatBytes(prog.bytes_written)}</span>
                  </div>
                  ${prog.error ? `<div class="error-text">${escapeHtml(prog.error)}</div>` : ""}
                  ${
                    prog.status === "completed"
                      ? `<div style="display:flex;justify-content:flex-end;">
                           <button class="btn-secondary" id="btn-open-export-dir">Open Folder</button>
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
              ? `<button class="btn-secondary" id="btn-cancel-export">Cancel Export</button>`
              : `<button class="btn-primary" id="btn-start-export" ${!book || totalSents === 0 ? "disabled" : ""}>Choose Output &amp; Start Export</button>`
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
      await invoke("open_folder_in_explorer", { path: prog.output_path });
    }
  });

  container.querySelector("#btn-start-export")?.addEventListener("click", async () => {
    if (!book) return;
    const ext = draftFormat;
    const safeTitle = book.title.replace(/[\\/:*?"<>|]/g, "_");
    const outputPath = await save({
      defaultPath: `${safeTitle}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!outputPath) return;

    try {
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
      handlers.onToast(`Export error: ${String(err)}`);
    }
  });
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
