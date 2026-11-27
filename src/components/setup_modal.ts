import {
  type AppLanguage,
  detectSystemLanguage,
  getLanguageMeta,
  setActiveUiLanguage,
  SUPPORTED_LANGUAGES,
  t,
} from "../i18n";
import { Icons } from "../icons";
import { applySettingsSideEffects, state } from "../state";
import { invoke } from "../tauri_bridge";
import type { LanguageModelStatus, SetTtsLanguageResponse, Settings } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface SetupModalHandlers {
  onReady: () => void | Promise<void>;
  onLanguageChanged?: () => void;
}

let downloading = false;
let setupError = "";
let selectedLang: AppLanguage | null = null;

export function renderSetupModal(container: HTMLElement, handlers: SetupModalHandlers): void {
  if (!selectedLang) {
    selectedLang = state.settings.ui_language ?? detectSystemLanguage();
    setActiveUiLanguage(selectedLang);
  }
  const lang = selectedLang;
  const meta = getLanguageMeta(lang);

  const dp = state.downloadProgress?.kind === "model" ? state.downloadProgress : null;
  const pct =
    dp && dp.bytes_total && dp.bytes_total > 0
      ? Math.min(100, (dp.bytes_done / dp.bytes_total) * 100).toFixed(1)
      : dp && dp.files_total > 0
        ? Math.min(100, (dp.files_done / dp.files_total) * 100).toFixed(1)
        : "0";
  const defaultFilesTotal = lang === "en" ? 4 : 2;
  const filesTotal = dp?.files_total || defaultFilesTotal;
  const currentFileNum = Math.min(
    filesTotal,
    (dp?.files_done ?? 0) + (dp?.done ? 0 : 1),
  );

  const descText =
    lang === "en"
      ? t(lang, "setup_desc_phonon", {
          engine: meta.engineLabel,
          size: meta.sizeMb,
          path: "BookReader_Data/models/",
        })
      : t(lang, "setup_desc_pocket", {
          engine: meta.engineLabel,
          language: meta.nativeName,
          size: meta.sizeMb,
          path: "BookReader_Data/models/",
        });

  container.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-card mobile-page" role="dialog" aria-label="${escapeAttr(t(lang, "setup_aria_label"))}">
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:8px;">
            ${Icons.brandLogo(20)}
            <span class="modal-title">${escapeHtml(t(lang, "setup_title"))}</span>
          </div>
        </div>

        <div class="modal-body">
          <div class="setting-group">
            <div class="setting-row">
              <span><strong>${escapeHtml(t(lang, "setup_language_label"))}</strong></span>
              <select id="setup-lang-select" ${downloading ? "disabled" : ""}>
                ${SUPPORTED_LANGUAGES.map(
                  (item) =>
                    `<option value="${item.code}" ${item.code === lang ? "selected" : ""}>${escapeHtml(
                      `${item.nativeName} (${item.englishName}) — ${item.modelName} (~${item.sizeMb} MB)`,
                    )}</option>`,
                ).join("")}
              </select>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);">
              ${escapeHtml(t(lang, "setup_language_hint"))}
            </div>
          </div>

          <div class="setup-notice-banner">
            ${escapeHtml(t(lang, "setup_settings_notice"))}
          </div>

          <p style="margin:0;color:var(--text-secondary);line-height:1.55;">
            ${escapeHtml(descText)}
          </p>

          ${
            downloading
              ? `
            <div class="setting-group">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;">
                <span>${escapeHtml(t(lang, "setup_downloading_file", { file: dp?.current_file || t(lang, "setup_connecting") }))}</span>
                <span>${escapeHtml(t(lang, "setup_file_progress", { current: currentFileNum, total: filesTotal }))}</span>
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
            ${escapeHtml(
              downloading
                ? t(lang, "setup_downloading_btn")
                : t(lang, "setup_download_btn", {
                    model: `${meta.modelName} (${meta.nativeName})`,
                    size: meta.sizeMb,
                  }),
            )}
          </button>
        </div>
      </div>
    </div>
  `;

  container.querySelector<HTMLSelectElement>("#setup-lang-select")?.addEventListener("change", (e) => {
    const next = (e.target as HTMLSelectElement).value as AppLanguage;
    selectedLang = next;
    setupError = "";
    setActiveUiLanguage(next);
    handlers.onLanguageChanged?.();
    renderSetupModal(container, handlers);
  });

  container.querySelector("#btn-download-model")?.addEventListener("click", async () => {
    const targetLang = selectedLang ?? detectSystemLanguage();
    downloading = true;
    setupError = "";
    state.downloadProgress = null;
    renderSetupModal(container, handlers);
    try {
      const nextSettings: Settings = {
        ...state.settings,
        ui_language: targetLang,
        tts_language: targetLang,
      };
      const savedUi = await invoke<Settings>("update_settings", { settings: nextSettings });
      state.settings = savedUi;
      applySettingsSideEffects(savedUi);

      const models = await invoke<LanguageModelStatus[]>("download_language_model", {
        language: targetLang,
      });
      const switched = await invoke<SetTtsLanguageResponse>("set_tts_language", {
        language: targetLang,
      });
      state.settings = switched.settings;
      state.voices = switched.voices;
      if (state.bootstrap) {
        state.bootstrap.language_models =
          switched.language_models.length > 0 ? switched.language_models : models;
        state.bootstrap.model_ready = true;
      }
      applySettingsSideEffects(switched.settings);
      downloading = false;
      await handlers.onReady();
    } catch (err) {
      downloading = false;
      setupError = String(err);
      renderSetupModal(container, handlers);
    }
  });
}
