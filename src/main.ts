import "./styles/tokens.css";
import "./styles/app.css";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { renderCcBar, resetCcClockForSeek, syncCcPlaybackClock } from "./components/cc_bar";
import { renderExportModal } from "./components/export_modal";
import { renderLibraryModal } from "./components/library_modal";
import { PdfViewer } from "./components/pdf_viewer";
import { RichViewer } from "./components/rich_viewer";
import { resetRulesModalDraft, renderRulesModal } from "./components/rules_modal";
import { ScrollController } from "./components/scroll_controller";
import { renderSearchBar } from "./components/search_bar";
import { renderSettingsModal } from "./components/settings_modal";
import { renderSetupModal } from "./components/setup_modal";
import { escapeHtml, renderSidebar } from "./components/sidebar";
import { renderTocBookmarksModal } from "./components/toc_bookmarks";
import {
  closeToolbarPopovers,
  hasOpenToolbarPopover,
  initToolbar,
  syncToolbar,
} from "./components/toolbar";
import {
  prepareVoiceCloneModalOpen,
  renderVoiceCloneModal,
  syncVoiceCloneDownloadProgress,
} from "./components/voice_clone_modal";
import { renderVoicePickerModal } from "./components/voice_picker";
import { Icons } from "./icons";
import { persistSettings, state, subscribe } from "./state";
import type {
  ActiveModal,
  AppBootstrap,
  BookMeta,
  DocumentPayload,
  DownloadProgressEvent,
  ExportProgressEvent,
  SleepTimerStatus,
  TtsStateEvent,
} from "./types";

const root = document.querySelector<HTMLElement>("#app")!;
root.innerHTML = `
  <div class="app-shell">
    <aside id="sidebar" class="sidebar"></aside>
    <main class="main-col">
      <header id="toolbar-host"></header>
      <div id="search-host" style="display:none;"></div>
      <div id="loading-banner" class="loading-banner hidden" role="status" aria-live="polite"></div>
      <div id="reader-viewport" class="reader-viewport">
        <div id="viewer-host" style="width:100%;display:flex;flex-direction:column;align-items:center;"></div>
      </div>
      <button id="back-to-reading-btn" class="back-to-reading-btn" type="button"></button>
      <div id="cc-host" class="cc-bar hidden"></div>
    </main>
  </div>
  <div id="modal-host"></div>
  <div id="toast-host"></div>
`;

const sidebarEl = document.getElementById("sidebar")!;
const toolbarEl = document.getElementById("toolbar-host")!;
const searchEl = document.getElementById("search-host")!;
const loadingBannerEl = document.getElementById("loading-banner")!;
const viewportEl = document.getElementById("reader-viewport")!;
const viewerHostEl = document.getElementById("viewer-host")!;
const backBtnEl = document.getElementById("back-to-reading-btn") as HTMLButtonElement;
const ccHostEl = document.getElementById("cc-host")!;
const modalHostEl = document.getElementById("modal-host")!;
const toastHostEl = document.getElementById("toast-host")!;

let busyLoadingMessage: string | null = null;
let lastBannerMessage: string | null = null;

function syncLoadingBanner(): void {
  let msg: string | null = null;
  if (busyLoadingMessage !== null) {
    msg = busyLoadingMessage;
  } else if (state.tts.status === "loading") {
    msg = state.settings.voice_id.startsWith("clone_")
      ? "Warming up Qwen3-TTS voice model, please wait..."
      : "Warming up voice model and preparing audio, please wait...";
  }
  if (msg === lastBannerMessage) return;
  lastBannerMessage = msg;
  if (msg === null) {
    loadingBannerEl.classList.add("hidden");
    loadingBannerEl.innerHTML = "";
  } else {
    loadingBannerEl.classList.remove("hidden");
    loadingBannerEl.innerHTML = `<span class="loading-spinner" aria-hidden="true"></span><span>${escapeHtml(msg)}</span>`;
  }
}

function setBusyLoading(msg: string | null): void {
  busyLoadingMessage = msg;
  syncLoadingBanner();
}

let toastTimer: number | undefined;
function showToast(msg: string): void {
  toastHostEl.innerHTML = `<div class="toast">${msg.replace(/</g, "&lt;")}</div>`;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastHostEl.innerHTML = "";
  }, 3200);
}

const scrollCtrl = new ScrollController(viewportEl, backBtnEl);

const richViewer = new RichViewer(viewerHostEl, (sid) => {
  void jumpAndPlay(sid);
});

