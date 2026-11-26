export type ThemeMode = "dark" | "light";
export type BracketMode = "strip_brackets_read_inner" | "skip_bracketed_content" | "keep";
export type BookFormat = "pdf" | "epub" | "docx" | "txt";
export type ExportFormat = "wav" | "mp3";
export type ExportScope = "entire_book" | "range";
export type QwenModelVariant = "0.6b" | "1.7b";

export interface PauseSettings {
  sentence_ms: number;
  paragraph_ms: number;
  section_ms: number;
  comma_extra_ms: number;
  semicolon_extra_ms: number;
  adaptive_speed_scaling: boolean;
  preset: string;
}

export interface SanitizerSettings {
  strip_kaomoji_emotes: boolean;
  strip_decorative_dividers: boolean;
  strip_emojis_symbols: boolean;
  skip_citation_brackets: boolean;
  bracket_mode: BracketMode;
}

export interface TypographySettings {
  font_size: number;
  line_height: number;
  max_width: number;
  pdf_zoom: number;
  reader_zoom: number;
  cc_font_size: number;
}

export interface Settings {
  theme: ThemeMode;
  voice_id: string;
  qwen_model_variant: QwenModelVariant;
  speed: number;
  volume: number;
  cc_enabled: boolean;
  sidebar_collapsed: boolean;
  pauses: PauseSettings;
  sanitizer: SanitizerSettings;
  typography: TypographySettings;
  default_pdf_header_ignore_pct: number;
  default_pdf_footer_ignore_pct: number;
  keep_blur_visible: boolean;
  pdf_invert_dark: boolean;
  pdf_reflow: boolean;
  last_book_id: string | null;
}

export interface PronunciationRule {
  id: string;
  source: string;
  replace: string;
  match_case: boolean;
  ignore_word_boundary: boolean;
  is_regex: boolean;
  enabled: boolean;
}

export interface IgnoreRule {
  id: string;
  pattern: string;
  match_case: boolean;
  ignore_word_boundary: boolean;
  is_regex: boolean;
  enabled: boolean;
}

export interface Bookmark {
  id: string;
  label: string;
  sentence_idx: number;
  page: number | null;
  created_at: number;
}

export interface BookMeta {
  id: string;
  title: string;
  format: BookFormat;
  stored_filename: string;
  original_filename: string;
  added_at: number;
  last_opened_at: number;
  current_sentence_idx: number;
  current_page: number;
  scroll_y: number;
  total_sentences: number;
  total_words: number;
  pdf_header_ignore_pct: number;
  pdf_footer_ignore_pct: number;
  bookmarks: Bookmark[];
}

export interface SentenceItem {
  id: number;
  text: string;
  page: number | null;
  paragraph_idx: number;
  is_paragraph_end: boolean;
  is_section_break: boolean;
  chapter_idx: number | null;
}

export interface TocEntry {
  title: string;
  sentence_idx: number;
  page: number | null;
  level: number;
}

export interface ChapterHtml {
  title: string;
  html: string;
}

export interface DocumentPayload {
  book: BookMeta;
  sentences: SentenceItem[];
  toc: TocEntry[];
  html_chapters: ChapterHtml[];
}

export interface VoiceInfo {
  voice_id: string;
  name: string;
  locale: string;
  gender: string;
  age: string;
  description: string;
  downloaded: boolean;
  engine: "phonon" | "qwen_clone";
  is_cloned: boolean;
}

export interface ClonedVoiceMeta {
  voice_id: string;
  name: string;
  description: string;
  ref_text: string | null;
  icl_mode: boolean;
  duration_sec: number;
  created_at: number;
}

export interface AudioClipProbe {
  path: string;
  filename: string;
  duration_sec: number;
  sample_rate: number;
  recommended_start_sec: number;
  recommended_end_sec: number;
  status: "too_short" | "optimal" | "will_trim";
  message: string;
}

export interface QwenVariantStatus {
  variant: QwenModelVariant;
  display_name: string;
  model_ready: boolean;
  engine_loaded: boolean;
  model_dir: string;
  estimated_size_mb: number;
}

export interface QwenModelStatus {
  active_variant: QwenModelVariant;
  model_ready: boolean;
  engine_loaded: boolean;
  device_label: string;
  model_dir: string;
  estimated_size_mb: number;
  variants: QwenVariantStatus[];
}

export interface SetQwenVariantResponse {
  settings: Settings;
  status: QwenModelStatus;
}

export interface CloneVoiceResponse {
  created: ClonedVoiceMeta;
  voices: VoiceInfo[];
}

export interface DeleteClonedVoiceResponse {
  voices: VoiceInfo[];
  settings: Settings;
}

export interface AppBootstrap {
  model_ready: boolean;
  engine_loaded: boolean;
  qwen_model_variant: QwenModelVariant;
  qwen_model_ready: boolean;
  qwen_device_label: string;
  appdata_dir: string;
  data_dir: string;
  media_base_url: string;
  platform: "windows" | "macos" | "linux" | "android";
  voice_cloning_enabled?: boolean;
  settings: Settings;
  library: BookMeta[];
  pronunciations: PronunciationRule[];
  ignore_rules: IgnoreRule[];
  voices: VoiceInfo[];
  mp3_native_available: boolean;
  ffmpeg_available: boolean;
}

export interface DownloadProgressEvent {
  kind: string;
  item_id: string;
  current_file: string;
  bytes_done: number;
  bytes_total: number | null;
  files_done: number;
  files_total: number;
  done: boolean;
  error: string | null;
}

export interface TtsStateEvent {
  status: "idle" | "loading" | "playing" | "paused" | "error";
  book_id: string | null;
  sentence_idx: number;
  word_idx: number;
  playback_ms: number;
  sentence_duration_ms: number;
  word_starts_ms?: number[];
  total_sentences: number;
  elapsed_est_sec: number;
  remaining_est_sec: number;
  error: string | null;
}

export interface ExportRequest {
  book_id: string;
  book_title: string;
  format: ExportFormat;
  scope: ExportScope;
  start_sentence: number;
  end_sentence: number;
  voice_id: string;
  speed: number;
  output_path: string;
  sentences: SentenceItem[];
}

export interface ExportProgressEvent {
  job_id: string;
  book_title: string;
  format: ExportFormat;
  status: "preparing" | "running" | "finalizing" | "completed" | "cancelled" | "error";
  completed_sentences: number;
  total_sentences: number;
  percent: number;
  elapsed_sec: number;
  eta_sec: number | null;
  realtime_factor: number;
  bytes_written: number;
  output_path: string;
  error: string | null;
}

export interface SleepTimerStatus {
  active: boolean;
  mode: "off" | "minutes" | "end_of_chapter";
  remaining_sec: number | null;
}

export type ActiveModal =
  | null
  | "library"
  | "pronunciation"
  | "ignore"
  | "voices"
  | "toc"
  | "export"
  | "voice_clone"
  | "settings"
  | "setup";
