import { invoke } from "../../src/tauri_bridge";
import { Icons } from "../../src/icons";
import { formatDuration, notify, persistSettings, state } from "../../src/state";
import type { ActiveModal, SleepTimerStatus } from "../../src/types";

export interface MobileChromeHandlers {
  onOpenModal: (modal: ActiveModal) => void;
  onTogglePlay: () => void;
  onStep: (delta: number) => void;
  onSeekSentence: (idx: number) => void;
  onZoomStep: (delta: number) => void;
  onZoomReset: () => void;
  onTogglePdfInvert: () => void;
  onTogglePdfReflow: (enabled: boolean) => void;
  onCcSizeStep: (delta: number) => void;
  onCcSizeReset: () => void;
  onToggleSearch: () => void;
  onToggleMarginsEdit: () => void;
  onAddBookmark: () => void;
  onTypographyChanged: () => void;
  onLayoutChanged: () => void;
  onToast?: (msg: string) => void;
}

interface MobileHosts {
  topbarHost: HTMLElement;
  dockHost: HTMLElement;
  drawerBackdrop: HTMLElement;
  sheetHost: HTMLElement;
  ccHost: HTMLElement;
  sidebarHost: HTMLElement;
}

let hostsRef: MobileHosts | null = null;
let handlersRef: MobileChromeHandlers | null = null;
let resizeObserver: ResizeObserver | null = null;
let mountedSheet: null | "quick" | "speed" | "sleep" = null;
let quickSheetStructureKey = "";
let mountedDockMode: null | "collapsed" | "expanded" = null;
let dockScrubbing = false;

export function attachSheetSwipeToDismiss(
  sheetEl: HTMLElement,
  backdropEl: HTMLElement | null,
  onDismiss: () => void,
): void {
  let tracking = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let currentDy = 0;
  let prevY = 0;
  let prevTs = 0;
  let lastY = 0;
  let lastTs = 0;
  let pointerId = -1;
  let mode: "touch" | "mouse" | null = null;

  const bodyEl = sheetEl.querySelector<HTMLElement>(".modal-body");

  const isInteractiveTarget = (target: EventTarget | null): boolean => {
    const el = target instanceof HTMLElement ? target : null;
    return Boolean(el?.closest("button, a, input, select, textarea, label"));
  };

  const canStartFrom = (target: EventTarget | null, viaTouchBody = false): "immediate" | "body" | null => {
    const el = target instanceof HTMLElement ? target : null;
    if (!el || isInteractiveTarget(el)) return null;
    if (el.closest(".sheet-handle") || el.closest(".modal-header")) return "immediate";
    if (viaTouchBody && bodyEl && bodyEl.contains(el) && bodyEl.scrollTop <= 1) return "body";
    return null;
  };

  const applyTransform = (dy: number) => {
    currentDy = Math.max(0, dy);
    sheetEl.style.transition = "none";
    sheetEl.style.transform = `translateY(${currentDy}px)`;
    if (backdropEl) {
      const h = Math.max(240, sheetEl.offsetHeight || 360);
      const frac = Math.max(0, 1 - currentDy / (h * 1.15));
      backdropEl.style.background = `rgba(0, 0, 0, ${(0.55 * frac).toFixed(3)})`;
    }
  };

  const beginDrag = (x: number, y: number, immediate: boolean) => {
    tracking = true;
    dragging = immediate;
    startX = x;
    startY = y;
    currentDy = 0;
    prevY = y;
    lastY = y;
    prevTs = performance.now();
    lastTs = prevTs;
    if (immediate) applyTransform(0);
  };

  const updateDrag = (x: number, y: number): boolean => {
    if (!tracking) return false;
    const dx = x - startX;
    const dy = y - startY;
    if (!dragging) {
      if (dy > 8 && Math.abs(dy) > Math.abs(dx) * 1.15) {
        dragging = true;
        startY = y - Math.max(0, dy - 8);
        applyTransform(0);
      } else if (Math.abs(dx) > 10 && Math.abs(dx) >= Math.abs(dy)) {
        tracking = false;
        mode = null;
        return false;
      } else {
        return false;
      }
    }
    const now = performance.now();
    if (now - lastTs >= 16) {
      prevY = lastY;
      prevTs = lastTs;
      lastY = y;
      lastTs = now;
    }
    applyTransform(Math.max(0, y - startY));
    return true;
  };

  const finishDrag = (cancelled = false) => {
    if (!tracking) return;
    const wasDragging = dragging;
    const dy = currentDy;
    tracking = false;
    dragging = false;
    mode = null;
    pointerId = -1;
    if (!wasDragging) return;

    const now = performance.now();
    const dt = Math.max(16, (lastTs > prevTs ? lastTs : now) - prevTs);
    const vel = (lastY - prevY) / dt;
    const threshold = Math.min(110, Math.max(68, (sheetEl.offsetHeight || 360) * 0.25));

    if (!cancelled && (dy > threshold || (dy > 24 && vel > 0.45))) {
      sheetEl.style.transition = "transform 160ms ease-out";
      sheetEl.style.transform = "translateY(100%)";
      if (backdropEl) {
        backdropEl.style.transition = "background 160ms ease-out";
        backdropEl.style.background = "rgba(0, 0, 0, 0)";
      }
      window.setTimeout(onDismiss, 160);
    } else {
      sheetEl.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
      sheetEl.style.transform = "translateY(0px)";
      if (backdropEl) {
        backdropEl.style.transition = "background 180ms ease-out";
        backdropEl.style.background = "";
      }
      window.setTimeout(() => {
        sheetEl.style.transition = "";
        sheetEl.style.transform = "";
        if (backdropEl) backdropEl.style.transition = "";
      }, 185);
    }
  };

  sheetEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1 || mode !== null) return;
      const startZone = canStartFrom(e.target, true);
      if (!startZone) return;
      mode = "touch";
      beginDrag(e.touches[0].clientX, e.touches[0].clientY, startZone === "immediate");
    },
    { passive: true },
  );

  sheetEl.addEventListener(
    "touchmove",
    (e) => {
      if (mode !== "touch" || !tracking || e.touches.length !== 1) return;
      if (bodyEl && dragging === false && bodyEl.scrollTop > 1) {
        tracking = false;
        mode = null;
        return;
      }
      const consumed = updateDrag(e.touches[0].clientX, e.touches[0].clientY);
      if (consumed && e.cancelable) {
        e.preventDefault();
      }
    },
    { passive: false },
  );

  sheetEl.addEventListener("touchend", () => {
    if (mode === "touch") finishDrag(false);
  });
  sheetEl.addEventListener("touchcancel", () => {
    if (mode === "touch") finishDrag(true);
  });

  sheetEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0 || mode !== null) return;
    const startZone = canStartFrom(e.target, false);
    if (!startZone) return;
    mode = "mouse";
    pointerId = e.pointerId;
    beginDrag(e.clientX, e.clientY, true);
    try {
      sheetEl.setPointerCapture(e.pointerId);
    } catch {
    }
  });

  sheetEl.addEventListener("pointermove", (e) => {
    if (mode !== "mouse" || e.pointerId !== pointerId) return;
    updateDrag(e.clientX, e.clientY);
  });

  const endMouse = (e: PointerEvent) => {
    if (mode !== "mouse" || e.pointerId !== pointerId) return;
    try {
      if (sheetEl.hasPointerCapture(e.pointerId)) sheetEl.releasePointerCapture(e.pointerId);
    } catch {
    }
    finishDrag(e.type === "pointercancel");
  };
  sheetEl.addEventListener("pointerup", endMouse);
  sheetEl.addEventListener("pointercancel", endMouse);
}