const pdfViewer = new PdfViewer(
  viewerHostEl,
  viewportEl,
  (sid) => {
    void jumpAndPlay(sid);
  },
  async (sentences, toc, cursorIdx, preserving) => {
    state.sentences = sentences;
    state.toc = toc;
    state.tts.sentence_idx = cursorIdx;
    state.tts.total_sentences = sentences.length;
    if (state.activeBook) {
      const updated = await invoke<BookMeta>("set_pdf_sentences", {
        bookId: state.activeBook.id,
        sentences,
        cursorIdx,
        preserving,
      });
      state.activeBook = updated;
      state.library = state.library.map((b) => (b.id === updated.id ? updated : b));
    }
    renderChrome();
    pdfViewer.syncHighlight(cursorIdx);
    if (!preserving) {
      scrollCtrl.onActiveSentenceChanged(cursorIdx, true, true);
    }
  },
);

function openModal(modal: ActiveModal): void {
  if (modal === "pronunciation" || modal === "ignore") {
    resetRulesModalDraft();
  } else if (modal === "voice_clone") {
    prepareVoiceCloneModalOpen();
  }
  state.activeModal = modal;
  renderModal();
}

function closeModal(): void {
  if (state.activeModal === "setup" && !state.bootstrap?.model_ready) {
    return;
  }
  state.activeModal = null;
  renderModal();
}

async function jumpAndPlay(sentenceIdx: number): Promise<void> {
  if (!state.activeBook || state.sentences.length === 0) return;
  const clamped = Math.max(0, Math.min(sentenceIdx, state.sentences.length - 1));
  state.autoScrollEnabled = true;
  state.tts.sentence_idx = clamped;
  syncActiveHighlight();
  scrollCtrl.onActiveSentenceChanged(clamped, true);
  resetCcClockForSeek();
  try {
    state.tts = await invoke<TtsStateEvent>("tts_play_from", { sentenceIdx: clamped });
    syncCcPlaybackClock(state.tts, ccHostEl);
    renderChrome();
  } catch (err) {
    showToast(String(err));
  }
}

function jumpToSearchHit(sentenceIdx: number): void {
  if (!state.activeBook || state.sentences.length === 0) return;
  if (sentenceIdx < 0) {
    state.searchFocusedSid = null;
    syncActiveHighlight();
    return;
  }
  const clamped = Math.max(0, Math.min(sentenceIdx, state.sentences.length - 1));
  state.searchFocusedSid = clamped;
  if (state.tts.status === "playing" || state.tts.status === "loading") {
    state.autoScrollEnabled = false;
    scrollCtrl.syncBackButton();
  }
  syncActiveHighlight();
  scrollCtrl.scrollToSearchFocus();
}

function syncActiveHighlight(): void {
  if (!state.activeBook) return;
  if (state.activeBook.format === "pdf") {
    pdfViewer.syncHighlight(state.tts.sentence_idx);
  } else {
    richViewer.syncHighlight(state.tts.sentence_idx);
  }
}

async function openBookById(bookId: string): Promise<void> {
  setBusyLoading("Loading book and restoring your last reading position, please wait...");
  try {
    state.searchOpen = false;
    state.searchQuery = "";
    state.searchHits = [];
    state.searchFocusedSid = null;
    state.pdfMarginsEditing = false;
    resetCcClockForSeek();

    const payload = await invoke<DocumentPayload>("open_book", { bookId });
    state.activeBook = payload.book;
    state.library = state.library.map((b) =>
      b.id === payload.book.id ? payload.book : b,
    );
    scrollCtrl.resetForNewBook();

    if (payload.book.format === "pdf") {
      richViewer.clear();
      state.sentences = [];
      state.toc = [];
      state.htmlChapters = [];
      renderChrome();
      await pdfViewer.mountPdf(payload.book, (msg) => setBusyLoading(msg));
    } else {
      pdfViewer.clear();
      state.sentences = payload.sentences;
      state.toc = payload.toc;
      state.htmlChapters = payload.html_chapters;
      state.tts.sentence_idx = payload.book.current_sentence_idx;
      state.tts.total_sentences = payload.sentences.length;
      state.tts.word_idx = 0;
      richViewer.mountDocument(payload);
      renderChrome();
      scrollCtrl.onActiveSentenceChanged(payload.book.current_sentence_idx, true, true);
    }
  } catch (err) {
    showToast(`Failed opening book: ${String(err)}`);
  } finally {
    setBusyLoading(null);
  }
}

