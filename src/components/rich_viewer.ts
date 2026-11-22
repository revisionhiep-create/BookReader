import { state } from "../state";
import type { DocumentPayload } from "../types";

export class RichViewer {
  private container: HTMLElement;
  private renderedBookId: string | null = null;
  private activeSid: number | null = null;
  private onSentenceClick: (sid: number) => void;

  constructor(container: HTMLElement, onSentenceClick: (sid: number) => void) {
    this.container = container;
    this.onSentenceClick = onSentenceClick;
  }

  public clear(): void {
    this.renderedBookId = null;
    this.activeSid = null;
    this.container.innerHTML = "";
  }

  public mountDocument(payload: DocumentPayload): void {
    this.renderedBookId = payload.book.id;
    this.activeSid = null;

    const prose = document.createElement("article");
    prose.className = "br-prose";
    this.applyTypographyVars(prose);

    const chaptersHtml = payload.html_chapters
      .map((ch) => `<section class="br-chapter">${ch.html}</section>`)
      .join("\n<hr/>\n");
    prose.innerHTML = chaptersHtml || "<p>No readable text found in this document.</p>";

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
    el.style.setProperty("--reader-font-size", `${t.font_size}px`);
    el.style.setProperty("--reader-line-height", `${t.line_height}`);
    el.style.setProperty("--reader-max-width", `${t.max_width}px`);
  }

  public syncHighlight(sentenceIdx: number): void {
    if (!this.renderedBookId) return;

    if (this.activeSid !== null && this.activeSid !== sentenceIdx) {
      const prev = this.container.querySelector<HTMLElement>(
        `.br-sent[data-sid="${this.activeSid}"]`,
      );
      if (prev) {
        prev.classList.remove("active");
        prev.removeAttribute("data-active-sid");
      }
    }

    const cur = this.container.querySelector<HTMLElement>(
      `.br-sent[data-sid="${sentenceIdx}"]`,
    );
    if (cur) {
      cur.classList.add("active");
      cur.setAttribute("data-active-sid", "true");
    }
    this.activeSid = sentenceIdx;

    // Sync search highlight hits and focused search match separately from playback cursor
    this.container.querySelectorAll(".br-sent.search-hit, .br-sent.search-focus").forEach((el) => {
      el.classList.remove("search-hit", "search-focus");
      el.removeAttribute("data-search-focus");
    });
    for (const hitSid of state.searchHits) {
      const el = this.container.querySelector<HTMLElement>(`.br-sent[data-sid="${hitSid}"]`);
      if (el) el.classList.add("search-hit");
    }
    if (state.searchFocusedSid !== null) {
      const focusEl = this.container.querySelector<HTMLElement>(
        `.br-sent[data-sid="${state.searchFocusedSid}"]`,
      );
      if (focusEl) {
        focusEl.classList.add("search-focus");
        focusEl.setAttribute("data-search-focus", "true");
      }
    }
  }
}
