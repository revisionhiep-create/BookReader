import { invoke } from "../tauri_bridge";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { isAndroidPlatform, notify, persistSettings, state } from "../state";
import type { BookMeta, SentenceItem, TocEntry } from "../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface RectNorm {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PdfSpan {
  page: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PdfLine {
  page: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  paraBreakBefore: boolean;
}

export class PdfViewer {
  private container: HTMLElement;
  private viewport: HTMLElement;
  private onSentenceClick: (sid: number) => void;
  private onSentencesExtracted: (
    sentences: SentenceItem[],
    toc: TocEntry[],
    cursorIdx: number,
    preserving: boolean,
  ) => void | Promise<void>;

  private pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  private loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
  private currentBook: BookMeta | null = null;
  private pageWraps: Map<number, HTMLElement> = new Map();
  private renderedPages: Set<number> = new Set();
  private renderingPages: Set<number> = new Set();
  private observer: IntersectionObserver | null = null;
  private sentenceRects: RectNorm[][] = [];
  private pageSentences: Map<number, number[]> = new Map();
  private activeSid = -1;
  private prevSearchFocusedSid: number | null = null;
  private basePageDimensions: Array<{ width: number; height: number }> = [];
  private zoomTimer: number | undefined;
  private renderGeneration = 0;
  private activeRenderTasks: Map<number, pdfjsLib.RenderTask> = new Map();
  private inFlightRenders: Map<number, Promise<void>> = new Map();

  constructor(
    container: HTMLElement,
    viewport: HTMLElement,
    onSentenceClick: (sid: number) => void,
    onSentencesExtracted: (
      sentences: SentenceItem[],
      toc: TocEntry[],
      cursorIdx: number,
      preserving: boolean,
    ) => void | Promise<void>,
  ) {
    this.container = container;
    this.viewport = viewport;
    this.onSentenceClick = onSentenceClick;
    this.onSentencesExtracted = onSentencesExtracted;
  }

  public clear(): void {
    if (this.zoomTimer !== undefined) {
      window.clearTimeout(this.zoomTimer);
      this.zoomTimer = undefined;
    }
    this.cancelActiveRenders();
    this.observer?.disconnect();
    this.observer = null;
    void this.pdfDoc?.cleanup();
    void this.loadingTask?.destroy();
    this.pdfDoc = null;
    this.loadingTask = null;
    this.currentBook = null;
    this.pageWraps.clear();
    this.sentenceRects = [];
    this.pageSentences.clear();
    this.basePageDimensions = [];
    this.activeSid = -1;
    this.prevSearchFocusedSid = null;
    this.container.innerHTML = "";
  }

  public async mountPdf(
    book: BookMeta,
    onProgress?: (msg: string) => void,
  ): Promise<void> {
    this.clear();
    const mountGen = this.renderGeneration;
    this.currentBook = book;

    this.container.innerHTML = `
      <div class="pdf-loading-card">
        <span class="loading-spinner" aria-hidden="true"></span>
        <span id="pdf-loading-msg">Loading book &amp; restoring last reading position, please wait...</span>
      </div>
    `;
    const loadingMsgEl = this.container.querySelector<HTMLElement>("#pdf-loading-msg");
    const reportProgress = (msg: string) => {
      if (mountGen !== this.renderGeneration) return;
      if (loadingMsgEl) loadingMsgEl.textContent = msg;
      onProgress?.(msg);
    };

    reportProgress("Opening PDF document, please wait...");
    const mediaBase = state.bootstrap?.media_base_url ?? "http://bookmedia.localhost";
    const url = `${mediaBase}/book/${book.id}`;
    this.loadingTask = pdfjsLib.getDocument({ url });
    const doc = await this.loadingTask.promise;
    if (mountGen !== this.renderGeneration) {
      void doc.cleanup();
      return;
    }
    this.pdfDoc = doc;

    const numPages = doc.numPages;
    this.basePageDimensions = [];

    // Sample unscaled (1.0x) dimensions once so future zooms resize instantaneously
    for (let p = 1; p <= numPages; p++) {
      if (mountGen !== this.renderGeneration || this.pdfDoc !== doc) return;
      const page = await doc.getPage(p);
      if (mountGen !== this.renderGeneration || this.pdfDoc !== doc) return;
      const vp = page.getViewport({ scale: 1.0 });
      this.basePageDimensions.push({ width: vp.width, height: vp.height });
      if (p === 1 || p % 25 === 0 || p === numPages) {
        reportProgress(`Preparing pages (${p} / ${numPages}), please wait...`);
      }
    }

    const extracted = await this.extractSentencesData(false, mountGen, reportProgress);
    if (!extracted || mountGen !== this.renderGeneration || this.pdfDoc !== doc) return;

    reportProgress("Jumping to your last reading position, please wait...");
    this.sentenceRects = extracted.rects;
    this.pageSentences = extracted.pageSentences;
    this.buildDomSkeleton();
    this.activeSid = extracted.newCursor;
    this.syncHighlight(extracted.newCursor);
    await this.onSentencesExtracted(
      extracted.sentences,
      extracted.toc,
      extracted.newCursor,
      false,
    );
    if (mountGen !== this.renderGeneration || this.pdfDoc !== doc) return;
    this.syncHighlight(extracted.newCursor);
    this.refreshVisibleHitLayers(extracted.newCursor);
  }