function renderEmptyWelcome(): void {
  if (state.activeBook) return;
  pdfViewer.clear();
  richViewer.clear();
  viewerHostEl.innerHTML = `
    <div class="empty-state" style="margin-top:14vh;">
      <div style="opacity:0.75;">${Icons.brandLogo(48)}</div>
      <h2 style="margin:0;font-size:20px;color:var(--text-primary);">BookReader</h2>
      <p style="margin:0;font-size:13.5px;line-height:1.55;">
        Open a <strong>PDF</strong>, <strong>EPUB</strong>, <strong>Word (.docx)</strong>, or <strong>TXT</strong> file to read and listen offline with Phonon 31M.
      </p>
      <div style="display:flex;gap:10px;margin-top:6px;">
        <button class="btn-primary" id="btn-empty-import">${Icons.plus()}<span>Import Book</span></button>
        <button class="btn-secondary" id="btn-empty-library">${Icons.library()}<span>Open Library</span></button>
      </div>
    </div>
  `;

  viewerHostEl.querySelector("#btn-empty-import")?.addEventListener("click", async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Books", extensions: ["pdf", "epub", "docx", "txt"] }],
    });
    if (!picked || typeof picked !== "string") return;
    const book = await invoke<BookMeta>("import_book_file", { path: picked });
    state.library = [book, ...state.library.filter((b) => b.id !== book.id)];
    await openBookById(book.id);
  });

  viewerHostEl.querySelector("#btn-empty-library")?.addEventListener("click", () => {
    openModal("library");
  });
}

function renderChrome(): void {
  renderSidebar(sidebarEl, {
    onOpenModal: openModal,
  });

  syncToolbar();

  renderCcBar(ccHostEl);
  syncLoadingBanner();
  scrollCtrl.syncBackButton();
  if (!state.activeBook) {
    renderEmptyWelcome();
  }
}

function applyPageZoom(nextRaw: number): void {
  if (!state.activeBook) return;
  const next = Math.max(0.6, Math.min(2.2, Number(nextRaw.toFixed(2))));
  const t = state.settings.typography;
  if (state.activeBook.format === "pdf") {
    if (Math.abs(next - t.pdf_zoom) < 0.001) return;
    void persistSettings({ typography: { ...t, pdf_zoom: next } });
    pdfViewer.rebuildForZoom();
  } else {
    if (Math.abs(next - t.reader_zoom) < 0.001) return;
    void persistSettings({ typography: { ...t, reader_zoom: next } });
    richViewer.applyTypography();
  }
}

function stepPageZoom(delta: number): void {
  if (!state.activeBook) return;
  const t = state.settings.typography;
  const cur = state.activeBook.format === "pdf" ? t.pdf_zoom : t.reader_zoom;
  applyPageZoom(cur + delta);
}

function resetPageZoom(): void {
  applyPageZoom(1.0);
}

function togglePdfInvert(): void {
  if (state.activeBook?.format !== "pdf") return;
  void persistSettings({ pdf_invert_dark: !state.settings.pdf_invert_dark });
}

function applyCcSize(nextRaw: number): void {
  const next = Math.max(14, Math.min(48, Math.round(nextRaw)));
  const t = state.settings.typography;
  if (next === t.cc_font_size) return;
  void persistSettings({ typography: { ...t, cc_font_size: next } });
}

function mountToolbarOnce(): void {
  initToolbar(toolbarEl, {
    onOpenModal: openModal,
    onTogglePlay: () => {
      void (async () => {
        try {
          state.tts = await invoke<TtsStateEvent>("tts_toggle_play_pause");
          syncCcPlaybackClock(state.tts, ccHostEl);
          renderChrome();
        } catch (err) {
          showToast(String(err));
        }
      })();
    },
    onStep: (delta) => {
      void (async () => {
        state.autoScrollEnabled = true;
        resetCcClockForSeek();
        state.tts = await invoke<TtsStateEvent>("tts_step_sentence", { delta });
        syncCcPlaybackClock(state.tts, ccHostEl);
        syncActiveHighlight();
        scrollCtrl.onActiveSentenceChanged(state.tts.sentence_idx, true);
        renderChrome();
      })();
    },
    onSeekSentence: (idx) => {
      void jumpAndPlay(idx);
    },
    onZoomStep: stepPageZoom,
    onZoomReset: resetPageZoom,
    onTogglePdfInvert: togglePdfInvert,
    onCcSizeStep: (delta) => applyCcSize(state.settings.typography.cc_font_size + delta),
    onCcSizeReset: () => applyCcSize(21),
    onToggleSearch: () => {
      state.searchOpen = !state.searchOpen;
      if (!state.searchOpen) {
        state.searchHits = [];
        state.searchFocusedSid = null;
        syncActiveHighlight();
      }
      renderSearch();
      renderChrome();
    },
    onToggleMarginsEdit: () => {
      if (state.activeBook?.format !== "pdf") return;
      state.pdfMarginsEditing = !state.pdfMarginsEditing;
      pdfViewer.refreshMarginOverlayUI();
      renderChrome();
    },
    onAddBookmark: () => {
      void (async () => {
        if (!state.activeBook) return;
        const idx = state.tts.sentence_idx;
        const sent = state.sentences[idx];
        const label = sent ? sent.text.slice(0, 44) : `Sentence ${idx + 1}`;
        const updated = await invoke<BookMeta>("add_bookmark", {
          bookId: state.activeBook.id,
          label,
          sentenceIdx: idx,
          page: sent?.page ?? null,
        });
        state.activeBook = updated;
        state.library = state.library.map((b) => (b.id === updated.id ? updated : b));
        showToast("Bookmark added");
      })();
    },
  });
}

