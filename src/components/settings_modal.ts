import {
  type AppLanguage,
  getActiveUiLanguage,
  getLanguageMeta,
  SUPPORTED_LANGUAGES,
  tr,
} from "../i18n";
import { Icons } from "../icons";
import { isAndroidPlatform, persistSettings, state, syncServerSettings } from "../state";
import { invoke } from "../tauri_bridge";
import type {
  BracketMode,
  LanguageModelStatus,
  SetTtsLanguageResponse,
  VoiceInfo,
} from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface SettingsModalHandlers {
  onClose: () => void;
  onTypographyChanged: () => void;
  onLanguageChanged?: () => void;
  onTtsModelsUpdated?: () => void;
  onToast?: (msg: string) => void;
}

let downloadingLang: AppLanguage | null = null;
let switchingLang: AppLanguage | null = null;
let modelActionError = "";

export function syncSettingsDownloadProgress(container: HTMLElement): void {
  const dp = state.downloadProgress;
  if (!dp || dp.kind !== "model") return;
  const pct =
    dp.bytes_total && dp.bytes_total > 0
      ? Math.min(100, (dp.bytes_done / dp.bytes_total) * 100).toFixed(1)
      : dp.files_total > 0
        ? Math.min(100, (dp.files_done / dp.files_total) * 100).toFixed(1)
        : "0";
  const fileEl = container.querySelector("#settings-dl-file");
  const pctEl = container.querySelector("#settings-dl-pct");
  const fillEl = container.querySelector<HTMLElement>("#settings-dl-fill");
  if (fileEl) fileEl.textContent = dp.current_file || tr("setup_connecting");
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (fillEl) fillEl.style.width = `${pct}%`;
}

function rerenderIfOpen(container: HTMLElement, handlers: SettingsModalHandlers): void {
  if (state.activeModal === "settings") {
    renderSettingsModal(container, handlers);
  }
}

