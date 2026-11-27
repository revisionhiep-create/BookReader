//! Shared domain models serialized across Rust storage and Tauri IPC.

use serde::{Deserialize, Serialize};

/// How brackets and their inner text are treated before TTS synthesis.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BracketMode {
    #[default]
    StripBracketsReadInner,
    SkipBracketedContent,
    Keep,
}

/// Supported document formats in BookReader.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    Pdf,
    Epub,
    Docx,
    Txt,
}

impl BookFormat {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.trim().to_ascii_lowercase().as_str() {
            "pdf" => Some(Self::Pdf),
            "epub" => Some(Self::Epub),
            "docx" => Some(Self::Docx),
            "txt" => Some(Self::Txt),
            _ => None,
        }
    }

    pub fn as_ext(&self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Epub => "epub",
            Self::Docx => "docx",
            Self::Txt => "txt",
        }
    }
}

/// Pause durations (in milliseconds) injected at speech boundaries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PauseSettings {
    pub sentence_ms: u32,
    pub paragraph_ms: u32,
    pub section_ms: u32,
    pub comma_extra_ms: u32,
    pub semicolon_extra_ms: u32,
    pub adaptive_speed_scaling: bool,
    pub preset: String,
}

impl Default for PauseSettings {
    fn default() -> Self {
        Self {
            sentence_ms: 450,
            paragraph_ms: 850,
            section_ms: 1300,
            comma_extra_ms: 0,
            semicolon_extra_ms: 0,
            adaptive_speed_scaling: true,
            preset: "natural".to_string(),
        }
    }
}

/// Sanitization options for symbols, kaomoji/foreign emotes, dividers, and brackets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SanitizerSettings {
    pub strip_kaomoji_emotes: bool,
    pub strip_decorative_dividers: bool,
    pub strip_emojis_symbols: bool,
    pub skip_citation_brackets: bool,
    pub bracket_mode: BracketMode,
}

impl Default for SanitizerSettings {
    fn default() -> Self {
        Self {
            strip_kaomoji_emotes: true,
            strip_decorative_dividers: true,
            strip_emojis_symbols: true,
            skip_citation_brackets: true,
            bracket_mode: BracketMode::StripBracketsReadInner,
        }
    }
}

/// Reader visual typography and zoom preferences.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TypographySettings {
    pub font_size: u32,
    pub line_height: f32,
    pub max_width: u32,
    pub pdf_zoom: f32,
    pub reader_zoom: f32,
    pub cc_font_size: u32,
}

impl Default for TypographySettings {
    fn default() -> Self {
        Self {
            font_size: 18,
            line_height: 1.75,
            max_width: 780,
            pdf_zoom: 1.0,
            reader_zoom: 1.0,
            cc_font_size: 21,
        }
    }
}

/// Supported TTS and UI languages in BookReader.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppLanguage {
    #[default]
    En,
    Fr,
    De,
    Es,
    Pt,
    It,
    Nl,
}

impl AppLanguage {
    pub fn all() -> [Self; 7] {
        [
            Self::En,
            Self::Fr,
            Self::De,
            Self::Es,
            Self::Pt,
            Self::It,
            Self::Nl,
        ]
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Fr => "fr",
            Self::De => "de",
            Self::Es => "es",
            Self::Pt => "pt",
            Self::It => "it",
            Self::Nl => "nl",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        match code.trim().to_ascii_lowercase().as_str() {
            "en" => Some(Self::En),
            "fr" => Some(Self::Fr),
            "de" => Some(Self::De),
            "es" => Some(Self::Es),
            "pt" => Some(Self::Pt),
            "it" => Some(Self::It),
            "nl" => Some(Self::Nl),
            _ => None,
        }
    }

