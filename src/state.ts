import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveModal,
  AppBootstrap,
  BookMeta,
  ChapterHtml,
  DownloadProgressEvent,
  ExportProgressEvent,
  IgnoreRule,
  PronunciationRule,
  SentenceItem,
  Settings,
  SleepTimerStatus,
  TocEntry,
  TtsStateEvent,
  VoiceInfo,
} from "./types";

export interface ClientState {
  bootstrap: AppBootstrap | null;
  settings: Settings;
  library: BookMeta[];
  pronunciations: PronunciationRule[];
  ignoreRules: IgnoreRule[];
  voices: VoiceInfo[];
  activeBook: BookMeta | null;
  sentences: SentenceItem[];
  toc: TocEntry[];
  htmlChapters: ChapterHtml[];
  tts: TtsStateEvent;
  sleepTimer: SleepTimerStatus;
  exportProgress: ExportProgressEvent | null;
  downloadProgress: DownloadProgressEvent | null;
  activeModal: ActiveModal;
  searchOpen: boolean;
  searchQuery: string;
  searchHits: number[];
  searchCursor: number;
  searchFocusedSid: number | null;
  pdfMarginsEditing: boolean;
  autoScrollEnabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  voice_id: "LMDIYE0Oa377Qh6Z",
  qwen_model_variant: "1.7b",
  speed: 1.0,
  volume: 1.0,
  cc_enabled: true,
  sidebar_collapsed: false,
  pauses: {
    sentence_ms: 450,
    paragraph_ms: 850,
    section_ms: 1300,
    comma_extra_ms: 0,
    semicolon_extra_ms: 0,
    adaptive_speed_scaling: true,
    preset: "natural",
  },
  sanitizer: {
    strip_kaomoji_emotes: true,
    strip_decorative_dividers: true,
    strip_emojis_symbols: true,
    skip_citation_brackets: true,
    bracket_mode: "strip_brackets_read_inner",
  },
  typography: {
    font_size: 18,
    line_height: 1.75,
    max_width: 780,
    pdf_zoom: 1.0,
    reader_zoom: 1.0,
    cc_font_size: 21,
  },
  default_pdf_header_ignore_pct: 0.06,
  default_pdf_footer_ignore_pct: 0.06,
  keep_blur_visible: true,
  pdf_invert_dark: true,
  last_book_id: null,
};

export const state: ClientState = {
  bootstrap: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  library: [],
  pronunciations: [],
  ignoreRules: [],
  voices: [],
  activeBook: null,
  sentences: [],
  toc: [],
  htmlChapters: [],
  tts: {
    status: "idle",
    book_id: null,
    sentence_idx: 0,
    word_idx: 0,
    playback_ms: 0,
    sentence_duration_ms: 0,
    total_sentences: 0,
    elapsed_est_sec: 0,
    remaining_est_sec: 0,
    error: null,
  },
  sleepTimer: { active: false, mode: "off", remaining_sec: null },
  exportProgress: null,
  downloadProgress: null,
  activeModal: null,
  searchOpen: false,
  searchQuery: "",
  searchHits: [],
  searchCursor: 0,
  searchFocusedSid: null,
  pdfMarginsEditing: false,
  autoScrollEnabled: true,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) {
    fn();
  }
}

let settingsRev = 0;
let persistQueue: Promise<void> = Promise.resolve();

export function persistSettings(patch: Partial<Settings>): Promise<void> {
  const rev = ++settingsRev;
  const next: Settings = { ...state.settings, ...patch };
  state.settings = next;
  document.documentElement.setAttribute("data-theme", next.theme);
  notify();

  const task = persistQueue.then(async () => {
    if (rev < settingsRev) return;
    try {
      const saved = await invoke<Settings>("update_settings", { settings: next });
      if (rev === settingsRev) {
        state.settings = saved;
        document.documentElement.setAttribute("data-theme", saved.theme);
      }
    } catch (err) {
      console.error("Failed to persist settings:", err);
    }
  });
  persistQueue = task;
  return task;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}
