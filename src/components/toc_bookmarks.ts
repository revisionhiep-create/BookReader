import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../icons";
import { state } from "../state";
import type { BookMeta } from "../types";
import { escapeHtml } from "./sidebar";

export interface TocModalHandlers {
  onJumpSentence: (sentenceIdx: number) => void;
  onClose: () => void;
  onChanged: () => void;
}

export function renderTocBookmarksModal(
  container: HTMLElement,
  handlers: TocModalHandlers,
): void {
  const book = state.activeBook;

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card" role="dialog" aria-label="Chapters and Bookmarks">
        <div class="modal-header">
          <span class="modal-title">Chapters &amp; Bookmarks</span>
          <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <strong style="font-size:13px;">Bookmarks</strong>
            ${
              book
                ? `<button class="btn-secondary" id="btn-bm-here">${Icons.bookmark(true)}<span>Bookmark Here</span></button>`
                : ""
            }
          </div>

          ${
            !book || book.bookmarks.length === 0
              ? `<div style="font-size:12.5px;color:var(--text-muted);">No bookmarks saved for this book yet.</div>`
              : book.bookmarks
                  .map(
                    (bm) => `
                  <div class="book-row">
                    <div style="cursor:pointer;flex:1;" data-jump-sid="${bm.sentence_idx}">
                      <div><strong>${escapeHtml(bm.label)}</strong></div>
                      <div style="font-size:11.5px;color:var(--text-muted);">
                        Sentence ${bm.sentence_idx + 1}${bm.page ? ` · Page ${bm.page}` : ""}
                      </div>
                    </div>
                    <button class="icon-btn" data-del-bm="${bm.id}" title="Delete bookmark">${Icons.trash()}</button>
                  </div>
                `,
                  )
                  .join("")
          }

          <strong style="font-size:13px;margin-top:8px;">Table of Contents</strong>
          ${
            state.toc.length === 0
              ? `<div style="font-size:12.5px;color:var(--text-muted);">No chapter headings found in this book.</div>`
              : state.toc
                  .map(
                    (entry) => `
                  <button class="nav-btn" style="padding-left:${10 + (entry.level - 1) * 14}px;" data-jump-sid="${entry.sentence_idx}">
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(entry.title)}</span>
                    ${entry.page ? `<span class="badge">p.${entry.page}</span>` : ""}
                  </button>
                `,
                  )
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

  container.querySelector("#btn-bm-here")?.addEventListener("click", async () => {
    if (!book) return;
    const idx = state.tts.sentence_idx;
    const sent = state.sentences[idx];
    const snippet = sent ? sent.text.slice(0, 44) : `Position ${idx + 1}`;
    const updated = await invoke<BookMeta>("add_bookmark", {
      bookId: book.id,
      label: snippet,
      sentenceIdx: idx,
      page: sent?.page ?? null,
    });
    state.activeBook = updated;
    state.library = state.library.map((b) => (b.id === updated.id ? updated : b));
    handlers.onChanged();
    renderTocBookmarksModal(container, handlers);
  });

  container.querySelectorAll<HTMLElement>("[data-jump-sid]").forEach((el) => {
    el.addEventListener("click", () => {
      const sid = Number(el.dataset.jumpSid);
      handlers.onClose();
      handlers.onJumpSentence(sid);
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-del-bm]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!book) return;
      const updated = await invoke<BookMeta>("remove_bookmark", {
        bookId: book.id,
        bookmarkId: btn.dataset.delBm!,
      });
      state.activeBook = updated;
      state.library = state.library.map((b) => (b.id === updated.id ? updated : b));
      handlers.onChanged();
      renderTocBookmarksModal(container, handlers);
    });
  });
}