    pub fn pocket_folder(self) -> Option<&'static str> {
        match self {
            Self::En => None,
            Self::Fr => Some("french"),
            Self::De => Some("german"),
            Self::Es => Some("spanish"),
            Self::Pt => Some("portuguese"),
            Self::It => Some("italian"),
            Self::Nl => Some("dutch"),
        }
    }

    pub fn engine_id(self) -> &'static str {
        match self {
            Self::En => "phonon",
            _ => "pocket",
        }
    }

    pub fn model_id(self) -> &'static str {
        match self {
            Self::En => "phonon-31m-en",
            Self::Fr => "pocket-tts-fr",
            Self::De => "pocket-tts-de",
            Self::Es => "pocket-tts-es",
            Self::Pt => "pocket-tts-pt",
            Self::It => "pocket-tts-it",
            Self::Nl => "pocket-tts-nl",
        }
    }

    pub fn estimated_size_mb(self) -> u64 {
        match self {
            Self::En => 65,
            _ => 209,
        }
    }

    pub fn default_voice_id(self) -> &'static str {
        match self {
            Self::En => "LMDIYE0Oa377Qh6Z",
            Self::Fr => "pocket:fr:estelle",
            Self::De => "pocket:de:juergen",
            Self::Es => "pocket:es:lola",
            Self::Pt => "pocket:pt:rafael",
            Self::It => "pocket:it:giovanni",
            Self::Nl => "pocket:nl:daan",
        }
    }

    pub fn ptts_lang(self) -> ptts::preprocess::Lang {
        match self {
            Self::En => ptts::preprocess::Lang::En,
            Self::Fr => ptts::preprocess::Lang::Fr,
            Self::De => ptts::preprocess::Lang::De,
            Self::Es => ptts::preprocess::Lang::Es,
            Self::Pt => ptts::preprocess::Lang::Pt,
            Self::It => ptts::preprocess::Lang::It,
            Self::Nl => ptts::preprocess::Lang::Nl,
        }
    }

    #[cfg_attr(
        any(not(feature = "voice-cloning"), target_os = "android"),
        allow(dead_code)
    )]
    pub fn qwen_language(self) -> &'static str {
        match self {
            Self::En => "english",
            Self::Fr => "french",
            Self::De => "german",
            Self::Es => "spanish",
            Self::Pt | Self::It | Self::Nl => "auto",
        }
    }
}

/// Download and load readiness status for one TTS language model.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LanguageModelStatus {
    pub language: AppLanguage,
    pub engine: String,
    pub model_id: String,
    pub ready: bool,
    pub loaded: bool,
    pub estimated_size_mb: u64,
    pub default_voice_id: String,
}

/// Selectable local Qwen3-TTS base model size for voice cloning & playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum QwenModelVariant {
    #[serde(rename = "0.6b")]
    Fast0_6B,
    #[default]
    #[serde(rename = "1.7b")]
    Quality1_7B,
}

impl QwenModelVariant {
    pub fn all() -> [Self; 2] {
        [Self::Fast0_6B, Self::Quality1_7B]
    }

    pub fn as_id(&self) -> &'static str {
        match self {
            Self::Fast0_6B => "0.6b",
            Self::Quality1_7B => "1.7b",
        }
    }

    pub fn dir_name(&self) -> &'static str {
        match self {
            Self::Fast0_6B => "qwen3-tts-0.6b-base",
            Self::Quality1_7B => "qwen3-tts-1.7b-base",
        }
    }

    pub fn hf_repo(&self) -> &'static str {
        match self {
            Self::Fast0_6B => "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            Self::Quality1_7B => "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Fast0_6B => "Qwen3-TTS 0.6B-Base",
            Self::Quality1_7B => "Qwen3-TTS 1.7B-Base",
        }
    }

    pub fn prompt_suffix(&self) -> &'static str {
        match self {
            Self::Fast0_6B => "0_6b",
            Self::Quality1_7B => "1_7b",
        }
    }

    pub fn estimated_size_mb(&self) -> u64 {
        match self {
            Self::Fast0_6B => 2_560,
            Self::Quality1_7B => 4_608,
        }
    }

    pub fn model_safetensors_est_bytes(&self) -> u64 {
        match self {
            Self::Fast0_6B => 1_965_000_000,
            Self::Quality1_7B => 3_858_000_000,
        }
    }
}

/// Persisted global user settings saved immediately to `%APPDATA%\Bookreader\settings.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    pub ui_language: Option<AppLanguage>,
    pub tts_language: AppLanguage,
    pub voice_id: String,
    pub qwen_model_variant: QwenModelVariant,
    pub speed: f32,
    pub volume: f32,
    pub cc_enabled: bool,
    pub sidebar_collapsed: bool,
    pub pauses: PauseSettings,
    pub sanitizer: SanitizerSettings,
    pub typography: TypographySettings,
    pub default_pdf_header_ignore_pct: f32,
    pub default_pdf_footer_ignore_pct: f32,
    pub keep_blur_visible: bool,
    pub pdf_invert_dark: bool,
    pub pdf_reflow: bool,
    pub last_book_id: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            ui_language: None,
            tts_language: AppLanguage::En,
            voice_id: "LMDIYE0Oa377Qh6Z".to_string(), // Easton (en-us male)
            qwen_model_variant: QwenModelVariant::default(),
            speed: 1.0,
            volume: 1.0,
            cc_enabled: true,
            sidebar_collapsed: false,
            pauses: PauseSettings::default(),
            sanitizer: SanitizerSettings::default(),
            typography: TypographySettings::default(),
            default_pdf_header_ignore_pct: 0.06,
            default_pdf_footer_ignore_pct: 0.06,
            keep_blur_visible: true,
            pdf_invert_dark: true,
            pdf_reflow: false,
            last_book_id: None,
        }
    }
}