  private getPageScale(baseWidth: number): number {
    const zoom = state.settings.typography.pdf_zoom;
    if (isAndroidPlatform() && window.innerWidth < 600 && this.viewport.clientWidth > 32) {
      const fitScale = Math.min(1, (this.viewport.clientWidth - 20) / Math.max(1, baseWidth));
      return fitScale * zoom;
    }
    return zoom;
  }

  public rebuildForZoom(): void {
    if (!this.pdfDoc || !this.currentBook) return;

    const maxBefore = Math.max(1, this.viewport.scrollHeight - this.viewport.clientHeight);
    const scrollFrac = this.viewport.scrollTop / maxBefore;

    this.pageWraps.forEach((card, pageNum) => {
      const base = this.basePageDimensions[pageNum - 1] ?? { width: 700, height: 950 };
      const scale = this.getPageScale(base.width);
      const w = Math.round(base.width * scale);
      const h = Math.round(base.height * scale);
      card.style.width = `${w}px`;
      card.style.height = `${h}px`;
      const canvas = card.querySelector<HTMLCanvasElement>(".pdf-canvas");
      if (canvas && canvas.width > 0) {
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    });

    const maxAfter = Math.max(1, this.viewport.scrollHeight - this.viewport.clientHeight);
    this.viewport.scrollTop = Math.round(scrollFrac * maxAfter);

    this.cancelActiveRenders();

    if (this.zoomTimer !== undefined) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => {
      this.renderVisiblePages();
    }, 95);
  }

  public syncDarkInvert(): void {
    this.pageWraps.forEach((card) =>
      card.classList.toggle("dark-invert", state.settings.pdf_invert_dark),
    );
  }

  private renderVisiblePages(): void {
    if (!this.pdfDoc) return;
    const vpRect = this.viewport.getBoundingClientRect();
    const margin = 700;
    this.pageWraps.forEach((card, p) => {
      const r = card.getBoundingClientRect();
      if (r.bottom >= vpRect.top - margin && r.top <= vpRect.bottom + margin) {
        void this.renderPageCanvas(p);
      }
    });
  }

  public refreshMarginOverlayUI(): void {
    if (!this.currentBook) return;
    this.renderMarginControlsBar();
    this.syncCurtainPositions();
  }

