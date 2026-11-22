import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Icons } from "../icons";
import { state } from "../state";
import type { BookMeta } from "../types";
import { escapeHtml } from "./sidebar";

export interface LibraryHandlers {
  onOpenBook: (bookId: string) => Promise<void>;
  onClose: () => void;
  onLibraryChanged: () => void;
}

export function renderLibraryModal(container: HTMLElement, handlers: LibraryHandlers): void {
  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card wide" role="dialog" aria-label="Library">
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
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Books", extensions: ["pdf", "epub", "docx", "txt"] },
      ],
    });
    if (!picked || typeof picked !== "string") return;
    const book = await invoke<BookMeta>("import_book_file", { path: picked });
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
