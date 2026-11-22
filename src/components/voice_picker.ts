import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../icons";
import { state } from "../state";
import type { DeleteClonedVoiceResponse, Settings, VoiceInfo } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface VoicePickerHandlers {
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
  onOpenVoiceClone?: () => void;
}

let activeFilter: "all" | "cloned" | "en-us" | "en-gb" | "characters" = "all";
let downloadingVoiceId: string | null = null;

function rerenderIfOpen(container: HTMLElement, handlers: VoicePickerHandlers): void {
  if (state.activeModal === "voices") {
    renderVoicePickerModal(container, handlers);
  }
}

export function renderVoicePickerModal(
  container: HTMLElement,
  handlers: VoicePickerHandlers,
): void {
  const clonedVoices = state.voices.filter((v) => v.is_cloned);
  const groups = [
    { key: "cloned", label: "Cloned Voices (Qwen3-TTS)" },
    { key: "en-us", label: "English (US) — Female & Male" },
    { key: "en-gb", label: "English (UK) — Female & Male" },
    { key: "characters", label: "English Character Voices" },
  ].filter((g) => {
    if (activeFilter === "all") {
      return g.key !== "cloned" || clonedVoices.length > 0;
    }
    return activeFilter === g.key;
  });

  const missingCount = state.voices.filter((v) => !v.is_cloned && !v.downloaded).length;

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide" role="dialog" aria-label="Voices">
        <div class="modal-header">
          <span class="modal-title">Phonon 31M &amp; Cloned Voices (${state.voices.length})</span>
          <div style="display:flex;align-items:center;gap:8px;">
            ${
              missingCount > 0
                ? `<button class="btn-secondary" id="btn-download-all-voices">Download All Missing (${missingCount})</button>`
                : `<span class="flag-tag">All 37 Phonon Cached</span>`
            }
            <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
          </div>
        </div>

        <div class="modal-body">
          <div class="chip-row" style="margin-top:0;">
            <button class="chip ${activeFilter === "all" ? "active" : ""}" data-vfilter="all">All (${state.voices.length})</button>
            <button class="chip ${activeFilter === "cloned" ? "active" : ""}" data-vfilter="cloned">Cloned (${clonedVoices.length})</button>
            <button class="chip ${activeFilter === "en-us" ? "active" : ""}" data-vfilter="en-us">US English (12)</button>
            <button class="chip ${activeFilter === "en-gb" ? "active" : ""}" data-vfilter="en-gb">UK English (13)</button>
            <button class="chip ${activeFilter === "characters" ? "active" : ""}" data-vfilter="characters">Characters (12)</button>
          </div>

          ${groups
            .map((g) => {
              const items = state.voices.filter((v) => v.locale === g.key);
              if (g.key === "cloned" && items.length === 0) {
                return `
                  <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-top:6px;">${g.label}</div>
                  <div class="setting-group" style="align-items:flex-start;">
                    <span style="font-size:13px;color:var(--text-secondary);">No cloned voices yet. Feed a 5–10 second audio sample in Voice Cloning to add one here automatically.</span>
                    <button class="btn-primary" id="btn-empty-open-clone">Open Voice Cloning</button>
                  </div>
                `;
              }
              return `
                <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-top:6px;">${g.label}</div>
                <div class="voice-grid">
                  ${items.map((v) => renderVoiceCard(v)).join("")}
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    </div>
  `;

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  container.querySelectorAll<HTMLButtonElement>("[data-vfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.vfilter as typeof activeFilter;
      renderVoicePickerModal(container, handlers);
    });
  });

  container.querySelector("#btn-download-all-voices")?.addEventListener("click", async () => {
    try {
      downloadingVoiceId = "__all__";
      rerenderIfOpen(container, handlers);
      state.voices = await invoke<VoiceInfo[]>("download_all_voices");
      downloadingVoiceId = null;
      handlers.onChanged();
      rerenderIfOpen(container, handlers);
      handlers.onToast("All 37 English voices downloaded");
    } catch (err) {
      downloadingVoiceId = null;
      rerenderIfOpen(container, handlers);
      handlers.onToast(`Download error: ${String(err)}`);
    }
  });

  container.querySelectorAll<HTMLButtonElement>("[data-select-voice]").forEach((card) => {
    card.addEventListener("click", async () => {
      const vid = card.dataset.selectVoice!;
      try {
        downloadingVoiceId = vid;
        rerenderIfOpen(container, handlers);
        state.settings = await invoke<Settings>("select_voice", { voiceId: vid });
        state.voices = await invoke<VoiceInfo[]>("list_voices");
        downloadingVoiceId = null;
        handlers.onChanged();
        rerenderIfOpen(container, handlers);
      } catch (err) {
        downloadingVoiceId = null;
        handlers.onToast(`Voice error: ${String(err)}`);
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-preview-voice]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const vid = btn.dataset.previewVoice!;
      try {
        await invoke("tts_preview_text", {
          text: "The quick brown fox reads smoothly across every page.",
          voiceId: vid,
        });
        state.voices = await invoke<VoiceInfo[]>("list_voices");
        rerenderIfOpen(container, handlers);
      } catch (err) {
        handlers.onToast(`Preview failed: ${String(err)}`);
      }
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-delete-voice]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const vid = btn.dataset.deleteVoice!;
      try {
        downloadingVoiceId = vid;
        rerenderIfOpen(container, handlers);
        const res = await invoke<DeleteClonedVoiceResponse>("delete_cloned_voice", {
          voiceId: vid,
        });
        state.voices = res.voices;
        state.settings = res.settings;
        downloadingVoiceId = null;
        handlers.onChanged();
        handlers.onToast("Cloned voice removed");
        rerenderIfOpen(container, handlers);
      } catch (err) {
        downloadingVoiceId = null;
        handlers.onToast(`Delete error: ${String(err)}`);
        rerenderIfOpen(container, handlers);
      }
    });
  });

  container.querySelector("#btn-empty-open-clone")?.addEventListener("click", () => {
    handlers.onOpenVoiceClone?.();
  });
}

function renderVoiceCard(v: VoiceInfo): string {
  const isActive = state.settings.voice_id === v.voice_id;
  const isBusy = downloadingVoiceId === v.voice_id || downloadingVoiceId === "__all__";
  const meta = v.is_cloned
    ? `Cloned · ${v.age}`
    : `${v.gender === "character" ? "Character" : v.gender} · ${v.age}`;
  const statusLabel = isBusy
    ? "..."
    : v.is_cloned
      ? "Local"
      : v.downloaded
        ? "Cached"
        : "Cloud";

  return `
    <div class="voice-card ${isActive ? "active" : ""}" role="button" tabindex="0" data-select-voice="${escapeAttr(v.voice_id)}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <strong style="font-size:13px;">${escapeHtml(v.name)}</strong>
        <div style="display:flex;align-items:center;gap:4px;">
          <span class="flag-tag">${statusLabel}</span>
          <button class="icon-btn" style="width:24px;height:24px;" data-preview-voice="${escapeAttr(v.voice_id)}" title="Preview voice">${Icons.play(11)}</button>
          ${
            v.is_cloned
              ? `<button class="icon-btn" style="width:24px;height:24px;" data-delete-voice="${escapeAttr(v.voice_id)}" title="Delete cloned voice">${Icons.trash()}</button>`
              : ""
          }
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(meta)}</div>
      <div style="font-size:11.5px;color:var(--text-secondary);line-height:1.35;">${escapeHtml(v.description)}</div>
    </div>
  `;
}
