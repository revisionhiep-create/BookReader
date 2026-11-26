import { invoke, openDialog } from "../tauri_bridge";
import { Icons } from "../icons";
import { state } from "../state";
import type { BookMeta } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface LibraryHandlers {
  onOpenBook: (bookId: string) => Promise<void>;
  onClose: () => void;
  onLibraryChanged: () => void;
  onToast?: (msg: string) => void;
}

let librarySearchQuery = "";

export function resetLibrarySearch(): void {
  librarySearchQuery = "";
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
      filters: [{ name: "Books", extensions: ["pdf", "epub", "docx", "txt"] }],
    });
  } catch {
    const file = await pickBookViaInput();
    if (!file) return null;
    onStatus?.("Importing book...");
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    return invoke<BookMeta>("import_book_bytes", {
      filename: file.name,
      bytes,
    });
  }
  if (!picked || typeof picked !== "string") return null;
  onStatus?.("Importing book...");
  return invoke<BookMeta>("import_book_file", { path: picked });
}

function renderLibraryList(container: HTMLElement, handlers: LibraryHandlers): void {
  const listHost = container.querySelector<HTMLElement>("#library-list-host");
  const countLabel = container.querySelector<HTMLElement>("#library-count-label");
  const clearBtn = container.querySelector<HTMLButtonElement>("#btn-library-search-clear");
  if (!listHost) return;

  const total = state.library.length;
  const trimmedQuery = librarySearchQuery.trim();
  const filtered = filterLibraryBooks(state.library, librarySearchQuery);

  if (countLabel) {
    const noun = `book${total === 1 ? "" : "s"}`;
    countLabel.textContent = trimmedQuery ? `${filtered.length} of ${total} ${noun}` : `${total} ${noun}`;
  }
  if (clearBtn) {
    clearBtn.classList.toggle("hidden", librarySearchQuery.length === 0);
  }

  if (total === 0) {
    listHost.innerHTML = `
      <div style="padding:36px;text-align:center;color:var(--text-secondary);">
        Your library is empty. Import a PDF, EPUB, Word (.docx), or TXT file to start reading.
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    listHost.innerHTML = `
      <div class="library-empty-search">
        <div>No books match &ldquo;${escapeHtml(trimmedQuery)}&rdquo;.</div>
        <button type="button" class="btn-secondary" id="btn-library-clear-empty">Clear Search</button>
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
      const pct =
        b.total_sentences > 0
          ? Math.round(((b.current_sentence_idx + 1) / b.total_sentences) * 100)
          : 0;
      return `
        <div class="book-row">
          <div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:center;gap:8px;">
              <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(b.title)}</strong>
              <span class="flag-tag">${escapeHtml(b.format.toUpperCase())}</span>
              ${isCurrent ? `<span class="flag-tag">Now Reading</span>` : ""}
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
              ${escapeHtml(b.original_filename)} · ${b.total_sentences > 0 ? `${pct}% read (${b.current_sentence_idx + 1}/${b.total_sentences})` : "Ready to read"}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="btn-secondary" data-open-book="${escapeAttr(b.id)}">${isCurrent ? "Resume" : "Open"}</button>
            <button class="icon-btn" data-delete-book="${escapeAttr(b.id)}" title="Delete from library">${Icons.trash()}</button>
          </div>
        </div>
      `;
    })
    .join("");

  listHost.querySelectorAll<HTMLButtonElement>("[data-open-book]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.openBook!;
      handlers.onClose();
      await handlers.onOpenBook(id);
    });
  });

  listHost.querySelectorAll<HTMLButtonElement>("[data-delete-book]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const id = btn.dataset.deleteBook!;
      try {
        state.library = await invoke<BookMeta[]>("delete_book", { bookId: id });
      } catch (err) {
        btn.disabled = false;
        handlers.onToast?.(`Delete failed: ${String(err)}`);
        return;
      }
      if (state.activeBook?.id === id) {
        state.activeBook = null;
        state.sentences = [];
        state.toc = [];
        state.htmlChapters = [];
      }
      handlers.onLibraryChanged();
      renderLibraryList(container, handlers);
    });
  });
}

export function renderLibraryModal(container: HTMLElement, handlers: LibraryHandlers): void {
  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide mobile-page" role="dialog" aria-label="Library">
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="modal-title">Library</span>
            <span id="library-count-label" style="font-size:12px;color:var(--text-muted);"></span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn-primary" id="btn-import-book">
              ${Icons.plus()}
              <span>Import Book (PDF / EPUB / DOCX / TXT)</span>
            </button>
            <button class="icon-btn" id="btn-modal-close" title="Close">${Icons.close()}</button>
          </div>
        </div>

        <div class="library-search-bar">
          <div class="library-search-wrap">
            <span class="library-search-icon" aria-hidden="true">${Icons.search()}</span>
            <input
              type="search"
              id="library-search-input"
              placeholder="Search library by title, filename, or format..."
              value="${escapeAttr(librarySearchQuery)}"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search library"
            />
            <button
              type="button"
              class="icon-btn library-search-clear${librarySearchQuery ? "" : " hidden"}"
              id="btn-library-search-clear"
              title="Clear search"
              aria-label="Clear search"
            >${Icons.close(14)}</button>
          </div>
        </div>

        <div class="modal-body" id="library-list-host"></div>
      </div>
    </div>
  `;

  renderLibraryList(container, handlers);

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
      handlers.onToast?.(`Import failed: ${String(err)}`);
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
