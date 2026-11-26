import { invoke } from "../tauri_bridge";
import { Icons } from "../icons";
import { isAndroidPlatform, persistSettings, state } from "../state";
import type { BracketMode } from "../types";
import { escapeHtml } from "./sidebar";

export interface SettingsModalHandlers {
  onClose: () => void;
  onTypographyChanged: () => void;
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
  const isAndroid = isAndroidPlatform();
  const isMac =
    state.bootstrap?.platform === "macos" || /Mac/i.test(navigator.platform);
  const settingsDirLabel = isMac ? "Settings Folder" : "AppData Settings";
  const openSettingsBtnLabel = isMac ? "Open Settings Folder" : "Open AppData Folder";
  const phononVoices = state.voices.filter((v) => !v.is_cloned);
  const cachedPhononCount = phononVoices.filter((v) => v.downloaded).length;

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide mobile-page" role="dialog" aria-label="Settings">
        <div class="modal-header">
          <span class="modal-title">Settings (Auto-Saved)</span>
          <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div class="setting-group">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong>Natural Pauses &amp; Prosody</strong>
              <div class="chip-row" style="margin-top:0;">
                <button class="chip ${p.preset === "fast_webnovel" ? "active" : ""}" data-preset="fast_webnovel">Fast Webnovel</button>
                <button class="chip ${p.preset === "natural" ? "active" : ""}" data-preset="natural">Natural</button>
                <button class="chip ${p.preset === "audiobook" ? "active" : ""}" data-preset="audiobook">Audiobook</button>
              </div>
            </div>
            <div class="setting-row">
              <span>Sentence end (. ! ?) — <strong>${p.sentence_ms} ms</strong></span>
              <input type="range" id="set-sent-ms" min="150" max="1500" step="25" value="${p.sentence_ms}"/>
            </div>
            <div class="setting-row">
              <span>Paragraph break — <strong>${p.paragraph_ms} ms</strong></span>
              <input type="range" id="set-para-ms" min="300" max="2500" step="50" value="${p.paragraph_ms}"/>
            </div>
            <div class="setting-row">
              <span>Section / Chapter break — <strong>${p.section_ms} ms</strong></span>
              <input type="range" id="set-sec-ms" min="500" max="3500" step="50" value="${p.section_ms}"/>
            </div>
            <div class="setting-row">
              <span>Extra comma (,) pause — <strong>${p.comma_extra_ms} ms</strong></span>
              <input type="range" id="set-comma-ms" min="0" max="300" step="20" value="${p.comma_extra_ms}"/>
            </div>
            <div class="setting-row">
              <span>Extra semicolon/colon (; :) pause — <strong>${p.semicolon_extra_ms} ms</strong></span>
              <input type="range" id="set-semi-ms" min="0" max="450" step="25" value="${p.semicolon_extra_ms}"/>
            </div>
            <label class="checkbox-label">
              <input type="checkbox" id="set-adaptive-pause" ${p.adaptive_speed_scaling ? "checked" : ""}/>
              <span>Adaptive speed scaling for pauses (prevents awkward gaps at 1.4x–2.0x)</span>
            </label>
          </div>

          <div class="setting-group">
            <strong>Symbol, Emote &amp; Bracket Filtering</strong>
            <label class="checkbox-label">
              <input type="checkbox" id="set-kaomoji" ${san.strip_kaomoji_emotes ? "checked" : ""}/>
              <span>Strip kaomoji &amp; foreign-symbol emotes (e.g. ಠ_ಠ, (ノಠ益ಠ)ノ)</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="set-dividers" ${san.strip_decorative_dividers ? "checked" : ""}/>
              <span>Skip decorative dividers (***, ===, -0-, ───) cleanly</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="set-emojis" ${san.strip_emojis_symbols ? "checked" : ""}/>
              <span>Strip unreadable emojis &amp; stray non-English symbols</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="set-citations" ${san.skip_citation_brackets ? "checked" : ""}/>
              <span>Skip citation markers ([1], [12-14], (p. 20))</span>
            </label>
            <div class="setting-row">
              <span>Bracket handling ([ ] ( ) { } &lt; &gt; 「」 【】)</span>
              <select id="set-bracket-mode">
                <option value="strip_brackets_read_inner" ${san.bracket_mode === "strip_brackets_read_inner" ? "selected" : ""}>Strip brackets, read inner text</option>
                <option value="skip_bracketed_content" ${san.bracket_mode === "skip_bracketed_content" ? "selected" : ""}>Skip entire bracketed blocks</option>
                <option value="keep" ${san.bracket_mode === "keep" ? "selected" : ""}>Keep as written</option>
              </select>
            </div>
          </div>

