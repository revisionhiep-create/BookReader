import { attachSheetSwipeToDismiss } from "../../android/ui/mobile_chrome";
import {
  type AppLanguage,
  getActiveUiLanguage,
  getLanguageMeta,
  tr,
  tVoiceAge,
  tVoiceDesc,
  tVoiceGender,
} from "../i18n";
import { Icons } from "../icons";
import { isAndroidPlatform, isVoiceCloningEnabled, state, syncServerSettings } from "../state";
import { invoke } from "../tauri_bridge";
import type {
  DeleteClonedVoiceResponse,
  SetTtsLanguageResponse,
  Settings,
  VoiceInfo,
} from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface VoicePickerHandlers {
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
  onOpenVoiceClone?: () => void;
  onOpenSettings?: () => void;
}

type EnFilter = "all" | "cloned" | "en-us" | "en-gb" | "characters";
type PocketFilter = "all" | "cloned" | "native" | "female" | "male";

let activeFilter: EnFilter | PocketFilter = "all";
let lastSeenTtsLang: AppLanguage | null = null;
let downloadingVoiceId: string | null = null;
let switchingModel = false;
let voiceActionSeq = 0;

function rerenderIfOpen(container: HTMLElement, handlers: VoicePickerHandlers): void {
  if (state.activeModal === "voices") {
    renderVoicePickerModal(container, handlers);
  }
}