impl Settings {
    /// Clamps numeric fields to safe operating ranges.
    pub fn sanitize(&mut self) {
        if self.theme != "light" {
            self.theme = "dark".to_string();
        }
        self.speed = self.speed.clamp(0.5, 3.0);
        self.volume = self.volume.clamp(0.0, 1.0);
        self.pauses.sentence_ms = self.pauses.sentence_ms.min(5000);
        self.pauses.paragraph_ms = self.pauses.paragraph_ms.min(8000);
        self.pauses.section_ms = self.pauses.section_ms.min(10000);
        self.pauses.comma_extra_ms = self.pauses.comma_extra_ms.min(1500);
        self.pauses.semicolon_extra_ms = self.pauses.semicolon_extra_ms.min(2000);
        self.typography.font_size = self.typography.font_size.clamp(12, 36);
        self.typography.line_height = self.typography.line_height.clamp(1.2, 2.6);
        self.typography.max_width = self.typography.max_width.clamp(520, 1300);
        self.typography.pdf_zoom = self.typography.pdf_zoom.clamp(0.5, 2.5);
        self.typography.reader_zoom = self.typography.reader_zoom.clamp(0.6, 2.2);
        self.typography.cc_font_size = self.typography.cc_font_size.clamp(14, 48);
        self.default_pdf_header_ignore_pct = self.default_pdf_header_ignore_pct.clamp(0.0, 0.45);
        self.default_pdf_footer_ignore_pct = self.default_pdf_footer_ignore_pct.clamp(0.0, 0.45);
    }
}

/// Saved desktop window position, client size, and display state in physical screen pixels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub scale_factor: f64,
    pub monitor_x: Option<i32>,
    pub monitor_y: Option<i32>,
    pub monitor_width: Option<u32>,
    pub monitor_height: Option<u32>,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 1280,
            height: 820,
            maximized: false,
            scale_factor: 1.0,
            monitor_x: None,
            monitor_y: None,
            monitor_width: None,
            monitor_height: None,
        }
    }
}

/// User-defined pronunciation replacement rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PronunciationRule {
    pub id: String,
    pub source: String,
    pub replace: String,
    pub match_case: bool,
    pub ignore_word_boundary: bool,
    pub is_regex: bool,
    pub enabled: bool,
}

impl Default for PronunciationRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            source: String::new(),
            replace: String::new(),
            match_case: false,
            ignore_word_boundary: false,
            is_regex: false,
            enabled: true,
        }
    }
}

/// User-defined ignore word / pattern rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct IgnoreRule {
    pub id: String,
    pub pattern: String,
    pub match_case: bool,
    pub ignore_word_boundary: bool,
    pub is_regex: bool,
    pub enabled: bool,
}

impl Default for IgnoreRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            pattern: String::new(),
            match_case: false,
            ignore_word_boundary: false,
            is_regex: false,
            enabled: true,
        }
    }
}

/// Saved user bookmark inside a book.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub label: String,
    pub sentence_idx: usize,
    pub page: Option<usize>,
    pub created_at: u64,
}

/// Library metadata and per-book progress persisted in `library.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BookMeta {
    pub id: String,
    pub title: String,
    pub format: BookFormat,
    pub stored_filename: String,
    pub original_filename: String,
    pub added_at: u64,
    pub last_opened_at: u64,
    pub current_sentence_idx: usize,
    pub current_page: usize,
    pub scroll_y: f64,
    pub total_sentences: usize,
    pub total_words: usize,
    pub pdf_header_ignore_pct: f32,
    pub pdf_footer_ignore_pct: f32,
    pub bookmarks: Vec<Bookmark>,
}

impl Default for BookMeta {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            format: BookFormat::Txt,
            stored_filename: String::new(),
            original_filename: String::new(),
            added_at: 0,
            last_opened_at: 0,
            current_sentence_idx: 0,
            current_page: 1,
            scroll_y: 0.0,
            total_sentences: 0,
            total_words: 0,
            pdf_header_ignore_pct: 0.06,
            pdf_footer_ignore_pct: 0.06,
            bookmarks: Vec::new(),
        }
    }
}

