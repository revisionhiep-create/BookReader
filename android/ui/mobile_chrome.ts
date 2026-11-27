import { type AppLanguage, getActiveUiLanguage, tr } from "../../src/i18n";
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
let mountedSheetLang: AppLanguage | null = null;
let quickSheetStructureKey = "";
let mountedDockMode: null | "collapsed" | "expanded" = null;
let mountedDockLang: AppLanguage | null = null;
let dockScrubbing = false;

let lastDrawerOpenState = false;
let drawerDragMode: "touch" | "mouse" | null = null;
let drawerCloseTimer: number | null = null;
let drawerSnapTimer: number | null = null;

const DRAG_EXCLUDED_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-no-swipe-dismiss]';

function isDragExcludedTarget(target: EventTarget | null): boolean {
  return Boolean(target instanceof Element && target.closest(DRAG_EXCLUDED_SELECTOR));
}

function hasScrolledAncestor(target: EventTarget | null, stopAt: HTMLElement): boolean {
  let el: HTMLElement | null =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  while (el) {
    if (el.scrollHeight > el.clientHeight + 2 && el.scrollTop > 1) {
      return true;
    }
    if (el === stopAt) break;
    el = el.parentElement;
  }
  return false;
}

function suppressNextClick(): void {
  let timer = 0;
  const cleanup = () => {
    window.clearTimeout(timer);
    document.removeEventListener("click", clickHandler, true);
    document.removeEventListener("pointerdown", cleanup, true);
    document.removeEventListener("touchstart", cleanup, true);
  };
  const clickHandler = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    cleanup();
  };
  document.addEventListener("click", clickHandler, { capture: true });
  // Release immediately if the user begins a new tap/press before the timeout expires.
  document.addEventListener("pointerdown", cleanup, { capture: true });
  document.addEventListener("touchstart", cleanup, { capture: true, passive: true });
  timer = window.setTimeout(cleanup, 120);
}

function setSwipeDismissActive(active: boolean): void {
  if (active) {
    document.documentElement.dataset.swipeDismissActive = "1";
  } else {
    delete document.documentElement.dataset.swipeDismissActive;
  }
}

function isCompactOrMediumViewport(): boolean {
  return window.innerWidth < 840 || window.innerHeight <= 520;
}

interface VerticalSwipeTargets {
  card: HTMLElement;
  backdrop: HTMLElement | null;
}

interface VerticalSwipeOptions {
  gestureRoot: HTMLElement;
  resolveTargets: () => VerticalSwipeTargets | null;
  canDismiss?: () => boolean;
  onDismiss: () => void;
  slopPx?: number;
  slopeRatio?: number;
  minThresholdPx?: number;
  maxThresholdPx?: number;
  heightFrac?: number;
  allowImmediateHandle?: boolean;
}

