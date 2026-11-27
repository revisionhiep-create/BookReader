import "./styles/tokens.css";
import "./styles/app.css";
import "../android/ui/android.css";

import {
  attachModalHostPageSwipeToDismiss,
  closeAllMobileOverlays,
  initMobileChrome,
  syncMobileChrome,
} from "../android/ui/mobile_chrome";
import { invoke, listen } from "./tauri_bridge";
import { renderCcBar, resetCcClockForSeek, syncCcPlaybackClock } from "./components/cc_bar";
import { renderExportModal } from "./components/export_modal";
import {
  pickAndImportBook,
  renderLibraryModal,
  resetLibrarySearch,
  sortLibraryByRecent,
} from "./components/library_modal";
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
  rerenderToolbar,
  syncToolbar,
} from "./components/toolbar";
import {
  prepareVoiceCloneModalOpen,
  renderVoiceCloneModal,
  syncVoiceCloneDownloadProgress,
} from "./components/voice_clone_modal";
import { renderVoicePickerModal } from "./components/voice_picker";
import { getLanguageMeta, setActiveUiLanguage, tr } from "./i18n";
import { Icons } from "./icons";
import {
  applySettingsSideEffects,
  isAndroidPlatform,
  isPreviewAndroidMode,
  isVoiceCloningEnabled,
  persistSettings,
  state,
  subscribe,
} from "./state";
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

if (isPreviewAndroidMode() || /Android/i.test(navigator.userAgent)) {
  document.documentElement.setAttribute("data-platform", "android");
}

const root = document.querySelector<HTMLElement>("#app")!;
root.innerHTML = `
  <div class="app-shell">
    <div id="mobile-drawer-backdrop" class="mobile-drawer-backdrop"></div>
    <aside id="sidebar" class="sidebar"></aside>
    <main class="main-col">
      <div id="mobile-topbar-host" class="mobile-topbar-host"></div>
      <header id="toolbar-host"></header>
      <div id="search-host" style="display:none;"></div>
      <div id="loading-banner" class="loading-banner hidden" role="status" aria-live="polite"></div>
      <div id="reader-viewport" class="reader-viewport">
        <div id="viewer-host" style="width:100%;max-width:100%;display:flex;flex-direction:column;align-items:flex-start;"></div>
      </div>
      <button id="back-to-reading-btn" class="back-to-reading-btn" type="button"></button>
      <div id="cc-host" class="cc-bar hidden"></div>
      <div id="mobile-dock-host" class="mobile-dock-host"></div>
    </main>
  </div>
  <div id="mobile-sheet-host" class="mobile-sheet-host"></div>
  <div id="modal-host"></div>
  <div id="toast-host"></div>
`;

const sidebarEl = document.getElementById("sidebar")!;
const mobileDrawerBackdropEl = document.getElementById("mobile-drawer-backdrop")!;
const mobileTopbarHostEl = document.getElementById("mobile-topbar-host")!;
const toolbarEl = document.getElementById("toolbar-host")!;
const searchEl = document.getElementById("search-host")!;
const loadingBannerEl = document.getElementById("loading-banner")!;
const viewportEl = document.getElementById("reader-viewport")!;
const viewerHostEl = document.getElementById("viewer-host")!;
const backBtnEl = document.getElementById("back-to-reading-btn") as HTMLButtonElement;
const ccHostEl = document.getElementById("cc-host")!;
const mobileDockHostEl = document.getElementById("mobile-dock-host")!;
const mobileSheetHostEl = document.getElementById("mobile-sheet-host")!;
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
      ? tr("loading_warming_qwen")
      : tr("loading_warming_voice");
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
  if (modal === "voice_clone" && !isVoiceCloningEnabled()) {
    return;
  }
  state.quickReaderSheetOpen = false;
  state.mobilePopoverSheet = null;
  state.mobileDrawerOpen = false;
  if (modal === "pronunciation" || modal === "ignore") {
    resetRulesModalDraft();
  } else if (modal === "library") {
    resetLibrarySearch();
  } else if (modal === "voice_clone") {
    prepareVoiceCloneModalOpen();
  }
  state.activeModal = modal;
  renderModal();
  if (isAndroidPlatform()) {
    syncMobileChrome();
  }
}

