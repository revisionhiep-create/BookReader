import { Icons } from "../icons";
import { persistSettings, state } from "../state";
import type { TtsStateEvent } from "../types";
import { escapeHtml } from "./sidebar";

let mountedKey = "";
let mountedSentenceIdx = -1;
let mountedSpans: HTMLElement[] = [];
let mountedActiveWord = -1;
let mountedContainer: HTMLElement | null = null;

let timelineSentenceIdx = -1;
let timelineDurationMs = 0;
let timelineWordStartsMs: number[] = [];
let anchorPlaybackMs = 0;
let anchorPerfMs = 0;
let playingClockActive = false;
let rafHandle: number | null = null;

function resetCcCache(): void {
  mountedKey = "";
  mountedSentenceIdx = -1;
  mountedSpans = [];
  mountedActiveWord = -1;
}

export function resetCcClockForSeek(): void {
  stopRaf();
  playingClockActive = false;
  timelineSentenceIdx = -1;
  timelineDurationMs = 0;
  timelineWordStartsMs = [];
  anchorPlaybackMs = 0;
  anchorPerfMs = 0;
}

function stopRaf(): void {
  if (rafHandle !== null) {
    window.cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function currentEstimatedPlaybackMs(now: number): number {
  if (!playingClockActive) return anchorPlaybackMs;
  const est = Math.max(0, anchorPlaybackMs + (now - anchorPerfMs));
  return timelineDurationMs > 0 ? Math.min(est, timelineDurationMs) : est;
}

function findWordAtMs(starts: number[], ms: number): number {
  if (starts.length === 0 || ms <= starts[0]) return 0;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ms) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

function applyActiveWord(container: HTMLElement, nextWord: number): void {
  if (nextWord === mountedActiveWord) return;
  if (mountedActiveWord >= 0 && mountedActiveWord < mountedSpans.length) {
    mountedSpans[mountedActiveWord].classList.remove("active");
  }
  if (nextWord >= 0 && nextWord < mountedSpans.length) {
    const nextSpan = mountedSpans[nextWord];
    nextSpan.classList.add("active");
    if (container.scrollHeight > container.clientHeight + 2) {
      nextSpan.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    }
  }
  mountedActiveWord = nextWord;
}

function stepRaf(): void {
  rafHandle = null;
  const container = mountedContainer;
  if (
    !container ||
    !playingClockActive ||
    !state.settings.cc_enabled ||
    state.sentences.length === 0 ||
    timelineWordStartsMs.length === 0
  ) {
    return;
  }

  const activeIdx = Math.min(state.tts.sentence_idx, state.sentences.length - 1);
  if (
    timelineSentenceIdx === activeIdx &&
    mountedSentenceIdx === activeIdx &&
    mountedSpans.length > 0 &&
    mountedSpans[0].isConnected
  ) {
    const estMs = currentEstimatedPlaybackMs(performance.now());
    const rawTarget = findWordAtMs(timelineWordStartsMs, estMs);
    const boundedTarget = Math.max(0, Math.min(rawTarget, mountedSpans.length - 1));

    let nextWord = boundedTarget;
    if (mountedActiveWord >= 0 && boundedTarget < mountedActiveWord) {
      nextWord = mountedActiveWord;
    } else if (mountedActiveWord >= 0 && boundedTarget === mountedActiveWord + 2) {
      // Reveal fast 1-word transitions cleanly across consecutive paint frames.
      nextWord = mountedActiveWord + 1;
    }

    if (nextWord !== mountedActiveWord) {
      applyActiveWord(container, nextWord);
    }
  }

  rafHandle = window.requestAnimationFrame(stepRaf);
}

function ensureRafRunning(): void {
  if (rafHandle === null && playingClockActive) {
    rafHandle = window.requestAnimationFrame(stepRaf);
  }
}

export function syncCcPlaybackClock(evt: TtsStateEvent, container: HTMLElement): void {
  mountedContainer = container;
  const now = performance.now();
  const incomingStarts = evt.word_starts_ms;
  const hasNewTimeline = Array.isArray(incomingStarts) && incomingStarts.length > 0;
  const sentenceChanged = evt.sentence_idx !== timelineSentenceIdx;
  const wasPlayingSameSentence = !sentenceChanged && playingClockActive && evt.status === "playing";
  let allowBackwardSnap = sentenceChanged || !wasPlayingSameSentence;

  let snapped = false;
  if (hasNewTimeline) {
    const prevDuration = timelineDurationMs;
    const prevEst = currentEstimatedPlaybackMs(now);
    const durationChanged = prevDuration !== evt.sentence_duration_ms;
    timelineSentenceIdx = evt.sentence_idx;
    timelineDurationMs = evt.sentence_duration_ms;
    timelineWordStartsMs = incomingStarts;
    if (sentenceChanged || durationChanged || !wasPlayingSameSentence) {
      anchorPlaybackMs = evt.playback_ms;
      anchorPerfMs = now;
      snapped = true;
      allowBackwardSnap = sentenceChanged || !wasPlayingSameSentence;
    } else {
      const drift = evt.playback_ms - prevEst;
      if (drift > 65) {
        anchorPlaybackMs = evt.playback_ms;
        snapped = true;
      } else if (drift >= 0) {
        anchorPlaybackMs = prevEst + drift * 0.35;
      } else {
        anchorPlaybackMs = Math.max(0, prevEst + Math.max(drift, -65) * 0.25);
      }
      anchorPerfMs = now;
    }
  } else if (
    evt.sentence_idx === timelineSentenceIdx &&
    timelineWordStartsMs.length > 0 &&
    !(evt.status !== "playing" && evt.sentence_duration_ms === 0)
  ) {
    const prevEst = currentEstimatedPlaybackMs(now);
    const drift = evt.playback_ms - prevEst;
    if (!playingClockActive || drift > 65) {
      anchorPlaybackMs = evt.playback_ms;
      snapped = true;
    } else if (drift >= 0) {
      anchorPlaybackMs = prevEst + drift * 0.35;
    } else {
      anchorPlaybackMs = Math.max(0, prevEst + Math.max(drift, -65) * 0.25);
    }
    anchorPerfMs = now;
  } else if (sentenceChanged || evt.status !== "playing") {
    timelineSentenceIdx = evt.sentence_idx;
    timelineDurationMs = evt.sentence_duration_ms;
    timelineWordStartsMs = [];
    anchorPlaybackMs = evt.playback_ms;
    anchorPerfMs = now;
    snapped = true;
    allowBackwardSnap = true;
  }

  const shouldPlay =
    evt.status === "playing" &&
    state.settings.cc_enabled &&
    state.sentences.length > 0 &&
    timelineWordStartsMs.length > 0;

  playingClockActive = shouldPlay;

  const displayedIdx =
    state.sentences.length > 0
      ? Math.min(state.tts.sentence_idx, state.sentences.length - 1)
      : -1;
  if (
    snapped &&
    mountedSpans.length > 0 &&
    mountedSpans[0].isConnected &&
    timelineSentenceIdx === displayedIdx &&
    mountedSentenceIdx === displayedIdx
  ) {
    const target =
      timelineWordStartsMs.length > 0
        ? findWordAtMs(timelineWordStartsMs, anchorPlaybackMs)
        : evt.word_idx;
    const bounded = Math.max(0, Math.min(target, mountedSpans.length - 1));
    const guarded =
      !allowBackwardSnap && mountedActiveWord >= 0 && bounded < mountedActiveWord
        ? mountedActiveWord
        : bounded;
    applyActiveWord(container, guarded);
  }

  if (shouldPlay) {
    ensureRafRunning();
  } else {
    stopRaf();
  }
}

export function renderCcBar(container: HTMLElement): void {
  mountedContainer = container;
  const show = state.settings.cc_enabled && state.sentences.length > 0;
  container.className = show ? "cc-bar" : "cc-bar hidden";
  if (!show) {
    stopRaf();
    playingClockActive = false;
    if (container.innerHTML !== "") {
      container.innerHTML = "";
    }
    resetCcCache();
    return;
  }

  const idx = Math.min(state.tts.sentence_idx, state.sentences.length - 1);
  const prevMountedSentence = mountedSentenceIdx;
  const sentenceText = state.sentences[idx]?.text ?? "";
  const fontSize = state.settings.typography.cc_font_size;
  const useLiveClock =
    playingClockActive &&
    timelineSentenceIdx === idx &&
    timelineWordStartsMs.length > 0;
  const activeWord = useLiveClock
    ? findWordAtMs(timelineWordStartsMs, currentEstimatedPlaybackMs(performance.now()))
    : state.tts.word_idx;
  const key = `${idx}|${fontSize}|${sentenceText}`;

  if (key === mountedKey && mountedSpans.length > 0 && mountedSpans[0].isConnected) {
    if (!useLiveClock) {
      applyActiveWord(container, activeWord);
    } else {
      ensureRafRunning();
    }
    return;
  }

  // Must match Rust align_words split_whitespace() 1:1
  const words = sentenceText.trim().length > 0 ? sentenceText.trim().split(/\s+/) : [];
  let boundedActive =
    words.length > 0 ? Math.max(0, Math.min(activeWord, words.length - 1)) : -1;
  if (
    prevMountedSentence === idx &&
    useLiveClock &&
    mountedActiveWord >= 0 &&
    words.length > 0
  ) {
    boundedActive = Math.max(boundedActive, Math.min(mountedActiveWord, words.length - 1));
  }
  const wordsHtml = words
    .map((w, i) => {
      const cls = i === boundedActive ? "cc-word active" : "cc-word";
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
  mountedSentenceIdx = idx;
  mountedSpans = Array.from(container.querySelectorAll<HTMLElement>(".cc-word"));
  mountedActiveWord = boundedActive;
  if (
    mountedActiveWord >= 0 &&
    mountedActiveWord < mountedSpans.length &&
    container.scrollHeight > container.clientHeight
  ) {
    mountedSpans[mountedActiveWord].scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  if (
    state.tts.status === "playing" &&
    timelineSentenceIdx === idx &&
    timelineWordStartsMs.length > 0
  ) {
    playingClockActive = true;
    ensureRafRunning();
  }
}