export function closeAllMobileOverlays(): boolean {
  let closed = false;
  if (state.quickReaderSheetOpen) {
    state.quickReaderSheetOpen = false;
    closed = true;
  }
  if (state.mobilePopoverSheet !== null) {
    state.mobilePopoverSheet = null;
    closed = true;
  }
  if (state.mobileDrawerOpen) {
    state.mobileDrawerOpen = false;
    closed = true;
  }
  if (closed) {
    syncMobileChrome();
    notify();
  }
  return closed;
}

export function initMobileChrome(hosts: MobileHosts, handlers: MobileChromeHandlers): void {
  hostsRef = hosts;
  handlersRef = handlers;

  hosts.drawerBackdrop.addEventListener("click", () => {
    state.mobileDrawerOpen = false;
    syncMobileChrome();
    notify();
  });

  if (!resizeObserver) {
    resizeObserver = new ResizeObserver(() => {
      syncBottomInsets();
    });
    resizeObserver.observe(hosts.dockHost);
    resizeObserver.observe(hosts.ccHost);
  }

  window.addEventListener("resize", syncBottomInsets);
  syncMobileChrome();
}

export function syncBottomInsets(): void {
  if (!hostsRef) return;
  const docStyle = document.documentElement.style;
  docStyle.setProperty("--mobile-cc-size", `${state.settings.typography.cc_font_size}px`);

  const dockEl = hostsRef.dockHost.querySelector<HTMLElement>(".mobile-player-dock");
  const dockHeight = dockEl ? Math.round(dockEl.getBoundingClientRect().height) : 0;
  const ccEl = hostsRef.ccHost;
  const ccVisible = state.settings.cc_enabled && !ccEl.classList.contains("hidden");
  const ccHeight = ccVisible ? Math.round(ccEl.getBoundingClientRect().height) : 0;

  docStyle.setProperty("--dock-height", `${dockHeight}px`);
  docStyle.setProperty("--cc-height", `${ccHeight}px`);

  handlersRef?.onLayoutChanged();
}

