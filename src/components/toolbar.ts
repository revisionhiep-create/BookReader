import { tr } from "../i18n";
import { invoke } from "../tauri_bridge";
import { Icons } from "../icons";
import { formatDuration, isAndroidPlatform, persistSettings, state } from "../state";
import type { ActiveModal, SleepTimerStatus } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface ToolbarHandlers {
  onOpenModal: (modal: ActiveModal) => void;
  onTogglePlay: () => void;
  onStep: (delta: number) => void;
  onSeekSentence: (idx: number) => void;
  onZoomStep: (delta: number) => void;
  onZoomReset: () => void;
  onTogglePdfInvert: () => void;
  onTogglePdfReflow: () => void;
  onCcSizeStep: (delta: number) => void;
  onCcSizeReset: () => void;
  onToggleSearch: () => void;
  onToggleMarginsEdit: () => void;
  onAddBookmark: () => void;
}

let openPopover: null | "speed" | "sleep" | "volume" = null;
let mountedContainer: HTMLElement | null = null;
let mountedHandlers: ToolbarHandlers | null = null;

export function hasOpenToolbarPopover(): boolean {
  return openPopover !== null;
}

export function closeToolbarPopovers(): void {
  if (openPopover === null) return;
  openPopover = null;
  renderPopoverOnly();
}

export function rerenderToolbar(): void {
  if (!mountedContainer || !mountedHandlers) return;
  const prevPopover = openPopover;
  initToolbar(mountedContainer, mountedHandlers);
  openPopover = prevPopover;
  if (openPopover !== null) {
    renderPopoverOnly();
  }
}

