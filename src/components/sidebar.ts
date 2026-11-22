import { Icons } from "../icons";
import { persistSettings, state } from "../state";
import type { ActiveModal } from "../types";

export interface SidebarHandlers {
  onOpenModal: (modal: ActiveModal) => void;
}

export function renderSidebar(container: HTMLElement, handlers: SidebarHandlers): void {
  const collapsed = state.settings.sidebar_collapsed;
  container.className = collapsed ? "sidebar collapsed" : "sidebar";

  const isPlaying = state.tts.status === "playing" || state.tts.status === "loading";
  const bookTitle = state.activeBook ? state.activeBook.title : "No book selected";
  const clonedCount = state.voices.filter((v) => v.is_cloned).length;
  const exp = state.exportProgress;
  const showMiniExport =
    exp && ["preparing", "running", "finalizing"].includes(exp.status);

  container.innerHTML = `
    <div class="sidebar-header">
      <div class="brand-mark">
        ${Icons.brandLogo(19)}
        <span>BookReader</span>
      </div>
      <button class="icon-btn" id="btn-sidebar-collapse" title="Collapse sidebar">
        ${Icons.sidebarToggle()}
      </button>
    </div>

    <div class="sidebar-section-label">Now Reading</div>
    <div class="now-reading-pill" title="${escapeAttr(bookTitle)}">
      <div class="eq-bars ${isPlaying ? "active" : ""}">
        <span></span><span></span><span></span>
      </div>
      <span class="now-reading-title">${escapeHtml(bookTitle)}</span>
    </div>

    <nav class="sidebar-nav">
      <button class="nav-btn" data-modal="library">
        ${Icons.library()}
        <span>Library</span>
        <span class="badge">${state.library.length}</span>
      </button>
      <button class="nav-btn" data-modal="pronunciation">
        ${Icons.pronunciation()}
        <span>Pronunciation</span>
        <span class="badge">${state.pronunciations.length}</span>
      </button>
      <button class="nav-btn" data-modal="ignore">
        ${Icons.ignoreWords()}
        <span>Ignore Words</span>
        <span class="badge">${state.ignoreRules.length}</span>
      </button>
      <button class="nav-btn" data-modal="toc">
        ${Icons.chapters()}
        <span>Chapters &amp; Bookmarks</span>
      </button>
      <button class="nav-btn" data-modal="export">
        ${Icons.exportAudio()}
        <span>Export Audio</span>
      </button>
      <button class="nav-btn" data-modal="voice_clone">
        ${Icons.voiceClone()}
        <span>Voice Cloning</span>
        ${clonedCount > 0 ? `<span class="badge">${clonedCount}</span>` : ""}
      </button>
      <button class="nav-btn" data-modal="settings">
        ${Icons.settings()}
        <span>Settings</span>
      </button>
    </nav>

    ${
      showMiniExport && exp
        ? `
      <div class="sidebar-export-mini" id="btn-mini-export" title="Click to open Export progress">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;">
          <span>Exporting ${exp.format.toUpperCase()}</span>
          <span>${exp.percent.toFixed(0)}%</span>
        </div>
        <div class="mini-bar-track">
          <div class="mini-bar-fill" style="width:${exp.percent.toFixed(1)}%"></div>
        </div>
      </div>
    `
        : ""
    }
  `;

  container.querySelector("#btn-sidebar-collapse")?.addEventListener("click", () => {
    void persistSettings({ sidebar_collapsed: true });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.modal as ActiveModal;
      handlers.onOpenModal(target);
    });
  });

  container.querySelector("#btn-mini-export")?.addEventListener("click", () => {
    handlers.onOpenModal("export");
  });
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(str: string): string {
  return escapeHtml(str);
}