function attachVerticalSwipeDismiss(opts: VerticalSwipeOptions): void {
  const {
    gestureRoot,
    resolveTargets,
    canDismiss,
    onDismiss,
    slopPx = 8,
    slopeRatio = 1.15,
    minThresholdPx = 68,
    maxThresholdPx = 110,
    heightFrac = 0.25,
    allowImmediateHandle = true,
  } = opts;

  const dismissingCards = new WeakSet<HTMLElement>();
  let tracking = false;
  let dragging = false;
  let movedBeyondSlop = false;
  let startX = 0;
  let startY = 0;
  let currentDy = 0;
  let prevY = 0;
  let prevTs = 0;
  let lastY = 0;
  let lastTs = 0;
  let pointerId = -1;
  let mode: "touch" | "mouse" | null = null;
  let startTarget: EventTarget | null = null;
  let activeCard: HTMLElement | null = null;
  let activeBackdrop: HTMLElement | null = null;
  let snapBackTimer: number | null = null;
  let snapBackCard: HTMLElement | null = null;
  let snapBackBackdrop: HTMLElement | null = null;

  const clearSnapBackTimer = () => {
    if (snapBackTimer !== null) {
      window.clearTimeout(snapBackTimer);
      snapBackTimer = null;
      if (snapBackCard) {
        snapBackCard.style.transition = "";
        snapBackCard.style.transform = "";
      }
      if (snapBackBackdrop) {
        snapBackBackdrop.style.transition = "";
        snapBackBackdrop.style.background = "";
      }
      snapBackCard = null;
      snapBackBackdrop = null;
    }
  };

  const resetTracking = () => {
    tracking = false;
    dragging = false;
    mode = null;
    pointerId = -1;
    startTarget = null;
    activeCard = null;
    activeBackdrop = null;
    setSwipeDismissActive(false);
  };

  const applyTransform = (card: HTMLElement, backdrop: HTMLElement | null, dy: number) => {
    currentDy = Math.max(0, dy);
    card.style.transition = "none";
    card.style.transform = `translateY(${currentDy}px)`;
    if (backdrop) {
      const h = Math.max(240, card.offsetHeight || 360);
      const frac = Math.max(0, 1 - currentDy / (h * 1.15));
      backdrop.style.transition = "none";
      backdrop.style.background = `rgba(0, 0, 0, ${(0.58 * frac).toFixed(3)})`;
    }
  };

  const canStartFrom = (
    target: EventTarget | null,
    card: HTMLElement,
    backdrop: HTMLElement | null,
  ): "immediate" | "slop" | null => {
    if (dismissingCards.has(card) || !card.isConnected) return null;
    if (canDismiss && !canDismiss()) return null;
    if (backdrop && target === backdrop) return "slop";
    if (!(target instanceof Node) || !card.contains(target)) return null;
    if (isDragExcludedTarget(target)) return null;
    if (allowImmediateHandle && target instanceof Element && target.closest(".sheet-handle")) {
      return "immediate";
    }
    if (hasScrolledAncestor(target, card)) return null;
    return "slop";
  };

  const beginDrag = (
    x: number,
    y: number,
    immediate: boolean,
    target: EventTarget | null,
    card: HTMLElement,
    backdrop: HTMLElement | null,
  ) => {
    clearSnapBackTimer();
    tracking = true;
    dragging = immediate;
    movedBeyondSlop = false;
    startX = x;
    startY = y;
    currentDy = 0;
    prevY = y;
    lastY = y;
    prevTs = performance.now();
    lastTs = prevTs;
    startTarget = target;
    activeCard = card;
    activeBackdrop = backdrop;
    if (immediate) {
      setSwipeDismissActive(true);
      applyTransform(card, backdrop, 0);
    }
  };

  const updateDrag = (x: number, y: number): boolean => {
    if (!tracking || !activeCard || !activeCard.isConnected || dismissingCards.has(activeCard)) {
      resetTracking();
      return false;
    }
    if (canDismiss && !canDismiss()) {
      resetTracking();
      return false;
    }
    const dx = x - startX;
    const dy = y - startY;
    if (!dragging) {
      if (
        startTarget &&
        startTarget !== activeBackdrop &&
        hasScrolledAncestor(startTarget, activeCard)
      ) {
        resetTracking();
        return false;
      }
      if (dy < -6) {
        resetTracking();
        return false;
      }
      if (Math.abs(dx) > 10 && Math.abs(dx) >= Math.abs(dy)) {
        resetTracking();
        return false;
      }
      if (dy > slopPx && Math.abs(dy) > Math.abs(dx) * slopeRatio) {
        dragging = true;
        movedBeyondSlop = true;
        startY = y;
        prevY = y;
        lastY = y;
        prevTs = performance.now();
        lastTs = prevTs;
        setSwipeDismissActive(true);
        if (mode === "mouse" && pointerId !== -1) {
          try {
            gestureRoot.setPointerCapture(pointerId);
          } catch {
          }
        }
        applyTransform(activeCard, activeBackdrop, 0);
        return true;
      }
      return false;
    }

    if (Math.abs(y - startY) > 4) {
      movedBeyondSlop = true;
    }
    const now = performance.now();
    if (now - lastTs >= 16) {
      prevY = lastY;
      prevTs = lastTs;
      lastY = y;
      lastTs = now;
    }
    applyTransform(activeCard, activeBackdrop, Math.max(0, y - startY));
    return true;
  };

  const finishDrag = (cancelled = false) => {
    if (!tracking) return;
    const card = activeCard;
    const backdrop = activeBackdrop;
    const wasDragging = dragging;
    const hadMotion = movedBeyondSlop;
    const dy = currentDy;
    const activePointerId = pointerId;
    const wasMouse = mode === "mouse";

    if (wasMouse && activePointerId !== -1) {
      try {
        if (gestureRoot.hasPointerCapture(activePointerId)) {
          gestureRoot.releasePointerCapture(activePointerId);
        }
      } catch {
      }
    }
    resetTracking();

    if (hadMotion) {
      suppressNextClick();
    }
    if (!wasDragging || !card || !card.isConnected) {
      if (card) {
        card.style.transition = "";
        card.style.transform = "";
      }
      if (backdrop) {
        backdrop.style.transition = "";
        backdrop.style.background = "";
      }
      return;
    }

    const now = performance.now();
    const dt = Math.max(16, (lastTs > prevTs ? lastTs : now) - prevTs);
    const vel = (lastY - prevY) / dt;
    const threshold = Math.min(
      maxThresholdPx,
      Math.max(minThresholdPx, (card.offsetHeight || 360) * heightFrac),
    );

    if (!cancelled && (dy > threshold || (dy > 24 && vel > 0.45))) {
      dismissingCards.add(card);
      card.style.transition = "transform 160ms ease-out";
      card.style.transform = "translateY(100%)";
      if (backdrop) {
        backdrop.style.transition = "background 160ms ease-out";
        backdrop.style.background = "rgba(0, 0, 0, 0)";
      }
      window.setTimeout(() => {
        if (!card.isConnected) return;
        if (canDismiss && !canDismiss()) return;
        onDismiss();
      }, 160);
    } else {
      card.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
      card.style.transform = "translateY(0px)";
      if (backdrop) {
        backdrop.style.transition = "background 180ms ease-out";
        backdrop.style.background = "";
      }
      snapBackCard = card;
      snapBackBackdrop = backdrop;
      snapBackTimer = window.setTimeout(() => {
        snapBackTimer = null;
        if (snapBackCard) {
          snapBackCard.style.transition = "";
          snapBackCard.style.transform = "";
        }
        if (snapBackBackdrop) {
          snapBackBackdrop.style.transition = "";
          snapBackBackdrop.style.background = "";
        }
        snapBackCard = null;
        snapBackBackdrop = null;
      }, 185);
    }
  };

  gestureRoot.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) {
        if (mode === "touch") finishDrag(true);
        return;
      }
      if (mode !== null) return;
      const targets = resolveTargets();
      if (!targets) return;
      const startZone = canStartFrom(e.target, targets.card, targets.backdrop);
      if (!startZone) return;
      mode = "touch";
      beginDrag(
        e.touches[0].clientX,
        e.touches[0].clientY,
        startZone === "immediate",
        e.target,
        targets.card,
        targets.backdrop,
      );
    },
    { passive: true },
  );

  gestureRoot.addEventListener(
    "touchmove",
    (e) => {
      if (mode !== "touch" || !tracking || e.touches.length !== 1) return;
      const consumed = updateDrag(e.touches[0].clientX, e.touches[0].clientY);
      if (consumed && e.cancelable) {
        e.preventDefault();
      }
    },
    { passive: false },
  );

  gestureRoot.addEventListener("touchend", () => {
    if (mode === "touch") finishDrag(false);
  });
  gestureRoot.addEventListener("touchcancel", () => {
    if (mode === "touch") finishDrag(true);
  });

  gestureRoot.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0 || mode !== null) return;
    const targets = resolveTargets();
    if (!targets) return;
    const startZone = canStartFrom(e.target, targets.card, targets.backdrop);
    if (!startZone) return;
    mode = "mouse";
    pointerId = e.pointerId;
    const immediate = startZone === "immediate";
    beginDrag(e.clientX, e.clientY, immediate, e.target, targets.card, targets.backdrop);
    if (immediate) {
      try {
        gestureRoot.setPointerCapture(e.pointerId);
      } catch {
      }
    }
  });

  gestureRoot.addEventListener("pointermove", (e) => {
    if (mode !== "mouse" || e.pointerId !== pointerId) return;
    updateDrag(e.clientX, e.clientY);
  });

  const endMouse = (e: PointerEvent) => {
    if (mode !== "mouse" || e.pointerId !== pointerId) return;
    finishDrag(e.type === "pointercancel");
  };
  gestureRoot.addEventListener("pointerup", endMouse);
  gestureRoot.addEventListener("pointercancel", endMouse);
}

