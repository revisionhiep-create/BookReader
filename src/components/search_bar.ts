import { Icons } from "../icons";
import { state } from "../state";

export interface SearchHandlers {
  onJumpToSentence: (sentenceIdx: number) => void;
  onClose: () => void;
}

export function renderSearchBar(container: HTMLElement, handlers: SearchHandlers): void {
  if (!state.searchOpen || !state.activeBook) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "flex";
  container.className = "search-bar";

  const countText =
    state.searchQuery.trim().length === 0
      ? "0 / 0"
      : state.searchHits.length === 0
        ? "0 / 0"
        : `${state.searchCursor + 1} / ${state.searchHits.length}`;

  container.innerHTML = `
    <input type="text" id="doc-search-input" placeholder="Search in book..." value="${escapeAttr(state.searchQuery)}" />
    <span class="search-count">${countText}</span>
    <button class="icon-btn" id="btn-search-prev" title="Previous match" ${state.searchHits.length === 0 ? "disabled" : ""}>${Icons.chevronUp()}</button>
    <button class="icon-btn" id="btn-search-next" title="Next match" ${state.searchHits.length === 0 ? "disabled" : ""}>${Icons.chevronDown()}</button>
    <button class="icon-btn" id="btn-search-close" title="Close Search (Esc)">${Icons.close(15)}</button>
  `;

  const input = container.querySelector<HTMLInputElement>("#doc-search-input")!;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const runSearch = (query: string) => {
    state.searchQuery = query;
    const q = query.trim().toLowerCase();
    if (!q) {
      state.searchHits = [];
      state.searchCursor = 0;
    } else {
      const hits: number[] = [];
      for (let i = 0; i < state.sentences.length; i++) {
        if (state.sentences[i].text.toLowerCase().includes(q)) {
          hits.push(i);
        }
      }
      state.searchHits = hits;
      state.searchCursor = 0;
    }
    updateCountLabel(container);
    if (state.searchHits.length > 0) {
      handlers.onJumpToSentence(state.searchHits[0]);
    } else {
      handlers.onJumpToSentence(-1);
    }
  };

  input.addEventListener("input", () => runSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepMatch(e.shiftKey ? -1 : 1, container, handlers);
    } else if (e.key === "Escape") {
      handlers.onClose();
    }
  });

  container.querySelector("#btn-search-prev")?.addEventListener("click", () => {
    stepMatch(-1, container, handlers);
  });
  container.querySelector("#btn-search-next")?.addEventListener("click", () => {
    stepMatch(1, container, handlers);
  });
  container.querySelector("#btn-search-close")?.addEventListener("click", handlers.onClose);
}

function stepMatch(delta: number, container: HTMLElement, handlers: SearchHandlers): void {
  if (state.searchHits.length === 0) return;
  state.searchCursor =
    (state.searchCursor + delta + state.searchHits.length) % state.searchHits.length;
  updateCountLabel(container);
  handlers.onJumpToSentence(state.searchHits[state.searchCursor]);
}

function updateCountLabel(container: HTMLElement): void {
  const lbl = container.querySelector(".search-count");
  if (lbl) {
    lbl.textContent =
      state.searchHits.length === 0
        ? "0 / 0"
        : `${state.searchCursor + 1} / ${state.searchHits.length}`;
  }
  const prev = container.querySelector<HTMLButtonElement>("#btn-search-prev");
  const next = container.querySelector<HTMLButtonElement>("#btn-search-next");
  if (prev) prev.disabled = state.searchHits.length === 0;
  if (next) next.disabled = state.searchHits.length === 0;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
