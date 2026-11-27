import { tr } from "../i18n";
import { state } from "../state";
import type { DocumentPayload } from "../types";
import { escapeHtml } from "./sidebar";

export class RichViewer {
  private container: HTMLElement;
  private renderedBookId: string | null = null;
  private activeSid: number | null = null;
  private sentElements: Map<number, HTMLElement> = new Map();
  private highlightedSearchEls: Set<HTMLElement> = new Set();
  private onSentenceClick: (sid: number) => void;

  constructor(container: HTMLElement, onSentenceClick: (sid: number) => void) {
    this.container = container;
    this.onSentenceClick = onSentenceClick;
  }

  public clear(): void {
    this.renderedBookId = null;
    this.activeSid = null;
    this.sentElements.clear();
    this.highlightedSearchEls.clear();
    this.container.innerHTML = "";
  }

  public mountDocument(payload: DocumentPayload): void {
    this.renderedBookId = payload.book.id;
    this.activeSid = null;
    this.sentElements.clear();
    this.highlightedSearchEls.clear();

    const prose = document.createElement("article");
    prose.className = "br-prose";
    this.applyTypographyVars(prose);

    const chaptersHtml = payload.html_chapters
      .map((ch) => `<section class="br-chapter">${ch.html}</section>`)
      .join("\n<hr/>\n");
    prose.innerHTML = chaptersHtml || `<p>${escapeHtml(tr("rich_no_text"))}</p>`;

    prose.querySelectorAll<HTMLElement>(".br-sent").forEach((el) => {
      const sid = Number(el.dataset.sid);
      if (Number.isFinite(sid) && !this.sentElements.has(sid)) {
        this.sentElements.set(sid, el);
      }
    });

    prose.addEventListener("click", (e) => {
      const span = (e.target as HTMLElement | null)?.closest<HTMLElement>(".br-sent");
      if (!span) return;
      const sid = Number(span.dataset.sid);
      if (Number.isFinite(sid)) {
        this.onSentenceClick(sid);
      }
    });

    this.container.innerHTML = "";
    this.container.appendChild(prose);
    this.syncHighlight(state.tts.sentence_idx);
  }

  public applyTypography(): void {
    const prose = this.container.querySelector<HTMLElement>(".br-prose");
    if (prose) {
      this.applyTypographyVars(prose);
    }
  }

  private applyTypographyVars(el: HTMLElement): void {
    const t = state.settings.typography;
    const scaledFont = Math.round(t.font_size * t.reader_zoom);
    const scaledWidth = Math.round(t.max_width * Math.min(1.55, Math.max(0.85, t.reader_zoom)));
    el.style.setProperty("--reader-font-size", `${scaledFont}px`);
    el.style.setProperty("--reader-line-height", `${t.line_height}`);
    el.style.setProperty("--reader-max-width", `${scaledWidth}px`);
  }

  public syncHighlight(sentenceIdx: number): void {
    if (!this.renderedBookId) return;

    if (this.activeSid !== null && this.activeSid !== sentenceIdx) {
      const prev = this.sentElements.get(this.activeSid);
      if (prev) {
        prev.classList.remove("active");
        prev.removeAttribute("data-active-sid");
      }
    }

    const cur = this.sentElements.get(sentenceIdx);
    if (cur) {
      cur.classList.add("active");
      cur.setAttribute("data-active-sid", "true");
    }
    this.activeSid = sentenceIdx;

    // Sync search highlight hits and focused search match separately from playback cursor
    this.highlightedSearchEls.forEach((el) => {
      el.classList.remove("search-hit", "search-focus");
      el.removeAttribute("data-search-focus");
    });
    this.highlightedSearchEls.clear();

    for (const hitSid of state.searchHits) {
      const el = this.sentElements.get(hitSid);
      if (el) {
        el.classList.add("search-hit");
        this.highlightedSearchEls.add(el);
      }
    }
    if (state.searchFocusedSid !== null) {
      const focusEl = this.sentElements.get(state.searchFocusedSid);
      if (focusEl) {
        focusEl.classList.add("search-focus");
        focusEl.setAttribute("data-search-focus", "true");
        this.highlightedSearchEls.add(focusEl);
      }
    }
  }
}