/// A single readable sentence unit in a document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SentenceItem {
    pub id: usize,
    pub text: String,
    pub page: Option<usize>,
    pub paragraph_idx: usize,
    pub is_paragraph_end: bool,
    pub is_section_break: bool,
    pub chapter_idx: Option<usize>,
}

impl Default for SentenceItem {
    fn default() -> Self {
        Self {
            id: 0,
            text: String::new(),
            page: None,
            paragraph_idx: 0,
            is_paragraph_end: false,
            is_section_break: false,
            chapter_idx: None,
        }
    }
}

/// Table of contents / chapter entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TocEntry {
    pub title: String,
    pub sentence_idx: usize,
    pub page: Option<usize>,
    pub level: usize,
}

/// Rendered HTML section for EPUB / DOCX / TXT.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChapterHtml {
    pub title: String,
    pub html: String,
}

/// Payload returned to frontend when opening an EPUB, DOCX, or TXT book.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocumentPayload {
    pub book: BookMeta,
    pub sentences: Vec<SentenceItem>,
    pub toc: Vec<TocEntry>,
    pub html_chapters: Vec<ChapterHtml>,
}

/// Catalog or custom cloned voice metadata + local availability.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VoiceInfo {
    pub voice_id: String,
    pub name: String,
    pub language: String,
    pub locale: String,
    pub gender: String,
    pub age: String,
    pub description: String,
    pub downloaded: bool,
    pub engine: String,
    pub is_cloned: bool,
    pub is_native: bool,
}

/// Persisted metadata for a user-created Qwen3-TTS cloned voice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ClonedVoiceMeta {
    pub voice_id: String,
    pub name: String,
    pub description: String,
    pub ref_text: Option<String>,
    pub icl_mode: bool,
    pub duration_sec: f32,
    pub created_at: u64,
}

impl Default for ClonedVoiceMeta {
    fn default() -> Self {
        Self {
            voice_id: String::new(),
            name: String::new(),
            description: String::new(),
            ref_text: None,
            icl_mode: false,
            duration_sec: 0.0,
            created_at: 0,
        }
    }
}

/// Duration/sample-rate inspection result for a user-selected reference audio file.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioClipProbe {
    pub path: String,
    pub filename: String,
    pub duration_sec: f32,
    pub sample_rate: u32,
    pub recommended_start_sec: f32,
    pub recommended_end_sec: f32,
    pub status: String, // "too_short" | "optimal" | "will_trim"
    pub message: String,
}

/// Request payload to clone a voice via Qwen3-TTS.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CloneVoiceRequest {
    pub name: String,
    pub audio_path: String,
    pub ref_text: Option<String>,
    pub trim_start_sec: Option<f32>,
    pub trim_end_sec: Option<f32>,
}

/// Availability status for a single Qwen3-TTS base model size.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QwenVariantStatus {
    pub variant: QwenModelVariant,
    pub display_name: String,
    pub model_ready: bool,
    pub engine_loaded: bool,
    pub model_dir: String,
    pub estimated_size_mb: u64,
}

/// Availability and hardware execution status for Qwen3-TTS voice cloning.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QwenModelStatus {
    pub active_variant: QwenModelVariant,
    pub model_ready: bool,
    pub engine_loaded: bool,
    pub device_label: String,
    pub model_dir: String,
    pub estimated_size_mb: u64,
    pub variants: Vec<QwenVariantStatus>,
}

/// Response returned after switching the active Qwen3-TTS model size.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetQwenVariantResponse {
    pub settings: Settings,
    pub status: QwenModelStatus,
}

/// Response returned after cloning a voice cleanly updates both catalog and metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CloneVoiceResponse {
    pub created: ClonedVoiceMeta,
    pub voices: Vec<VoiceInfo>,
}

/// Response returned after deleting a cloned voice cleanly updates catalog and active voice.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeleteClonedVoiceResponse {
    pub voices: Vec<VoiceInfo>,
    pub settings: Settings,
}

/// Response returned after switching the active TTS language.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetTtsLanguageResponse {
    pub settings: Settings,
    pub voices: Vec<VoiceInfo>,
    pub language_models: Vec<LanguageModelStatus>,
}

/// Current runtime setup & asset availability returned to frontend on startup.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppBootstrap {
    pub model_ready: bool,
    pub engine_loaded: bool,
    pub language_models: Vec<LanguageModelStatus>,
    pub qwen_model_variant: QwenModelVariant,
    pub qwen_model_ready: bool,
    pub qwen_device_label: String,
    pub appdata_dir: String,
    pub data_dir: String,
    pub media_base_url: String,
    pub platform: String,
    pub voice_cloning_enabled: bool,
    pub settings: Settings,
    pub library: Vec<BookMeta>,
    pub pronunciations: Vec<PronunciationRule>,
    pub ignore_rules: Vec<IgnoreRule>,
    pub voices: Vec<VoiceInfo>,
    pub mp3_native_available: bool,
    pub ffmpeg_available: bool,
}

