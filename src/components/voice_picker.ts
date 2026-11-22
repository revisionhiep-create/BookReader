import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../icons";
import { state } from "../state";
import type { Settings, VoiceInfo } from "../types";
import { escapeHtml } from "./sidebar";

export interface VoicePickerHandlers {
  onClose: () => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

let activeFilter: "all" | "en-us" | "en-gb" | "characters" = "all";
let downloadingVoiceId: string | null = null;

export function renderVoicePickerModal(
  container: HTMLElement,
  handlers: VoicePickerHandlers,
): void {
  const groups = [
    { key: "en-us", label: "English (US) — Female & Male" },
    { key: "en-gb", label: "English (UK) — Female & Male" },
    { key: "characters", label: "English Character Voices" },
  ].filter((g) => activeFilter === "all" || activeFilter === g.key);

  const missingCount = state.voices.filter((v) => !v.downloaded).length;

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide" role="dialog" aria-label="Voices">
        <div class="modal-header">
          <span class="modal-title">Phonon 31M English Voices (37)</span>
          <div style="display:flex;align-items:center;gap:8px;">
            ${
              missingCount > 0
                ? `<button class="btn-secondary" id="btn-download-all-voices">Download All Missing (${missingCount})</button>`
                : `<span class="flag-tag">All 37 Cached</span>`
            }
            <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
          </div>
        </div>

        <div class="modal-body">
          <div class="chip-row" style="margin-top:0;">
            <button class="chip ${activeFilter === "all" ? "active" : ""}" data-vfilter="all">All (37)</button>
            <button class="chip ${activeFilter === "en-us" ? "active" : ""}" data-vfilter="en-us">US English (12)</button>
            <button class="chip ${activeFilter === "en-gb" ? "active" : ""}" data-vfilter="en-gb">UK English (13)</button>
            <button class="chip ${activeFilter === "characters" ? "active" : ""}" data-vfilter="characters">Characters (12)</button>
          </div>

          ${groups
            .map((g) => {
              const items = state.voices.filter((v) => v.locale === g.key);
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
      renderVoicePickerModal(container, handlers);
      state.voices = await invoke<VoiceInfo[]>("download_all_voices");
      downloadingVoiceId = null;
      handlers.onChanged();
      renderVoicePickerModal(container, handlers);
      handlers.onToast("All 37 English voices downloaded");
    } catch (err) {
      downloadingVoiceId = null;
      handlers.onToast(`Download error: ${String(err)}`);
    }
  });

  container.querySelectorAll<HTMLButtonElement>("[data-select-voice]").forEach((card) => {
    card.addEventListener("click", async () => {
      const vid = card.dataset.selectVoice!;
      try {
        downloadingVoiceId = vid;
        renderVoicePickerModal(container, handlers);
        state.settings = await invoke<Settings>("select_voice", { voiceId: vid });
        state.voices = await invoke<VoiceInfo[]>("list_voices");
        downloadingVoiceId = null;
        handlers.onChanged();
        renderVoicePickerModal(container, handlers);
      } catch (err) {
        downloadingVoiceId = null;
        handlers.onToast(`Voice error: ${String(err)}`);
        renderVoicePickerModal(container, handlers);
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
        renderVoicePickerModal(container, handlers);
      } catch (err) {
        handlers.onToast(`Preview failed: ${String(err)}`);
      }
    });
  });
}

function renderVoiceCard(v: VoiceInfo): string {
  const isActive = state.settings.voice_id === v.voice_id;
  const isBusy = downloadingVoiceId === v.voice_id || downloadingVoiceId === "__all__";
  const meta = `${v.gender === "character" ? "Character" : v.gender} · ${v.age}`;

  return `
    <div class="voice-card ${isActive ? "active" : ""}" role="button" tabindex="0" data-select-voice="${v.voice_id}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <strong style="font-size:13px;">${escapeHtml(v.name)}</strong>
        <div style="display:flex;align-items:center;gap:4px;">
          <span class="flag-tag">${isBusy ? "..." : v.downloaded ? "Cached" : "Cloud"}</span>
          <button class="icon-btn" style="width:24px;height:24px;" data-preview-voice="${v.voice_id}" title="Preview voice">${Icons.play(11)}</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(meta)}</div>
      <div style="font-size:11.5px;color:var(--text-secondary);line-height:1.35;">${escapeHtml(v.description)}</div>
    </div>
  `;
}