  private buildDomSkeleton(): void {
    if (!this.pdfDoc || !this.currentBook) return;
    this.cancelActiveRenders();
    this.observer?.disconnect();
    this.pageWraps.clear();

    this.container.innerHTML = "";

    const controlsBar = document.createElement("div");
    controlsBar.id = "pdf-controls-anchor";
    this.container.appendChild(controlsBar);
    this.renderMarginControlsBar();

    const stack = document.createElement("div");
    stack.className = "pdf-stack";
    this.container.appendChild(stack);

    for (let p = 1; p <= this.pdfDoc.numPages; p++) {
      const base = this.basePageDimensions[p - 1] ?? { width: 700, height: 950 };
      const scale = this.getPageScale(base.width);
      const wrap = document.createElement("div");
      wrap.className = "pdf-page-wrap";

      const card = document.createElement("div");
      card.className = state.settings.pdf_invert_dark
        ? "pdf-page-card dark-invert"
        : "pdf-page-card";
      card.style.width = `${Math.round(base.width * scale)}px`;
      card.style.height = `${Math.round(base.height * scale)}px`;
      card.dataset.page = String(p);

      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      card.appendChild(canvas);

      const hlLayer = document.createElement("div");
      hlLayer.className = "pdf-highlight-layer";
      card.appendChild(hlLayer);

      const topCurtain = document.createElement("div");
      topCurtain.className = "ignore-curtain top";
      topCurtain.innerHTML = `
        <div class="ignore-handle" data-edge="top" style="touch-action:none;">
          <div class="ignore-line"></div>
          <span class="ignore-pill">Header</span>
        </div>
      `;
      card.appendChild(topCurtain);

      const botCurtain = document.createElement("div");
      botCurtain.className = "ignore-curtain bottom";
      botCurtain.innerHTML = `
        <div class="ignore-handle" data-edge="bottom" style="touch-action:none;">
          <div class="ignore-line"></div>
          <span class="ignore-pill">Footer</span>
        </div>
      `;
      card.appendChild(botCurtain);

      this.bindCurtainDrag(card, topCurtain, "top");
      this.bindCurtainDrag(card, botCurtain, "bottom");

      const badge = document.createElement("div");
      badge.className = "pdf-page-badge";
      badge.textContent = String(p);

      wrap.appendChild(card);
      wrap.appendChild(badge);
      stack.appendChild(wrap);
      this.pageWraps.set(p, card);
    }

    this.syncCurtainPositions();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const p = Number((entry.target as HTMLElement).dataset.page);
            if (Number.isFinite(p)) {
              void this.renderPageCanvas(p);
              if (p > 1) void this.renderPageCanvas(p - 1);
              if (this.pdfDoc && p < this.pdfDoc.numPages) void this.renderPageCanvas(p + 1);
            }
          }
        }
      },
      { root: this.viewport, rootMargin: "700px 0px" },
    );

    this.pageWraps.forEach((card) => this.observer?.observe(card));
  }

  private renderMarginControlsBar(): void {
    const anchor = this.container.querySelector<HTMLElement>("#pdf-controls-anchor");
    if (!anchor || !this.currentBook) return;

    if (!state.pdfMarginsEditing) {
      anchor.innerHTML = "";
      return;
    }

    const headerPct = Math.round(this.currentBook.pdf_header_ignore_pct * 100);
    const footerPct = Math.round(this.currentBook.pdf_footer_ignore_pct * 100);

    anchor.innerHTML = `
      <div class="pdf-toolbar-strip" style="flex-wrap:wrap;border-radius:12px;">
        <span><strong>Drag lines on any page</strong></span>
        <span>Top: <strong id="lbl-hdr-pct">${headerPct}%</strong></span>
        <span>Bottom: <strong id="lbl-ftr-pct">${footerPct}%</strong></span>
        <label class="checkbox-label" style="font-size:12px;">
          <input type="checkbox" id="chk-keep-blur" ${state.settings.keep_blur_visible ? "checked" : ""}/>
          Keep blur visible
        </label>
        <button class="chip" id="btn-save-default-margins">Save as default</button>
        <button class="btn-primary" style="padding:4px 10px;font-size:12px;" id="btn-margins-done">Done</button>
      </div>
    `;

    anchor.querySelector<HTMLInputElement>("#chk-keep-blur")?.addEventListener("change", (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      void persistSettings({ keep_blur_visible: checked }).then(() => {
        this.syncCurtainPositions();
      });
    });

    anchor.querySelector("#btn-save-default-margins")?.addEventListener("click", async () => {
      if (!this.currentBook) return;
      await persistSettings({
        default_pdf_header_ignore_pct: this.currentBook.pdf_header_ignore_pct,
        default_pdf_footer_ignore_pct: this.currentBook.pdf_footer_ignore_pct,
      });
    });

    anchor.querySelector("#btn-margins-done")?.addEventListener("click", () => {
      state.pdfMarginsEditing = false;
      this.refreshMarginOverlayUI();
      notify();
    });
  }

  private bindCurtainDrag(
    card: HTMLElement,
    curtain: HTMLElement,
    edge: "top" | "bottom",
  ): void {
    const handle = curtain.querySelector<HTMLElement>(".ignore-handle");
    if (!handle) return;

    handle.addEventListener("pointerdown", (e) => {
      if (!state.pdfMarginsEditing || !this.currentBook) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        if (!this.currentBook) return;
        const rect = card.getBoundingClientRect();
        const relY = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
        if (edge === "top") {
          const maxTop = Math.max(0.02, 0.94 - this.currentBook.pdf_footer_ignore_pct);
          this.currentBook.pdf_header_ignore_pct = Math.max(
            0,
            Math.min(Math.min(0.45, maxTop), relY / rect.height),
          );
        } else {
          const maxBot = Math.max(0.02, 0.94 - this.currentBook.pdf_header_ignore_pct);
          const fromBot = (rect.height - relY) / rect.height;
          this.currentBook.pdf_footer_ignore_pct = Math.max(
            0,
            Math.min(Math.min(0.45, maxBot), fromBot),
          );
        }
        this.syncCurtainPositions();
      };

      const onUp = async () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        if (!this.currentBook) return;
        const updated = await invoke<BookMeta>("update_pdf_margins", {
          bookId: this.currentBook.id,
          headerPct: this.currentBook.pdf_header_ignore_pct,
          footerPct: this.currentBook.pdf_footer_ignore_pct,
        });
        this.currentBook = updated;
        state.activeBook = updated;
        await this.extractAllSentences(true);
        this.syncHighlight(state.tts.sentence_idx);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }

  private syncCurtainPositions(): void {
    if (!this.currentBook) return;
    const hdr = this.currentBook.pdf_header_ignore_pct;
    const ftr = this.currentBook.pdf_footer_ignore_pct;
    const editing = state.pdfMarginsEditing;
    const showBlur = editing || state.settings.keep_blur_visible;

    const lblH = this.container.querySelector("#lbl-hdr-pct");
    const lblF = this.container.querySelector("#lbl-ftr-pct");
    if (lblH) lblH.textContent = `${Math.round(hdr * 100)}%`;
    if (lblF) lblF.textContent = `${Math.round(ftr * 100)}%`;

    this.pageWraps.forEach((card) => {
      const topC = card.querySelector<HTMLElement>(".ignore-curtain.top");
      const botC = card.querySelector<HTMLElement>(".ignore-curtain.bottom");
      if (topC) {
        topC.style.display = showBlur && (editing || hdr > 0.002) ? "block" : "none";
        topC.style.height = `${(hdr * 100).toFixed(2)}%`;
        const h = topC.querySelector<HTMLElement>(".ignore-handle");
        const pill = topC.querySelector<HTMLElement>(".ignore-pill");
        if (h) h.style.display = editing ? "flex" : "none";
        if (pill) pill.textContent = `Header ${Math.round(hdr * 100)}%`;
      }
      if (botC) {
        botC.style.display = showBlur && (editing || ftr > 0.002) ? "block" : "none";
        botC.style.height = `${(ftr * 100).toFixed(2)}%`;
        const h = botC.querySelector<HTMLElement>(".ignore-handle");
        const pill = botC.querySelector<HTMLElement>(".ignore-pill");
        if (h) h.style.display = editing ? "flex" : "none";
        if (pill) pill.textContent = `Footer ${Math.round(ftr * 100)}%`;
      }
    });
  }

  private cancelActiveRenders(): void {
    this.renderGeneration++;
    for (const task of this.activeRenderTasks.values()) {
      try {
        task.cancel();
      } catch {
        // Ignore cancellation errors on tasks that already settled
      }
    }
    this.activeRenderTasks.clear();
    this.renderedPages.clear();
    this.renderingPages.clear();
  }

  private async renderPageCanvas(pageNum: number): Promise<void> {
    const doc = this.pdfDoc;
    if (!doc || this.renderedPages.has(pageNum) || this.renderingPages.has(pageNum)) {
      return;
    }

    const gen = this.renderGeneration;
    const prev = this.inFlightRenders.get(pageNum);
    this.renderingPages.add(pageNum);

    let work!: Promise<void>;
    work = (async () => {
      try {
        if (prev) {
          await prev.catch(() => {});
        }
        if (gen !== this.renderGeneration || this.pdfDoc !== doc) return;

        const card = this.pageWraps.get(pageNum);
        if (!card) return;

        const page = await doc.getPage(pageNum);
        if (gen !== this.renderGeneration || this.pdfDoc !== doc) return;

        const base = this.basePageDimensions[pageNum - 1] ?? { width: 700, height: 950 };
        const scale = this.getPageScale(base.width);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: scale * dpr });
        const cssVp = page.getViewport({ scale });

        const canvas = card.querySelector<HTMLCanvasElement>(".pdf-canvas");
        if (!canvas) return;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${Math.round(cssVp.width)}px`;
        canvas.style.height = `${Math.round(cssVp.height)}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const task = page.render({ canvasContext: ctx, canvas, viewport: vp });
        this.activeRenderTasks.set(pageNum, task);
        try {
          await task.promise;
        } catch (err: unknown) {
          if (
            (err instanceof Error && err.name === "RenderingCancelledException") ||
            gen !== this.renderGeneration
          ) {
            return;
          }
          throw err;
        } finally {
          if (this.activeRenderTasks.get(pageNum) === task) {
            this.activeRenderTasks.delete(pageNum);
          }
        }

        if (gen !== this.renderGeneration || this.pdfDoc !== doc) return;
        this.renderedPages.add(pageNum);
        this.renderPageHighlights(pageNum);
      } finally {
        if (gen === this.renderGeneration) {
          this.renderingPages.delete(pageNum);
        }
        if (this.inFlightRenders.get(pageNum) === work) {
          this.inFlightRenders.delete(pageNum);
        }
      }
    })();

    this.inFlightRenders.set(pageNum, work);
    await work;
  }

  private async extractAllSentences(
    preservingPos: boolean,
    onProgress?: (msg: string) => void,
  ): Promise<void> {
    const mountGen = this.renderGeneration;
    const doc = this.pdfDoc;
    const extracted = await this.extractSentencesData(preservingPos, mountGen, onProgress);
    if (!extracted || mountGen !== this.renderGeneration || this.pdfDoc !== doc) return;

    this.sentenceRects = extracted.rects;
    this.pageSentences = extracted.pageSentences;
    await this.onSentencesExtracted(
      extracted.sentences,
      extracted.toc,
      extracted.newCursor,
      preservingPos,
    );
    this.refreshVisibleHitLayers(extracted.newCursor);
  }

  private async extractSentencesData(
    preservingPos: boolean,
    mountGen: number,
    onProgress?: (msg: string) => void,
  ): Promise<{
    sentences: SentenceItem[];
    rects: RectNorm[][];
    pageSentences: Map<number, number[]>;
    toc: TocEntry[];
    newCursor: number;
  } | null> {
    const doc = this.pdfDoc;
    const book = this.currentBook;
    if (!doc || !book) return null;

    const oldSid = state.tts.sentence_idx;
    const oldPage = state.sentences[oldSid]?.page ?? 1;
    const oldSnippet = state.sentences[oldSid]?.text.slice(0, 48) ?? "";

    const hdrPct = book.pdf_header_ignore_pct;
    const ftrPct = book.pdf_footer_ignore_pct;
    const allLines: PdfLine[] = [];
    const numPages = doc.numPages;

    for (let p = 1; p <= numPages; p++) {
      if (mountGen !== this.renderGeneration || this.pdfDoc !== doc) return null;
      if (p === 1 || p % 15 === 0 || p === numPages) {
        onProgress?.(`Indexing page ${p} of ${numPages}, please wait...`);
      }
      const page = await doc.getPage(p);
      if (mountGen !== this.renderGeneration || this.pdfDoc !== doc) return null;
      const vp = page.getViewport({ scale: 1.0 });
      const content = await page.getTextContent();
      if (mountGen !== this.renderGeneration || this.pdfDoc !== doc) return null;
      const spans: PdfSpan[] = [];

      for (const rawItem of content.items) {
        if (!("str" in rawItem) || !rawItem.str || !rawItem.str.trim()) continue;
        const tx = pdfjsLib.Util.transform(vp.transform, rawItem.transform);
        const fontH = Math.max(8, Math.hypot(rawItem.transform[2], rawItem.transform[3]) || rawItem.height || 12);
        const h = Math.max(0.008, fontH / vp.height);
        const y = tx[5] / vp.height - h * 0.82;
        const x = tx[4] / vp.width;
        const w = Math.max(0.004, rawItem.width / vp.width);
        const centerY = y + h * 0.5;

        if (centerY < hdrPct || centerY > 1.0 - ftrPct) {
          continue;
        }
        spans.push({ page: p, text: rawItem.str, x, y, w, h });
      }

      const pageLines = groupSpansIntoLines(spans);
      allLines.push(...pageLines);
    }

    const { sentences, rects } = buildStitchedPdfSentences(allLines);
    const pageSentences = new Map<number, number[]>();
    for (let sid = 0; sid < rects.length; sid++) {
      const seen = new Set<number>();
      for (const r of rects[sid]) {
        if (!seen.has(r.page)) {
          seen.add(r.page);
          let arr = pageSentences.get(r.page);
          if (!arr) {
            arr = [];
            pageSentences.set(r.page, arr);
          }
          arr.push(sid);
        }
      }
    }

    // Extract PDF outline / TOC if present
    const toc = await this.extractOutlineToc(sentences);
    if (mountGen !== this.renderGeneration || this.pdfDoc !== doc) return null;

    let newCursor = book.current_sentence_idx;
    if (preservingPos) {
      newCursor = findPreservedPdfCursor(sentences, oldPage, oldSnippet, oldSid);
    } else {
      newCursor = Math.min(newCursor, Math.max(0, sentences.length - 1));
    }

    return { sentences, rects, pageSentences, toc, newCursor };
  }

  private async extractOutlineToc(sentences: SentenceItem[]): Promise<TocEntry[]> {
    if (!this.pdfDoc) return [];
    try {
      const outline = await this.pdfDoc.getOutline();
      if (!outline || outline.length === 0) return [];
      const toc: TocEntry[] = [];

      const walk = async (items: typeof outline, level: number) => {
        for (const item of items) {
          let pageNum = 1;
          try {
            const dest =
              typeof item.dest === "string"
                ? await this.pdfDoc!.getDestination(item.dest)
                : item.dest;
            if (Array.isArray(dest) && dest[0]) {
              const idx = await this.pdfDoc!.getPageIndex(dest[0] as never);
              pageNum = idx + 1;
            }
          } catch {
            // Keep fallback pageNum = 1
          }
          const sid = sentences.findIndex((s) => (s.page ?? 1) >= pageNum);
          toc.push({
            title: item.title || `Page ${pageNum}`,
            sentence_idx: Math.max(0, sid),
            page: pageNum,
            level,
          });
          if (item.items?.length) {
            await walk(item.items, level + 1);
          }
        }
      };

      await walk(outline, 1);
      return toc;
    } catch {
      return [];
    }
  }

  private refreshVisibleHitLayers(activeIdx: number): void {
    this.pageWraps.forEach((card, pageNum) => {
      if (this.renderedPages.has(pageNum)) {
        this.renderPageHighlights(pageNum);
      } else {
        const layer = card.querySelector<HTMLElement>(".pdf-highlight-layer");
        if (layer) layer.innerHTML = "";
      }
    });
    if (this.sentenceRects[activeIdx]) {
      for (const r of this.sentenceRects[activeIdx]) {
        this.renderPageHighlights(r.page);
      }
    }
    if (state.searchFocusedSid !== null && this.sentenceRects[state.searchFocusedSid]) {
      for (const r of this.sentenceRects[state.searchFocusedSid]) {
        this.renderPageHighlights(r.page);
      }
    }
  }

  private renderPageHighlights(pageNum: number): void {
    const card = this.pageWraps.get(pageNum);
    if (!card) return;
    const layer = card.querySelector<HTMLElement>(".pdf-highlight-layer");
    if (!layer) return;

    layer.innerHTML = "";
    const pageSids = this.pageSentences.get(pageNum);
    if (!pageSids || pageSids.length === 0) return;
    const hitSet = new Set(state.searchHits);

    for (const sid of pageSids) {
      const rects = this.sentenceRects[sid];
      const pageRects = rects.filter((r) => r.page === pageNum);
      if (pageRects.length === 0) continue;

      const isActive = sid === this.activeSid;
      const isSearchFocus = sid === state.searchFocusedSid;
      const isSearch = hitSet.has(sid);

      for (let i = 0; i < pageRects.length; i++) {
        const r = pageRects[i];
        const div = document.createElement("div");
        div.className = isActive
          ? "pdf-sent-rect active"
          : isSearchFocus
            ? "pdf-sent-rect search-focus"
            : isSearch
              ? "pdf-sent-rect search-hit"
              : "pdf-sent-rect passive";
        if (isActive && i === 0) {
          div.setAttribute("data-active-sid", "true");
        }
        if (isSearchFocus && i === 0) {
          div.setAttribute("data-search-focus", "true");
        }
        div.style.left = `${(r.x * 100).toFixed(3)}%`;
        div.style.top = `${(r.y * 100).toFixed(3)}%`;
        div.style.width = `${(r.w * 100).toFixed(3)}%`;
        div.style.height = `${(r.h * 100).toFixed(3)}%`;
        div.addEventListener("click", (e) => {
          e.stopPropagation();
          this.onSentenceClick(sid);
        });
        layer.appendChild(div);
      }
    }
  }

  public syncHighlight(sentenceIdx: number): void {
    if (!this.currentBook) return;
    const prevSid = this.activeSid;
    const prevSearch = this.prevSearchFocusedSid;
    this.activeSid = sentenceIdx;
    this.prevSearchFocusedSid = state.searchFocusedSid;

    const pagesToRefresh = new Set<number>();
    const addPages = (sid: number | null) => {
      if (sid !== null && sid >= 0 && this.sentenceRects[sid]) {
        for (const r of this.sentenceRects[sid]) pagesToRefresh.add(r.page);
      }
    };
    addPages(prevSid);
    addPages(sentenceIdx);
    addPages(prevSearch);
    addPages(state.searchFocusedSid);
    for (const pageNum of this.renderedPages) {
      pagesToRefresh.add(pageNum);
    }
    for (const p of pagesToRefresh) {
      this.renderPageHighlights(p);
    }
  }

  public scrollToPage(pageNum: number): void {
    const card = this.pageWraps.get(pageNum);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

function groupSpansIntoLines(spans: PdfSpan[]): PdfLine[] {
  if (spans.length === 0) return [];
  spans.sort((a, b) => (Math.abs(a.y - b.y) > 0.008 ? a.y - b.y : a.x - b.x));

  const lines: PdfLine[] = [];
  let curGroup: PdfSpan[] = [];
  let curY = spans[0].y;

  const flush = (group: PdfSpan[]) => {
    group.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = -1;
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;

    for (const sp of group) {
      if (prevEnd >= 0 && sp.x - prevEnd > sp.h * 0.15 && !text.endsWith(" ")) {
        text += " ";
      }
      text += sp.text;
      prevEnd = sp.x + sp.w;
      minX = Math.min(minX, sp.x);
      maxX = Math.max(maxX, sp.x + sp.w);
      minY = Math.min(minY, sp.y);
      maxY = Math.max(maxY, sp.y + sp.h);
    }
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return;

    const prevLine = lines[lines.length - 1];
    const h = Math.max(0.01, maxY - minY);
    const gap = prevLine ? minY - (prevLine.y + prevLine.h) : 0;
    const paraBreakBefore = prevLine ? gap > h * 0.95 : false;

    lines.push({
      page: group[0].page,
      text: trimmed,
      x: minX,
      y: minY,
      w: Math.max(0.01, maxX - minX),
      h,
      paraBreakBefore,
    });
  };

  for (const sp of spans) {
    if (Math.abs(sp.y - curY) <= Math.max(0.01, sp.h * 0.55)) {
      curGroup.push(sp);
    } else {
      flush(curGroup);
      curGroup = [sp];
      curY = sp.y;
    }
  }
  if (curGroup.length > 0) flush(curGroup);
  return lines;
}

/**
 * Stitches filtered PDF lines across page breaks into clean sentences,
 * preserving de-hyphenation across wrapped lines/pages and mapping each
 * sentence back to its multi-line PDF bounding rects.
 */
function buildStitchedPdfSentences(lines: PdfLine[]): {
  sentences: SentenceItem[];
  rects: RectNorm[][];
} {
  const sentences: SentenceItem[] = [];
  const rects: RectNorm[][] = [];
  if (lines.length === 0) return { sentences, rects };

  interface TokenChunk {
    text: string;
    rect: RectNorm;
    paraEnd: boolean;
  }

  // Group lines into logical paragraphs first (stitching across page boundaries when not broken)
  const paragraphs: TokenChunk[][] = [];
  let curPara: TokenChunk[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (curPara.length > 0) {
      const prev = curPara[curPara.length - 1];
      const crossedPageAfterSentence =
        line.page !== prev.rect.page &&
        /[.!?]["'”’)\]]*$/.test(prev.text.trim());
      if (line.paraBreakBefore || crossedPageAfterSentence) {
        prev.paraEnd = true;
        paragraphs.push(curPara);
        curPara = [];
      }
    }

    let lineText = line.text;
    // De-hyphenate wrapped word across line or page boundary
    if (curPara.length > 0) {
      const prev = curPara[curPara.length - 1];
      if (
        prev.text.endsWith("-") &&
        prev.text.length > 2 &&
        /^[a-z]/.test(lineText)
      ) {
        prev.text = prev.text.slice(0, -1);
      } else if (!prev.text.endsWith(" ")) {
        prev.text += " ";
      }
    }

    curPara.push({
      text: lineText,
      rect: { page: line.page, x: line.x, y: line.y, w: line.w, h: line.h },
      paraEnd: false,
    });
  }
  if (curPara.length > 0) {
    curPara[curPara.length - 1].paraEnd = true;
    paragraphs.push(curPara);
  }

  // Split each paragraph into sentences while associating approximate line rects
  let paraIdx = 0;
  for (const para of paragraphs) {
    const full = para.map((c) => c.text).join("");
    const charToRect: RectNorm[] = [];
    for (const chunk of para) {
      for (let k = 0; k < chunk.text.length; k++) {
        charToRect.push(chunk.rect);
      }
    }

    const parts = splitParagraphKeepOffsets(full);
    for (let j = 0; j < parts.length; j++) {
      const { text, start, end } = parts[j];
      const sid = sentences.length;
      const isLastInPara = j === parts.length - 1;
      const firstRect = charToRect[Math.min(start, charToRect.length - 1)];

      const uniqueRects: RectNorm[] = [];
      for (let c = start; c < end && c < charToRect.length; c++) {
        const r = charToRect[c];
        const last = uniqueRects[uniqueRects.length - 1];
        if (
          !last ||
          last.page !== r.page ||
          Math.abs(last.y - r.y) > 0.002 ||
          Math.abs(last.x - r.x) > 0.002
        ) {
          uniqueRects.push(r);
        }
      }

      sentences.push({
        id: sid,
        text,
        page: firstRect?.page ?? 1,
        paragraph_idx: paraIdx,
        is_paragraph_end: isLastInPara,
        is_section_break: false,
        chapter_idx: null,
      });
      rects.push(uniqueRects);
    }
    paraIdx++;
  }

  return { sentences, rects };
}

const MAX_PDF_SENTENCE_CHARS = 320;
const PDF_CLOSING_DELIMS = new Set(['"', "'", "”", "’", ")", "]", "}", "»", "」", "』", "】", "》", "）"]);

function splitParagraphKeepOffsets(
  paragraph: string,
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const regex = /[^.!?。！？]+(?:[.!?。！？]+["'”’)\]}»」』】》）]*|$)/g;
  let match: RegExpExecArray | null;
  let bufferStart = -1;
  let bufferText = "";

  const pushTrimmed = (rawStart: number, rawEnd: number, rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    const leadWs = rawText.length - rawText.trimStart().length;
    const trailWs = rawText.length - rawText.trimEnd().length;
    const trimmedStart = rawStart + leadWs;
    const trimmedEnd = Math.max(trimmedStart, rawEnd - trailWs);
    if (trimmed.length <= MAX_PDF_SENTENCE_CHARS) {
      out.push({ text: trimmed, start: trimmedStart, end: trimmedEnd });
    } else {
      pushOversizedPdfSentence(paragraph, trimmedStart, trimmedEnd, out);
    }
  };

  while ((match = regex.exec(paragraph)) !== null) {
    const raw = match[0];
    if (!raw.trim()) continue;
    const mStart = match.index;
    const mEnd = mStart + raw.length;

    if (bufferStart < 0) bufferStart = mStart;
    bufferText += raw;

    // Protect short abbreviations like "Dr.", "Mr.", "U.S.", decimals
    const trimmed = bufferText.trim();
    if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)|\d)\.$/.test(trimmed)) {
      continue;
    }
    pushTrimmed(bufferStart, mEnd, bufferText);
    bufferStart = -1;
    bufferText = "";
  }

  if (bufferText.trim()) {
    pushTrimmed(Math.max(0, bufferStart), paragraph.length, bufferText);
  }
  return out;
}

function pushOversizedPdfSentence(
  paragraph: string,
  start: number,
  end: number,
  out: Array<{ text: string; start: number; end: number }>,
): void {
  const trimBounds = (s: number, e: number): [number, number] | null => {
    let lo = s;
    let hi = e;
    while (lo < hi && /\s/.test(paragraph[lo])) lo++;
    while (hi > lo && /\s/.test(paragraph[hi - 1])) hi--;
    return lo < hi ? [lo, hi] : null;
  };

  const safeMid = (s: number, e: number): number => {
    let m = s + Math.floor((e - s) / 2);
    if (m > s && m < e) {
      const code = paragraph.charCodeAt(m);
      if (code >= 0xdc00 && code <= 0xdfff) {
        m = m > s + 1 ? m - 1 : m + 1;
      }
    }
    return m;
  };

  const skipClosers = (idx: number, hi: number): number => {
    let cur = idx;
    while (cur + 1 < hi && PDF_CLOSING_DELIMS.has(paragraph[cur + 1])) {
      cur++;
    }
    return cur;
  };

  const initial = trimBounds(start, end);
  if (!initial) return;
  const stack: Array<[number, number]> = [initial];

  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    const trimmed = trimBounds(s, e);
    if (!trimmed) continue;
    const [lo, hi] = trimmed;
    const len = hi - lo;
    if (len <= MAX_PDF_SENTENCE_CHARS) {
      out.push({ text: paragraph.slice(lo, hi), start: lo, end: hi });
      continue;
    }

    const mid = safeMid(lo, hi);
    const minSide = Math.max(1, Math.min(mid - lo, Math.floor(len / 4)));
    const minSplit = lo + minSide;
    const maxSplit = hi - minSide;

    let bestStrong: { dist: number; idx: number } | null = null;
    let bestComma: { dist: number; idx: number } | null = null;
    let bestWs: { dist: number; idx: number } | null = null;

    const consider = (
      slot: { dist: number; idx: number } | null,
      cand: number,
    ): { dist: number; idx: number } | null => {
      if (cand >= minSplit && cand <= maxSplit && cand > lo && cand < hi) {
        const dist = Math.abs(cand - mid);
        if (!slot || dist < slot.dist) {
          return { dist, idx: cand };
        }
      }
      return slot;
    };

    for (let i = lo; i < hi; i++) {
      const ch = paragraph[i];
      if (ch === ";" || ch === ":") {
        const endClose = skipClosers(i, hi);
        if (endClose + 1 < hi && /\s/.test(paragraph[endClose + 1])) {
          bestStrong = consider(bestStrong, endClose + 1);
        }
      } else if (ch === "—" || ch === "–" || ch === "…") {
        let endMark = i;
        while (endMark + 1 < hi && "—–…".includes(paragraph[endMark + 1])) {
          endMark++;
        }
        const endClose = skipClosers(endMark, hi);
        bestStrong = consider(bestStrong, endClose + 1);
      } else if (ch === "；" || ch === "：") {
        const endClose = skipClosers(i, hi);
        bestStrong = consider(bestStrong, endClose + 1);
      } else if (ch === ",") {
        const endClose = skipClosers(i, hi);
        if (endClose + 1 < hi && /\s/.test(paragraph[endClose + 1])) {
          bestComma = consider(bestComma, endClose + 1);
        }
      } else if (ch === "，" || ch === "、") {
        const endClose = skipClosers(i, hi);
        bestComma = consider(bestComma, endClose + 1);
      } else if (/\s/.test(ch)) {
        bestWs = consider(bestWs, i);
      }
    }

    const chosen = bestStrong?.idx ?? bestComma?.idx ?? bestWs?.idx ?? mid;
    let leftBounds = trimBounds(lo, chosen);
    let rightBounds = trimBounds(chosen, hi);

    if (
      !leftBounds ||
      !rightBounds ||
      leftBounds[1] - leftBounds[0] >= len ||
      rightBounds[1] - rightBounds[0] >= len
    ) {
      leftBounds = trimBounds(lo, mid) ?? [lo, mid];
      rightBounds = trimBounds(mid, hi) ?? [mid, hi];
    }

    stack.push(rightBounds);
    stack.push(leftBounds);
  }
}

function findPreservedPdfCursor(
  sentences: SentenceItem[],
  oldPage: number,
  oldSnippet: string,
  oldSid: number,
): number {
  if (sentences.length === 0) return 0;

  if (oldSnippet) {
    // Prefer an exact match on the current page, then adjacent pages, before falling back
    const onSamePage = sentences.findIndex(
      (s) => (s.page ?? 1) === oldPage && s.text.includes(oldSnippet),
    );
    if (onSamePage >= 0) return onSamePage;

    const nearPage = sentences.findIndex(
      (s) => Math.abs((s.page ?? 1) - oldPage) <= 1 && s.text.includes(oldSnippet),
    );
    if (nearPage >= 0) return nearPage;
  }

  const pageStart = sentences.findIndex((s) => (s.page ?? 1) >= oldPage);
  if (pageStart >= 0) return pageStart;
  return Math.min(oldSid, sentences.length - 1);
}