function closeModal(): void {
  if (state.activeModal === "setup" && !state.bootstrap?.model_ready) {
    return;
  }
  state.activeModal = null;
  renderModal();
}

let ttsActionInFlight = false;
let seekRequestSeq = 0;
let pendingSeekTarget: number | null = null;

async function runTtsAction<T>(
  busyHint: string | null,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (ttsActionInFlight) return null;
  ttsActionInFlight = true;
  let hintTimer: number | undefined;
  let showedBusy = false;
  if (busyHint) {
    hintTimer = window.setTimeout(() => {
      showedBusy = true;
      setBusyLoading(busyHint);
    }, 180);
  }
  try {
    return await fn();
  } finally {
    if (hintTimer !== undefined) window.clearTimeout(hintTimer);
    if (showedBusy && busyLoadingMessage === busyHint) {
      setBusyLoading(null);
    }
    ttsActionInFlight = false;
  }
}

async function jumpAndPlay(sentenceIdx: number): Promise<void> {
  if (!state.activeBook || state.sentences.length === 0) return;
  const clamped = Math.max(0, Math.min(sentenceIdx, state.sentences.length - 1));
  const mySeq = ++seekRequestSeq;
  pendingSeekTarget = clamped;
  state.autoScrollEnabled = true;
  state.tts = {
    ...state.tts,
    status: "loading",
    sentence_idx: clamped,
    word_idx: 0,
    playback_ms: 0,
    sentence_duration_ms: 0,
    word_starts_ms: undefined,
    error: null,
  };
  syncLoadingBanner();
  syncActiveHighlight();
  scrollCtrl.onActiveSentenceChanged(clamped, true);
  resetCcClockForSeek();
  renderChrome();

  try {
    const res = await invoke<TtsStateEvent>("tts_play_from", { sentenceIdx: clamped });
    if (mySeq !== seekRequestSeq) return;
    pendingSeekTarget = null;
    state.tts = res;
    syncCcPlaybackClock(state.tts, ccHostEl);
    syncLoadingBanner();
    syncActiveHighlight();
    renderChrome();
  } catch (err) {
    if (mySeq !== seekRequestSeq) return;
    pendingSeekTarget = null;
    showToast(String(err));
    try {
      state.tts = await invoke<TtsStateEvent>("get_tts_state");
    } catch {
      state.tts = { ...state.tts, status: "paused" };
    }
    syncCcPlaybackClock(state.tts, ccHostEl);
    syncLoadingBanner();
    syncActiveHighlight();
    renderChrome();
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
  setBusyLoading(tr("loading_book_restore"));
  try {
    state.searchOpen = false;
    state.searchQuery = "";
    state.searchHits = [];
    state.searchFocusedSid = null;
    state.pdfMarginsEditing = false;
    resetCcClockForSeek();

    const payload = await invoke<DocumentPayload>("open_book", { bookId });
    state.activeBook = payload.book;
    state.library = [
      payload.book,
      ...state.library.filter((b) => b.id !== payload.book.id),
    ];
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
    showToast(tr("toast_open_book_failed", { error: String(err) }));
  } finally {
    setBusyLoading(null);
  }
}

function renderEmptyWelcome(): void {
  if (state.activeBook) return;
  pdfViewer.clear();
  richViewer.clear();
  const activeMeta = getLanguageMeta(state.settings.tts_language ?? "en");
  const modelLabel = `${activeMeta.modelName} (${activeMeta.nativeName})`;
  viewerHostEl.innerHTML = `
    <div class="empty-state" style="margin-top:14vh;">
      <div style="opacity:0.75;">${Icons.brandLogo(48)}</div>
      <h2 style="margin:0;font-size:20px;color:var(--text-primary);">${escapeHtml(tr("app_title"))}</h2>
      <p style="margin:0;font-size:13.5px;line-height:1.55;">
        ${escapeHtml(tr("empty_welcome_desc", { formats: "PDF / EPUB / DOCX / TXT", model: modelLabel }))}
      </p>
      <div style="display:flex;gap:10px;margin-top:6px;">
        <button class="btn-primary" id="btn-empty-import">${Icons.plus()}<span>${escapeHtml(tr("empty_import_book"))}</span></button>
        <button class="btn-secondary" id="btn-empty-library">${Icons.library()}<span>${escapeHtml(tr("empty_open_library"))}</span></button>
      </div>
    </div>
  `;

  viewerHostEl.querySelector("#btn-empty-import")?.addEventListener("click", async () => {
    try {
      const book = await pickAndImportBook((msg) => setBusyLoading(msg));
      if (!book) return;
      state.library = [book, ...state.library.filter((b) => b.id !== book.id)];
      await openBookById(book.id);
    } catch (err) {
      showToast(tr("toast_import_failed", { error: String(err) }));
    } finally {
      setBusyLoading(null);
    }
  });

  viewerHostEl.querySelector("#btn-empty-library")?.addEventListener("click", () => {
    openModal("library");
  });
}

function renderSidebarChrome(): void {
  renderSidebar(sidebarEl, {
    onOpenModal: openModal,
    onCloseDrawer: () => {
      state.mobileDrawerOpen = false;
      syncMobileChrome();
    },
  });
}

let desktopCcResizeObserver: ResizeObserver | null = null;

function syncDesktopCcHeight(): void {
  if (isAndroidPlatform()) return;
  const ccVisible = state.settings.cc_enabled && !ccHostEl.classList.contains("hidden");
  const h = ccVisible ? Math.round(ccHostEl.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty("--desktop-cc-height", `${h}px`);
  scrollCtrl.syncBackButton();
}

function renderChrome(): void {
  renderSidebarChrome();

  syncToolbar();
  renderCcBar(ccHostEl);
  syncDesktopCcHeight();
  if (isAndroidPlatform()) {
    syncMobileChrome();
  }
  syncLoadingBanner();
  scrollCtrl.syncBackButton();
  if (!state.activeBook) {
    renderEmptyWelcome();
  }
}

function rerenderAllChrome(): void {
  document.title = tr("app_title");
  rerenderToolbar();
  scrollCtrl.syncLabels();
  lastBannerMessage = null;
  renderChrome();
  if (state.searchOpen) {
    renderSearch();
  }
  if (state.activeModal !== null) {
    renderModal();
  }
}

let shownPdfReflowHint = false;

function applyPageZoom(nextRaw: number): void {
  if (!state.activeBook) return;
  const next = Math.max(0.6, Math.min(2.2, Number(nextRaw.toFixed(2))));
  const t = state.settings.typography;
  if (state.activeBook.format === "pdf") {
    if (Math.abs(next - t.pdf_zoom) < 0.001) return;
    void persistSettings({ typography: { ...t, pdf_zoom: next } });
    pdfViewer.rebuildForZoom();
    if (
      isAndroidPlatform() &&
      !state.settings.pdf_reflow &&
      next > 1.05 &&
      !shownPdfReflowHint
    ) {
      shownPdfReflowHint = true;
      showToast(tr("toast_pdf_reflow_hint"));
    }
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

function setPdfReflow(enabled: boolean): void {
  if (state.activeBook?.format !== "pdf") return;
  if (enabled && state.pdfMarginsEditing) {
    state.pdfMarginsEditing = false;
  }
  void persistSettings({ pdf_reflow: enabled });
  pdfViewer.setReflowMode(enabled);
  renderChrome();
  scrollCtrl.onActiveSentenceChanged(state.tts.sentence_idx, true, true);
}

function applyCcSize(nextRaw: number): void {
  const next = Math.max(14, Math.min(48, Math.round(nextRaw)));
  const t = state.settings.typography;
  if (next === t.cc_font_size) return;
  void persistSettings({ typography: { ...t, cc_font_size: next } });
}

function getPlaybackActions() {
  return {
    onOpenModal: openModal,
    onTogglePlay: () => {
      pendingSeekTarget = null;
      seekRequestSeq++;
      const willStart =
        state.tts.status !== "playing" && state.tts.status !== "loading";
      void (async () => {
        const res = await runTtsAction(
          willStart ? tr("loading_waking_audio") : null,
          async () => {
            try {
              return await invoke<TtsStateEvent>("tts_toggle_play_pause");
            } catch (err) {
              showToast(String(err));
              return null;
            }
          },
        );
        if (res) {
          state.tts = res;
          syncCcPlaybackClock(state.tts, ccHostEl);
          renderChrome();
        }
      })();
    },
    onStep: (delta: number) => {
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
    onSeekSentence: (idx: number) => {
      void jumpAndPlay(idx);
    },
    onZoomStep: stepPageZoom,
    onZoomReset: resetPageZoom,
    onTogglePdfInvert: togglePdfInvert,
    onTogglePdfReflow: () => setPdfReflow(!state.settings.pdf_reflow),
    onCcSizeStep: (delta: number) => applyCcSize(state.settings.typography.cc_font_size + delta),
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
      const next = !state.pdfMarginsEditing;
      state.pdfMarginsEditing = next;
      if (next && state.settings.pdf_reflow) {
        void persistSettings({ pdf_reflow: false });
        pdfViewer.setReflowMode(false);
        showToast(tr("toast_switched_original_margins"));
      }
      pdfViewer.refreshMarginOverlayUI();
      renderChrome();
    },
    onAddBookmark: () => {
      void (async () => {
        if (!state.activeBook) return;
        const idx = state.tts.sentence_idx;
        const sent = state.sentences[idx];
        const label = sent ? sent.text.slice(0, 44) : tr("bookmark_sentence_label", { num: idx + 1 });
        const updated = await invoke<BookMeta>("add_bookmark", {
          bookId: state.activeBook.id,
          label,
          sentenceIdx: idx,
          page: sent?.page ?? null,
        });
        state.activeBook = updated;
        state.library = state.library.map((b) => (b.id === updated.id ? updated : b));
        showToast(tr("toast_bookmark_added"));
      })();
    },
  };
}

function mountToolbarOnce(): void {
  const actions = getPlaybackActions();
  initToolbar(toolbarEl, actions);
  if (isAndroidPlatform()) {
    initMobileChrome(
      {
        topbarHost: mobileTopbarHostEl,
        dockHost: mobileDockHostEl,
        drawerBackdrop: mobileDrawerBackdropEl,
        sheetHost: mobileSheetHostEl,
        ccHost: ccHostEl,
        sidebarHost: sidebarEl,
      },
      {
        ...actions,
        onTogglePdfReflow: setPdfReflow,
        onTypographyChanged: () => {
          richViewer.applyTypography();
          pdfViewer.applyReflowTypography();
        },
        onLayoutChanged: () => scrollCtrl.syncBackButton(),
        onToast: showToast,
      },
    );
    attachModalHostPageSwipeToDismiss(
      modalHostEl,
      () =>
        state.activeModal !== null &&
        state.activeModal !== "setup" &&
        state.activeModal !== "voices",
      closeModal,
    );
  }
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
        onLanguageChanged: () => {
          rerenderToolbar();
          scrollCtrl.syncLabels();
          renderChrome();
        },
        onReady: async () => {
          const boot = await invoke<AppBootstrap>("get_bootstrap");
          state.bootstrap = boot;
          state.settings = boot.settings;
          applySettingsSideEffects(boot.settings);
          state.voices = boot.voices;
          state.activeModal = null;
          renderModal();
          rerenderAllChrome();
          const activeMeta = getLanguageMeta(boot.settings.tts_language ?? "en");
          showToast(tr("toast_model_ready", { model: `${activeMeta.modelName} · ${activeMeta.nativeName}` }));
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
        onToast: showToast,
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
        onOpenSettings: () => openModal("settings"),
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
        onTypographyChanged: () => {
          richViewer.applyTypography();
          pdfViewer.applyReflowTypography();
        },
        onLanguageChanged: rerenderAllChrome,
        onTtsModelsUpdated: renderChrome,
        onToast: showToast,
      });
      return;
  }
}

async function initApp(): Promise<void> {
  if (isPreviewAndroidMode() && !window.__TAURI_INTERNALS__) {
    const mod = await import("../android/preview/mock_tauri");
    mod.installPreviewMock();
    document.documentElement.setAttribute("data-preview", "true");
    installPreviewTouchScroll();
    attachPreviewMessageHandler();
  }

  setActiveUiLanguage(null);
  document.title = tr("app_title");
  setBusyLoading(tr("loading_startup_voice_library"));
  viewerHostEl.innerHTML = `
    <div class="pdf-loading-card">
      <span class="loading-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(tr("loading_startup_voice_book"))}</span>
    </div>
  `;

  let boot: AppBootstrap | null = null;
  let lastBootErr: unknown = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      boot = await invoke<AppBootstrap>("get_bootstrap");
      break;
    } catch (err) {
      lastBootErr = err;
      await new Promise((r) => window.setTimeout(r, 250));
    }
  }
  if (!boot) {
    setBusyLoading(null);
    const errMsg = String(lastBootErr ?? tr("boot_unknown_error"));
    showToast(tr("toast_startup_failed", { error: errMsg }));
    viewerHostEl.innerHTML = `
      <div class="empty-welcome">
        <h2>${escapeHtml(tr("boot_error_title"))}</h2>
        <p>${escapeHtml(errMsg)}</p>
        <div style="display:flex;gap:10px;">
          <button class="btn-primary" id="btn-boot-retry">${escapeHtml(tr("common_retry"))}</button>
        </div>
      </div>
    `;
    viewerHostEl.querySelector("#btn-boot-retry")?.addEventListener("click", () => {
      void initApp();
    });
    return;
  }

  state.bootstrap = boot;
  state.settings = boot.settings;
  state.library = sortLibraryByRecent(boot.library);
  state.pronunciations = boot.pronunciations;
  state.ignoreRules = boot.ignore_rules;
  state.voices = boot.voices;

  applySettingsSideEffects(boot.settings);
  document.title = tr("app_title");
  document.documentElement.setAttribute(
    "data-platform",
    isPreviewAndroidMode() ? "android" : boot.platform,
  );

  await listen<TtsStateEvent>("tts:state", (ev) => {
    if (pendingSeekTarget !== null && ev.payload.sentence_idx !== pendingSeekTarget) {
      return;
    }
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
    if (ev.payload.kind !== "model" && ev.payload.kind !== "qwen_model") {
      return;
    }
    state.downloadProgress = ev.payload;
    if (state.activeModal === "setup" && ev.payload.kind === "model") {
      renderModal();
    } else if (state.activeModal === "settings" && ev.payload.kind === "model") {
      renderModal();
    } else if (state.activeModal === "voice_clone" && ev.payload.kind === "qwen_model") {
      syncVoiceCloneDownloadProgress(modalHostEl);
    }
  });

  await listen<ExportProgressEvent>("export:progress", (ev) => {
    state.exportProgress = ev.payload;
    renderSidebarChrome();
    if (state.activeModal === "export") {
      renderModal();
    }
    if (ev.payload.status === "completed") {
      showToast(tr("toast_export_complete", { path: ev.payload.output_path }));
    } else if (ev.payload.status === "error" && ev.payload.error) {
      showToast(tr("toast_export_error", { error: ev.payload.error }));
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
  if (!isAndroidPlatform() && typeof ResizeObserver !== "undefined" && !desktopCcResizeObserver) {
    desktopCcResizeObserver = new ResizeObserver(() => {
      syncDesktopCcHeight();
    });
    desktopCcResizeObserver.observe(ccHostEl);
  }
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
    renderSidebarChrome();
    syncToolbar();
    renderCcBar(ccHostEl);
    syncDesktopCcHeight();
    scrollCtrl.syncBackButton();
    syncLoadingBanner();
    await openBookById(autoOpenBookId);
  }

  if (isPreviewAndroidMode()) {
    window.parent?.postMessage({ type: "preview:ready" }, window.location.origin);
  }
}

document.addEventListener("click", () => {
  if (hasOpenToolbarPopover()) {
    closeToolbarPopovers();
  }
});

let visibilitySyncInFlight = false;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.bootstrap || visibilitySyncInFlight) return;
  visibilitySyncInFlight = true;
  void (async () => {
    try {
      const evt = await invoke<TtsStateEvent>("get_tts_state");
      const prevSid = state.tts.sentence_idx;
      const sameBook = Boolean(state.activeBook && evt.book_id === state.activeBook.id);
      state.tts = evt;
      syncCcPlaybackClock(evt, ccHostEl);
      syncLoadingBanner();
      if (sameBook && prevSid !== evt.sentence_idx) {
        syncActiveHighlight();
        scrollCtrl.onActiveSentenceChanged(evt.sentence_idx);
      }
      renderChrome();
    } catch {
      // Ignore transient visibility sync errors while WebView resumes
    } finally {
      visibilitySyncInFlight = false;
    }
  })();
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
    if (state.activeModal === "library") {
      e.preventDefault();
      const libInput = modalHostEl.querySelector<HTMLInputElement>("#library-search-input");
      if (libInput) {
        libInput.focus();
        libInput.select();
      }
      return;
    }
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
    if (isAndroidPlatform() && closeAllMobileOverlays()) {
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
    pendingSeekTarget = null;
    seekRequestSeq++;
    const willStart =
      state.tts.status !== "playing" && state.tts.status !== "loading";
    void (async () => {
      const res = await runTtsAction(
        willStart ? tr("loading_waking_audio") : null,
        async () => {
          try {
            return await invoke<TtsStateEvent>("tts_toggle_play_pause");
          } catch (err) {
            showToast(String(err));
            return null;
          }
        },
      );
      if (res) {
        state.tts = res;
        syncCcPlaybackClock(state.tts, ccHostEl);
        renderChrome();
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

let pinchStartDist: number | null = null;
let pinchLastAppliedDist = 0;

viewportEl.addEventListener(
  "touchstart",
  (e) => {
    if (!isAndroidPlatform() || e.touches.length !== 2) return;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStartDist = Math.hypot(dx, dy);
    pinchLastAppliedDist = pinchStartDist;
  },
  { passive: true },
);

viewportEl.addEventListener(
  "touchmove",
  (e) => {
    if (!isAndroidPlatform() || pinchStartDist === null || e.touches.length !== 2) return;
    if (!state.activeBook || state.activeModal !== null) return;
    if (e.cancelable) e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    const delta = dist - pinchLastAppliedDist;
    if (Math.abs(delta) >= 34) {
      pinchLastAppliedDist = dist;
      stepPageZoom(delta > 0 ? 0.1 : -0.1);
    }
  },
  { passive: false },
);

const clearPinch = (e: TouchEvent) => {
  if (e.touches.length < 2) {
    pinchStartDist = null;
  }
};
viewportEl.addEventListener("touchend", clearPinch, { passive: true });
viewportEl.addEventListener("touchcancel", clearPinch, { passive: true });

function installPreviewTouchScroll(): void {
  let activeEl: HTMLElement | null = null;
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastTs = 0;
  let vx = 0;
  let vy = 0;
  let dragging = false;
  let momentumRaf = 0;

  const stopMomentum = () => {
    if (momentumRaf) {
      window.cancelAnimationFrame(momentumRaf);
      momentumRaf = 0;
    }
  };

  const findScrollContainer = (target: EventTarget | null): HTMLElement | null => {
    let el = target instanceof HTMLElement ? target : null;
    while (el) {
      if (
        el.matches(".reader-viewport, .modal-body, .sidebar-nav, .rules-list, .cc-bar") &&
        (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  };

  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (document.documentElement.dataset.swipeDismissActive === "1") return;
    const targetEl = e.target as HTMLElement | null;
    if (
      targetEl?.closest(
        "input, textarea, select, button, a, label, .ignore-handle, #m-progress-track, #progress-seek-track",
      )
    ) {
      return;
    }
    const scroller = findScrollContainer(e.target);
    if (!scroller) return;

    stopMomentum();
    activeEl = scroller;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    lastTs = performance.now();
    vx = 0;
    vy = 0;
    dragging = false;
  });

  document.addEventListener("pointermove", (e) => {
    if (!activeEl || e.pointerId !== pointerId) return;
    if (document.documentElement.dataset.swipeDismissActive === "1") {
      activeEl = null;
      pointerId = -1;
      dragging = false;
      document.documentElement.classList.remove("preview-dragging");
      return;
    }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    const totalDist = Math.hypot(e.clientX - startX, e.clientY - startY);

    if (!dragging) {
      if (totalDist < 6) return;
      dragging = true;
      document.documentElement.classList.add("preview-dragging");
      if (activeEl.id === "reader-viewport") {
        scrollCtrl.markManualScroll();
      }
    }

    const now = performance.now();
    const dt = Math.max(1, now - lastTs);
    vx = dx / dt;
    vy = dy / dt;
    lastX = e.clientX;
    lastY = e.clientY;
    lastTs = now;

    activeEl.scrollTop -= dy;
    activeEl.scrollLeft -= dx;
  });

  const endDrag = (e: PointerEvent) => {
    if (!activeEl || e.pointerId !== pointerId) return;
    const scroller = activeEl;
    const wasDragging = dragging;
    const releaseVx = vx;
    const releaseVy = vy;

    activeEl = null;
    pointerId = -1;
    dragging = false;
    document.documentElement.classList.remove("preview-dragging");

    if (!wasDragging) return;

    const suppressClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    document.addEventListener("click", suppressClick, { capture: true, once: true });
    window.setTimeout(() => {
      document.removeEventListener("click", suppressClick, { capture: true });
    }, 80);

    // Gentle momentum glide matching touch flicks
    let velY = Math.max(-2.2, Math.min(2.2, releaseVy)) * 16;
    let velX = Math.max(-2.2, Math.min(2.2, releaseVx)) * 16;
    if (Math.hypot(velX, velY) > 1.2) {
      const step = () => {
        scroller.scrollTop -= velY;
        scroller.scrollLeft -= velX;
        velY *= 0.92;
        velX *= 0.92;
        if (Math.hypot(velX, velY) > 0.35) {
          momentumRaf = window.requestAnimationFrame(step);
        } else {
          momentumRaf = 0;
        }
      };
      momentumRaf = window.requestAnimationFrame(step);
    }
  };

  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
}

function attachPreviewMessageHandler(): void {
  window.addEventListener("message", (ev) => {
    const data = ev.data as { type?: string; [k: string]: unknown } | null;
    if (!data || typeof data.type !== "string") return;
    switch (data.type) {
      case "preview:set-theme":
        void persistSettings({ theme: data.theme === "light" ? "light" : "dark" });
        break;
      case "preview:toggle-cc":
        void persistSettings({ cc_enabled: Boolean(data.enabled) });
        break;
      case "preview:toggle-dock":
        state.mobileDockCollapsed = Boolean(data.collapsed);
        syncMobileChrome();
        break;
      case "preview:toggle-play":
        void getPlaybackActions().onTogglePlay();
        break;
      case "preview:open-modal": {
        const target = (data.modal as ActiveModal) ?? null;
        closeAllMobileOverlays();
        if (target === null) {
          closeModal();
        } else {
          openModal(target);
        }
        break;
      }
      case "preview:open-drawer":
        closeModal();
        state.quickReaderSheetOpen = false;
        state.mobilePopoverSheet = null;
        state.mobileDrawerOpen = Boolean(data.open);
        renderChrome();
        break;
      case "preview:open-quick-sheet":
        closeModal();
        state.mobileDrawerOpen = false;
        state.mobilePopoverSheet = null;
        state.quickReaderSheetOpen = Boolean(data.open);
        renderChrome();
        break;
      case "preview:set-insets":
        document.documentElement.style.setProperty("--preview-safe-top", `${Number(data.top ?? 0)}px`);
        document.documentElement.style.setProperty("--preview-safe-bottom", `${Number(data.bottom ?? 0)}px`);
        scrollCtrl.syncBackButton();
        break;
    }
  });
}

void initApp();
