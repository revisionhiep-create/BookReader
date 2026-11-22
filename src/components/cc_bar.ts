import { Icons } from "../icons";
import { persistSettings, state } from "../state";
import { escapeHtml } from "./sidebar";

export function renderCcBar(container: HTMLElement): void {
  const show = state.settings.cc_enabled && state.sentences.length > 0;
  container.className = show ? "cc-bar" : "cc-bar hidden";
  if (!show) {
    container.innerHTML = "";
    return;
  }

  const idx = Math.min(state.tts.sentence_idx, state.sentences.length - 1);
  const sentenceText = state.sentences[idx]?.text ?? "";
  // Must match Rust align_words split_whitespace() 1:1
  const words = sentenceText.trim().length > 0 ? sentenceText.trim().split(/\s+/) : [];
  const activeWord = state.tts.word_idx;

  const wordsHtml = words
    .map((w, i) => {
      const cls = i === activeWord ? "cc-word active" : "cc-word";
      return `<span class="${cls}" data-w="${i}">${escapeHtml(w)}</span>`;
    })
    .join(" ");

  container.innerHTML = `
    <button class="cc-close" id="btn-cc-close" title="Hide Closed Captions">${Icons.close(14)}</button>
    <div class="cc-text" style="font-size:${state.settings.typography.cc_font_size}px;">${wordsHtml || escapeHtml(sentenceText)}</div>
  `;

  container.querySelector("#btn-cc-close")?.addEventListener("click", () => {
    void persistSettings({ cc_enabled: false });
  });
}