/// Download progress payload emitted over `download:progress`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadProgressEvent {
    pub kind: String,
    pub item_id: String,
    pub current_file: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub files_done: usize,
    pub files_total: usize,
    pub done: bool,
    pub error: Option<String>,
}

/// Playback & CC word timing event emitted over `tts:state`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TtsStateEvent {
    pub status: String, // "idle" | "loading" | "playing" | "paused" | "error"
    pub book_id: Option<String>,
    pub sentence_idx: usize,
    pub word_idx: usize,
    pub playback_ms: u32,
    pub sentence_duration_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_starts_ms: Option<Vec<u32>>,
    pub total_sentences: usize,
    pub elapsed_est_sec: f64,
    pub remaining_est_sec: f64,
    pub error: Option<String>,
}

/// Audio export format.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Wav,
    Mp3,
}

/// Audio export scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportScope {
    EntireBook,
    Range,
}

/// Request from frontend to export book sentences to WAV or MP3.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportRequest {
    pub book_id: String,
    pub book_title: String,
    pub format: ExportFormat,
    pub scope: ExportScope,
    pub start_sentence: usize,
    pub end_sentence: usize,
    pub voice_id: String,
    pub speed: f32,
    pub output_path: String,
    pub sentences: Vec<SentenceItem>,
}

/// Progress update emitted continuously over `export:progress`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportProgressEvent {
    pub job_id: String,
    pub book_title: String,
    pub format: ExportFormat,
    pub status: String, // "preparing" | "running" | "finalizing" | "completed" | "cancelled" | "error"
    pub completed_sentences: usize,
    pub total_sentences: usize,
    pub percent: f32,
    pub elapsed_sec: f64,
    pub eta_sec: Option<f64>,
    pub realtime_factor: f64,
    pub bytes_written: u64,
    pub output_path: String,
    pub error: Option<String>,
}

/// Sleep timer tick emitted over `sleep:tick`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SleepTimerStatus {
    pub active: bool,
    pub mode: String, // "off" | "minutes" | "end_of_chapter"
    pub remaining_sec: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_language_metadata_and_serde_round_trip() {
        assert_eq!(AppLanguage::all().len(), 7);
        assert_eq!(AppLanguage::En.pocket_folder(), None);
        assert_eq!(AppLanguage::En.engine_id(), "phonon");
        assert_eq!(AppLanguage::En.model_id(), "phonon-31m-en");
        assert_eq!(AppLanguage::En.estimated_size_mb(), 65);
        assert_eq!(AppLanguage::En.qwen_language(), "english");

        let expected = [
            (AppLanguage::Fr, "fr", "french", "pocket:fr:estelle", "french"),
            (AppLanguage::De, "de", "german", "pocket:de:juergen", "german"),
            (AppLanguage::Es, "es", "spanish", "pocket:es:lola", "spanish"),
            (AppLanguage::Pt, "pt", "portuguese", "pocket:pt:rafael", "auto"),
            (AppLanguage::It, "it", "italian", "pocket:it:giovanni", "auto"),
            (AppLanguage::Nl, "nl", "dutch", "pocket:nl:daan", "auto"),
        ];
        for (lang, code, folder, def_vid, qwen_lang) in expected {
            assert_eq!(lang.code(), code);
            assert_eq!(AppLanguage::from_code(&code.to_uppercase()), Some(lang));
            assert_eq!(lang.pocket_folder(), Some(folder));
            assert_eq!(lang.engine_id(), "pocket");
            assert_eq!(lang.model_id(), format!("pocket-tts-{code}"));
            assert_eq!(lang.estimated_size_mb(), 209);
            assert_eq!(lang.default_voice_id(), def_vid);
            assert_eq!(lang.qwen_language(), qwen_lang);
            let _ = lang.ptts_lang();
        }
        assert_eq!(AppLanguage::from_code("xx"), None);

        // Legacy Settings JSON without ui_language/tts_language deserializes with clean defaults.
        let legacy: Settings = serde_json::from_str(r#"{"theme":"light","speed":1.2}"#).unwrap();
        assert_eq!(legacy.ui_language, None);
        assert_eq!(legacy.tts_language, AppLanguage::En);
        assert_eq!(legacy.theme, "light");
    }
}