export function syncMobileChrome(): void {
  if (!hostsRef || !handlersRef) return;
  const { topbarHost, dockHost, drawerBackdrop, sheetHost, sidebarHost } = hostsRef;

  drawerBackdrop.classList.toggle("visible", state.mobileDrawerOpen);
  sidebarHost.classList.toggle("drawer-open", state.mobileDrawerOpen);

  renderMobileTopbar(topbarHost, handlersRef);
  renderMobileDock(dockHost, handlersRef);
  renderMobileSheet(sheetHost, handlersRef);
  syncBottomInsets();
}

function renderMobileTopbar(container: HTMLElement, handlers: MobileChromeHandlers): void {
  const hasBook = state.activeBook !== null;
  const title = state.activeBook ? state.activeBook.title : "BookReader";

  container.innerHTML = `
    <div class="mobile-topbar">
      <button class="icon-btn" id="m-btn-drawer" aria-label="Open menu">${Icons.menu()}</button>
      <button class="mobile-book-title-btn" id="m-btn-title" title="${escapeAttr(title)}">
        <span class="mobile-book-title-text">${escapeHtml(title)}</span>
      </button>
      <button class="icon-btn ${state.searchOpen ? "active" : ""}" id="m-btn-search" aria-label="Search" ${hasBook ? "" : "disabled"}>
        ${Icons.search()}
      </button>
      <button class="icon-btn ${state.quickReaderSheetOpen ? "active" : ""}" id="m-btn-quick-reader" aria-label="Reader settings">
        ${Icons.textAa()}
      </button>
    </div>
  `;

  container.querySelector("#m-btn-drawer")?.addEventListener("click", () => {
    state.mobileDrawerOpen = !state.mobileDrawerOpen;
    syncMobileChrome();
    notify();
  });

  container.querySelector("#m-btn-title")?.addEventListener("click", () => {
    handlers.onOpenModal(hasBook ? "toc" : "library");
  });

  container.querySelector("#m-btn-search")?.addEventListener("click", handlers.onToggleSearch);

  container.querySelector("#m-btn-quick-reader")?.addEventListener("click", () => {
    state.mobilePopoverSheet = null;
    state.quickReaderSheetOpen = !state.quickReaderSheetOpen;
    syncMobileChrome();
  });
}