export function initToolbar(container: HTMLElement, handlers: ToolbarHandlers): void {
  mountedContainer = container;
  mountedHandlers = handlers;
  const isMac =
    state.bootstrap?.platform === "macos" || /Mac/i.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  container.innerHTML = `
    <div class="topbar">
      <div class="toolbar-group">
        <button class="icon-btn" id="btn-sidebar-expand" title="${escapeAttr(tr("toolbar_open_sidebar"))}">${Icons.sidebarToggle()}</button>
        <button class="icon-btn" id="btn-add-bookmark" title="${escapeAttr(tr("toolbar_bookmark_pos"))}">${Icons.bookmark(false)}</button>
        <div class="toolbar-segmented" id="grp-page-zoom" title="${escapeAttr(tr("toolbar_page_zoom", { mod: modKey }))}">
          <button class="seg-btn" id="btn-zoom-out" title="${escapeAttr(tr("toolbar_zoom_out", { mod: modKey }))}">${Icons.zoomOut()}</button>
          <button class="seg-val" id="btn-zoom-reset" title="${escapeAttr(tr("toolbar_zoom_reset"))}">100%</button>
          <button class="seg-btn" id="btn-zoom-in" title="${escapeAttr(tr("toolbar_zoom_in", { mod: modKey }))}">${Icons.zoomIn()}</button>
        </div>
        <button class="toolbar-chip" id="btn-pdf-reflow" title="${escapeAttr(tr("toolbar_reflow_tooltip"))}">${escapeHtml(tr("toolbar_reflow_text"))}</button>
        <button class="toolbar-chip" id="btn-pdf-dark-page" title="${escapeAttr(tr("toolbar_dark_page_tooltip"))}">${escapeHtml(tr("toolbar_dark_page"))}</button>
      </div>

      <div class="toolbar-group">
        <button class="voice-btn" id="btn-voice-picker" title="${escapeAttr(tr("toolbar_select_voice"))}">
          ${Icons.voice()}
          <span id="lbl-active-voice"></span>
        </button>

        <button class="icon-btn" id="btn-prev-sent" title="${escapeAttr(tr("toolbar_prev_sentence"))}">
          ${Icons.prevSentence()}
        </button>

        <button class="play-btn" id="btn-play-pause" title="${escapeAttr(tr("toolbar_play_pause"))}"></button>

        <button class="icon-btn" id="btn-next-sent" title="${escapeAttr(tr("toolbar_next_sentence"))}">
          ${Icons.nextSentence()}
        </button>

        <button class="speed-pill" id="btn-speed-pop" title="${escapeAttr(tr("toolbar_playback_speed"))}"></button>

        <button class="icon-btn" id="btn-volume-pop" title="${escapeAttr(tr("toolbar_volume"))}">
          ${Icons.volume()}
        </button>
      </div>

      <div class="toolbar-group">
        <button class="icon-btn" id="btn-cc-toggle" title="${escapeAttr(tr("toolbar_toggle_cc"))}">
          ${Icons.cc()}
        </button>
        <div class="toolbar-segmented" id="grp-cc-size" title="${escapeAttr(tr("toolbar_cc_font_size"))}">
          <button class="seg-btn" id="btn-cc-smaller" title="${escapeAttr(tr("toolbar_cc_smaller"))}">A-</button>
          <button class="seg-val" id="btn-cc-size-reset" title="${escapeAttr(tr("toolbar_cc_reset"))}">21px</button>
          <button class="seg-btn" id="btn-cc-larger" title="${escapeAttr(tr("toolbar_cc_larger"))}">A+</button>
        </div>
        <button class="icon-btn" id="btn-search-toggle" title="${escapeAttr(tr("toolbar_search_doc", { mod: modKey }))}">
          ${Icons.search()}
        </button>
        <button class="icon-btn" id="btn-margins-toggle" title="${escapeAttr(tr("toolbar_pdf_margins"))}">
          ${Icons.margins()}
        </button>
        <button class="icon-btn" id="btn-theme-toggle" title="${escapeAttr(tr("toolbar_theme_toggle"))}"></button>
        <button class="icon-btn" id="btn-sleep-pop" title="${escapeAttr(tr("toolbar_sleep_timer"))}">
          ${Icons.sleepTimer()}
          <span id="lbl-sleep-badge" style="position:absolute;bottom:1px;right:1px;font-size:9px;font-weight:700;"></span>
        </button>
      </div>
    </div>

    <div class="progress-strip">
      <div class="progress-track" id="progress-seek-track" title="${escapeAttr(tr("toolbar_progress_seek"))}">
        <div class="progress-fill" id="progress-fill-bar"></div>
      </div>
      <div class="time-row">
        <span id="lbl-time-elapsed">00:00:00</span>
        <span id="lbl-sent-count">—</span>
        <span id="lbl-time-remaining">-00:00:00</span>
      </div>
    </div>

    <div id="toolbar-popover-host"></div>
  `;

  container.querySelector("#btn-sidebar-expand")?.addEventListener("click", () => {
    void persistSettings({ sidebar_collapsed: false });
  });
  container.querySelector("#btn-add-bookmark")?.addEventListener("click", handlers.onAddBookmark);
  container.querySelector("#btn-zoom-out")?.addEventListener("click", () => handlers.onZoomStep(-0.1));
  container.querySelector("#btn-zoom-reset")?.addEventListener("click", handlers.onZoomReset);
  container.querySelector("#btn-zoom-in")?.addEventListener("click", () => handlers.onZoomStep(0.1));
  container.querySelector("#btn-pdf-reflow")?.addEventListener("click", handlers.onTogglePdfReflow);
  container.querySelector("#btn-pdf-dark-page")?.addEventListener("click", handlers.onTogglePdfInvert);

  container.querySelector("#btn-voice-picker")?.addEventListener("click", () => {
    closeToolbarPopovers();
    handlers.onOpenModal("voices");
  });
  container.querySelector("#btn-prev-sent")?.addEventListener("click", () => handlers.onStep(-1));
  container.querySelector("#btn-play-pause")?.addEventListener("click", handlers.onTogglePlay);
  container.querySelector("#btn-next-sent")?.addEventListener("click", () => handlers.onStep(1));

  container.querySelector("#btn-cc-toggle")?.addEventListener("click", () => {
    void persistSettings({ cc_enabled: !state.settings.cc_enabled });
  });
  container.querySelector("#btn-cc-smaller")?.addEventListener("click", () => handlers.onCcSizeStep(-2));
  container.querySelector("#btn-cc-size-reset")?.addEventListener("click", handlers.onCcSizeReset);
  container.querySelector("#btn-cc-larger")?.addEventListener("click", () => handlers.onCcSizeStep(2));

  container.querySelector("#btn-search-toggle")?.addEventListener("click", handlers.onToggleSearch);
  container.querySelector("#btn-margins-toggle")?.addEventListener("click", handlers.onToggleMarginsEdit);
  container.querySelector("#btn-theme-toggle")?.addEventListener("click", () => {
    const next = state.settings.theme === "dark" ? "light" : "dark";
    void persistSettings({ theme: next });
  });

  container.querySelector("#btn-speed-pop")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover = openPopover === "speed" ? null : "speed";
    renderPopoverOnly();
  });
  container.querySelector("#btn-volume-pop")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover = openPopover === "volume" ? null : "volume";
    renderPopoverOnly();
  });
  container.querySelector("#btn-sleep-pop")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover = openPopover === "sleep" ? null : "sleep";
    renderPopoverOnly();
  });

  container.querySelector("#progress-seek-track")?.addEventListener("click", (e) => {
    if (state.sentences.length === 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, ((e as MouseEvent).clientX - rect.left) / rect.width));
    const idx = Math.floor(frac * (state.sentences.length - 1));
    handlers.onSeekSentence(idx);
  });

  syncToolbar();
}

