import { tr } from "../i18n";
import { invoke, openDialog } from "../tauri_bridge";
import { Icons } from "../icons";
import { isAndroidPlatform, state } from "../state";
import type { BookMeta } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface LibraryHandlers {
  onOpenBook: (bookId: string) => Promise<void>;
  onClose: () => void;
  onLibraryChanged: () => void;
  onActiveBookDeleted?: () => void;
  onToast?: (msg: string) => void;
}

let librarySearchQuery = "";
const selectedBookIds = new Set<string>();
let lastSelectedBookId: string | null = null;
let focusedBookId: string | null = null;
let deletingBooks = false;
let confirmingClearAll = false;
let lastContainer: HTMLElement | null = null;
let lastHandlers: LibraryHandlers | null = null;
let libraryKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

export function cleanupLibraryModal(): void {
  if (libraryKeydownHandler) {
    window.removeEventListener("keydown", libraryKeydownHandler);
    libraryKeydownHandler = null;
  }
  lastContainer = null;
  lastHandlers = null;
  confirmingClearAll = false;
}

export function hasLibrarySelection(): boolean {
  return !isAndroidPlatform() && selectedBookIds.size > 0;
}

export function clearLibrarySelection(): void {
  if (selectedBookIds.size === 0 && lastSelectedBookId === null) return;
  selectedBookIds.clear();
  lastSelectedBookId = null;
  if (state.activeModal === "library" && lastContainer && lastHandlers) {
    renderLibraryList(lastContainer, lastHandlers);
  }
}

export function resetLibrarySearch(): void {
  librarySearchQuery = "";
  selectedBookIds.clear();
  lastSelectedBookId = null;
  focusedBookId = null;
  deletingBooks = false;
  confirmingClearAll = false;
}

export function sortLibraryByRecent(books: BookMeta[]): BookMeta[] {
  return [...books].sort((a, b) => {
    const aOpened = a.last_opened_at || 0;
    const bOpened = b.last_opened_at || 0;
    if (bOpened !== aOpened) return bOpened - aOpened;
    if (aOpened === 0 && bOpened === 0) {
      return (b.added_at || 0) - (a.added_at || 0);
    }
    return 0;
  });
}

export function filterLibraryBooks(books: BookMeta[], query: string): BookMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return books;
  const tokens = q.split(/\s+/).filter(Boolean);
  return books.filter((b) => {
    const title = b.title.toLowerCase();
    const filename = b.original_filename.toLowerCase();
    const format = b.format.toLowerCase();
    return tokens.every(
      (tok) => title.includes(tok) || filename.includes(tok) || format.includes(tok),
    );
  });
}

function pickBookViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept =
      ".pdf,.epub,.docx,.txt,application/pdf,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
    input.style.display = "none";
    document.body.appendChild(input);
    const cleanup = () => input.remove();
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      resolve(file);
    });
    input.addEventListener("cancel", () => {
      cleanup();
      resolve(null);
    });
    input.click();
  });
}

export async function pickAndImportBook(onStatus?: (msg: string) => void): Promise<BookMeta | null> {
  let picked: string | string[] | null = null;
  try {
    picked = await openDialog({
      multiple: false,
      filters: [{ name: tr("library_books_filter"), extensions: ["pdf", "epub", "docx", "txt"] }],
    });
  } catch {
    const file = await pickBookViaInput();
    if (!file) return null;
    onStatus?.(tr("library_importing"));
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return invoke<BookMeta>("import_book_bytes", {
      filename: file.name,
      bytes,
    });
  }
  if (!picked || typeof picked !== "string") return null;
  onStatus?.(tr("library_importing"));
  return invoke<BookMeta>("import_book_file", { path: picked });
}

function getFilteredLibrary(): BookMeta[] {
  return filterLibraryBooks(sortLibraryByRecent(state.library), librarySearchQuery);
}