function renderSearch(): void {
  renderSearchBar(searchEl, {
    onJumpToSentence: (sid) => {
      jumpToSearchHit(sid);
    },
    onClose: () => {
      state.searchOpen = false;
      state.searchHits = [];
      state.searchFocusedSid = null;
      syncActiveHighlight();
      renderSearch();
      renderChrome();
    },
  });
}

function renderModal(): void {
  switch (state.activeModal) {
    case null:
      modalHostEl.innerHTML = "";
      return;
    case "setup":
      renderSetupModal(modalHostEl, {
        onReady: async () => {
          const boot = await invoke<AppBootstrap>("get_bootstrap");
          state.bootstrap = boot;
          state.voices = boot.voices;
          state.activeModal = null;
          renderModal();
          renderChrome();
          showToast("Phonon 31M ready!");
        },
      });
      return;
    case "library":
      renderLibraryModal(modalHostEl, {
        onOpenBook: openBookById,
        onClose: closeModal,
        onLibraryChanged: () => {
          renderChrome();
        },
      });
      return;
    case "pronunciation":
      renderRulesModal(modalHostEl, "pronunciation", {
        onClose: closeModal,
        onUpdated: renderChrome,
        onToast: showToast,
      });
      return;
    case "ignore":
      renderRulesModal(modalHostEl, "ignore", {
        onClose: closeModal,
        onUpdated: renderChrome,
        onToast: showToast,
      });
      return;
    case "voices":
      renderVoicePickerModal(modalHostEl, {
        onClose: closeModal,
        onChanged: renderChrome,
        onToast: showToast,
        onOpenVoiceClone: () => openModal("voice_clone"),
      });
      return;
    case "toc":
      renderTocBookmarksModal(modalHostEl, {
        onJumpSentence: (sid) => {
          void jumpAndPlay(sid);
        },
        onClose: closeModal,
        onChanged: renderChrome,
      });
      return;
    case "export":
      renderExportModal(modalHostEl, {
        onClose: closeModal,
        onToast: showToast,
      });
      return;
    case "voice_clone":
      renderVoiceCloneModal(modalHostEl, {
        onClose: closeModal,
        onChanged: renderChrome,
        onToast: showToast,
      });
      return;
    case "settings":
      renderSettingsModal(modalHostEl, {
        onClose: closeModal,
        onTypographyChanged: () => richViewer.applyTypography(),
      });
      return;
  }
}

