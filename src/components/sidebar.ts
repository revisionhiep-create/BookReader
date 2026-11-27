import { tr } from "../i18n";
import { Icons } from "../icons";
import { isAndroidPlatform, isVoiceCloningEnabled, persistSettings, state } from "../state";
import type { ActiveModal } from "../types";

export interface SidebarHandlers {
  onOpenModal: (modal: ActiveModal) => void;
  onCloseDrawer?: () => void;
}

export function renderSidebar(container: HTMLElement, handlers: SidebarHandlers): void {
  const isAndroid = isAndroidPlatform();
  const collapsed = state.settings.sidebar_collapsed;
  if (isAndroid) {
    container.className = [
      "sidebar",
      collapsed ? "collapsed" : "",
      state.mobileDrawerOpen ? "drawer-open" : "",
    ]
      .filter(Boolean)
      .join(" ");
  } else {
    container.className = collapsed ? "sidebar collapsed" : "sidebar";
  }

  const isPlaying = state.tts.status === "playing" || state.tts.status === "loading";
  const bookTitle = state.activeBook ? state.activeBook.title : tr("sidebar_no_book");
  const cloningEnabled = isVoiceCloningEnabled();
  const clonedCount = cloningEnabled ? state.voices.filter((v) => v.is_cloned).length : 0;
  const exp = state.exportProgress;
  const showMiniExport =
    exp && ["preparing", "running", "finalizing"].includes(exp.status);

  container.innerHTML = `
    <div class="sidebar-header">
      <div class="brand-mark">
        ${Icons.brandLogo(19)}
        <span>${escapeHtml(tr("app_title"))}</span>
      </div>
      <button class="icon-btn" id="btn-sidebar-collapse" title="${escapeAttr(tr("sidebar_collapse"))}">
        ${Icons.sidebarToggle()}
      </button>
    </div>

    <div class="sidebar-section-label">${escapeHtml(tr("sidebar_now_reading"))}</div>
    <div class="now-reading-pill" title="${escapeAttr(bookTitle)}">
      <div class="eq-bars ${isPlaying ? "active" : ""}">
        <span></span><span></span><span></span>
      </div>
      <span class="now-reading-title">${escapeHtml(bookTitle)}</span>
    </div>

    <nav class="sidebar-nav">
      <button class="nav-btn" data-modal="library">
        ${Icons.library()}
        <span>${escapeHtml(tr("sidebar_nav_library"))}</span>
        <span class="badge">${state.library.length}</span>
      </button>
      <button class="nav-btn" data-modal="pronunciation">
        ${Icons.pronunciation()}
        <span>${escapeHtml(tr("sidebar_nav_pronunciation"))}</span>
        <span class="badge">${state.pronunciations.length}</span>
      </button>
      <button class="nav-btn" data-modal="ignore">
        ${Icons.ignoreWords()}
        <span>${escapeHtml(tr("sidebar_nav_ignore"))}</span>
        <span class="badge">${state.ignoreRules.length}</span>
      </button>
      <button class="nav-btn" data-modal="toc">
        ${Icons.chapters()}
        <span>${escapeHtml(tr("sidebar_nav_toc"))}</span>
      </button>
      <button class="nav-btn" data-modal="export">
        ${Icons.exportAudio()}
        <span>${escapeHtml(tr("sidebar_nav_export"))}</span>
      </button>
      ${
        cloningEnabled
          ? `
      <button class="nav-btn" data-modal="voice_clone">
        ${Icons.voiceClone()}
        <span>${escapeHtml(tr("sidebar_nav_voice_clone"))}</span>
        ${clonedCount > 0 ? `<span class="badge">${clonedCount}</span>` : ""}
      </button>
      `
          : ""
      }
      <button class="nav-btn" data-modal="settings">
        ${Icons.settings()}
        <span>${escapeHtml(tr("sidebar_nav_settings"))}</span>
      </button>
    </nav>

    ${
      showMiniExport && exp
        ? `
      <div class="sidebar-export-mini" id="btn-mini-export" title="${escapeAttr(tr("sidebar_export_progress_tooltip"))}">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;">
          <span>${escapeHtml(tr("sidebar_exporting_fmt", { format: exp.format.toUpperCase() }))}</span>
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
    if (isAndroid && (window.innerWidth < 840 || window.innerHeight <= 520)) {
      handlers.onCloseDrawer?.();
    } else {
      void persistSettings({ sidebar_collapsed: true });
    }
  });

  container.querySelectorAll<HTMLButtonElement>("[data-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.modal as ActiveModal;
      handlers.onCloseDrawer?.();
      handlers.onOpenModal(target);
    });
  });

  container.querySelector("#btn-mini-export")?.addEventListener("click", () => {
    handlers.onCloseDrawer?.();
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
