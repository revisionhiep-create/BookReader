import { tr } from "../i18n";
import { invoke } from "../tauri_bridge";
import { Icons } from "../icons";
import { state } from "../state";
import type { BookMeta } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export interface TocModalHandlers {
  onJumpSentence: (sentenceIdx: number) => void;
  onClose: () => void;
  onChanged: () => void;
  onToast?: (msg: string) => void;
}

let activeMobileTab: "chapters" | "bookmarks" = "chapters";

export function renderTocBookmarksModal(
  container: HTMLElement,
  handlers: TocModalHandlers,
): void {
  const book = state.activeBook;

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card mobile-page toc-modal-card" data-toc-tab="${activeMobileTab}" role="dialog" aria-label="${escapeAttr(tr("toc_aria_label"))}">
        <div class="modal-header">
          <span class="modal-title">${escapeHtml(tr("toc_title"))}</span>
          <button class="icon-btn" id="btn-modal-close">${Icons.close()}</button>
        </div>

        <div class="toc-mobile-tabs">
          <button type="button" class="toc-tab-btn ${activeMobileTab === "chapters" ? "active" : ""}" data-toc-tab-btn="chapters">
            ${escapeHtml(tr("toc_tab_chapters", { count: state.toc.length }))}
          </button>
          <button type="button" class="toc-tab-btn ${activeMobileTab === "bookmarks" ? "active" : ""}" data-toc-tab-btn="bookmarks">
            ${escapeHtml(tr("toc_tab_bookmarks", { count: book?.bookmarks.length ?? 0 }))}
          </button>
        </div>

        <div class="modal-body">
          <div class="toc-section toc-section-bookmarks">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <strong style="font-size:13px;">${escapeHtml(tr("toc_bookmarks_heading"))}</strong>
              ${
                book
                  ? `<button class="btn-secondary" id="btn-bm-here">${Icons.bookmark(true)}<span>${escapeHtml(tr("toc_bookmark_here"))}</span></button>`
                  : ""
              }
            </div>

            ${
              !book || book.bookmarks.length === 0
                ? `<div style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(tr("toc_bookmarks_empty"))}</div>`
                : book.bookmarks
                    .map(
                      (bm) => `
                    <div class="book-row">
                      <div style="cursor:pointer;flex:1;" data-jump-sid="${bm.sentence_idx}">
                        <div><strong>${escapeHtml(bm.label)}</strong></div>
                        <div style="font-size:11.5px;color:var(--text-muted);">
                          ${escapeHtml(tr("toc_bookmark_pos", { sentence: bm.sentence_idx + 1 }))}${bm.page ? ` · ${escapeHtml(tr("toc_bookmark_page", { page: bm.page }))}` : ""}
                        </div>
                      </div>
                      <button class="icon-btn" data-del-bm="${bm.id}" title="${escapeAttr(tr("toc_delete_bookmark"))}">${Icons.trash()}</button>
                    </div>
                  `,
                    )
                    .join("")
            }
          </div>

          <div class="toc-section toc-section-chapters">
            <strong style="font-size:13px;display:block;margin-top:8px;margin-bottom:6px;">${escapeHtml(tr("toc_heading"))}</strong>
            ${
              state.toc.length === 0
                ? `<div style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(tr("toc_chapters_empty"))}</div>`
                : state.toc
                    .map(
                      (entry) => `
                    <button class="nav-btn" style="padding-left:${10 + (entry.level - 1) * 14}px;" data-jump-sid="${entry.sentence_idx}">
                      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(entry.title)}</span>
                      ${entry.page ? `<span class="badge">${escapeHtml(tr("toc_page_short", { page: entry.page }))}</span>` : ""}
                    </button>
                  `,
                    )
                    .join("")
            }
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll<HTMLButtonElement>("[data-toc-tab-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeMobileTab = btn.dataset.tocTabBtn as "chapters" | "bookmarks";
      renderTocBookmarksModal(container, handlers);
    });
  });

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-modal-close")?.addEventListener("click", handlers.onClose);

  container.querySelector("#btn-bm-here")?.addEventListener("click", async () => {
    if (!book) return;
    const idx = state.tts.sentence_idx;
    const sent = state.sentences[idx];
    const snippet = sent ? sent.text.slice(0, 44) : tr("toc_position_label", { pos: idx + 1 });
    try {
      const updated = await invoke<BookMeta>("add_bookmark", {
        bookId: book.id,
        label: snippet,
        sentenceIdx: idx,
        page: sent?.page ?? null,
      });
      state.activeBook = updated;
      state.library = state.library.map((b) => (b.id === updated.id ? updated : b));
      handlers.onChanged();
      if (state.activeModal === "toc") {
        renderTocBookmarksModal(container, handlers);
      }
    } catch (err) {
      handlers.onToast?.(String(err));
    }
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
      try {
        const updated = await invoke<BookMeta>("remove_bookmark", {
          bookId: book.id,
          bookmarkId: btn.dataset.delBm!,
        });
        state.activeBook = updated;
        state.library = state.library.map((b) => (b.id === updated.id ? updated : b));
        handlers.onChanged();
        if (state.activeModal === "toc") {
          renderTocBookmarksModal(container, handlers);
        }
      } catch (err) {
        handlers.onToast?.(String(err));
      }
    });
  });
}