async function initApp(): Promise<void> {
  setBusyLoading("Warming up voice model and loading library, please wait...");
  viewerHostEl.innerHTML = `
    <div class="pdf-loading-card">
      <span class="loading-spinner" aria-hidden="true"></span>
      <span>Warming up voice model and loading your last book, please wait...</span>
    </div>
  `;

  let boot: AppBootstrap;
  try {
    boot = await invoke<AppBootstrap>("get_bootstrap");
  } catch (err) {
    setBusyLoading(null);
    showToast(`Startup failed: ${String(err)}`);
    throw err;
  }

  state.bootstrap = boot;
  state.settings = boot.settings;
  state.library = boot.library;
  state.pronunciations = boot.pronunciations;
  state.ignoreRules = boot.ignore_rules;
  state.voices = boot.voices;

  document.documentElement.setAttribute("data-theme", boot.settings.theme);

  await listen<TtsStateEvent>("tts:state", (ev) => {
    const prevSid = state.tts.sentence_idx;
    const prevWord = state.tts.word_idx;
    const prevStatus = state.tts.status;
    state.tts = ev.payload;

    if (ev.payload.error && ev.payload.status === "error" && prevStatus !== "error") {
      showToast(ev.payload.error);
    }

    syncCcPlaybackClock(ev.payload, ccHostEl);

    if (prevStatus !== ev.payload.status) {
      syncLoadingBanner();
    }
    if (prevSid !== ev.payload.sentence_idx) {
      syncActiveHighlight();
      scrollCtrl.onActiveSentenceChanged(ev.payload.sentence_idx);
    }
    if (
      prevSid !== ev.payload.sentence_idx ||
      prevStatus !== ev.payload.status
    ) {
      renderChrome();
    } else if (prevWord !== ev.payload.word_idx) {
      renderCcBar(ccHostEl);
    }
  });

  await listen<DownloadProgressEvent>("download:progress", (ev) => {
    state.downloadProgress = ev.payload;
    if (state.activeModal === "setup") {
      renderModal();
    } else if (state.activeModal === "voice_clone" && ev.payload.kind === "qwen_model") {
      syncVoiceCloneDownloadProgress(modalHostEl);
    }
  });

  await listen<ExportProgressEvent>("export:progress", (ev) => {
    state.exportProgress = ev.payload;
    renderSidebar(sidebarEl, { onOpenModal: openModal });
    if (state.activeModal === "export") {
      renderModal();
    }
    if (ev.payload.status === "completed") {
      showToast(`Export complete: ${ev.payload.output_path}`);
    } else if (ev.payload.status === "error" && ev.payload.error) {
      showToast(`Export error: ${ev.payload.error}`);
    }
  });

  await listen<SleepTimerStatus>("sleep:tick", (ev) => {
    state.sleepTimer = ev.payload;
    renderChrome();
  });

  subscribe(() => {
    renderChrome();
  });

  mountToolbarOnce();
  const autoOpenBookId =
    boot.model_ready &&
    boot.settings.last_book_id &&
    boot.library.some((b) => b.id === boot.settings.last_book_id)
      ? boot.settings.last_book_id
      : null;

  if (!autoOpenBookId) {
    setBusyLoading(null);
    renderChrome();
    if (!boot.model_ready) {
      openModal("setup");
    }
  } else {
    renderSidebar(sidebarEl, { onOpenModal: openModal });
    syncToolbar();
    renderCcBar(ccHostEl);
    scrollCtrl.syncBackButton();
    syncLoadingBanner();
    await openBookById(autoOpenBookId);
  }
}

document.addEventListener("click", () => {
  if (hasOpenToolbarPopover()) {
    closeToolbarPopovers();
  }
});

subscribe(() => {
  pdfViewer.syncDarkInvert();
});

let wheelZoomAccum = 0;
viewportEl.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!state.activeBook || state.activeModal !== null) return;
    e.preventDefault();
    wheelZoomAccum += -e.deltaY;
    if (Math.abs(wheelZoomAccum) >= 50) {
      const dir = wheelZoomAccum > 0 ? 1 : -1;
      wheelZoomAccum = 0;
      stepPageZoom(dir * 0.1);
    }
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  const inInput =
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable);

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    if (state.activeBook && state.activeModal === null) {
      e.preventDefault();
      state.searchOpen = true;
      renderSearch();
      renderChrome();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !inInput && state.activeModal === null && state.activeBook) {
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      stepPageZoom(0.1);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      stepPageZoom(-0.1);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      resetPageZoom();
      return;
    }
  }

  if (e.key === "Escape") {
    if (state.activeModal !== null) {
      closeModal();
      return;
    }
    if (state.searchOpen) {
      state.searchOpen = false;
      state.searchHits = [];
      state.searchFocusedSid = null;
      syncActiveHighlight();
      renderSearch();
      renderChrome();
    }
    return;
  }

  if (inInput || state.activeModal !== null || !state.activeBook) {
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    void (async () => {
      try {
        state.tts = await invoke<TtsStateEvent>("tts_toggle_play_pause");
        syncCcPlaybackClock(state.tts, ccHostEl);
        renderChrome();
      } catch (err) {
        showToast(String(err));
      }
    })();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    void (async () => {
      state.autoScrollEnabled = true;
      resetCcClockForSeek();
      state.tts = await invoke<TtsStateEvent>("tts_step_sentence", { delta: -1 });
      syncCcPlaybackClock(state.tts, ccHostEl);
      syncActiveHighlight();
      scrollCtrl.onActiveSentenceChanged(state.tts.sentence_idx, true);
      renderChrome();
    })();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    void (async () => {
      state.autoScrollEnabled = true;
      resetCcClockForSeek();
      state.tts = await invoke<TtsStateEvent>("tts_step_sentence", { delta: 1 });
      syncCcPlaybackClock(state.tts, ccHostEl);
      syncActiveHighlight();
      scrollCtrl.onActiveSentenceChanged(state.tts.sentence_idx, true);
      renderChrome();
    })();
  }
});

void initApp();