function renderMobileDock(container: HTMLElement, handlers: MobileChromeHandlers): void {
  const isPlaying = state.tts.status === "playing" || state.tts.status === "loading";
  const hasBook = state.activeBook !== null;

  if (state.mobileDockCollapsed) {
    if (mountedDockMode === "collapsed" && container.querySelector(".mobile-dock-pill")) {
      const pillPlay = container.querySelector<HTMLButtonElement>("#m-pill-play");
      if (pillPlay) {
        pillPlay.disabled = !hasBook;
        pillPlay.innerHTML = isPlaying ? Icons.pause(16) : Icons.play(16);
      }
      return;
    }
    mountedDockMode = "collapsed";
    dockScrubbing = false;
    container.innerHTML = `
      <div class="mobile-dock-pill">
        <button class="play-btn" id="m-pill-play" aria-label="Play or Pause" ${hasBook ? "" : "disabled"}>
          ${isPlaying ? Icons.pause(16) : Icons.play(16)}
        </button>
        <button class="icon-btn" id="m-pill-expand" aria-label="Expand player controls" title="Expand player">
          ${Icons.chevronUp()}
        </button>
      </div>
    `;

    container.querySelector("#m-pill-play")?.addEventListener("click", handlers.onTogglePlay);
    container.querySelector("#m-pill-expand")?.addEventListener("click", () => {
      state.mobileDockCollapsed = false;
      syncMobileChrome();
    });
    return;
  }

  const activeVoice =
    state.voices.find((v) => v.voice_id === state.settings.voice_id)?.name ?? "Default";
  const total = Math.max(1, state.sentences.length);
  const curIdx = Math.min(state.tts.sentence_idx, total - 1);
  const progressPct = state.sentences.length > 0 ? ((curIdx + 1) / state.sentences.length) * 100 : 0;
  const counterText = state.sentences.length > 0 ? `${curIdx + 1} / ${state.sentences.length}` : "—";

  if (mountedDockMode === "expanded" && container.querySelector("#m-progress-track")) {
    if (!dockScrubbing) {
      const fill = container.querySelector<HTMLElement>("#m-progress-track .progress-fill");
      if (fill) fill.style.width = `${progressPct.toFixed(2)}%`;
    }
    const elapsedEl = container.querySelector<HTMLElement>("#m-time-elapsed");
    const counterEl = container.querySelector<HTMLElement>("#m-time-counter");
    const remEl = container.querySelector<HTMLElement>("#m-time-remaining");
    if (elapsedEl) elapsedEl.textContent = formatDuration(state.tts.elapsed_est_sec);
    if (counterEl) counterEl.textContent = counterText;
    if (remEl) remEl.textContent = `-${formatDuration(state.tts.remaining_est_sec)}`;

    const voiceSpan = container.querySelector<HTMLElement>("#m-btn-voice span");
    if (voiceSpan) voiceSpan.textContent = activeVoice;

    const prevBtn = container.querySelector<HTMLButtonElement>("#m-btn-prev");
    const playBtn = container.querySelector<HTMLButtonElement>("#m-btn-play");
    const nextBtn = container.querySelector<HTMLButtonElement>("#m-btn-next");
    if (prevBtn) prevBtn.disabled = !hasBook;
    if (nextBtn) nextBtn.disabled = !hasBook;
    if (playBtn) {
      playBtn.disabled = !hasBook;
      playBtn.innerHTML = isPlaying ? Icons.pause(18) : Icons.play(18);
    }
    const speedBtn = container.querySelector<HTMLButtonElement>("#m-btn-speed");
    if (speedBtn) speedBtn.textContent = `${state.settings.speed.toFixed(2)}x`;
    return;
  }

  mountedDockMode = "expanded";
  dockScrubbing = false;
  container.innerHTML = `
    <div class="mobile-player-dock">
      <div class="mobile-scrub-hit" id="m-progress-track" title="Seek position">
        <div class="progress-track">
          <div class="progress-fill" style="width:${progressPct.toFixed(2)}%"></div>
        </div>
      </div>
      <div class="mobile-time-row">
        <span id="m-time-elapsed">${formatDuration(state.tts.elapsed_est_sec)}</span>
        <span id="m-time-counter">${counterText}</span>
        <span id="m-time-remaining">-${formatDuration(state.tts.remaining_est_sec)}</span>
      </div>
      <div class="mobile-dock-controls">
        <button class="mobile-voice-pill" id="m-btn-voice" title="Select voice">
          ${Icons.voice()}
          <span>${escapeHtml(activeVoice)}</span>
        </button>
        <div class="mobile-transport">
          <button class="icon-btn" id="m-btn-prev" aria-label="Previous sentence" ${hasBook ? "" : "disabled"}>
            ${Icons.prevSentence()}
          </button>
          <button class="play-btn" id="m-btn-play" aria-label="Play or Pause" ${hasBook ? "" : "disabled"}>
            ${isPlaying ? Icons.pause(18) : Icons.play(18)}
          </button>
          <button class="icon-btn" id="m-btn-next" aria-label="Next sentence" ${hasBook ? "" : "disabled"}>
            ${Icons.nextSentence()}
          </button>
        </div>
        <div class="mobile-dock-right">
          <button class="speed-pill" id="m-btn-speed" aria-label="Playback speed">${state.settings.speed.toFixed(2)}x</button>
          <button class="icon-btn" id="m-btn-dock-collapse" aria-label="Collapse player controls" title="Minimize player">
            ${Icons.chevronDown()}
          </button>
        </div>
      </div>
    </div>
  `;

  const scrubTrack = container.querySelector<HTMLElement>("#m-progress-track");
  if (scrubTrack) {
    const seekFromClientX = (clientX: number, commit: boolean) => {
      if (state.sentences.length === 0) return;
      const rect = scrubTrack.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const fill = scrubTrack.querySelector<HTMLElement>(".progress-fill");
      if (fill) fill.style.width = `${(frac * 100).toFixed(2)}%`;
      if (commit) {
        const idx = Math.floor(frac * (state.sentences.length - 1));
        handlers.onSeekSentence(idx);
      }
    };
    scrubTrack.addEventListener("pointerdown", (e) => {
      if (state.sentences.length === 0) return;
      e.preventDefault();
      dockScrubbing = true;
      scrubTrack.setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX, false);
    });
    scrubTrack.addEventListener("pointermove", (e) => {
      if (!dockScrubbing) return;
      seekFromClientX(e.clientX, false);
    });
    const finishScrub = (e: PointerEvent) => {
      if (!dockScrubbing) return;
      dockScrubbing = false;
      if (scrubTrack.hasPointerCapture(e.pointerId)) {
        scrubTrack.releasePointerCapture(e.pointerId);
      }
      seekFromClientX(e.clientX, true);
    };
    scrubTrack.addEventListener("pointerup", finishScrub);
    scrubTrack.addEventListener("pointercancel", finishScrub);
  }

  container.querySelector("#m-btn-voice")?.addEventListener("click", () => {
    state.quickReaderSheetOpen = false;
    state.mobilePopoverSheet = null;
    handlers.onOpenModal("voices");
  });
  container.querySelector("#m-btn-prev")?.addEventListener("click", () => handlers.onStep(-1));
  container.querySelector("#m-btn-play")?.addEventListener("click", handlers.onTogglePlay);
  container.querySelector("#m-btn-next")?.addEventListener("click", () => handlers.onStep(1));
  container.querySelector("#m-btn-speed")?.addEventListener("click", () => {
    state.quickReaderSheetOpen = false;
    state.mobilePopoverSheet = state.mobilePopoverSheet === "speed" ? null : "speed";
    syncMobileChrome();
  });
  container.querySelector("#m-btn-dock-collapse")?.addEventListener("click", () => {
    state.mobileDockCollapsed = true;
    syncMobileChrome();
  });
}