export function renderSettingsModal(
  container: HTMLElement,
  handlers: SettingsModalHandlers,
): void {
  const prevScrollTop = container.querySelector<HTMLElement>(".modal-body")?.scrollTop ?? 0;
  const s = state.settings;
  const p = s.pauses;
  const san = s.sanitizer;
  const typ = s.typography;
  const uiLang = getActiveUiLanguage();
  const activeTtsLang: AppLanguage = s.tts_language ?? "en";
  const activeMeta = getLanguageMeta(activeTtsLang);
  const isAndroid = isAndroidPlatform();
  const isMac =
    state.bootstrap?.platform === "macos" || /Mac/i.test(navigator.platform);
  const settingsDirLabel = isMac ? tr("settings_dir_mac") : tr("settings_dir_appdata");
  const openSettingsBtnLabel = isMac ? tr("settings_btn_open_mac") : tr("settings_btn_open_appdata");

  const langModels = state.bootstrap?.language_models ?? [];
  const getModelStatus = (lang: AppLanguage): LanguageModelStatus => {
    const found = langModels.find((m) => m.language === lang);
    if (found) return found;
    const meta = getLanguageMeta(lang);
    return {
      language: lang,
      engine: lang === "en" ? "phonon" : "pocket",
      model_id: lang === "en" ? "phonon-31m-en" : `pocket-tts-${lang}`,
      ready: lang === "en" ? Boolean(state.bootstrap?.model_ready) : false,
      loaded: lang === "en" ? Boolean(state.bootstrap?.engine_loaded) : false,
      estimated_size_mb: meta.sizeMb,
      default_voice_id: "",
    };
  };

  const activeLangStatus = getModelStatus(activeTtsLang);
  const activeLangVoices = state.voices.filter(
    (v) => !v.is_cloned && v.language === activeTtsLang,
  );
  const cachedLangVoicesCount = activeLangVoices.filter((v) => v.downloaded).length;
  const bookNoun =
    state.library.length === 1 ? tr("common_book_singular") : tr("common_book_plural");
  const busyModels = downloadingLang !== null || switchingLang !== null;

  const dp = state.downloadProgress;
  const dlModelPct =
    dp && dp.kind === "model" && dp.bytes_total && dp.bytes_total > 0
      ? Math.min(100, (dp.bytes_done / dp.bytes_total) * 100).toFixed(1)
      : dp && dp?.kind === "model" && dp.files_total > 0
        ? Math.min(100, (dp.files_done / dp.files_total) * 100).toFixed(1)
        : "0";

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide mobile-page" role="dialog" aria-label="${escapeAttr(tr("settings_aria_label"))}">
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(tr("settings_title"))}</span>
          <button class="icon-btn" id="btn-modal-close" title="${escapeAttr(tr("common_close"))}">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div class="setting-group">
            <strong>${escapeHtml(tr("settings_lang_section"))}</strong>
            <div class="setting-row">
              <div style="display:flex;flex-direction:column;gap:2px;">
                <span>${escapeHtml(tr("settings_ui_lang_label"))}</span>
                <span style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(tr("settings_ui_lang_desc"))}</span>
              </div>
              <select id="set-ui-language">
                ${SUPPORTED_LANGUAGES.map(
                  (item) =>
                    `<option value="${item.code}" ${item.code === uiLang ? "selected" : ""}>${escapeHtml(
                      `${item.nativeName} (${item.englishName})`,
                    )}</option>`,
                ).join("")}
              </select>
            </div>

            <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
              <strong style="font-size:12.5px;">${escapeHtml(tr("settings_tts_models_label"))}</strong>
              <span style="font-size:11.5px;color:var(--text-secondary);">${escapeHtml(tr("settings_tts_models_desc"))}</span>
            </div>

            <div class="lang-models-list">
              ${SUPPORTED_LANGUAGES.map((meta) => {
                const st = getModelStatus(meta.code);
                const isActive = activeTtsLang === meta.code && st.ready;
                const isThisDownloading = downloadingLang === meta.code;
                const isThisSwitching = switchingLang === meta.code;
                const pillText = isActive
                  ? tr("settings_model_active")
                  : st.ready
                    ? tr("settings_model_ready")
                    : tr("settings_model_not_downloaded");
                const pillClass = st.ready ? "ready" : "missing";

                return `
                  <div class="lang-model-row ${isActive ? "active" : ""}">
                    <div class="lang-model-meta">
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <strong style="font-size:13px;">${escapeHtml(`${meta.nativeName} (${meta.englishName})`)}</strong>
                        <span class="flag-tag">${escapeHtml(meta.modelName)}</span>
                        <span class="flag-tag">${escapeHtml(tr("settings_model_size_mb", { size: st.estimated_size_mb }))}</span>
                        <span class="status-pill ${pillClass}">${escapeHtml(pillText)}</span>
                      </div>
                      <span style="font-size:11.5px;color:var(--text-secondary);">
                        ${escapeHtml(tr("settings_model_default_voice", { voice: meta.defaultVoiceName }))}
                      </span>
                      ${
                        isThisDownloading
                          ? `
                        <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
                          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);">
                            <span id="settings-dl-file">${escapeHtml(dp?.kind === "model" && dp.current_file ? dp.current_file : tr("setup_connecting"))}</span>
                            <span id="settings-dl-pct">${dlModelPct}%</span>
                          </div>
                          <div class="progress-big" style="height:7px;">
                            <div id="settings-dl-fill" class="progress-big-fill" style="width:${dlModelPct}%"></div>
                          </div>
                        </div>
                      `
                          : ""
                      }
                    </div>
                    <div class="lang-model-actions">
                      ${
                        !st.ready
                          ? `<button type="button" class="btn-secondary" data-dl-lang-model="${meta.code}" ${busyModels ? "disabled" : ""}>
                               ${escapeHtml(isThisDownloading ? tr("settings_model_downloading") : tr("settings_model_download"))}
                             </button>`
                          : isActive
                            ? ""
                            : `<button type="button" class="btn-primary" style="padding:6px 12px;font-size:12px;" data-use-lang-model="${meta.code}" ${busyModels ? "disabled" : ""}>
                                 ${escapeHtml(isThisSwitching ? tr("common_loading") : tr("settings_model_use"))}
                               </button>`
                      }
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
            ${modelActionError ? `<div class="error-text">${escapeHtml(modelActionError)}</div>` : ""}
          </div>

          <div class="setting-group">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong>${escapeHtml(tr("settings_pauses_title"))}</strong>
              <div class="chip-row" style="margin-top:0;">
                <button class="chip ${p.preset === "fast_webnovel" ? "active" : ""}" data-preset="fast_webnovel">${escapeHtml(tr("settings_preset_fast"))}</button>
                <button class="chip ${p.preset === "natural" ? "active" : ""}" data-preset="natural">${escapeHtml(tr("settings_preset_natural"))}</button>
                <button class="chip ${p.preset === "audiobook" ? "active" : ""}" data-preset="audiobook">${escapeHtml(tr("settings_preset_audiobook"))}</button>
              </div>
            </div>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_pause_sentence"))} — <strong>${escapeHtml(tr("settings_unit_ms", { ms: p.sentence_ms }))}</strong></span>
              <input type="range" id="set-sent-ms" min="150" max="1500" step="25" value="${p.sentence_ms}"/>
            </div>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_pause_paragraph"))} — <strong>${escapeHtml(tr("settings_unit_ms", { ms: p.paragraph_ms }))}</strong></span>
              <input type="range" id="set-para-ms" min="300" max="2500" step="50" value="${p.paragraph_ms}"/>
            </div>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_pause_section"))} — <strong>${escapeHtml(tr("settings_unit_ms", { ms: p.section_ms }))}</strong></span>
              <input type="range" id="set-sec-ms" min="500" max="3500" step="50" value="${p.section_ms}"/>
            </div>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_pause_comma"))} — <strong>${escapeHtml(tr("settings_unit_ms", { ms: p.comma_extra_ms }))}</strong></span>
              <input type="range" id="set-comma-ms" min="0" max="300" step="20" value="${p.comma_extra_ms}"/>
            </div>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_pause_semi"))} — <strong>${escapeHtml(tr("settings_unit_ms", { ms: p.semicolon_extra_ms }))}</strong></span>
              <input type="range" id="set-semi-ms" min="0" max="450" step="25" value="${p.semicolon_extra_ms}"/>
            </div>
            <label class="checkbox-label">
              <input type="checkbox" id="set-adaptive-pause" ${p.adaptive_speed_scaling ? "checked" : ""}/>
              <span>${escapeHtml(tr("settings_adaptive_pauses"))}</span>
            </label>
          </div>

          <div class="setting-group">
            <strong>${escapeHtml(tr("settings_sanitizer_title"))}</strong>
            <label class="checkbox-label">
              <input type="checkbox" id="set-kaomoji" ${san.strip_kaomoji_emotes ? "checked" : ""}/>
              <span>${escapeHtml(tr("settings_strip_kaomoji"))}</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="set-dividers" ${san.strip_decorative_dividers ? "checked" : ""}/>
              <span>${escapeHtml(tr("settings_strip_dividers"))}</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="set-emojis" ${san.strip_emojis_symbols ? "checked" : ""}/>
              <span>${escapeHtml(tr("settings_strip_emojis"))}</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="set-citations" ${san.skip_citation_brackets ? "checked" : ""}/>
              <span>${escapeHtml(tr("settings_skip_citations"))}</span>
            </label>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_bracket_handling"))}</span>
              <select id="set-bracket-mode">
                <option value="strip_brackets_read_inner" ${san.bracket_mode === "strip_brackets_read_inner" ? "selected" : ""}>${escapeHtml(tr("settings_bracket_strip_inner"))}</option>
                <option value="skip_bracketed_content" ${san.bracket_mode === "skip_bracketed_content" ? "selected" : ""}>${escapeHtml(tr("settings_bracket_skip_all"))}</option>
                <option value="keep" ${san.bracket_mode === "keep" ? "selected" : ""}>${escapeHtml(tr("settings_bracket_keep"))}</option>
              </select>
            </div>
          </div>

          <div class="setting-group">
            <strong>${escapeHtml(tr("settings_typography_title"))}</strong>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_font_size"))} — <strong>${escapeHtml(tr("settings_unit_px", { px: typ.font_size }))}</strong></span>
              <input type="range" id="set-font-size" min="13" max="30" step="1" value="${typ.font_size}"/>
            </div>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_line_height"))} — <strong>${typ.line_height.toFixed(2)}</strong></span>
              <input type="range" id="set-line-height" min="1.3" max="2.3" step="0.05" value="${typ.line_height}"/>
            </div>
            <div class="setting-row">
              <span>${escapeHtml(tr("settings_cc_font_size"))} — <strong>${escapeHtml(tr("settings_unit_px", { px: typ.cc_font_size }))}</strong></span>
              <input type="range" id="set-cc-font-size" min="14" max="48" step="1" value="${typ.cc_font_size}"/>
            </div>
          </div>

          ${
            isAndroid
              ? `
          <div class="setting-group">
            <strong>${escapeHtml(tr("settings_storage_cache_title"))}</strong>
            <div class="storage-summary-grid">
              <div class="storage-summary-item">
                <span>${escapeHtml(`${tr("settings_active_tts_engine")} (${activeMeta.modelName} · ${activeMeta.nativeName})`)}</span>
                <strong>${escapeHtml(
                  activeLangStatus.ready
                    ? tr("settings_engine_status_ready", { size: activeLangStatus.estimated_size_mb })
                    : tr("settings_model_not_downloaded"),
                )}</strong>
              </div>
              <div class="storage-summary-item">
                <span>${escapeHtml(`${tr("settings_cached_voices")} (${activeMeta.nativeName})`)}</span>
                <strong>${cachedLangVoicesCount} / ${activeLangVoices.length}</strong>
              </div>
              <div class="storage-summary-item">
                <span>${escapeHtml(tr("settings_library_books"))}</span>
                <strong>${escapeHtml(tr("settings_book_count", { count: state.library.length, noun: bookNoun }))}</strong>
              </div>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.45;">
              ${escapeHtml(tr("settings_android_storage_note"))}
            </div>
          </div>
          `
              : `
          <div class="setting-group">
            <strong>${escapeHtml(tr("settings_storage_folders_title"))}</strong>
            <div style="font-size:12px;color:var(--text-secondary);word-break:break-all;">
              <div><strong>${escapeHtml(settingsDirLabel)}:</strong> ${escapeHtml(state.bootstrap?.appdata_dir ?? "")}</div>
              <div><strong>${escapeHtml(tr("settings_portable_data"))}:</strong> ${escapeHtml(state.bootstrap?.data_dir ?? "")}</div>
            </div>
            <div style="display:flex;gap:8px;margin-top:4px;">
              <button class="btn-secondary" id="btn-open-appdata">${escapeHtml(openSettingsBtnLabel)}</button>
              <button class="btn-secondary" id="btn-open-portable">${escapeHtml(tr("settings_btn_open_portable"))}</button>
            </div>
          </div>
          `
          }
        </div>
      </div>
    </div>
  `;

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  const newBody = container.querySelector<HTMLElement>(".modal-body");
  if (newBody && prevScrollTop > 0) {
    newBody.scrollTop = prevScrollTop;
  }

  container.querySelector<HTMLSelectElement>("#set-ui-language")?.addEventListener("change", async (e) => {
    const nextLang = (e.target as HTMLSelectElement).value as AppLanguage;
    await persistSettings({ ui_language: nextLang });
    handlers.onLanguageChanged?.();
  });

  container.querySelectorAll<HTMLButtonElement>("[data-dl-lang-model]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetLang = btn.dataset.dlLangModel as AppLanguage;
      if (busyModels) return;
      downloadingLang = targetLang;
      modelActionError = "";
      if (state.downloadProgress?.kind === "model") {
        state.downloadProgress = null;
      }
      rerenderIfOpen(container, handlers);
      try {
        const models = await invoke<LanguageModelStatus[]>("download_language_model", {
          language: targetLang,
        });
        const voices = await invoke<VoiceInfo[]>("list_voices");
        state.voices = voices;
        if (state.bootstrap) {
          state.bootstrap.language_models = models;
          state.bootstrap.model_ready = models.some((m) => m.ready);
        }
        downloadingLang = null;
        const meta = getLanguageMeta(targetLang);
        handlers.onTtsModelsUpdated?.();
        handlers.onToast?.(tr("toast_model_ready", { model: `${meta.modelName} · ${meta.nativeName}` }));
        rerenderIfOpen(container, handlers);
      } catch (err) {
        downloadingLang = null;
        modelActionError = String(err);
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-use-lang-model]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetLang = btn.dataset.useLangModel as AppLanguage;
      if (busyModels) return;
      switchingLang = targetLang;
      modelActionError = "";
      rerenderIfOpen(container, handlers);
      try {
        const res = await invoke<SetTtsLanguageResponse>("set_tts_language", {
          language: targetLang,
        });
        syncServerSettings(res.settings);
        state.voices = res.voices;
        if (state.bootstrap) {
          state.bootstrap.language_models = res.language_models;
        }
        switchingLang = null;
        handlers.onTtsModelsUpdated?.();
        rerenderIfOpen(container, handlers);
      } catch (err) {
        switchingLang = null;
        modelActionError = String(err);
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const preset = btn.dataset.preset!;
      const curPauses = state.settings.pauses;
      const nextP =
        preset === "fast_webnovel"
          ? { ...curPauses, preset, sentence_ms: 300, paragraph_ms: 550, section_ms: 950, comma_extra_ms: 0, semicolon_extra_ms: 0 }
          : preset === "audiobook"
            ? { ...curPauses, preset, sentence_ms: 550, paragraph_ms: 1050, section_ms: 1500, comma_extra_ms: 40, semicolon_extra_ms: 80 }
            : { ...curPauses, preset: "natural", sentence_ms: 450, paragraph_ms: 850, section_ms: 1300, comma_extra_ms: 0, semicolon_extra_ms: 0 };
      await persistSettings({ pauses: nextP });
      if (state.activeModal === "settings") {
        renderSettingsModal(container, handlers);
      }
    });
  });

  const clearPresetChips = () => {
    container.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((el) => {
      el.classList.remove("active");
    });
  };

  const bindRange = (id: string, onChange: (val: number) => void, fmt?: (val: number) => string) => {
    const input = container.querySelector<HTMLInputElement>(id);
    if (!input) return;
    if (fmt) {
      input.addEventListener("input", () => {
        const strong = input.closest(".setting-row")?.querySelector("strong");
        if (strong) strong.textContent = fmt(parseFloat(input.value));
      });
    }
    input.addEventListener("change", () => {
      onChange(parseFloat(input.value));
    });
  };

  bindRange(
    "#set-sent-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, sentence_ms: v, preset: "custom" } });
    },
    (v) => tr("settings_unit_ms", { ms: Math.round(v) }),
  );
  bindRange(
    "#set-para-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, paragraph_ms: v, preset: "custom" } });
    },
    (v) => tr("settings_unit_ms", { ms: Math.round(v) }),
  );
  bindRange(
    "#set-sec-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, section_ms: v, preset: "custom" } });
    },
    (v) => tr("settings_unit_ms", { ms: Math.round(v) }),
  );
  bindRange(
    "#set-comma-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, comma_extra_ms: v, preset: "custom" } });
    },
    (v) => tr("settings_unit_ms", { ms: Math.round(v) }),
  );
  bindRange(
    "#set-semi-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, semicolon_extra_ms: v, preset: "custom" } });
    },
    (v) => tr("settings_unit_ms", { ms: Math.round(v) }),
  );

  container.querySelector<HTMLInputElement>("#set-adaptive-pause")?.addEventListener("change", (e) => {
    void persistSettings({
      pauses: { ...state.settings.pauses, adaptive_speed_scaling: (e.target as HTMLInputElement).checked },
    });
  });

  const bindSan = (id: string, key: keyof typeof san) => {
    container.querySelector<HTMLInputElement>(id)?.addEventListener("change", (e) => {
      void persistSettings({
        sanitizer: { ...state.settings.sanitizer, [key]: (e.target as HTMLInputElement).checked },
      });
    });
  };
  bindSan("#set-kaomoji", "strip_kaomoji_emotes");
  bindSan("#set-dividers", "strip_decorative_dividers");
  bindSan("#set-emojis", "strip_emojis_symbols");
  bindSan("#set-citations", "skip_citation_brackets");

  container.querySelector<HTMLSelectElement>("#set-bracket-mode")?.addEventListener("change", (e) => {
    void persistSettings({
      sanitizer: {
        ...state.settings.sanitizer,
        bracket_mode: (e.target as HTMLSelectElement).value as BracketMode,
      },
    });
  });

  bindRange(
    "#set-font-size",
    (v) => {
      void persistSettings({
        typography: { ...state.settings.typography, font_size: Math.round(v) },
      }).then(() => {
        handlers.onTypographyChanged();
      });
    },
    (v) => tr("settings_unit_px", { px: Math.round(v) }),
  );
  bindRange(
    "#set-line-height",
    (v) => {
      void persistSettings({
        typography: { ...state.settings.typography, line_height: v },
      }).then(() => {
        handlers.onTypographyChanged();
      });
    },
    (v) => v.toFixed(2),
  );
  bindRange(
    "#set-cc-font-size",
    (v) => {
      void persistSettings({
        typography: { ...state.settings.typography, cc_font_size: Math.round(v) },
      });
    },
    (v) => tr("settings_unit_px", { px: Math.round(v) }),
  );

  container.querySelector("#btn-open-appdata")?.addEventListener("click", async () => {
    if (state.bootstrap?.appdata_dir) {
      try {
        await invoke("open_folder_in_explorer", { path: state.bootstrap.appdata_dir });
      } catch (err) {
        handlers.onToast?.(String(err));
      }
    }
  });
  container.querySelector("#btn-open-portable")?.addEventListener("click", async () => {
    if (state.bootstrap?.data_dir) {
      try {
        await invoke("open_folder_in_explorer", { path: state.bootstrap.data_dir });
      } catch (err) {
        handlers.onToast?.(String(err));
      }
    }
  });
}
