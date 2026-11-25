import { invoke, openDialog } from "../tauri_bridge";
import { Icons } from "../icons";
import { state } from "../state";
import type { BookMeta } from "../types";
import { escapeHtml } from "./sidebar";

export interface LibraryHandlers {
  onOpenBook: (bookId: string) => Promise<void>;
  onClose: () => void;
  onLibraryChanged: () => void;
  onToast?: (msg: string) => void;
}

function pickBookViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.epub,.docx,.txt,application/pdf,application/epub+zip,text/plain";
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

export function renderLibraryModal(container: HTMLElement, handlers: LibraryHandlers): void {
  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide mobile-page" role="dialog" aria-label="Library">
        <div class="modal-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="modal-title">Library</span>
            <span style="font-size:12px;color:var(--text-muted);">${state.library.length} book${state.library.length === 1 ? "" : "s"}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="btn-primary" id="btn-import-book">
              ${Icons.plus()}
              <span>Import Book (PDF / EPUB / DOCX / TXT)</span>
            </button>
            <button class="icon-btn" id="btn-modal-close" title="Close">${Icons.close()}</button>
          </div>
        </div>

        <div class="modal-body">
          ${
            state.library.length === 0
              ? `<div style="padding:36px;text-align:center;color:var(--text-secondary);">
                   Your library is empty. Import a PDF, EPUB, Word (.docx), or TXT file to start reading.
                 </div>`
              : state.library
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
                            <span class="flag-tag">${b.format.toUpperCase()}</span>
                            ${isCurrent ? `<span class="flag-tag">Now Reading</span>` : ""}
                          </div>
                          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
                            ${escapeHtml(b.original_filename)} · ${b.total_sentences > 0 ? `${pct}% read (${b.current_sentence_idx + 1}/${b.total_sentences})` : "Ready to read"}
                          </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;">
                          <button class="btn-secondary" data-open-book="${b.id}">${isCurrent ? "Resume" : "Open"}</button>
                          <button class="icon-btn" data-delete-book="${b.id}" title="Delete from library">${Icons.trash()}</button>
                        </div>
                      </div>
                    `;
                  })
                  .join("")
          }
        </div>
      </div>
    </div>
  `;

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  container.querySelector("#btn-import-book")?.addEventListener("click", async () => {
    let book: BookMeta | null = null;
    try {
      let picked: string | string[] | null = null;
      try {
        picked = await openDialog({
          multiple: false,
          filters: [
            { name: "Books", extensions: ["pdf", "epub", "docx", "txt"] },
          ],
        });
      } catch {
        const file = await pickBookViaInput();
        if (file) {
          const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
          book = await invoke<BookMeta>("import_book_bytes", {
            filename: file.name,
            bytes,
          });
        }
      }
      if (!book && picked && typeof picked === "string") {
        book = await invoke<BookMeta>("import_book_file", { path: picked });
      }
    } catch (err) {
      handlers.onToast?.(`Import failed: ${String(err)}`);
      return;
    }
    if (!book) return;
    state.library = [book, ...state.library.filter((b) => b.id !== book.id)];
    handlers.onLibraryChanged();
    handlers.onClose();
    await handlers.onOpenBook(book.id);
  });

  container.querySelectorAll<HTMLButtonElement>("[data-open-book]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.openBook!;
      handlers.onClose();
      await handlers.onOpenBook(id);
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-delete-book]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteBook!;
      state.library = await invoke<BookMeta[]>("delete_book", { bookId: id });
      if (state.activeBook?.id === id) {
        state.activeBook = null;
        state.sentences = [];
        state.toc = [];
        state.htmlChapters = [];
      }
      handlers.onLibraryChanged();
      renderLibraryModal(container, handlers);
    });
  });
}