function renderMobileSheet(container: HTMLElement, handlers: MobileChromeHandlers): void {
  if (state.activeModal !== null) {
    if (container.innerHTML !== "") container.innerHTML = "";
    mountedSheet = null;
    return;
  }

  if (state.quickReaderSheetOpen) {
    renderQuickReaderSheet(container, handlers);
    return;
  }
  if (state.mobilePopoverSheet === "speed") {
    renderSpeedSheet(container);
    return;
  }
  if (state.mobilePopoverSheet === "sleep") {
    renderSleepSheet(container);
    return;
  }
  if (container.innerHTML !== "") {
    container.innerHTML = "";
  }
  mountedSheet = null;
}

function renderQuickReaderSheet(container: HTMLElement, handlers: MobileChromeHandlers): void {
  const s = state.settings;
  const typ = s.typography;
  const hasBook = state.activeBook !== null;
  const isPdf = state.activeBook?.format === "pdf";
  const zoomFactor = isPdf ? typ.pdf_zoom : typ.reader_zoom;
  const sleepLabel =
    state.sleepTimer.active && state.sleepTimer.mode === "minutes" && state.sleepTimer.remaining_sec !== null
      ? `Sleep (${Math.ceil(state.sleepTimer.remaining_sec / 60)}m)`
      : state.sleepTimer.active && state.sleepTimer.mode === "end_of_chapter"
        ? "Sleep (Ch)"
        : "Sleep Timer";

  const nextStructureKey = `${isPdf}|${s.theme === "dark"}|${s.pdf_reflow}`;
  if (
    mountedSheet === "quick" &&
    quickSheetStructureKey === nextStructureKey &&
    container.querySelector("#m-sheet-backdrop")
  ) {
    container.querySelector("#m-theme-dark")?.classList.toggle("active", s.theme === "dark");
    container.querySelector("#m-theme-light")?.classList.toggle("active", s.theme === "light");
    container.querySelector("#m-pdf-mode-original")?.classList.toggle("active", !s.pdf_reflow);
    container.querySelector("#m-pdf-mode-reflow")?.classList.toggle("active", s.pdf_reflow);

    const zoomReset = container.querySelector<HTMLButtonElement>("#m-zoom-reset");
    if (zoomReset) {
      zoomReset.textContent = `${Math.round(zoomFactor * 100)}%`;
      zoomReset.disabled = !hasBook;
    }
    const zoomOut = container.querySelector<HTMLButtonElement>("#m-zoom-out");
    const zoomIn = container.querySelector<HTMLButtonElement>("#m-zoom-in");
    if (zoomOut) zoomOut.disabled = !hasBook;
    if (zoomIn) zoomIn.disabled = !hasBook;

    const fontSlider = container.querySelector<HTMLInputElement>("#m-font-size");
    const fontLbl = container.querySelector<HTMLElement>("#m-font-size-val");
    if (fontSlider && document.activeElement !== fontSlider) {
      fontSlider.value = String(typ.font_size);
    }
    if (fontLbl) fontLbl.textContent = `${typ.font_size} px`;

    const lhSlider = container.querySelector<HTMLInputElement>("#m-line-height");
    const lhLbl = container.querySelector<HTMLElement>("#m-line-height-val");
    if (lhSlider && document.activeElement !== lhSlider) {
      lhSlider.value = String(typ.line_height);
    }
    if (lhLbl) lhLbl.textContent = typ.line_height.toFixed(2);

    const ccToggle = container.querySelector<HTMLButtonElement>("#m-cc-toggle");
    if (ccToggle) {
      ccToggle.classList.toggle("active", s.cc_enabled);
      const span = ccToggle.querySelector("span");
      if (span) span.textContent = s.cc_enabled ? "On" : "Off";
    }
    const ccSmaller = container.querySelector<HTMLButtonElement>("#m-cc-smaller");
    const ccReset = container.querySelector<HTMLButtonElement>("#m-cc-reset");
    const ccLarger = container.querySelector<HTMLButtonElement>("#m-cc-larger");
    if (ccSmaller) ccSmaller.disabled = !s.cc_enabled;
    if (ccLarger) ccLarger.disabled = !s.cc_enabled;
    if (ccReset) {
      ccReset.disabled = !s.cc_enabled;
      ccReset.textContent = `${typ.cc_font_size}px`;
    }

    const sleepBtn = container.querySelector<HTMLButtonElement>("#m-open-sleep");
    if (sleepBtn) {
      sleepBtn.classList.toggle("active", state.sleepTimer.active);
      const span = sleepBtn.querySelector("span");
      if (span) span.textContent = sleepLabel;
    }

    const pdfInv = container.querySelector<HTMLButtonElement>("#m-pdf-invert");
    if (pdfInv) pdfInv.classList.toggle("active", s.pdf_invert_dark);
    const pdfMargins = container.querySelector<HTMLButtonElement>("#m-pdf-margins");
    if (pdfMargins) pdfMargins.classList.toggle("active", state.pdfMarginsEditing);
    return;
  }

  mountedSheet = "quick";
  quickSheetStructureKey = nextStructureKey;
  container.innerHTML = `
    <div class="modal-backdrop" id="m-sheet-backdrop">
      <div class="modal-card mobile-sheet" role="dialog" aria-label="Quick Reader Controls">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <span class="modal-title">Reader Appearance &amp; Tools</span>
          <button class="icon-btn" id="m-sheet-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div class="qr-two-col">
            <button type="button" class="qr-pill-btn ${s.theme === "dark" ? "active" : ""}" id="m-theme-dark">
              ${Icons.moon()}<span>Dark Theme</span>
            </button>
            <button type="button" class="qr-pill-btn ${s.theme === "light" ? "active" : ""}" id="m-theme-light">
              ${Icons.sun()}<span>Light Theme</span>
            </button>
          </div>

          <div class="qr-section">
            ${
              isPdf
                ? `
              <div class="qr-two-col">
                <button type="button" class="qr-pill-btn ${!s.pdf_reflow ? "active" : ""}" id="m-pdf-mode-original">Original Page</button>
                <button type="button" class="qr-pill-btn ${s.pdf_reflow ? "active" : ""}" id="m-pdf-mode-reflow">Reflow Text</button>
              </div>
            `
                : ""
            }
            <div class="qr-seg-row">
              <span style="font-size:13px;font-weight:500;">Page Zoom</span>
              <div class="qr-stepper">
                <button type="button" id="m-zoom-out" ${hasBook ? "" : "disabled"}>${Icons.zoomOut()}</button>
                <button type="button" class="qr-step-val" id="m-zoom-reset" ${hasBook ? "" : "disabled"}>${Math.round(zoomFactor * 100)}%</button>
                <button type="button" id="m-zoom-in" ${hasBook ? "" : "disabled"}>${Icons.zoomIn()}</button>
              </div>
            </div>

            ${
              !isPdf || s.pdf_reflow
                ? `
              <div class="setting-row">
                <span>Font Size — <strong id="m-font-size-val">${typ.font_size} px</strong></span>
                <input type="range" id="m-font-size" min="13" max="30" step="1" value="${typ.font_size}"/>
              </div>
              <div class="setting-row">
                <span>Line Height — <strong id="m-line-height-val">${typ.line_height.toFixed(2)}</strong></span>
                <input type="range" id="m-line-height" min="1.3" max="2.3" step="0.05" value="${typ.line_height}"/>
              </div>
            `
                : ""
            }
          </div>

          <div class="qr-section">
            <div class="qr-seg-row">
              <span style="font-size:13px;font-weight:500;">Closed Captions (CC)</span>
              <button type="button" class="qr-pill-btn ${s.cc_enabled ? "active" : ""}" id="m-cc-toggle" style="min-height:38px;padding:4px 14px;">
                ${Icons.cc()}<span>${s.cc_enabled ? "On" : "Off"}</span>
              </button>
            </div>
            <div class="qr-seg-row">
              <span style="font-size:13px;color:var(--text-secondary);">Caption Size</span>
              <div class="qr-stepper">
                <button type="button" id="m-cc-smaller" ${s.cc_enabled ? "" : "disabled"}>A-</button>
                <button type="button" class="qr-step-val" id="m-cc-reset" ${s.cc_enabled ? "" : "disabled"}>${typ.cc_font_size}px</button>
                <button type="button" id="m-cc-larger" ${s.cc_enabled ? "" : "disabled"}>A+</button>
              </div>
            </div>
          </div>

          <div class="qr-two-col">
            <button type="button" class="qr-pill-btn" id="m-add-bookmark" ${hasBook ? "" : "disabled"}>
              ${Icons.bookmark(false)}<span>Bookmark Here</span>
            </button>
            <button type="button" class="qr-pill-btn ${state.sleepTimer.active ? "active" : ""}" id="m-open-sleep">
              ${Icons.sleepTimer()}<span>${sleepLabel}</span>
            </button>
          </div>

          ${
            isPdf
              ? `
            <div class="qr-two-col">
              ${
                !s.pdf_reflow && s.theme === "dark"
                  ? `<button type="button" class="qr-pill-btn ${s.pdf_invert_dark ? "active" : ""}" id="m-pdf-invert">Dark PDF Page</button>`
                  : `<div></div>`
              }
              <button type="button" class="qr-pill-btn ${state.pdfMarginsEditing ? "active" : ""}" id="m-pdf-margins">
                ${Icons.margins()}<span>Ignore Margins</span>
              </button>
            </div>
          `
              : ""
          }
        </div>
      </div>
    </div>
  `;

  const close = () => {
    state.quickReaderSheetOpen = false;
    syncMobileChrome();
  };

  const sheetCard = container.querySelector<HTMLElement>(".mobile-sheet");
  const backdropEl = container.querySelector<HTMLElement>("#m-sheet-backdrop");
  if (sheetCard) {
    attachSheetSwipeToDismiss(sheetCard, backdropEl, close);
  }
  backdropEl?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  container.querySelector("#m-sheet-close")?.addEventListener("click", close);

  container.querySelector("#m-theme-dark")?.addEventListener("click", () => {
    void persistSettings({ theme: "dark" });
  });
  container.querySelector("#m-theme-light")?.addEventListener("click", () => {
    void persistSettings({ theme: "light" });
  });

  container.querySelector("#m-zoom-out")?.addEventListener("click", () => handlers.onZoomStep(-0.1));
  container.querySelector("#m-zoom-reset")?.addEventListener("click", handlers.onZoomReset);
  container.querySelector("#m-zoom-in")?.addEventListener("click", () => handlers.onZoomStep(0.1));

  const fontInput = container.querySelector<HTMLInputElement>("#m-font-size");
  fontInput?.addEventListener("input", () => {
    const v = Math.round(parseFloat(fontInput.value));
    const lbl = container.querySelector<HTMLElement>("#m-font-size-val");
    if (lbl) lbl.textContent = `${v} px`;
    state.settings = { ...state.settings, typography: { ...state.settings.typography, font_size: v } };
    handlers.onTypographyChanged();
  });
  fontInput?.addEventListener("change", () => {
    const v = Math.round(parseFloat(fontInput.value));
    void persistSettings({ typography: { ...state.settings.typography, font_size: v } }).then(() => {
      handlers.onTypographyChanged();
    });
  });

  const lhInput = container.querySelector<HTMLInputElement>("#m-line-height");
  lhInput?.addEventListener("input", () => {
    const v = parseFloat(lhInput.value);
    const lbl = container.querySelector<HTMLElement>("#m-line-height-val");
    if (lbl) lbl.textContent = v.toFixed(2);
    state.settings = { ...state.settings, typography: { ...state.settings.typography, line_height: v } };
    handlers.onTypographyChanged();
  });
  lhInput?.addEventListener("change", () => {
    const v = parseFloat(lhInput.value);
    void persistSettings({ typography: { ...state.settings.typography, line_height: v } }).then(() => {
      handlers.onTypographyChanged();
    });
  });

  container.querySelector("#m-cc-toggle")?.addEventListener("click", () => {
    void persistSettings({ cc_enabled: !state.settings.cc_enabled });
  });
  container.querySelector("#m-cc-smaller")?.addEventListener("click", () => handlers.onCcSizeStep(-2));
  container.querySelector("#m-cc-reset")?.addEventListener("click", handlers.onCcSizeReset);
  container.querySelector("#m-cc-larger")?.addEventListener("click", () => handlers.onCcSizeStep(2));

  container.querySelector("#m-add-bookmark")?.addEventListener("click", () => {
    handlers.onAddBookmark();
    close();
  });
  container.querySelector("#m-open-sleep")?.addEventListener("click", () => {
    state.quickReaderSheetOpen = false;
    state.mobilePopoverSheet = "sleep";
    syncMobileChrome();
  });
  container.querySelector("#m-pdf-invert")?.addEventListener("click", handlers.onTogglePdfInvert);
  container.querySelector("#m-pdf-mode-original")?.addEventListener("click", () => handlers.onTogglePdfReflow(false));
  container.querySelector("#m-pdf-mode-reflow")?.addEventListener("click", () => handlers.onTogglePdfReflow(true));
  container.querySelector("#m-pdf-margins")?.addEventListener("click", () => {
    handlers.onToggleMarginsEdit();
    close();
  });
}