/** Updates toolbar buttons, zoom/CC readouts, icons, and progress labels in place without destroying popovers or sliders. */
export function syncToolbar(): void {
  const container = mountedContainer;
  if (!container) return;

  const isPlaying = state.tts.status === "playing" || state.tts.status === "loading";
  const hasBook = state.activeBook !== null;
  const isPdf = state.activeBook?.format === "pdf";
  const activeVoice =
    state.voices.find((v) => v.voice_id === state.settings.voice_id)?.name ?? tr("common_default");

  const total = Math.max(1, state.sentences.length);
  const curIdx = Math.min(state.tts.sentence_idx, total - 1);
  const progressPct = state.sentences.length > 0 ? ((curIdx + 1) / state.sentences.length) * 100 : 0;

  const expandBtn = container.querySelector<HTMLButtonElement>("#btn-sidebar-expand");
  if (expandBtn) expandBtn.style.display = state.settings.sidebar_collapsed ? "inline-flex" : "none";

  const bmBtn = container.querySelector<HTMLButtonElement>("#btn-add-bookmark");
  if (bmBtn) bmBtn.disabled = !hasBook;

  const zoomGroup = container.querySelector<HTMLElement>("#grp-page-zoom");
  const zoomLbl = container.querySelector<HTMLElement>("#btn-zoom-reset");
  const zoomFactor = isPdf
    ? state.settings.typography.pdf_zoom
    : state.settings.typography.reader_zoom;
  if (zoomGroup) {
    zoomGroup.classList.toggle("disabled", !hasBook);
    zoomGroup.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.disabled = !hasBook;
    });
  }
  if (zoomLbl) zoomLbl.textContent = `${Math.round(zoomFactor * 100)}%`;

  const reflowBtn = container.querySelector<HTMLButtonElement>("#btn-pdf-reflow");
  if (reflowBtn) {
    reflowBtn.style.display = isPdf ? "inline-flex" : "none";
    reflowBtn.classList.toggle("active", state.settings.pdf_reflow);
  }

  const darkPageBtn = container.querySelector<HTMLButtonElement>("#btn-pdf-dark-page");
  if (darkPageBtn) {
    const showDarkPage = isPdf && !state.settings.pdf_reflow && state.settings.theme === "dark";
    darkPageBtn.style.display = showDarkPage ? "inline-flex" : "none";
    darkPageBtn.classList.toggle("active", state.settings.pdf_invert_dark);
  }

  const voiceBtn = container.querySelector<HTMLButtonElement>("#btn-voice-picker");
  const voiceLbl = container.querySelector<HTMLElement>("#lbl-active-voice");
  if (voiceBtn) voiceBtn.title = tr("toolbar_voice_tooltip", { voice: activeVoice });
  if (voiceLbl) voiceLbl.textContent = activeVoice;

  const prevBtn = container.querySelector<HTMLButtonElement>("#btn-prev-sent");
  const playBtn = container.querySelector<HTMLButtonElement>("#btn-play-pause");
  const nextBtn = container.querySelector<HTMLButtonElement>("#btn-next-sent");
  if (prevBtn) prevBtn.disabled = !hasBook;
  if (nextBtn) nextBtn.disabled = !hasBook;
  if (playBtn) {
    playBtn.disabled = !hasBook;
    playBtn.innerHTML = isPlaying ? Icons.pause(17) : Icons.play(17);
  }

  const speedPill = container.querySelector<HTMLElement>("#btn-speed-pop");
  if (speedPill) speedPill.textContent = `${state.settings.speed.toFixed(2)}x`;

  const volumeBtn = container.querySelector<HTMLButtonElement>("#btn-volume-pop");
  if (volumeBtn) {
    volumeBtn.style.display = isAndroidPlatform() ? "none" : "inline-flex";
  }

  container.querySelector("#btn-cc-toggle")?.classList.toggle("active", state.settings.cc_enabled);

  const ccSizeGroup = container.querySelector<HTMLElement>("#grp-cc-size");
  const ccSizeLbl = container.querySelector<HTMLElement>("#btn-cc-size-reset");
  if (ccSizeGroup) {
    ccSizeGroup.classList.toggle("disabled", !state.settings.cc_enabled);
    ccSizeGroup.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.disabled = !state.settings.cc_enabled;
    });
  }
  if (ccSizeLbl) ccSizeLbl.textContent = `${state.settings.typography.cc_font_size}px`;

  const searchBtn = container.querySelector<HTMLButtonElement>("#btn-search-toggle");
  if (searchBtn) {
    searchBtn.disabled = !hasBook;
    searchBtn.classList.toggle("active", state.searchOpen);
  }

  const marginsBtn = container.querySelector<HTMLButtonElement>("#btn-margins-toggle");
  if (marginsBtn) {
    marginsBtn.disabled = !isPdf;
    marginsBtn.classList.toggle("active", state.pdfMarginsEditing);
  }

  const themeBtn = container.querySelector<HTMLElement>("#btn-theme-toggle");
  if (themeBtn) {
    themeBtn.innerHTML = state.settings.theme === "dark" ? Icons.sun() : Icons.moon();
  }

  const sleepBtn = container.querySelector<HTMLElement>("#btn-sleep-pop");
  const sleepBadgeEl = container.querySelector<HTMLElement>("#lbl-sleep-badge");
  if (sleepBtn) sleepBtn.classList.toggle("active", state.sleepTimer.active);
  if (sleepBadgeEl) {
    const badge =
      state.sleepTimer.active && state.sleepTimer.mode === "minutes" && state.sleepTimer.remaining_sec !== null
        ? tr("sleep_badge_min", { min: Math.ceil(state.sleepTimer.remaining_sec / 60) })
        : state.sleepTimer.active && state.sleepTimer.mode === "end_of_chapter"
          ? tr("sleep_badge_chapter")
          : "";
    sleepBadgeEl.textContent = badge;
  }

  const fillEl = container.querySelector<HTMLElement>("#progress-fill-bar");
  const elapsedEl = container.querySelector<HTMLElement>("#lbl-time-elapsed");
  const countEl = container.querySelector<HTMLElement>("#lbl-sent-count");
  const remEl = container.querySelector<HTMLElement>("#lbl-time-remaining");
  if (fillEl) fillEl.style.width = `${progressPct.toFixed(2)}%`;
  if (elapsedEl) elapsedEl.textContent = formatDuration(state.tts.elapsed_est_sec);
  if (countEl) countEl.textContent = state.sentences.length > 0 ? `${curIdx + 1} / ${state.sentences.length}` : "—";
  if (remEl) remEl.textContent = `-${formatDuration(state.tts.remaining_est_sec)}`;
}