export function renderVoicePickerModal(
  container: HTMLElement,
  handlers: VoicePickerHandlers,
): void {
  const activeTtsLang: AppLanguage = state.settings.tts_language ?? "en";
  if (lastSeenTtsLang !== activeTtsLang) {
    lastSeenTtsLang = activeTtsLang;
    activeFilter = "all";
  }

  const uiLang = getActiveUiLanguage();
  const activeMeta = getLanguageMeta(activeTtsLang);
  const cloningEnabled = isVoiceCloningEnabled();

  // Strict language-only filtering: never mix English voices into French, etc.
  const langVoicesRaw = state.voices.filter(
    (v) => !v.is_cloned && v.language === activeTtsLang,
  );
  const langVoices =
    activeTtsLang === "en"
      ? langVoicesRaw
      : [...langVoicesRaw].sort((a, b) => Number(Boolean(b.is_native)) - Number(Boolean(a.is_native)));

  const clonedVoices = cloningEnabled ? state.voices.filter((v) => v.is_cloned) : [];
  const visibleVoices = [...clonedVoices, ...langVoices];

  if (!cloningEnabled && activeFilter === "cloned") {
    activeFilter = "all";
  }
  if (activeTtsLang === "en") {
    if (!["all", "cloned", "en-us", "en-gb", "characters"].includes(activeFilter)) {
      activeFilter = "all";
    }
  } else if (!["all", "cloned", "native", "female", "male"].includes(activeFilter)) {
    activeFilter = "all";
  }

  const readyModels = (state.bootstrap?.language_models ?? []).filter((m) => m.ready);
  const missingCount = langVoices.filter((v) => !v.downloaded).length;
  const modalTitle = cloningEnabled
    ? tr("voices_title_with_clone", { model: activeMeta.modelName, count: visibleVoices.length })
    : tr("voices_title_plain", { model: activeMeta.modelName, count: visibleVoices.length });

  const renderFilterChips = (): string => {
    const clonedChip = cloningEnabled
      ? `<button class="chip ${activeFilter === "cloned" ? "active" : ""}" data-vfilter="cloned">${escapeHtml(tr("voices_filter_cloned", { count: clonedVoices.length }))}</button>`
      : "";

    if (activeTtsLang === "en") {
      const enUsCount = langVoices.filter((v) => v.locale === "en-us").length;
      const enGbCount = langVoices.filter((v) => v.locale === "en-gb").length;
      const charCount = langVoices.filter((v) => v.locale === "characters").length;
      return `
        <button class="chip ${activeFilter === "all" ? "active" : ""}" data-vfilter="all">${escapeHtml(tr("voices_filter_all", { count: visibleVoices.length }))}</button>
        ${clonedChip}
        <button class="chip ${activeFilter === "en-us" ? "active" : ""}" data-vfilter="en-us">${escapeHtml(tr("voices_filter_us", { count: enUsCount }))}</button>
        <button class="chip ${activeFilter === "en-gb" ? "active" : ""}" data-vfilter="en-gb">${escapeHtml(tr("voices_filter_uk", { count: enGbCount }))}</button>
        <button class="chip ${activeFilter === "characters" ? "active" : ""}" data-vfilter="characters">${escapeHtml(tr("voices_filter_characters", { count: charCount }))}</button>
      `;
    }

    return `
      <button class="chip ${activeFilter === "all" ? "active" : ""}" data-vfilter="all">${escapeHtml(tr("voices_filter_all", { count: visibleVoices.length }))}</button>
      ${clonedChip}
      <button class="chip ${activeFilter === "native" ? "active" : ""}" data-vfilter="native">${escapeHtml(tr("voices_filter_native"))}</button>
      <button class="chip ${activeFilter === "female" ? "active" : ""}" data-vfilter="female">${escapeHtml(tr("voices_filter_female"))}</button>
      <button class="chip ${activeFilter === "male" ? "active" : ""}" data-vfilter="male">${escapeHtml(tr("voices_filter_male"))}</button>
    `;
  };

  const renderGroupsHtml = (): string => {
    if (activeTtsLang === "en") {
      const groups = [
        ...(cloningEnabled ? [{ key: "cloned", label: tr("voices_group_cloned") }] : []),
        { key: "en-us", label: tr("voices_group_en_us") },
        { key: "en-gb", label: tr("voices_group_en_gb") },
        { key: "characters", label: tr("voices_group_characters") },
      ].filter((g) => {
        if (activeFilter === "all") {
          return g.key !== "cloned" || clonedVoices.length > 0;
        }
        return activeFilter === g.key;
      });

      return groups
        .map((g) => {
          const items =
            g.key === "cloned"
              ? clonedVoices
              : langVoices.filter((v) => v.locale === g.key);
          if (g.key === "cloned" && items.length === 0) {
            return renderEmptyClonedSection(g.label);
          }
          return `
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-top:6px;">${escapeHtml(g.label)}</div>
            <div class="voice-grid">
              ${items.map((v) => renderVoiceCard(v, uiLang)).join("")}
            </div>
          `;
        })
        .join("");
    }

    const parts: string[] = [];
    if (cloningEnabled && (activeFilter === "cloned" || (activeFilter === "all" && clonedVoices.length > 0))) {
      if (clonedVoices.length === 0) {
        parts.push(renderEmptyClonedSection(tr("voices_group_cloned")));
      } else {
        parts.push(`
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-top:6px;">${escapeHtml(tr("voices_group_cloned"))}</div>
          <div class="voice-grid">
            ${clonedVoices.map((v) => renderVoiceCard(v, uiLang)).join("")}
          </div>
        `);
      }
    }

    if (activeFilter !== "cloned") {
      const filteredPocket = langVoices.filter((v) => {
        if (activeFilter === "native") return Boolean(v.is_native);
        if (activeFilter === "female") return v.gender.toLowerCase() === "female";
        if (activeFilter === "male") return v.gender.toLowerCase() === "male";
        return true;
      });
      const sectionLabel =
        activeFilter === "native"
          ? tr("voices_group_native")
          : tr("voices_group_pocket", { language: activeMeta.nativeName });

      parts.push(`
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-top:6px;">${escapeHtml(sectionLabel)}</div>
        <div class="voice-grid">
          ${filteredPocket.map((v) => renderVoiceCard(v, uiLang)).join("")}
        </div>
      `);
    }

    return parts.join("");
  };

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide mobile-sheet" role="dialog" aria-label="${escapeAttr(tr("voices_aria_label"))}">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(modalTitle)}</span>
          <div style="display:flex;align-items:center;gap:8px;">
            ${
              missingCount > 0
                ? `<button class="btn-secondary" id="btn-download-all-voices" ${downloadingVoiceId !== null ? "disabled" : ""}>${escapeHtml(tr("voices_download_missing", { count: missingCount }))}</button>`
                : `<span class="flag-tag">${escapeHtml(tr("voices_all_cached", { count: langVoices.length, language: activeMeta.nativeName }))}</span>`
            }
            <button class="icon-btn" id="btn-modal-close" title="${escapeAttr(tr("common_close"))}">${Icons.close()}</button>
          </div>
        </div>

        <div class="modal-body">
          <div class="voice-model-bar">
            <div class="voice-model-bar-meta">
              <span class="flag-tag">${escapeHtml(tr("voices_detected_model"))}</span>
              <strong>${escapeHtml(`${activeMeta.modelName} · ${activeMeta.nativeName}`)}</strong>
            </div>
            <div class="voice-model-bar-actions">
              ${
                readyModels.length > 1
                  ? `<select id="vp-lang-switch" class="voice-model-switcher" ${switchingModel ? "disabled" : ""}>
                      ${readyModels
                        .map((m) => {
                          const meta = getLanguageMeta(m.language);
                          return `<option value="${m.language}" ${m.language === activeTtsLang ? "selected" : ""}>${escapeHtml(`${meta.nativeName} · ${meta.modelName}`)}</option>`;
                        })
                        .join("")}
                    </select>`
                  : ""
              }
              ${
                handlers.onOpenSettings
                  ? `<button type="button" class="btn-secondary" id="btn-vp-add-languages" style="padding:5px 10px;font-size:12px;">${escapeHtml(tr("voices_add_languages"))}</button>`
                  : ""
              }
            </div>
          </div>

          <div class="chip-row" style="margin-top:0;">
            ${renderFilterChips()}
          </div>

          ${renderGroupsHtml()}
        </div>
      </div>
    </div>
  `;

  const backdropEl = container.querySelector<HTMLElement>("#modal-backdrop");
  const sheetCard = container.querySelector<HTMLElement>(".mobile-sheet");
  if (sheetCard && isAndroidPlatform()) {
    attachSheetSwipeToDismiss(sheetCard, backdropEl, handlers.onClose);
  }
  backdropEl?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  container.querySelector<HTMLSelectElement>("#vp-lang-switch")?.addEventListener("change", async (e) => {
    const nextLang = (e.target as HTMLSelectElement).value as AppLanguage;
    if (nextLang === activeTtsLang || switchingModel || downloadingVoiceId !== null) return;
    const seq = ++voiceActionSeq;
    switchingModel = true;
    rerenderIfOpen(container, handlers);
    try {
      const res = await invoke<SetTtsLanguageResponse>("set_tts_language", { language: nextLang });
      if (seq !== voiceActionSeq) return;
      syncServerSettings(res.settings);
      state.voices = res.voices;
      if (state.bootstrap) {
        state.bootstrap.language_models = res.language_models;
      }
      activeFilter = "all";
      lastSeenTtsLang = nextLang;
      switchingModel = false;
      handlers.onChanged();
      rerenderIfOpen(container, handlers);
    } catch (err) {
      switchingModel = false;
      handlers.onToast(tr("voices_toast_voice_err", { error: String(err) }));
      rerenderIfOpen(container, handlers);
    }
  });

  container.querySelector("#btn-vp-add-languages")?.addEventListener("click", () => {
    handlers.onOpenSettings?.();
  });

  container.querySelectorAll<HTMLButtonElement>("[data-vfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.vfilter as EnFilter | PocketFilter;
      renderVoicePickerModal(container, handlers);
    });
  });

  container.querySelector("#btn-download-all-voices")?.addEventListener("click", async () => {
    if (downloadingVoiceId !== null || switchingModel) return;
    const seq = ++voiceActionSeq;
    try {
      downloadingVoiceId = "__all__";
      rerenderIfOpen(container, handlers);
      const voices = await invoke<VoiceInfo[]>("download_all_voices", {
        language: activeTtsLang,
      });
      if (seq !== voiceActionSeq) return;
      state.voices = voices;
      downloadingVoiceId = null;
      handlers.onChanged();
      rerenderIfOpen(container, handlers);
      handlers.onToast(
        tr("voices_toast_all_downloaded", {
          count: langVoices.length,
          language: activeMeta.nativeName,
        }),
      );
    } catch (err) {
      downloadingVoiceId = null;
      rerenderIfOpen(container, handlers);
      handlers.onToast(tr("voices_toast_download_err", { error: String(err) }));
    }
  });

  container.querySelectorAll<HTMLElement>("[data-select-voice]").forEach((card) => {
    const activateCard = async () => {
      if (downloadingVoiceId !== null || switchingModel) return;
      const vid = card.dataset.selectVoice!;
      const seq = ++voiceActionSeq;
      try {
        downloadingVoiceId = vid;
        rerenderIfOpen(container, handlers);
        const saved = await invoke<Settings>("select_voice", { voiceId: vid });
        if (seq !== voiceActionSeq) return;
        syncServerSettings(saved);
        state.voices = await invoke<VoiceInfo[]>("list_voices");
        downloadingVoiceId = null;
        handlers.onChanged();
        rerenderIfOpen(container, handlers);
      } catch (err) {
        downloadingVoiceId = null;
        handlers.onToast(tr("voices_toast_voice_err", { error: String(err) }));
        rerenderIfOpen(container, handlers);
      }
    };
    card.addEventListener("click", () => {
      void activateCard();
    });
    card.addEventListener("keydown", (e) => {
      if (e.target === card && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        void activateCard();
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-preview-voice]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (downloadingVoiceId !== null || switchingModel) return;
      const vid = btn.dataset.previewVoice!;
      const voice = state.voices.find((v) => v.voice_id === vid);
      const previewLang: AppLanguage =
        voice && !voice.is_cloned && (voice.language === "en" || voice.language === "fr" || voice.language === "de" || voice.language === "es" || voice.language === "pt" || voice.language === "it" || voice.language === "nl")
          ? voice.language
          : activeTtsLang;
      const sampleText = getLanguageMeta(previewLang).samplePreviewText;
      try {
        await invoke("tts_preview_text", {
          text: sampleText,
          voiceId: vid,
        });
        state.voices = await invoke<VoiceInfo[]>("list_voices");
        rerenderIfOpen(container, handlers);
      } catch (err) {
        handlers.onToast(tr("voices_toast_preview_err", { error: String(err) }));
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-delete-voice]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (downloadingVoiceId !== null || switchingModel) return;
      const vid = btn.dataset.deleteVoice!;
      const seq = ++voiceActionSeq;
      try {
        downloadingVoiceId = vid;
        rerenderIfOpen(container, handlers);
        const res = await invoke<DeleteClonedVoiceResponse>("delete_cloned_voice", {
          voiceId: vid,
        });
        if (seq !== voiceActionSeq) return;
        state.voices = res.voices;
        syncServerSettings(res.settings);
        downloadingVoiceId = null;
        handlers.onChanged();
        handlers.onToast(tr("voices_toast_clone_deleted"));
        rerenderIfOpen(container, handlers);
      } catch (err) {
        downloadingVoiceId = null;
        handlers.onToast(tr("voices_toast_delete_err", { error: String(err) }));
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelector("#btn-empty-open-clone")?.addEventListener("click", () => {
    handlers.onOpenVoiceClone?.();
  });
}

function renderEmptyClonedSection(label: string): string {
  return `
    <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-top:6px;">${escapeHtml(label)}</div>
    <div class="setting-group" style="align-items:flex-start;">
      <span style="font-size:13px;color:var(--text-secondary);">${escapeHtml(tr("voices_empty_cloned"))}</span>
      <button class="btn-primary" id="btn-empty-open-clone">${escapeHtml(tr("voices_open_clone_btn"))}</button>
    </div>
  `;
}

function renderVoiceCard(v: VoiceInfo, uiLang: AppLanguage): string {
  const isActive = state.settings.voice_id === v.voice_id;
  const modalBusy = downloadingVoiceId !== null || switchingModel;
  const isBusy =
    downloadingVoiceId === v.voice_id ||
    (downloadingVoiceId === "__all__" && !v.is_cloned && !v.downloaded);
  const meta = v.is_cloned
    ? `${tVoiceGender(uiLang, "cloned")} · ${v.age}`
    : `${tVoiceGender(uiLang, v.gender)} · ${tVoiceAge(uiLang, v.age)}`;
  const statusLabel = isBusy
    ? "..."
    : v.is_cloned
      ? tr("voices_badge_local")
      : v.downloaded
        ? tr("voices_badge_cached")
        : tr("voices_badge_cloud");
  const desc = v.is_cloned ? v.description : tVoiceDesc(uiLang, v.voice_id, v.description);

  return `
    <div class="voice-card ${isActive ? "active" : ""}" role="button" tabindex="0" aria-disabled="${modalBusy ? "true" : "false"}" data-select-voice="${escapeAttr(v.voice_id)}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <div style="display:flex;align-items:center;gap:5px;min-width:0;">
          <strong style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(v.name)}</strong>
          ${v.is_native ? `<span class="flag-tag native">${escapeHtml(tr("voices_badge_native"))}</span>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
          <span class="flag-tag">${escapeHtml(statusLabel)}</span>
          <button class="icon-btn" style="width:24px;height:24px;" data-preview-voice="${escapeAttr(v.voice_id)}" ${modalBusy ? "disabled" : ""} title="${escapeAttr(tr("voices_preview_tooltip"))}">${Icons.play(11)}</button>
          ${
            v.is_cloned
              ? `<button class="icon-btn" style="width:24px;height:24px;" data-delete-voice="${escapeAttr(v.voice_id)}" ${modalBusy ? "disabled" : ""} title="${escapeAttr(tr("voices_delete_tooltip"))}">${Icons.trash()}</button>`
              : ""
          }
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(meta)}</div>
      <div style="font-size:11.5px;color:var(--text-secondary);line-height:1.35;">${escapeHtml(desc)}</div>
    </div>
  `;
}