function syncSpeedSheetInPlace(container: HTMLElement, speed: number): void {
  const lbl = container.querySelector<HTMLElement>("#m-speed-val");
  if (lbl) lbl.textContent = `${speed.toFixed(2)}x`;
  const slider = container.querySelector<HTMLInputElement>("#m-speed-slider");
  if (slider && document.activeElement !== slider) {
    slider.value = String(speed);
  }
  container.querySelectorAll<HTMLButtonElement>("[data-mspeed]").forEach((btn) => {
    const p = parseFloat(btn.dataset.mspeed || "1.0");
    btn.classList.toggle("active", Math.abs(speed - p) < 0.015);
  });
}

function renderSpeedSheet(container: HTMLElement): void {
  if (mountedSheet === "speed" && container.querySelector("#m-speed-slider")) {
    syncSpeedSheetInPlace(container, state.settings.speed);
    return;
  }

  mountedSheet = "speed";
  const presets = [0.75, 1.0, 1.25, 1.38, 1.5, 2.0];
  container.innerHTML = `
    <div class="modal-backdrop" id="m-sheet-backdrop">
      <div class="modal-card mobile-sheet" role="dialog" aria-label="Reading Speed">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <span class="modal-title">Reading Speed</span>
          <div style="display:flex;align-items:center;gap:10px;">
            <strong id="m-speed-val">${state.settings.speed.toFixed(2)}x</strong>
            <button class="icon-btn" id="m-sheet-close" aria-label="Close">${Icons.close()}</button>
          </div>
        </div>
        <div class="modal-body">
          <input type="range" id="m-speed-slider" min="0.5" max="3.0" step="0.02" value="${state.settings.speed}" style="width:100%;height:38px;" />
          <div class="chip-row">
            ${presets
              .map(
                (p) =>
                  `<button class="chip ${Math.abs(state.settings.speed - p) < 0.015 ? "active" : ""}" data-mspeed="${p}">${p}x</button>`,
              )
              .join("")}
          </div>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    state.mobilePopoverSheet = null;
    syncMobileChrome();
  };
  const sheetCard = container.querySelector<HTMLElement>(".mobile-sheet");
  const backdropEl = container.querySelector<HTMLElement>("#m-sheet-backdrop");
  if (sheetCard) {
    attachSheetSwipeToDismiss(sheetCard, backdropEl, close);
  }
  backdropEl?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  container.querySelector("#m-sheet-close")?.addEventListener("click", close);

  const slider = container.querySelector<HTMLInputElement>("#m-speed-slider");
  slider?.addEventListener("input", () => {
    const val = parseFloat(slider.value);
    syncSpeedSheetInPlace(container, val);
    void persistSettings({ speed: val });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-mspeed]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = parseFloat(btn.dataset.mspeed || "1.0");
      void persistSettings({ speed: val });
      close();
    });
  });
}

function renderSleepSheet(container: HTMLElement): void {
  if (mountedSheet === "sleep" && container.querySelector("#m-sheet-backdrop")) {
    const offBtn = container.querySelector<HTMLButtonElement>("[data-msleep-off]");
    if (offBtn) offBtn.style.display = state.sleepTimer.active ? "" : "none";
    return;
  }

  mountedSheet = "sleep";
  container.innerHTML = `
    <div class="modal-backdrop" id="m-sheet-backdrop">
      <div class="modal-card mobile-sheet" role="dialog" aria-label="Sleep Timer">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <span class="modal-title">Sleep Timer</span>
          <button class="icon-btn" id="m-sheet-close">${Icons.close()}</button>
        </div>
        <div class="modal-body">
          <div class="chip-row" style="margin-top:0;">
            <button class="chip" data-msleep-min="15">15 min</button>
            <button class="chip" data-msleep-min="30">30 min</button>
            <button class="chip" data-msleep-min="60">60 min</button>
            <button class="chip" data-msleep-chap="1">End of Chapter</button>
            <button class="chip" data-msleep-off="1" style="${state.sleepTimer.active ? "" : "display:none"}">Turn Off</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const close = () => {
    state.mobilePopoverSheet = null;
    syncMobileChrome();
  };
  const sheetCard = container.querySelector<HTMLElement>(".mobile-sheet");
  const backdropEl = container.querySelector<HTMLElement>("#m-sheet-backdrop");
  if (sheetCard) {
    attachSheetSwipeToDismiss(sheetCard, backdropEl, close);
  }
  backdropEl?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) close();
  });
  container.querySelector("#m-sheet-close")?.addEventListener("click", close);

  container.querySelectorAll<HTMLButtonElement>("[data-msleep-min]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mins = parseInt(btn.dataset.msleepMin || "15", 10);
      try {
        state.sleepTimer = await invoke<SleepTimerStatus>("set_sleep_timer", {
          mode: "minutes",
          minutes: mins,
          endSentenceIdx: null,
        });
        close();
      } catch (err) {
        handlersRef?.onToast?.(`Sleep timer failed: ${String(err)}`);
      }
    });
  });

  container.querySelector("[data-msleep-chap]")?.addEventListener("click", async () => {
    const cur = state.tts.sentence_idx;
    const nextChap = state.toc.find((t) => t.sentence_idx > cur);
    const endSentenceIdx = nextChap ? nextChap.sentence_idx : Math.max(0, state.sentences.length - 1);
    try {
      state.sleepTimer = await invoke<SleepTimerStatus>("set_sleep_timer", {
        mode: "end_of_chapter",
        minutes: null,
        endSentenceIdx,
      });
      close();
    } catch (err) {
      handlersRef?.onToast?.(`Sleep timer failed: ${String(err)}`);
    }
  });

  container.querySelector("[data-msleep-off]")?.addEventListener("click", async () => {
    try {
      state.sleepTimer = await invoke<SleepTimerStatus>("set_sleep_timer", {
        mode: "off",
        minutes: null,
        endSentenceIdx: null,
      });
      close();
    } catch (err) {
      handlersRef?.onToast?.(`Sleep timer failed: ${String(err)}`);
    }
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str: string): string {
  return escapeHtml(str);
}
