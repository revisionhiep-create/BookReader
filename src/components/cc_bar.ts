import { Icons } from "../icons";
import { persistSettings, state } from "../state";
import { escapeHtml } from "./sidebar";

let mountedKey = "";
let mountedSpans: HTMLElement[] = [];
let mountedActiveWord = -1;

function resetCcCache(): void {
  mountedKey = "";
  mountedSpans = [];
  mountedActiveWord = -1;
}

export function renderCcBar(container: HTMLElement): void {
  const show = state.settings.cc_enabled && state.sentences.length > 0;
  container.className = show ? "cc-bar" : "cc-bar hidden";
  if (!show) {
    if (container.innerHTML !== "") {
      container.innerHTML = "";
    }
    resetCcCache();
    return;
  }

  const idx = Math.min(state.tts.sentence_idx, state.sentences.length - 1);
  const sentenceText = state.sentences[idx]?.text ?? "";
  const fontSize = state.settings.typography.cc_font_size;
  const activeWord = state.tts.word_idx;
  const key = `${idx}|${fontSize}|${sentenceText}`;

  if (key === mountedKey && mountedSpans.length > 0 && mountedSpans[0].isConnected) {
    if (mountedActiveWord !== activeWord) {
      if (mountedActiveWord >= 0 && mountedActiveWord < mountedSpans.length) {
        mountedSpans[mountedActiveWord].classList.remove("active");
      }
      if (activeWord >= 0 && activeWord < mountedSpans.length) {
        const nextSpan = mountedSpans[activeWord];
        nextSpan.classList.add("active");
        if (container.scrollHeight > container.clientHeight) {
          nextSpan.scrollIntoView({ block: "nearest", behavior: "auto" });
        }
      }
      mountedActiveWord = activeWord;
    }
    return;
  }

  // Must match Rust align_words split_whitespace() 1:1
  const words = sentenceText.trim().length > 0 ? sentenceText.trim().split(/\s+/) : [];
  const wordsHtml = words
    .map((w, i) => {
      const cls = i === activeWord ? "cc-word active" : "cc-word";
      return `<span class="${cls}" data-w="${i}">${escapeHtml(w)}</span>`;
    })
    .join(" ");

  container.innerHTML = `
    <button class="cc-close" id="btn-cc-close" title="Hide Closed Captions">${Icons.close(14)}</button>
    <div class="cc-text" style="font-size:${fontSize}px;">${wordsHtml || escapeHtml(sentenceText)}</div>
  `;

  container.querySelector("#btn-cc-close")?.addEventListener("click", () => {
    void persistSettings({ cc_enabled: false });
  });

  mountedKey = key;
  mountedSpans = Array.from(container.querySelectorAll<HTMLElement>(".cc-word"));
  mountedActiveWord = activeWord;
  if (
    mountedActiveWord >= 0 &&
    mountedActiveWord < mountedSpans.length &&
    container.scrollHeight > container.clientHeight
  ) {
    mountedSpans[mountedActiveWord].scrollIntoView({ block: "nearest", behavior: "auto" });
  }
}