export function attachSheetSwipeToDismiss(
  sheetEl: HTMLElement,
  backdropEl: HTMLElement | null,
  onDismiss: () => void,
): void {
  attachVerticalSwipeDismiss({
    gestureRoot: backdropEl ?? sheetEl,
    resolveTargets: () => ({ card: sheetEl, backdrop: backdropEl }),
    onDismiss,
    slopPx: 8,
    slopeRatio: 1.15,
    minThresholdPx: 68,
    maxThresholdPx: 110,
    heightFrac: 0.25,
    allowImmediateHandle: true,
  });
}

export function attachModalHostPageSwipeToDismiss(
  modalHostEl: HTMLElement,
  canDismiss: () => boolean,
  onDismiss: () => void,
): void {
  attachVerticalSwipeDismiss({
    gestureRoot: modalHostEl,
    resolveTargets: () => {
      const card = modalHostEl.querySelector<HTMLElement>(".modal-card.mobile-page");
      if (!card) return null;
      return { card, backdrop: card.closest<HTMLElement>(".modal-backdrop") };
    },
    canDismiss,
    onDismiss,
    slopPx: 10,
    slopeRatio: 1.2,
    minThresholdPx: 80,
    maxThresholdPx: 130,
    heightFrac: 0.22,
    allowImmediateHandle: false,
  });
}