          <div class="setting-group">
            <strong>Reader Typography</strong>
            <div class="setting-row">
              <span>Font Size (EPUB/Word/TXT) — <strong>${typ.font_size} px</strong></span>
              <input type="range" id="set-font-size" min="13" max="30" step="1" value="${typ.font_size}"/>
            </div>
            <div class="setting-row">
              <span>Line Height — <strong>${typ.line_height.toFixed(2)}</strong></span>
              <input type="range" id="set-line-height" min="1.3" max="2.3" step="0.05" value="${typ.line_height}"/>
            </div>
            <div class="setting-row">
              <span>Caption Font Size (CC Bar) — <strong>${typ.cc_font_size} px</strong></span>
              <input type="range" id="set-cc-font-size" min="14" max="48" step="1" value="${typ.cc_font_size}"/>
            </div>
          </div>

          ${
            isAndroid
              ? `
          <div class="setting-group">
            <strong>Storage &amp; Cache</strong>
            <div class="storage-summary-grid">
              <div class="storage-summary-item">
                <span>Phonon 31M Engine</span>
                <strong>${state.bootstrap?.model_ready ? "Ready (~65 MB)" : "Not Downloaded"}</strong>
              </div>
              <div class="storage-summary-item">
                <span>Cached Voices</span>
                <strong>${cachedPhononCount} / ${phononVoices.length}</strong>
              </div>
              <div class="storage-summary-item">
                <span>Library Books</span>
                <strong>${state.library.length} book${state.library.length === 1 ? "" : "s"}</strong>
              </div>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.45;">
              Models, voices, books, and settings are stored privately inside Android app storage.
            </div>
          </div>
          `
              : `
          <div class="setting-group">
            <strong>Storage Folders</strong>
            <div style="font-size:12px;color:var(--text-secondary);word-break:break-all;">
              <div><strong>${settingsDirLabel}:</strong> ${escapeHtml(state.bootstrap?.appdata_dir ?? "")}</div>
              <div><strong>Portable Data (Models/Voices/Books):</strong> ${escapeHtml(state.bootstrap?.data_dir ?? "")}</div>
            </div>
            <div style="display:flex;gap:8px;margin-top:4px;">
              <button class="btn-secondary" id="btn-open-appdata">${openSettingsBtnLabel}</button>
              <button class="btn-secondary" id="btn-open-portable">Open BookReader_Data Folder</button>
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

  container.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const preset = btn.dataset.preset!;
      const nextP =
        preset === "fast_webnovel"
          ? { ...p, preset, sentence_ms: 300, paragraph_ms: 550, section_ms: 950, comma_extra_ms: 0, semicolon_extra_ms: 0 }
          : preset === "audiobook"
            ? { ...p, preset, sentence_ms: 550, paragraph_ms: 1050, section_ms: 1500, comma_extra_ms: 40, semicolon_extra_ms: 80 }
            : { ...p, preset: "natural", sentence_ms: 450, paragraph_ms: 850, section_ms: 1300, comma_extra_ms: 0, semicolon_extra_ms: 0 };
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
    (v) => `${Math.round(v)} ms`,
  );
  bindRange(
    "#set-para-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, paragraph_ms: v, preset: "custom" } });
    },
    (v) => `${Math.round(v)} ms`,
  );
  bindRange(
    "#set-sec-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, section_ms: v, preset: "custom" } });
    },
    (v) => `${Math.round(v)} ms`,
  );
  bindRange(
    "#set-comma-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, comma_extra_ms: v, preset: "custom" } });
    },
    (v) => `${Math.round(v)} ms`,
  );
  bindRange(
    "#set-semi-ms",
    (v) => {
      clearPresetChips();
      void persistSettings({ pauses: { ...state.settings.pauses, semicolon_extra_ms: v, preset: "custom" } });
    },
    (v) => `${Math.round(v)} ms`,
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
    (v) => `${Math.round(v)} px`,
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
    (v) => `${Math.round(v)} px`,
  );

  container.querySelector("#btn-open-appdata")?.addEventListener("click", () => {
    if (state.bootstrap?.appdata_dir) {
      void invoke("open_folder_in_explorer", { path: state.bootstrap.appdata_dir });
    }
  });
  container.querySelector("#btn-open-portable")?.addEventListener("click", () => {
    if (state.bootstrap?.data_dir) {
      void invoke("open_folder_in_explorer", { path: state.bootstrap.data_dir });
    }
  });
}