function selectBookRange(
  visibleIds: string[],
  anchorId: string | null,
  targetId: string,
  additive: boolean,
): void {
  const targetIdx = visibleIds.indexOf(targetId);
  if (targetIdx < 0) return;
  const anchorIdx = anchorId ? visibleIds.indexOf(anchorId) : 0;
  const startIdx = anchorIdx >= 0 ? anchorIdx : 0;
  const lo = Math.min(startIdx, targetIdx);
  const hi = Math.max(startIdx, targetIdx);
  if (!additive) {
    selectedBookIds.clear();
  }
  for (let i = lo; i <= hi; i++) {
    selectedBookIds.add(visibleIds[i]);
  }
}

function handleDeletedBooksState(deletedIds: string[], handlers: LibraryHandlers): void {
  const deletedSet = new Set(deletedIds);
  for (const id of deletedIds) {
    selectedBookIds.delete(id);
  }
  if (lastSelectedBookId && deletedSet.has(lastSelectedBookId)) {
    lastSelectedBookId = null;
  }
  if (focusedBookId && deletedSet.has(focusedBookId)) {
    focusedBookId = null;
  }
  if (state.settings.last_book_id && deletedSet.has(state.settings.last_book_id)) {
    state.settings = { ...state.settings, last_book_id: null };
  }
  if (state.activeBook && deletedSet.has(state.activeBook.id)) {
    state.activeBook = null;
    state.sentences = [];
    state.toc = [];
    state.htmlChapters = [];
    handlers.onActiveBookDeleted?.();
  }
}

async function performBatchDelete(
  container: HTMLElement,
  handlers: LibraryHandlers,
  ids: string[],
): Promise<void> {
  if (deletingBooks || ids.length === 0) return;
  deletingBooks = true;
  if (state.activeModal === "library") {
    renderLibraryList(container, handlers);
  }
  try {
    state.library = await invoke<BookMeta[]>("delete_books", { bookIds: ids });
    handleDeletedBooksState(ids, handlers);
    handlers.onLibraryChanged();
    const noun = ids.length === 1 ? tr("common_book_singular") : tr("common_book_plural");
    handlers.onToast?.(tr("library_deleted_count", { count: ids.length, noun }));
  } catch (err) {
    handlers.onToast?.(tr("library_delete_failed", { error: String(err) }));
  } finally {
    deletingBooks = false;
    if (state.activeModal === "library") {
      renderLibraryList(container, handlers);
    }
  }
}

async function performClearAll(
  container: HTMLElement,
  handlers: LibraryHandlers,
): Promise<void> {
  if (deletingBooks) return;
  const allIds = state.library.map((b) => b.id);
  deletingBooks = true;
  if (state.activeModal === "library") {
    renderLibraryList(container, handlers);
  }
  try {
    state.library = await invoke<BookMeta[]>("clear_library");
    confirmingClearAll = false;
    selectedBookIds.clear();
    lastSelectedBookId = null;
    focusedBookId = null;
    handleDeletedBooksState(allIds, handlers);
    handlers.onLibraryChanged();
    handlers.onToast?.(tr("library_cleared_toast"));
  } catch (err) {
    handlers.onToast?.(tr("library_clear_failed", { error: String(err) }));
  } finally {
    deletingBooks = false;
    if (state.activeModal === "library") {
      renderLibraryList(container, handlers);
    }
  }
}

