import { Icons } from "../icons";
import { notify, state } from "../state";

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

  private bindEvents(): void {
    const markUserScroll = () => {
      if (state.tts.status === "playing" && state.autoScrollEnabled) {
        state.autoScrollEnabled = false;
        this.userScrollingFlag = true;
        this.syncBackButton();
        notify();
      }
    };

    this.viewport.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) return;
        markUserScroll();
      },
      { passive: true },
    );
    this.viewport.addEventListener("touchmove", markUserScroll, { passive: true });

    // Scrollbar drag or clicking inside scrollbar gutter
    this.viewport.addEventListener("pointerdown", (e) => {
      const rect = this.viewport.getBoundingClientRect();
      if (e.clientX >= rect.right - 16) {
        markUserScroll();
      }
    });

    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
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

    this.backBtn.innerHTML = `${Icons.arrowUp()}<span>Back to reading</span>`;
    this.backBtn.addEventListener("click", () => {
      state.autoScrollEnabled = true;
      this.lastScrolledSid = null;
      this.scrollToActiveElement(true);
      this.syncBackButton();
      notify();
    });
  }

  public syncBackButton(): void {
    const show =
      !state.autoScrollEnabled &&
      state.activeBook !== null &&
      (state.tts.status === "playing" || state.tts.status === "loading" || state.tts.status === "paused");
    this.backBtn.classList.toggle("visible", show);
    const ccBar = document.getElementById("cc-host");
    if (show && state.settings.cc_enabled && ccBar && !ccBar.classList.contains("hidden")) {
      const ccHeight = ccBar.offsetHeight || 78;
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