function renderPopoverOnly(): void {
  const host = mountedContainer?.querySelector<HTMLElement>("#toolbar-popover-host");
  if (!host || !mountedHandlers) return;

  if (openPopover === null) {
    host.innerHTML = "";
    return;
  }

  if (openPopover === "speed") {
    const presets = [0.75, 1.0, 1.25, 1.38, 1.5, 2.0];
    host.innerHTML = `
      <div class="popover" style="left:50%;transform:translateX(-50%);" id="toolbar-popover">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px;">
          <span>${escapeHtml(tr("popover_reading_speed"))}</span>
          <strong id="pop-speed-val">${state.settings.speed.toFixed(2)}x</strong>
        </div>
        <input type="range" id="speed-slider" min="0.5" max="3.0" step="0.02" value="${state.settings.speed}" style="width:100%;" />
        <div class="chip-row">
          ${presets
            .map(
              (p) =>
                `<button class="chip ${Math.abs(state.settings.speed - p) < 0.015 ? "active" : ""}" data-speed="${p}">${p}x</button>`,
            )
            .join("")}
        </div>
      </div>
    `;
  } else if (openPopover === "volume") {
    host.innerHTML = `
      <div class="popover" style="left:56%;transform:translateX(-50%);" id="toolbar-popover">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px;">
          <span>${escapeHtml(tr("toolbar_volume"))}</span>
          <strong id="pop-vol-val">${Math.round(state.settings.volume * 100)}%</strong>
        </div>
        <input type="range" id="volume-slider" min="0" max="1" step="0.02" value="${state.settings.volume}" style="width:100%;" />
      </div>
    `;
  } else {
    host.innerHTML = `
      <div class="popover" style="right:14px;" id="toolbar-popover">
        <div style="font-size:12.5px;font-weight:600;margin-bottom:8px;">${escapeHtml(tr("popover_sleep_timer"))}</div>
        <div class="chip-row">
          <button class="chip" data-sleep-min="15">${escapeHtml(tr("sleep_minutes", { min: 15 }))}</button>
          <button class="chip" data-sleep-min="30">${escapeHtml(tr("sleep_minutes", { min: 30 }))}</button>
          <button class="chip" data-sleep-min="60">${escapeHtml(tr("sleep_minutes", { min: 60 }))}</button>
          <button class="chip" data-sleep-chap="1">${escapeHtml(tr("sleep_end_of_chapter"))}</button>
          ${state.sleepTimer.active ? `<button class="chip" data-sleep-off="1">${escapeHtml(tr("sleep_turn_off"))}</button>` : ""}
        </div>
      </div>
    `;
  }

  const pop = host.querySelector<HTMLElement>("#toolbar-popover");
  if (!pop) return;
  pop.addEventListener("click", (e) => e.stopPropagation());

  pop.querySelector<HTMLInputElement>("#speed-slider")?.addEventListener("input", (e) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    const valLbl = pop.querySelector<HTMLElement>("#pop-speed-val");
    if (valLbl) valLbl.textContent = `${val.toFixed(2)}x`;
    pop.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((btn) => {
      const p = parseFloat(btn.dataset.speed || "1.0");
      btn.classList.toggle("active", Math.abs(val - p) < 0.015);
    });
    void persistSettings({ speed: val });
  });

  pop.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = parseFloat(btn.dataset.speed || "1.0");
      const slider = pop.querySelector<HTMLInputElement>("#speed-slider");
      const valLbl = pop.querySelector<HTMLElement>("#pop-speed-val");
      if (slider) slider.value = String(val);
      if (valLbl) valLbl.textContent = `${val.toFixed(2)}x`;
      pop.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      void persistSettings({ speed: val });
    });
  });

  pop.querySelector<HTMLInputElement>("#volume-slider")?.addEventListener("input", (e) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    const valLbl = pop.querySelector<HTMLElement>("#pop-vol-val");
    if (valLbl) valLbl.textContent = `${Math.round(val * 100)}%`;
    void persistSettings({ volume: val });
  });

  pop.querySelectorAll<HTMLButtonElement>("[data-sleep-min]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mins = parseInt(btn.dataset.sleepMin || "15", 10);
      state.sleepTimer = await invoke<SleepTimerStatus>("set_sleep_timer", {
        mode: "minutes",
        minutes: mins,
        endSentenceIdx: null,
      });
      closeToolbarPopovers();
      syncToolbar();
    });
  });

  pop.querySelector("[data-sleep-chap]")?.addEventListener("click", async () => {
    const cur = state.tts.sentence_idx;
    const nextChap = state.toc.find((t) => t.sentence_idx > cur);
    const endSentenceIdx = nextChap ? nextChap.sentence_idx : Math.max(0, state.sentences.length - 1);
    state.sleepTimer = await invoke<SleepTimerStatus>("set_sleep_timer", {
      mode: "end_of_chapter",
      minutes: null,
      endSentenceIdx,
    });
    closeToolbarPopovers();
    syncToolbar();
  });

  pop.querySelector("[data-sleep-off]")?.addEventListener("click", async () => {
    state.sleepTimer = await invoke<SleepTimerStatus>("set_sleep_timer", {
      mode: "off",
      minutes: null,
      endSentenceIdx: null,
    });
    closeToolbarPopovers();
    syncToolbar();
  });
}