function resetDrawerGestureState(sidebarEl: HTMLElement, backdropEl: HTMLElement): void {
  if (drawerCloseTimer !== null) {
    window.clearTimeout(drawerCloseTimer);
    drawerCloseTimer = null;
  }
  if (drawerSnapTimer !== null) {
    window.clearTimeout(drawerSnapTimer);
    drawerSnapTimer = null;
  }
  drawerDragMode = null;
  setSwipeDismissActive(false);
  sidebarEl.style.transition = "";
  sidebarEl.style.transform = "";
  backdropEl.style.transition = "";
  backdropEl.style.opacity = "";
}

function attachDrawerSwipeToDismiss(
  sidebarEl: HTMLElement,
  backdropEl: HTMLElement,
  onClose: () => void,
): void {
  let tracking = false;
  let dragging = false;
  let movedBeyondSlop = false;
  let startX = 0;
  let startY = 0;
  let currentDx = 0;
  let prevX = 0;
  let prevTs = 0;
  let lastX = 0;
  let lastTs = 0;
  let pointerId = -1;
  let captureEl: HTMLElement | null = null;

  const clearSnapTimer = () => {
    if (drawerSnapTimer !== null) {
      window.clearTimeout(drawerSnapTimer);
      drawerSnapTimer = null;
      sidebarEl.style.transition = "";
      sidebarEl.style.transform = "";
      backdropEl.style.transition = "";
      backdropEl.style.opacity = "";
    }
  };

  const resetLocalTracking = () => {
    tracking = false;
    dragging = false;
    drawerDragMode = null;
    pointerId = -1;
    captureEl = null;
    setSwipeDismissActive(false);
  };

  const applyDrawerTransform = (dx: number) => {
    const width = Math.max(180, sidebarEl.offsetWidth || 260);
    currentDx = Math.max(-width, Math.min(0, dx));
    sidebarEl.style.transition = "none";
    sidebarEl.style.transform = `translateX(${currentDx}px)`;
    backdropEl.style.transition = "none";
    backdropEl.style.opacity = String(Math.max(0, Math.min(1, 1 + currentDx / width)));
  };

  const canStart = (target: EventTarget | null): boolean => {
    if (!state.mobileDrawerOpen || !isCompactOrMediumViewport() || drawerCloseTimer !== null) {
      return false;
    }
    if (isDragExcludedTarget(target)) return false;
    return target instanceof Node && (sidebarEl.contains(target) || target === backdropEl);
  };

  const begin = (x: number, y: number, sourceEl: HTMLElement) => {
    clearSnapTimer();
    tracking = true;
    dragging = false;
    movedBeyondSlop = false;
    startX = x;
    startY = y;
    currentDx = 0;
    prevX = x;
    lastX = x;
    prevTs = performance.now();
    lastTs = prevTs;
    captureEl = sourceEl;
  };

  const update = (x: number, y: number): boolean => {
    if (!tracking || !state.mobileDrawerOpen || drawerCloseTimer !== null) {
      resetLocalTracking();
      return false;
    }
    const dx = x - startX;
    const dy = y - startY;
    if (!dragging) {
      if (dx > 12) {
        resetLocalTracking();
        return false;
      }
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
        resetLocalTracking();
        return false;
      }
      if (dx < -8 && Math.abs(dx) > Math.abs(dy) * 1.15) {
        dragging = true;
        movedBeyondSlop = true;
        startX = x;
        prevX = x;
        lastX = x;
        prevTs = performance.now();
        lastTs = prevTs;
        setSwipeDismissActive(true);
        if (drawerDragMode === "mouse" && pointerId !== -1 && captureEl) {
          try {
            captureEl.setPointerCapture(pointerId);
          } catch {
          }
        }
        applyDrawerTransform(0);
        return true;
      }
      return false;
    }

    if (Math.abs(x - startX) > 4) {
      movedBeyondSlop = true;
    }
    const now = performance.now();
    if (now - lastTs >= 16) {
      prevX = lastX;
      prevTs = lastTs;
      lastX = x;
      lastTs = now;
    }
    applyDrawerTransform(Math.min(0, x - startX));
    return true;
  };

  const finish = (cancelled = false) => {
    if (!tracking) return;
    const wasDragging = dragging;
    const hadMotion = movedBeyondSlop;
    const dx = currentDx;
    const activePointerId = pointerId;
    const cap = captureEl;
    const wasMouse = drawerDragMode === "mouse";

    if (wasMouse && activePointerId !== -1 && cap) {
      try {
        if (cap.hasPointerCapture(activePointerId)) {
          cap.releasePointerCapture(activePointerId);
        }
      } catch {
      }
    }
    resetLocalTracking();

    if (hadMotion) {
      suppressNextClick();
    }
    if (!wasDragging) return;

    const width = Math.max(180, sidebarEl.offsetWidth || 260);
    const now = performance.now();
    const dt = Math.max(16, (lastTs > prevTs ? lastTs : now) - prevTs);
    const velX = (lastX - prevX) / dt;
    const threshold = Math.min(100, Math.max(56, width * 0.28));

    if (!cancelled && (-dx > threshold || (-dx > 24 && velX < -0.45))) {
      sidebarEl.style.transition = "transform 160ms ease-out";
      sidebarEl.style.transform = "translateX(-105%)";
      backdropEl.style.transition = "opacity 160ms ease-out";
      backdropEl.style.opacity = "0";
      drawerCloseTimer = window.setTimeout(() => {
        drawerCloseTimer = null;
        lastDrawerOpenState = false;
        state.mobileDrawerOpen = false;
        sidebarEl.classList.remove("drawer-open");
        backdropEl.classList.remove("visible");
        sidebarEl.style.transition = "";
        sidebarEl.style.transform = "";
        backdropEl.style.transition = "";
        backdropEl.style.opacity = "";
        onClose();
      }, 160);
    } else {
      sidebarEl.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
      sidebarEl.style.transform = "translateX(0px)";
      backdropEl.style.transition = "opacity 180ms ease-out";
      backdropEl.style.opacity = "1";
      drawerSnapTimer = window.setTimeout(() => {
        drawerSnapTimer = null;
        sidebarEl.style.transition = "";
        sidebarEl.style.transform = "";
        backdropEl.style.transition = "";
        backdropEl.style.opacity = "";
      }, 185);
    }
  };

  for (const targetEl of [sidebarEl, backdropEl]) {
    targetEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) {
          if (drawerDragMode === "touch") finish(true);
          return;
        }
        if (drawerDragMode !== null || !canStart(e.target)) return;
        drawerDragMode = "touch";
        begin(e.touches[0].clientX, e.touches[0].clientY, targetEl);
      },
      { passive: true },
    );

    targetEl.addEventListener(
      "touchmove",
      (e) => {
        if (drawerDragMode !== "touch" || !tracking || e.touches.length !== 1) return;
        const consumed = update(e.touches[0].clientX, e.touches[0].clientY);
        if (consumed && e.cancelable) {
          e.preventDefault();
        }
      },
      { passive: false },
    );

    targetEl.addEventListener("touchend", () => {
      if (drawerDragMode === "touch") finish(false);
    });
    targetEl.addEventListener("touchcancel", () => {
      if (drawerDragMode === "touch") finish(true);
    });

    targetEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" || e.button !== 0 || drawerDragMode !== null) return;
      if (!canStart(e.target)) return;
      drawerDragMode = "mouse";
      pointerId = e.pointerId;
      begin(e.clientX, e.clientY, targetEl);
    });

    targetEl.addEventListener("pointermove", (e) => {
      if (drawerDragMode !== "mouse" || e.pointerId !== pointerId) return;
      update(e.clientX, e.clientY);
    });

    const endMouse = (e: PointerEvent) => {
      if (drawerDragMode !== "mouse" || e.pointerId !== pointerId) return;
      finish(e.type === "pointercancel");
    };
    targetEl.addEventListener("pointerup", endMouse);
    targetEl.addEventListener("pointercancel", endMouse);
  }
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
    if (drawerCloseTimer !== null) return;
    state.mobileDrawerOpen = false;
    syncMobileChrome();
    notify();
  });

  attachDrawerSwipeToDismiss(hosts.sidebarHost, hosts.drawerBackdrop, () => {
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

  if (state.mobileDrawerOpen !== lastDrawerOpenState) {
    resetDrawerGestureState(sidebarHost, drawerBackdrop);
    lastDrawerOpenState = state.mobileDrawerOpen;
  }

  drawerBackdrop.classList.toggle("visible", state.mobileDrawerOpen);
  sidebarHost.classList.toggle("drawer-open", state.mobileDrawerOpen);

  renderMobileTopbar(topbarHost, handlersRef);
  renderMobileDock(dockHost, handlersRef);
  renderMobileSheet(sheetHost, handlersRef);
  syncBottomInsets();
}

function renderMobileTopbar(container: HTMLElement, handlers: MobileChromeHandlers): void {
  const hasBook = state.activeBook !== null;
  const title = state.activeBook ? state.activeBook.title : tr("app_title");

  container.innerHTML = `
    <div class="mobile-topbar">
      <button class="icon-btn" id="m-btn-drawer" aria-label="${escapeAttr(tr("mobile_open_menu"))}">${Icons.menu()}</button>
      <button class="mobile-book-title-btn" id="m-btn-title" title="${escapeAttr(title)}">
        <span class="mobile-book-title-text">${escapeHtml(title)}</span>
      </button>
      <button class="icon-btn ${state.searchOpen ? "active" : ""}" id="m-btn-search" aria-label="${escapeAttr(tr("mobile_search"))}" ${hasBook ? "" : "disabled"}>
        ${Icons.search()}
      </button>
      <button class="icon-btn ${state.quickReaderSheetOpen ? "active" : ""}" id="m-btn-quick-reader" aria-label="${escapeAttr(tr("mobile_reader_settings"))}">
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
  const uiLang = getActiveUiLanguage();

  if (state.mobileDockCollapsed) {
    if (
      mountedDockMode === "collapsed" &&
      mountedDockLang === uiLang &&
      container.querySelector(".mobile-dock-pill")
    ) {
      const pillPlay = container.querySelector<HTMLButtonElement>("#m-pill-play");
      if (pillPlay) {
        pillPlay.disabled = !hasBook;
        pillPlay.innerHTML = isPlaying ? Icons.pause(16) : Icons.play(16);
      }
      return;
    }
    mountedDockMode = "collapsed";
    mountedDockLang = uiLang;
    dockScrubbing = false;
    container.innerHTML = `
      <div class="mobile-dock-pill">
        <button class="play-btn" id="m-pill-play" aria-label="${escapeAttr(tr("mobile_play_pause"))}" ${hasBook ? "" : "disabled"}>
          ${isPlaying ? Icons.pause(16) : Icons.play(16)}
        </button>
        <button class="icon-btn" id="m-pill-expand" aria-label="${escapeAttr(tr("mobile_expand_player"))}" title="${escapeAttr(tr("mobile_expand_player_title"))}">
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
    state.voices.find((v) => v.voice_id === state.settings.voice_id)?.name ?? tr("common_default");
  const total = Math.max(1, state.sentences.length);
  const curIdx = Math.min(state.tts.sentence_idx, total - 1);
  const progressPct = state.sentences.length > 0 ? ((curIdx + 1) / state.sentences.length) * 100 : 0;
  const counterText = state.sentences.length > 0 ? `${curIdx + 1} / ${state.sentences.length}` : "—";

  if (
    mountedDockMode === "expanded" &&
    mountedDockLang === uiLang &&
    container.querySelector("#m-progress-track")
  ) {
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
  mountedDockLang = uiLang;
  dockScrubbing = false;
  container.innerHTML = `
    <div class="mobile-player-dock">
      <div class="mobile-scrub-hit" id="m-progress-track" title="${escapeAttr(tr("mobile_seek_position"))}">
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
        <button class="mobile-voice-pill" id="m-btn-voice" title="${escapeAttr(tr("toolbar_select_voice"))}">
          ${Icons.voice()}
          <span>${escapeHtml(activeVoice)}</span>
        </button>
        <div class="mobile-transport">
          <button class="icon-btn" id="m-btn-prev" aria-label="${escapeAttr(tr("mobile_prev_sentence"))}" ${hasBook ? "" : "disabled"}>
            ${Icons.prevSentence()}
          </button>
          <button class="play-btn" id="m-btn-play" aria-label="${escapeAttr(tr("mobile_play_pause"))}" ${hasBook ? "" : "disabled"}>
            ${isPlaying ? Icons.pause(18) : Icons.play(18)}
          </button>
          <button class="icon-btn" id="m-btn-next" aria-label="${escapeAttr(tr("mobile_next_sentence"))}" ${hasBook ? "" : "disabled"}>
            ${Icons.nextSentence()}
          </button>
        </div>
        <div class="mobile-dock-right">
          <button class="speed-pill" id="m-btn-speed" aria-label="${escapeAttr(tr("toolbar_playback_speed"))}">${state.settings.speed.toFixed(2)}x</button>
          <button class="icon-btn" id="m-btn-dock-collapse" aria-label="${escapeAttr(tr("mobile_collapse_player"))}" title="${escapeAttr(tr("mobile_minimize_player"))}">
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
  const uiLang = getActiveUiLanguage();
  const hasBook = state.activeBook !== null;
  const isPdf = state.activeBook?.format === "pdf";
  const zoomFactor = isPdf ? typ.pdf_zoom : typ.reader_zoom;
  const sleepLabel =
    state.sleepTimer.active && state.sleepTimer.mode === "minutes" && state.sleepTimer.remaining_sec !== null
      ? tr("mobile_sleep_min_badge", { min: Math.ceil(state.sleepTimer.remaining_sec / 60) })
      : state.sleepTimer.active && state.sleepTimer.mode === "end_of_chapter"
        ? tr("mobile_sleep_chapter_badge")
        : tr("popover_sleep_timer");

  const nextStructureKey = `${uiLang}|${isPdf}|${s.theme === "dark"}|${s.pdf_reflow}`;
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
    if (fontLbl) fontLbl.textContent = tr("settings_unit_px", { px: typ.font_size });

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
      if (span) span.textContent = s.cc_enabled ? tr("common_on") : tr("common_off");
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
  mountedSheetLang = uiLang;
  quickSheetStructureKey = nextStructureKey;
  container.innerHTML = `
    <div class="modal-backdrop" id="m-sheet-backdrop">
      <div class="modal-card mobile-sheet" role="dialog" aria-label="${escapeAttr(tr("mobile_quick_reader_aria"))}">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(tr("mobile_quick_reader_title"))}</span>
          <button class="icon-btn" id="m-sheet-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div class="qr-two-col">
            <button type="button" class="qr-pill-btn ${s.theme === "dark" ? "active" : ""}" id="m-theme-dark">
              ${Icons.moon()}<span>${escapeHtml(tr("mobile_dark_theme"))}</span>
            </button>
            <button type="button" class="qr-pill-btn ${s.theme === "light" ? "active" : ""}" id="m-theme-light">
              ${Icons.sun()}<span>${escapeHtml(tr("mobile_light_theme"))}</span>
            </button>
          </div>

          <div class="qr-section">
            ${
              isPdf
                ? `
              <div class="qr-two-col">
                <button type="button" class="qr-pill-btn ${!s.pdf_reflow ? "active" : ""}" id="m-pdf-mode-original">${escapeHtml(tr("mobile_pdf_original"))}</button>
                <button type="button" class="qr-pill-btn ${s.pdf_reflow ? "active" : ""}" id="m-pdf-mode-reflow">${escapeHtml(tr("mobile_pdf_reflow"))}</button>
              </div>
            `
                : ""
            }
            <div class="qr-seg-row">
              <span style="font-size:13px;font-weight:500;">${escapeHtml(tr("mobile_page_zoom"))}</span>
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
                <span>${escapeHtml(tr("mobile_font_size"))} — <strong id="m-font-size-val">${escapeHtml(tr("settings_unit_px", { px: typ.font_size }))}</strong></span>
                <input type="range" id="m-font-size" min="13" max="30" step="1" value="${typ.font_size}"/>
              </div>
              <div class="setting-row">
                <span>${escapeHtml(tr("mobile_line_height"))} — <strong id="m-line-height-val">${typ.line_height.toFixed(2)}</strong></span>
                <input type="range" id="m-line-height" min="1.3" max="2.3" step="0.05" value="${typ.line_height}"/>
              </div>
            `
                : ""
            }
          </div>

          <div class="qr-section">
            <div class="qr-seg-row">
              <span style="font-size:13px;font-weight:500;">${escapeHtml(tr("mobile_cc_label"))}</span>
              <button type="button" class="qr-pill-btn ${s.cc_enabled ? "active" : ""}" id="m-cc-toggle" style="min-height:38px;padding:4px 14px;">
                ${Icons.cc()}<span>${escapeHtml(s.cc_enabled ? tr("common_on") : tr("common_off"))}</span>
              </button>
            </div>
            <div class="qr-seg-row">
              <span style="font-size:13px;color:var(--text-secondary);">${escapeHtml(tr("mobile_caption_size"))}</span>
              <div class="qr-stepper">
                <button type="button" id="m-cc-smaller" ${s.cc_enabled ? "" : "disabled"}>A-</button>
                <button type="button" class="qr-step-val" id="m-cc-reset" ${s.cc_enabled ? "" : "disabled"}>${typ.cc_font_size}px</button>
                <button type="button" id="m-cc-larger" ${s.cc_enabled ? "" : "disabled"}>A+</button>
              </div>
            </div>
          </div>

          <div class="qr-two-col">
            <button type="button" class="qr-pill-btn" id="m-add-bookmark" ${hasBook ? "" : "disabled"}>
              ${Icons.bookmark(false)}<span>${escapeHtml(tr("toc_bookmark_here"))}</span>
            </button>
            <button type="button" class="qr-pill-btn ${state.sleepTimer.active ? "active" : ""}" id="m-open-sleep">
              ${Icons.sleepTimer()}<span>${escapeHtml(sleepLabel)}</span>
            </button>
          </div>

          ${
            isPdf
              ? `
            <div class="qr-two-col">
              ${
                !s.pdf_reflow && s.theme === "dark"
                  ? `<button type="button" class="qr-pill-btn ${s.pdf_invert_dark ? "active" : ""}" id="m-pdf-invert">${escapeHtml(tr("mobile_dark_pdf_page"))}</button>`
                  : `<div></div>`
              }
              <button type="button" class="qr-pill-btn ${state.pdfMarginsEditing ? "active" : ""}" id="m-pdf-margins">
                ${Icons.margins()}<span>${escapeHtml(tr("mobile_ignore_margins"))}</span>
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
    if (lbl) lbl.textContent = tr("settings_unit_px", { px: v });
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
  const uiLang = getActiveUiLanguage();
  if (mountedSheet === "speed" && mountedSheetLang === uiLang && container.querySelector("#m-speed-slider")) {
    syncSpeedSheetInPlace(container, state.settings.speed);
    return;
  }

  mountedSheet = "speed";
  mountedSheetLang = uiLang;
  const presets = [0.75, 1.0, 1.25, 1.38, 1.5, 2.0];
  container.innerHTML = `
    <div class="modal-backdrop" id="m-sheet-backdrop">
      <div class="modal-card mobile-sheet" role="dialog" aria-label="${escapeAttr(tr("popover_reading_speed"))}">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(tr("popover_reading_speed"))}</span>
          <div style="display:flex;align-items:center;gap:10px;">
            <strong id="m-speed-val">${state.settings.speed.toFixed(2)}x</strong>
            <button class="icon-btn" id="m-sheet-close" aria-label="${escapeAttr(tr("common_close"))}">${Icons.close()}</button>
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
  const uiLang = getActiveUiLanguage();
  if (mountedSheet === "sleep" && mountedSheetLang === uiLang && container.querySelector("#m-sheet-backdrop")) {
    const offBtn = container.querySelector<HTMLButtonElement>("[data-msleep-off]");
    if (offBtn) offBtn.style.display = state.sleepTimer.active ? "" : "none";
    return;
  }

  mountedSheet = "sleep";
  mountedSheetLang = uiLang;
  container.innerHTML = `
    <div class="modal-backdrop" id="m-sheet-backdrop">
      <div class="modal-card mobile-sheet" role="dialog" aria-label="${escapeAttr(tr("popover_sleep_timer"))}">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(tr("popover_sleep_timer"))}</span>
          <button class="icon-btn" id="m-sheet-close">${Icons.close()}</button>
        </div>
        <div class="modal-body">
          <div class="chip-row" style="margin-top:0;">
            <button class="chip" data-msleep-min="15">${escapeHtml(tr("sleep_minutes", { min: 15 }))}</button>
            <button class="chip" data-msleep-min="30">${escapeHtml(tr("sleep_minutes", { min: 30 }))}</button>
            <button class="chip" data-msleep-min="60">${escapeHtml(tr("sleep_minutes", { min: 60 }))}</button>
            <button class="chip" data-msleep-chap="1">${escapeHtml(tr("sleep_end_of_chapter"))}</button>
            <button class="chip" data-msleep-off="1" style="${state.sleepTimer.active ? "" : "display:none"}">${escapeHtml(tr("sleep_turn_off"))}</button>
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
        handlersRef?.onToast?.(tr("mobile_sleep_failed", { error: String(err) }));
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
      handlersRef?.onToast?.(tr("mobile_sleep_failed", { error: String(err) }));
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
      handlersRef?.onToast?.(tr("mobile_sleep_failed", { error: String(err) }));
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
