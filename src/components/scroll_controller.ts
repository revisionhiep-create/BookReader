import { tr } from "../i18n";
import { Icons } from "../icons";
import { notify, state } from "../state";
import { escapeHtml } from "./sidebar";

/**
 * Coordinates smooth auto-scroll keeping the active sentence near the top
 * of the reading viewport, detects intentional user scroll input, and displays
 * the floating "Back to reading" button until clicked.
 */
export class ScrollController {
  private viewport: HTMLElement;
  private backBtn: HTMLButtonElement;
  private programmaticUntil = 0;
  private lastScrolledSid: number | null = null;
  private userScrollingFlag = false;

  constructor(viewport: HTMLElement, backBtn: HTMLButtonElement) {
    this.viewport = viewport;
    this.backBtn = backBtn;
    this.bindEvents();
  }

  public markManualScroll(): void {
    if (state.tts.status === "playing" && state.autoScrollEnabled) {
      state.autoScrollEnabled = false;
      this.userScrollingFlag = true;
      this.syncBackButton();
      notify();
    }
  }

  private bindEvents(): void {
    const markUserScroll = () => this.markManualScroll();

    this.viewport.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) return;
        markUserScroll();
      },
      { passive: true },
    );
    this.viewport.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 1) {
          markUserScroll();
        }
      },
      { passive: true },
    );

    // Scrollbar drag or clicking inside scrollbar gutter
    this.viewport.addEventListener("pointerdown", (e) => {
      const rect = this.viewport.getBoundingClientRect();
      if (e.clientX >= rect.right - 16) {
        markUserScroll();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (state.activeModal !== null) return;
      const target = e.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(e.key)) {
        markUserScroll();
      }
    });

    this.viewport.addEventListener(
      "scroll",
      () => {
        // Ignore events triggered during our own smooth auto-scroll animation window
        if (performance.now() < this.programmaticUntil) {
          return;
        }
        // Fallback detection if OS precision trackpad/scrollbar moved without wheel
        if (this.userScrollingFlag) {
          this.userScrollingFlag = false;
        }
      },
      { passive: true },
    );

    this.syncLabels();
    this.backBtn.addEventListener("click", () => {
      state.autoScrollEnabled = true;
      this.lastScrolledSid = null;
      this.scrollToActiveElement(true);
      this.syncBackButton();
      notify();
    });
  }

  public syncLabels(): void {
    this.backBtn.innerHTML = `${Icons.arrowUp()}<span>${escapeHtml(tr("scroll_back_to_reading"))}</span>`;
  }

  public syncBackButton(): void {
    const show =
      !state.autoScrollEnabled &&
      state.activeBook !== null &&
      (state.tts.status === "playing" || state.tts.status === "loading" || state.tts.status === "paused");
    this.backBtn.classList.toggle("visible", show);
    const isAndroid = document.documentElement.dataset.platform === "android";
    const ccBar = document.getElementById("cc-host");
    const ccVisible = state.settings.cc_enabled && ccBar && !ccBar.classList.contains("hidden");
    const ccHeight = ccVisible ? ccBar.offsetHeight || 78 : 0;

    if (isAndroid && (window.innerWidth < 840 || window.innerHeight <= 520)) {
      const dockEl = document.getElementById("mobile-dock-host")?.querySelector<HTMLElement>(".mobile-player-dock");
      const dockHeight = dockEl ? dockEl.offsetHeight : 0;
      const safeBottomRaw = getComputedStyle(document.documentElement)
        .getPropertyValue("--safe-bottom")
        .trim();
      const safeBottom = Number.parseFloat(safeBottomRaw) || 0;
      const bottomBase = Math.max(dockHeight, safeBottom);
      const pillReserve = dockEl ? 0 : 54;
      this.backBtn.style.bottom = `${bottomBase + ccHeight + pillReserve + 14}px`;
      return;
    }

    if (show && ccVisible) {
      this.backBtn.style.bottom = `${ccHeight + 16}px`;
    } else {
      this.backBtn.style.bottom = "24px";
    }
  }

  public resetForNewBook(): void {
    state.autoScrollEnabled = true;
    this.lastScrolledSid = null;
    this.syncBackButton();
  }

  /**
   * Scrolls the viewport so the active highlighted sentence stays near the top (~16% down)
   * when reading advances to a new row/sentence.
   */
  public onActiveSentenceChanged(sentenceIdx: number, force = false, instant = false): void {
    this.syncBackButton();
    if (!state.autoScrollEnabled) return;
    if (!force && this.lastScrolledSid === sentenceIdx) return;
    this.scrollToActiveElement(force, instant);
  }

  public scrollToActiveElement(force = false, instant = false): void {
    const target = this.viewport.querySelector<HTMLElement>(
      `[data-active-sid="true"]`,
    );
    if (!target) return;

    const vpRect = this.viewport.getBoundingClientRect();
    const elRect = target.getBoundingClientRect();
    const desiredTop = vpRect.top + Math.min(110, vpRect.height * 0.16);
    const delta = elRect.top - desiredTop;

    // Only scroll if moved down past the next row, offscreen above, or forced
    if (force || Math.abs(delta) > 22) {
      this.lastScrolledSid = state.tts.sentence_idx;
      this.programmaticUntil = performance.now() + (instant ? 250 : 750);
      this.viewport.scrollTo({
        top: Math.max(0, this.viewport.scrollTop + delta),
        behavior: instant ? "auto" : "smooth",
      });
    } else {
      this.lastScrolledSid = state.tts.sentence_idx;
    }
  }

  public scrollToSearchFocus(): void {
    const target = this.viewport.querySelector<HTMLElement>(
      `[data-search-focus="true"]`,
    );
    if (!target) return;

    const vpRect = this.viewport.getBoundingClientRect();
    const elRect = target.getBoundingClientRect();
    const desiredTop = vpRect.top + Math.min(140, vpRect.height * 0.24);
    const delta = elRect.top - desiredTop;

    this.programmaticUntil = performance.now() + 750;
    this.viewport.scrollTo({
      top: Math.max(0, this.viewport.scrollTop + delta),
      behavior: "smooth",
    });
  }
}
