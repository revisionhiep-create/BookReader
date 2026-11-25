import { invoke } from "../tauri_bridge";
import { Icons } from "../icons";
import { state } from "../state";
import { escapeHtml } from "./sidebar";

export interface SetupModalHandlers {
  onReady: () => void;
}

let downloading = false;
let setupError = "";

export function renderSetupModal(container: HTMLElement, handlers: SetupModalHandlers): void {
  const dp = state.downloadProgress;
  const pct =
    dp && dp.bytes_total && dp.bytes_total > 0
      ? ((dp.bytes_done / dp.bytes_total) * 100).toFixed(1)
      : dp && dp.files_total > 0
        ? ((dp.files_done / dp.files_total) * 100).toFixed(1)
        : "0";

  container.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-card mobile-page" role="dialog" aria-label="Setup Phonon 31M">
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:8px;">
            ${Icons.brandLogo(20)}
            <span class="modal-title">First-Time Voice Engine Setup</span>
          </div>
        </div>

        <div class="modal-body">
          <p style="margin:0;color:var(--text-secondary);line-height:1.55;">
            BookReader runs offline using Gradium's <strong>Phonon 31M English</strong> model (~65 MB, quantized 8-bit).
            Files are stored cleanly inside <code>BookReader_Data/models/</code>.
          </p>

          ${
            downloading
              ? `
            <div class="setting-group">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;">
                <span>Downloading: <strong>${escapeHtml(dp?.current_file || "Connecting...")}</strong></span>
                <span>File ${(dp?.files_done ?? 0) + (dp?.done ? 0 : 1)} / ${dp?.files_total || 4}</span>
              </div>
              <div class="progress-big">
                <div class="progress-big-fill" style="width:${pct}%"></div>
              </div>
            </div>
          `
              : ""
          }

          ${setupError ? `<div class="error-text">${escapeHtml(setupError)}</div>` : ""}
        </div>

        <div class="modal-footer" style="flex-direction:row;justify-content:flex-end;">
          <button class="btn-primary" id="btn-download-model" ${downloading ? "disabled" : ""}>
            ${downloading ? "Downloading Model..." : "Download Phonon 31M (~65 MB)"}
          </button>
        </div>
      </div>
    </div>
  `;

  container.querySelector("#btn-download-model")?.addEventListener("click", async () => {
    downloading = true;
    setupError = "";
    renderSetupModal(container, handlers);
    try {
      await invoke("download_model");
      downloading = false;
      handlers.onReady();
    } catch (err) {
      downloading = false;
      setupError = String(err);
      renderSetupModal(container, handlers);
    }
  });
}