function renderLibraryList(container: HTMLElement, handlers: LibraryHandlers): void {
  const listHost = container.querySelector<HTMLElement>("#library-list-host");
  const actionBarHost = container.querySelector<HTMLElement>("#library-action-host");
  const countLabel = container.querySelector<HTMLElement>("#library-count-label");
  const clearBtn = container.querySelector<HTMLButtonElement>("#btn-library-search-clear");
  if (!listHost) return;

  const isAndroid = isAndroidPlatform();
  const isMac =
    state.bootstrap?.platform === "macos" || /Mac/i.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  const existingIds = new Set(state.library.map((b) => b.id));
  for (const id of Array.from(selectedBookIds)) {
    if (!existingIds.has(id)) selectedBookIds.delete(id);
  }
  if (lastSelectedBookId && !existingIds.has(lastSelectedBookId)) {
    lastSelectedBookId = null;
  }
  if (focusedBookId && !existingIds.has(focusedBookId)) {
    focusedBookId = null;
  }

  const total = state.library.length;
  const trimmedQuery = librarySearchQuery.trim();
  const ordered = sortLibraryByRecent(state.library);
  const filtered = filterLibraryBooks(ordered, librarySearchQuery);
  const visibleIds = filtered.map((b) => b.id);

  if (countLabel) {
    const noun = total === 1 ? tr("common_book_singular") : tr("common_book_plural");
    countLabel.textContent = trimmedQuery
      ? tr("library_count_filtered", { filtered: filtered.length, total, noun })
      : tr("library_count_total", { total, noun });
  }
  if (clearBtn) {
    clearBtn.classList.toggle("hidden", librarySearchQuery.length === 0);
  }

  if (actionBarHost) {
    if (total === 0) {
      confirmingClearAll = false;
      actionBarHost.innerHTML = "";
    } else if (isAndroid) {
      if (confirmingClearAll) {
        actionBarHost.innerHTML = `
          <div class="library-confirm-banner" role="alert">
            <div class="library-confirm-copy">
              <strong>${escapeHtml(tr("library_clear_all_confirm_title", { count: total }))}</strong>
              <span>${escapeHtml(tr("library_clear_all_confirm_desc"))}</span>
            </div>
            <div class="library-confirm-actions">
              <button type="button" class="btn-secondary" id="btn-library-clear-cancel" ${deletingBooks ? "disabled" : ""}>${escapeHtml(tr("common_cancel"))}</button>
              <button type="button" class="btn-danger" id="btn-library-clear-confirm" ${deletingBooks ? "disabled" : ""}>${escapeHtml(tr("library_clear_all_confirm_action", { count: total }))}</button>
            </div>
          </div>
        `;
        actionBarHost.querySelector("#btn-library-clear-cancel")?.addEventListener("click", () => {
          confirmingClearAll = false;
          renderLibraryList(container, handlers);
        });
        actionBarHost.querySelector("#btn-library-clear-confirm")?.addEventListener("click", () => {
          void performClearAll(container, handlers);
        });
      } else {
        actionBarHost.innerHTML = `
          <div class="library-clear-all-row">
            <button type="button" class="btn-danger-outline" id="btn-library-clear-all" ${deletingBooks ? "disabled" : ""}>
              ${Icons.trash()}
              <span>${escapeHtml(tr("library_clear_all_btn"))}</span>
            </button>
          </div>
        `;
        actionBarHost.querySelector("#btn-library-clear-all")?.addEventListener("click", () => {
          confirmingClearAll = true;
          renderLibraryList(container, handlers);
        });
      }
    } else {
      const selectedCount = selectedBookIds.size;
      const allVisibleSelected =
        visibleIds.length > 0 && visibleIds.every((id) => selectedBookIds.has(id));
      const someVisibleSelected =
        !allVisibleSelected && visibleIds.some((id) => selectedBookIds.has(id));

      actionBarHost.innerHTML = `
        <div class="library-selection-bar">
          <div class="library-selection-left">
            <label class="checkbox-label">
              <input type="checkbox" id="library-select-all" ${allVisibleSelected ? "checked" : ""} ${visibleIds.length === 0 || deletingBooks ? "disabled" : ""} />
              <span>${escapeHtml(tr("library_select_all"))}</span>
            </label>
            <span class="library-selection-meta">
              ${escapeHtml(
                selectedCount > 0
                  ? tr("library_selected_count", { count: selectedCount })
                  : tr("library_multiselect_hint", { mod: modKey }),
              )}
            </span>
          </div>
          ${
            selectedCount > 0
              ? `
            <div class="library-selection-actions">
              <button type="button" class="btn-secondary" id="btn-library-clear-sel" ${deletingBooks ? "disabled" : ""}>${escapeHtml(tr("library_clear_selection"))}</button>
              <button type="button" class="btn-danger" id="btn-library-delete-sel" ${deletingBooks ? "disabled" : ""}>
                ${Icons.trash()}
                <span>${escapeHtml(tr("library_delete_selected", { count: selectedCount }))}</span>
              </button>
            </div>
          `
              : ""
          }
        </div>
      `;

      const selectAllEl = actionBarHost.querySelector<HTMLInputElement>("#library-select-all");
      if (selectAllEl) {
        selectAllEl.indeterminate = someVisibleSelected;
        selectAllEl.addEventListener("change", () => {
          if (selectAllEl.checked) {
            for (const id of visibleIds) selectedBookIds.add(id);
            if (visibleIds.length > 0) {
              lastSelectedBookId = visibleIds[visibleIds.length - 1];
            }
          } else {
            for (const id of visibleIds) selectedBookIds.delete(id);
            lastSelectedBookId = null;
          }
          renderLibraryList(container, handlers);
        });
      }

      actionBarHost.querySelector("#btn-library-clear-sel")?.addEventListener("click", () => {
        selectedBookIds.clear();
        lastSelectedBookId = null;
        renderLibraryList(container, handlers);
      });
      actionBarHost.querySelector("#btn-library-delete-sel")?.addEventListener("click", () => {
        void performBatchDelete(container, handlers, Array.from(selectedBookIds));
      });
    }
  }

  if (total === 0) {
    listHost.innerHTML = `
      <div style="padding:36px;text-align:center;color:var(--text-secondary);">
        ${escapeHtml(tr("library_empty"))}
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    listHost.innerHTML = `
      <div class="library-empty-search">
        <div>${escapeHtml(tr("library_no_match", { query: trimmedQuery }))}</div>
        <button type="button" class="btn-secondary" id="btn-library-clear-empty">${escapeHtml(tr("library_clear_search"))}</button>
      </div>
    `;
    listHost.querySelector("#btn-library-clear-empty")?.addEventListener("click", () => {
      librarySearchQuery = "";
      const input = container.querySelector<HTMLInputElement>("#library-search-input");
      if (input) {
        input.value = "";
        input.focus();
      }
      renderLibraryList(container, handlers);
    });
    return;
  }

  listHost.innerHTML = filtered
    .map((b) => {
      const isCurrent = state.activeBook?.id === b.id;
      const isSelected = !isAndroid && selectedBookIds.has(b.id);
      const isFocused = !isAndroid && focusedBookId === b.id;
      const pct =
        b.total_sentences > 0
          ? Math.round(((b.current_sentence_idx + 1) / b.total_sentences) * 100)
          : 0;
      return `
        <div class="book-row${isSelected ? " selected" : ""}${isFocused ? " focused" : ""}" data-book-id="${escapeAttr(b.id)}">
          ${
            !isAndroid
              ? `<input type="checkbox" class="library-book-checkbox" data-select-book="${escapeAttr(b.id)}" aria-label="${escapeAttr(tr("library_select_book_aria", { title: b.title }))}" ${isSelected ? "checked" : ""} ${deletingBooks ? "disabled" : ""} />`
              : ""
          }
          <div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:center;gap:8px;">
              <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(b.title)}</strong>
              <span class="flag-tag">${escapeHtml(b.format.toUpperCase())}</span>
              ${isCurrent ? `<span class="flag-tag">${escapeHtml(tr("library_now_reading"))}</span>` : ""}
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
              ${escapeHtml(b.original_filename)} · ${escapeHtml(
                b.total_sentences > 0
                  ? tr("library_progress_read", {
                      pct,
                      current: b.current_sentence_idx + 1,
                      total: b.total_sentences,
                    })
                  : tr("library_ready_to_read"),
              )}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="btn-secondary" data-open-book="${escapeAttr(b.id)}">${escapeHtml(isCurrent ? tr("library_resume") : tr("library_open"))}</button>
            <button class="icon-btn" data-delete-book="${escapeAttr(b.id)}" title="${escapeAttr(tr("library_delete_tooltip"))}" ${deletingBooks ? "disabled" : ""}>${Icons.trash()}</button>
          </div>
        </div>
      `;
    })
    .join("");

  if (!isAndroid) {
    listHost.querySelectorAll<HTMLInputElement>("[data-select-book]").forEach((chk) => {
      chk.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = chk.dataset.selectBook!;
        if (e.shiftKey) {
          e.preventDefault();
          selectBookRange(visibleIds, lastSelectedBookId, id, e.ctrlKey || e.metaKey);
          focusedBookId = id;
          renderLibraryList(container, handlers);
        }
      });
      chk.addEventListener("change", () => {
        const id = chk.dataset.selectBook!;
        if (chk.checked) {
          selectedBookIds.add(id);
        } else {
          selectedBookIds.delete(id);
        }
        lastSelectedBookId = id;
        focusedBookId = id;
        renderLibraryList(container, handlers);
      });
    });

    listHost.querySelectorAll<HTMLElement>("[data-book-id]").forEach((row) => {
      row.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest("button, input")) return;
        const id = row.dataset.bookId!;
        if (e.shiftKey) {
          window.getSelection()?.removeAllRanges();
          selectBookRange(visibleIds, lastSelectedBookId, id, e.ctrlKey || e.metaKey);
          focusedBookId = id;
        } else if (e.ctrlKey || e.metaKey) {
          if (selectedBookIds.has(id)) selectedBookIds.delete(id);
          else selectedBookIds.add(id);
          lastSelectedBookId = id;
          focusedBookId = id;
        } else {
          if (selectedBookIds.size === 1 && selectedBookIds.has(id)) {
            selectedBookIds.clear();
          } else {
            selectedBookIds.clear();
            selectedBookIds.add(id);
          }
          lastSelectedBookId = id;
          focusedBookId = id;
        }
        renderLibraryList(container, handlers);
      });

      row.addEventListener("dblclick", async (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest("button, input")) return;
        const id = row.dataset.bookId!;
        handlers.onClose();
        await handlers.onOpenBook(id);
      });
    });
  }

  listHost.querySelectorAll<HTMLButtonElement>("[data-open-book]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.openBook!;
      handlers.onClose();
      await handlers.onOpenBook(id);
    });
  });

  listHost.querySelectorAll<HTMLButtonElement>("[data-delete-book]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled || deletingBooks) return;
      btn.disabled = true;
      const id = btn.dataset.deleteBook!;
      try {
        state.library = await invoke<BookMeta[]>("delete_book", { bookId: id });
      } catch (err) {
        btn.disabled = false;
        handlers.onToast?.(tr("library_delete_failed", { error: String(err) }));
        return;
      }
      handleDeletedBooksState([id], handlers);
      handlers.onLibraryChanged();
      if (state.activeModal === "library") {
        renderLibraryList(container, handlers);
      }
    });
  });
}

export function renderLibraryModal(container: HTMLElement, handlers: LibraryHandlers): void {
  cleanupLibraryModal();
  lastContainer = container;
  lastHandlers = handlers;

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide mobile-page" role="dialog" aria-label="${escapeAttr(tr("library_aria_label"))}">
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="modal-title">${escapeHtml(tr("library_title"))}</span>
            <span id="library-count-label" style="font-size:12px;color:var(--text-muted);"></span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn-primary" id="btn-import-book">
              ${Icons.plus()}
              <span>${escapeHtml(tr("library_import_btn"))}</span>
            </button>
            <button class="icon-btn" id="btn-modal-close" title="${escapeAttr(tr("common_close"))}">${Icons.close()}</button>
          </div>
        </div>

        <div class="library-search-bar">
          <div class="library-search-wrap">
            <span class="library-search-icon" aria-hidden="true">${Icons.search()}</span>
            <input
              type="search"
              id="library-search-input"
              placeholder="${escapeAttr(tr("library_search_placeholder"))}"
              value="${escapeAttr(librarySearchQuery)}"
              autocomplete="off"
              spellcheck="false"
              aria-label="${escapeAttr(tr("library_search_aria"))}"
            />
            <button
              type="button"
              class="icon-btn library-search-clear${librarySearchQuery ? "" : " hidden"}"
              id="btn-library-search-clear"
              title="${escapeAttr(tr("library_clear_search_tooltip"))}"
              aria-label="${escapeAttr(tr("library_clear_search_tooltip"))}"
            >${Icons.close(14)}</button>
          </div>
        </div>

        <div id="library-action-host"></div>

        <div class="modal-body" id="library-list-host"></div>
      </div>
    </div>
  `;

  renderLibraryList(container, handlers);

  if (!isAndroidPlatform()) {
    libraryKeydownHandler = (e: KeyboardEvent) => {
      if (state.activeModal !== "library" || isAndroidPlatform()) return;
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox"));
      if (isTextInput) return;

      const filtered = getFilteredLibrary();
      const visibleIds = filtered.map((b) => b.id);
      if (visibleIds.length === 0) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        for (const id of visibleIds) selectedBookIds.add(id);
        lastSelectedBookId = visibleIds[visibleIds.length - 1];
        renderLibraryList(container, handlers);
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedBookIds.size > 0) {
        if (target?.tagName === "BUTTON") return;
        e.preventDefault();
        void performBatchDelete(container, handlers, Array.from(selectedBookIds));
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const curIdx = focusedBookId ? visibleIds.indexOf(focusedBookId) : -1;
        const nextIdx =
          curIdx < 0
            ? delta > 0
              ? 0
              : visibleIds.length - 1
            : Math.max(0, Math.min(visibleIds.length - 1, curIdx + delta));
        const nextId = visibleIds[nextIdx];
        if (e.shiftKey) {
          const anchor = lastSelectedBookId ?? (curIdx >= 0 ? visibleIds[curIdx] : nextId);
          if (!lastSelectedBookId) lastSelectedBookId = anchor;
          selectBookRange(visibleIds, anchor, nextId, false);
        }
        focusedBookId = nextId;
        renderLibraryList(container, handlers);
        container
          .querySelector<HTMLElement>(`[data-book-id="${CSS.escape(nextId)}"]`)
          ?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (e.code === "Space" && focusedBookId && target?.tagName !== "BUTTON" && target?.tagName !== "INPUT") {
        e.preventDefault();
        if (selectedBookIds.has(focusedBookId)) selectedBookIds.delete(focusedBookId);
        else selectedBookIds.add(focusedBookId);
        lastSelectedBookId = focusedBookId;
        renderLibraryList(container, handlers);
      }
    };
    window.addEventListener("keydown", libraryKeydownHandler);
  }

  const searchInput = container.querySelector<HTMLInputElement>("#library-search-input");
  searchInput?.addEventListener("input", () => {
    librarySearchQuery = searchInput.value;
    renderLibraryList(container, handlers);
  });
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      librarySearchQuery = "";
      searchInput.value = "";
      renderLibraryList(container, handlers);
    } else if (e.key === "Enter") {
      searchInput.blur();
    }
  });

  container.querySelector("#btn-library-search-clear")?.addEventListener("click", () => {
    librarySearchQuery = "";
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
    }
    renderLibraryList(container, handlers);
  });

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  const importBtn = container.querySelector<HTMLButtonElement>("#btn-import-book");
  importBtn?.addEventListener("click", async () => {
    if (importBtn.disabled) return;
    importBtn.disabled = true;
    let book: BookMeta | null = null;
    try {
      book = await pickAndImportBook();
    } catch (err) {
      handlers.onToast?.(tr("toast_import_failed", { error: String(err) }));
      return;
    } finally {
      if (importBtn.isConnected) importBtn.disabled = false;
    }
    if (!book) return;
    state.library = [book, ...state.library.filter((b) => b.id !== book.id)];
    handlers.onLibraryChanged();
    handlers.onClose();
    await handlers.onOpenBook(book.id);
  });
}
