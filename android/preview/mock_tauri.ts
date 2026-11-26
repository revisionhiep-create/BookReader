import type { Event, UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppBootstrap,
  BookMeta,
  DocumentPayload,
  IgnoreRule,
  PronunciationRule,
  SentenceItem,
  Settings,
  SleepTimerStatus,
  TocEntry,
  TtsStateEvent,
  VoiceInfo,
} from "../../src/types";

const SAMPLE_SENTENCES_TEXT = [
  "Chapter 4: Into the Lower Gallery",
  "his head from playing <Dreadful-Crusade of Oblivion>, things were bound to go smoothly.",
  "Of course, there were drawbacks too.",
  "'The biggest problem is still the lack of firepower.'",
  "Guns were not a bad option.",
  "But they had clear limits because they were designed to kill humans.",
  "In other words, unless it was a Magitech Rifle, they still lacked firepower against monsters.",
  "'I need 1st-Tier offensive magic.'",
  "Eugene smiled awkwardly and brushed the matter aside.",
  "\"Ha ha. You need at least this much to survive in the slums.\"",
  "\"It feels like you are hiding something....\"",
  "However, there was an unwritten rule in the mining industry that you did not ask about a miner's past.",
  "Gavin was a man who faithfully followed the industry's unwritten rules.",
  "\"Let us keep going.\"",
  "\"Yes.\"",
  "Gavin adjusted the strap of his lantern and stepped onto the narrow stone stairs descending into the gallery.",
  "The air grew noticeably cooler as the muffled hum of surface machinery faded behind them.",
];

function buildSampleVoices(): VoiceInfo[] {
  const entries: Array<[string, string, string, string, string, string]> = [
    ["NbpkqMVS3CJeq2j8", "Zoey", "en-us", "female", "Adult", "Playful, upbeat American voice with engaging conversational warmth."],
    ["NIWIOv5vTi5eRMj8", "Juniper", "en-us", "female", "Young Adult", "Cheerful presence with warm resonance, personable and clear."],
    ["vjFyp2BcCyTlUmYb", "Everly", "en-us", "female", "Middle-age", "Rounded, soft-edged tone with an easy, relaxed storytelling delivery."],
    ["4SZHfMpw-p46Ywgs", "Harper", "en-us", "female", "Adult", "Modern, confident, and friendly standard American voice."],
    ["bXwrkHhURL1VFJdG", "Hadley", "en-us", "female", "Middle-age", "Settled, even-toned, and genuinely kind with crisp consonants."],
    ["nGzMHMPAWGaJFHOo", "Delia", "en-us", "female", "Middle-age", "Low, grounded, and sincere delivery ideal for earnest prose."],
    ["LMDIYE0Oa377Qh6Z", "Easton", "en-us", "male", "Young Adult", "Punchy and close in, with crisp consonant attack and expressive lift."],
    ["40QrMVgAxFiUnP9f", "Micah", "en-us", "male", "Young Adult", "Buoyant and energetic with clean, clear articulation."],
    ["0zLApsZfVLLNaEGl", "Trevor", "en-us", "male", "Middle-age", "Buoyant energy over a resonant mid-low core with soft phrase landings."],
    ["_6Aslh2DxfmnRLmP", "Russell", "en-us", "male", "Adult", "High-energy American adult voice with clear, motivating intensity."],
    ["qIxlZ7Ei8KvWlyQH", "Preston", "en-us", "male", "Middle-age", "Trim, focused delivery with clean edges and a steady, low-set core."],
    ["d9XCyhjo4JhkHF1d", "Miles", "en-us", "male", "Young Adult", "Resonant and decisive narrator with strong dynamic range."],
    ["6PWnV0Nq4wu7RVBT", "Maeve", "en-gb", "female", "Adult", "Sparky, attentive British voice that stays clear and natural."],
    ["GgfEkEJtxZR7gnpy", "Freya", "en-gb", "female", "Young", "Young British voice, glossy and confident with lively brightness."],
    ["uem82D50GRv2Dwma", "Pippa", "en-gb", "female", "Adult", "Confident, upbeat British adult voice with expressive pacing."],
    ["y9bQqIDnyxwqK01t", "Elodie-Rose", "en-gb", "female", "Young", "Young British voice with enthusiastic energy and crisp articulation."],
    ["gDT1nz7Ie36ZhL-C", "Imogen", "en-gb", "female", "Adult", "Warm, friendly British voice that feels calm and inviting."],
    ["m9MxpY6IUGXtWp76", "Lottie", "en-gb", "female", "Young Adult", "Sparky and direct with clean consonants and expressive pitch range."],
    ["gfP44RlHwr2kEwk7", "Bryony", "en-gb", "female", "Middle-age", "Full, rich mid-range tones, softly relaxed and intimate."],
    ["X6NceqF285Gr04gb", "Alfie", "en-gb", "male", "Young Adult", "Punchy and forward British voice with crisp consonant attack."],
    ["YyKcxPG7iIgS3jsK", "Hugh", "en-gb", "male", "Middle-age", "Soft and close, airy in texture, with an attentive sincere delivery."],
    ["zUCxzrOrugTSis03", "Edwin", "en-gb", "male", "Middle-age", "Efficient and firm British voice with tidy, measured articulation."],
    ["JOW0vchyswkQUMDS", "Spencer", "en-gb", "male", "Middle-age", "Light and airy British voice with a patient, unhurried cadence."],
    ["dME3IWyZBvmh1n1q", "Toby", "en-gb", "male", "Adult", "Attentive British adult voice with natural conversational flow."],
    ["Zn7g6NxLqXlJb7Qi", "Teddy", "en-gb", "male", "Young Adult", "Close, articulate British delivery with strong expressive shifts."],
    ["xPDpsV3F592srkjA", "Captain Silas Blackwater", "characters", "character", "Older", "Deep, gravelly West Country sea captain with hearty roguish flair."],
    ["nOykTmcH9ydsGGIc", "Morwenna of the Deep", "characters", "character", "Adult", "Low, husky alto, slow and intimate with a hint of mystery."],
    ["lX3LavMNdlIbgEHH", "Old Mortlake", "characters", "character", "Elderly", "Low, raspy Victorian storyteller with heavy, deliberate pauses."],
    ["dGyGDKo2osj7h3s7", "Azgorath", "characters", "character", "Ancient", "Cavernous, impossibly deep bass voice with calm, measured menace."],
    ["cXoIXJ2llS8S0WOW", "Fennick the Young Elf", "characters", "character", "Youth", "Warm, earnest young fantasy voice full of wide-eyed curiosity."],
    ["GXaSqMEmOg12OIYb", "The Thing Under the Stairs", "characters", "character", "Unknown", "Gravelly, breathy creature whisper pitched low for eerie tales."],
    ["xO8xQo3BrB8FuI6J", "Vyrmathrax the Ancient", "characters", "character", "Ancient", "Deep, resonant dragon voice with dry, unhurried gravitas."],
    ["cYtsRSxV5q9IMehn", "Grub the Ogre", "characters", "character", "Adult", "Gruff, good-natured low rumble with lumbering rhythm and warmth."],
    ["gSgG5Tor0GPEnqzC", "Master Aldric", "characters", "character", "Elderly", "Wise old British wizard with rich resonance and kindly cadence."],
    ["NIWoEurJHMJjyUTe", "The Snow Queen", "characters", "character", "Adult", "Cool, crystalline mezzo voice, poised and quietly commanding."],
    ["y2eiKxtQo2B67deU", "Sir Bramwell", "characters", "character", "Middle-age", "Booming, theatrical English knight full of grand bravado."],
    ["QXNr0SvkukLB4wPq", "Fairy Godmother", "characters", "character", "Older", "Warm, velvety alto voice, cozy, unhurried, and reassuring."],
  ];
  return entries.map(([voice_id, name, locale, gender, age, description]) => ({
    voice_id,
    name,
    locale,
    gender,
    age,
    description,
    downloaded: true,
    engine: "phonon",
    is_cloned: false,
  }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function installPreviewMock(): void {
  if (window.__BOOKREADER_MOCK__) return;

  const sentences: SentenceItem[] = SAMPLE_SENTENCES_TEXT.map((text, idx) => ({
    id: idx,
    text,
    page: null,
    paragraph_idx: idx,
    is_paragraph_end: true,
    is_section_break: idx === 0,
    chapter_idx: 0,
  }));

  const toc: TocEntry[] = [
    { title: "Chapter 1: Copper Street Slums", sentence_idx: 0, page: null, level: 1 },
    { title: "Chapter 2: The Magitech Forge", sentence_idx: 1, page: null, level: 1 },
    { title: "Chapter 3: Gavin's Contract", sentence_idx: 6, page: null, level: 1 },
    { title: "Chapter 4: Into the Lower Gallery", sentence_idx: 14, page: null, level: 1 },
  ];

  const book1: BookMeta = {
    id: "preview-labyrinth",
    title: "The Labyrinth Is Too Easy For Me",
    format: "epub",
    stored_filename: "preview-labyrinth.epub",
    original_filename: "The_Labyrinth_Is_Too_Easy.epub",
    added_at: 1760000000,
    last_opened_at: 1760100000,
    current_sentence_idx: 2,
    current_page: 1,
    scroll_y: 0,
    total_sentences: sentences.length,
    total_words: 196,
    pdf_header_ignore_pct: 0.06,
    pdf_footer_ignore_pct: 0.06,
    bookmarks: [
      {
        id: "bm-1",
        label: "Of course, there were drawbacks too.",
        sentence_idx: 2,
        page: null,
        created_at: 1760100100,
      },
      {
        id: "bm-2",
        label: "I need 1st-Tier offensive magic.",
        sentence_idx: 7,
        page: null,
        created_at: 1760100200,
      },
    ],
  };

  const book2: BookMeta = {
    id: "preview-notes",
    title: "Phonon 31M Acoustic Notes",
    format: "txt",
    stored_filename: "preview-notes.txt",
    original_filename: "phonon_notes.txt",
    added_at: 1759900000,
    last_opened_at: 1759950000,
    current_sentence_idx: 0,
    current_page: 1,
    scroll_y: 0,
    total_sentences: 8,
    total_words: 92,
    pdf_header_ignore_pct: 0.06,
    pdf_footer_ignore_pct: 0.06,
    bookmarks: [],
  };

  const book3: BookMeta = {
    id: "preview-blacksmith",
    title: "A Mythic-Grade Blacksmith Devours the Tower",
    format: "epub",
    stored_filename: "preview-blacksmith.epub",
    original_filename: "Mythic_Blacksmith_Ch1-80.epub",
    added_at: 1759800000,
    last_opened_at: 1759850000,
    current_sentence_idx: 24,
    current_page: 1,
    scroll_y: 0,
    total_sentences: 120,
    total_words: 1840,
    pdf_header_ignore_pct: 0.06,
    pdf_footer_ignore_pct: 0.06,
    bookmarks: [],
  };

  const book4: BookMeta = {
    id: "preview-manual",
    title: "Magitech Architecture Reference",
    format: "pdf",
    stored_filename: "preview-manual.pdf",
    original_filename: "magitech_architecture.pdf",
    added_at: 1759700000,
    last_opened_at: 1759750000,
    current_sentence_idx: 12,
    current_page: 3,
    scroll_y: 0,
    total_sentences: 64,
    total_words: 980,
    pdf_header_ignore_pct: 0.06,
    pdf_footer_ignore_pct: 0.06,
    bookmarks: [],
  };

  let library: BookMeta[] = [book1, book2, book3, book4];
  let voices = buildSampleVoices();
  let pronunciations: PronunciationRule[] = [
    {
      id: "pr-1",
      source: "Magitech",
      replace: "majitek",
      match_case: false,
      ignore_word_boundary: false,
      is_regex: false,
      enabled: true,
    },
    {
      id: "pr-2",
      source: "1st-Tier",
      replace: "first tier",
      match_case: false,
      ignore_word_boundary: false,
      is_regex: false,
      enabled: true,
    },
  ];
  let ignoreRules: IgnoreRule[] = [
    {
      id: "ig-1",
      pattern: "[TL Note: *]",
      match_case: false,
      ignore_word_boundary: true,
      is_regex: false,
      enabled: true,
    },
  ];

  let settings: Settings = {
    theme: "dark",
    voice_id: "40QrMVgAxFiUnP9f", // Micah
    qwen_model_variant: "0.6b",
    speed: 1.1,
    volume: 1.0,
    cc_enabled: true,
    sidebar_collapsed: false,
    pauses: {
      sentence_ms: 300,
      paragraph_ms: 550,
      section_ms: 950,
      comma_extra_ms: 0,
      semicolon_extra_ms: 0,
      adaptive_speed_scaling: true,
      preset: "fast_webnovel",
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
    pdf_reflow: false,
    last_book_id: book1.id,
  };

  let sleepTimer: SleepTimerStatus = { active: false, mode: "off", remaining_sec: null };
  let activeBookId = book1.id;
  let activeSentences: SentenceItem[] = sentences;
  let activeSentenceIdx = 2;
  let playing = false;
  let simTimer: number | undefined;
  let simWordIdx = 2;
  let simPlaybackMs = 650;

  const eventListeners = new Map<string, Set<(event: Event<unknown>) => void>>();
  const emit = <T>(name: string, payload: T) => {
    const set = eventListeners.get(name);
    if (!set) return;
    const ev = { event: name, id: Date.now(), payload } as Event<unknown>;
    set.forEach((fn) => fn(ev));
  };

  function wordTimelineFor(sid: number): { starts: number[]; durationMs: number; words: string[] } {
    const text = activeSentences[sid]?.text ?? "";
    const words = text.trim().split(/\s+/).filter(Boolean);
    const stepMs = Math.max(140, Math.round(280 / settings.speed));
    const starts = words.map((_, i) => i * stepMs);
    return { starts, durationMs: Math.max(300, words.length * stepMs + 220), words };
  }

  function buildTtsState(includeTimeline = true): TtsStateEvent {
    const totalSents = Math.max(1, activeSentences.length);
    const clampedIdx = Math.max(0, Math.min(totalSents - 1, activeSentenceIdx));
    const tl = wordTimelineFor(clampedIdx);
    return {
      status: playing ? "playing" : "paused",
      book_id: activeBookId,
      sentence_idx: clampedIdx,
      word_idx: Math.min(simWordIdx, Math.max(0, tl.words.length - 1)),
      playback_ms: simPlaybackMs,
      sentence_duration_ms: tl.durationMs,
      word_starts_ms: includeTimeline ? tl.starts : undefined,
      total_sentences: activeSentences.length,
      elapsed_est_sec: clampedIdx * 4.2 + simPlaybackMs / 1000,
      remaining_est_sec: Math.max(0, (activeSentences.length - clampedIdx) * 4.2),
      error: null,
    };
  }

  function stopSim(): void {
    if (simTimer !== undefined) {
      window.clearInterval(simTimer);
      simTimer = undefined;
    }
  }

  function startSim(): void {
    stopSim();
    if (activeSentences.length === 0) return;
    emit("tts:state", buildTtsState(true));
    simTimer = window.setInterval(() => {
      if (!playing || activeSentences.length === 0) return;
      const tl = wordTimelineFor(activeSentenceIdx);
      simPlaybackMs += 100;
      if (simPlaybackMs >= tl.durationMs) {
        activeSentenceIdx = (activeSentenceIdx + 1) % activeSentences.length;
        simPlaybackMs = 0;
        simWordIdx = 0;
        emit("tts:state", buildTtsState(true));
      } else {
        let w = 0;
        for (let i = 0; i < tl.starts.length; i++) {
          if (tl.starts[i] <= simPlaybackMs) w = i;
        }
        simWordIdx = w;
        emit("tts:state", buildTtsState(false));
      }
    }, 100);
  }

  function buildBookPayload(book: BookMeta): DocumentPayload {
    if (book.id === book1.id) {
      const html = `
        <h2>${escapeHtml(SAMPLE_SENTENCES_TEXT[0])}</h2>
        ${sentences
          .slice(1)
          .map(
            (s) =>
              `<p><span class="br-sent" data-sid="${s.id}">${escapeHtml(s.text)}</span></p>`,
          )
          .join("\n")}
      `;
      return {
        book,
        sentences,
        toc,
        html_chapters: [{ title: "Chapter 4", html }],
      };
    }
    const altSents: SentenceItem[] = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      text: `Sample sentence ${i + 1} inside ${book.title} demonstrating responsive Android reader typography and live TTS highlighting.`,
      page: null,
      paragraph_idx: i,
      is_paragraph_end: true,
      is_section_break: false,
      chapter_idx: 0,
    }));
    return {
      book,
      sentences: altSents,
      toc: [{ title: "Introduction", sentence_idx: 0, page: null, level: 1 }],
      html_chapters: [
        {
          title: "Introduction",
          html: altSents
            .map((s) => `<p><span class="br-sent" data-sid="${s.id}">${escapeHtml(s.text)}</span></p>`)
            .join("\n"),
        },
      ],
    };
  }

  window.__BOOKREADER_MOCK__ = {
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      switch (cmd) {
        case "get_bootstrap": {
          const boot: AppBootstrap = {
            model_ready: true,
            engine_loaded: true,
            qwen_model_variant: "0.6b",
            qwen_model_ready: false,
            qwen_device_label: "Disabled",
            appdata_dir: "/data/user/0/com.bookreader.android/files/config",
            data_dir: "/data/user/0/com.bookreader.android/files/BookReader_Data",
            media_base_url: "http://bookmedia.localhost",
            platform: "android",
            voice_cloning_enabled: false,
            settings,
            library,
            pronunciations,
            ignore_rules: ignoreRules,
            voices,
            mp3_native_available: true,
            ffmpeg_available: false,
          };
          return boot as T;
        }
        case "open_book": {
          const id = String(args.bookId || book1.id);
          const found = library.find((b) => b.id === id) ?? book1;
          stopSim();
          playing = false;
          const payload = buildBookPayload(found);
          activeBookId = found.id;
          activeSentences = payload.sentences;
          activeSentenceIdx = Math.max(
            0,
            Math.min(Math.max(0, activeSentences.length - 1), found.current_sentence_idx),
          );
          simPlaybackMs = 0;
          simWordIdx = 0;
          return payload as T;
        }
        case "update_settings": {
          settings = { ...settings, ...(args.settings as Settings) };
          return settings as T;
        }
        case "select_voice": {
          settings = { ...settings, voice_id: String(args.voiceId || settings.voice_id) };
          return settings as T;
        }
        case "list_voices":
          return voices as T;
        case "download_all_voices":
          voices = voices.map((v) => ({ ...v, downloaded: true }));
          return voices as T;
        case "tts_toggle_play_pause":
          playing = !playing;
          if (playing) startSim();
          else stopSim();
          return buildTtsState(true) as T;
        case "tts_play_from":
          activeSentenceIdx = Math.max(
            0,
            Math.min(Math.max(0, activeSentences.length - 1), Number(args.sentenceIdx ?? 0)),
          );
          simPlaybackMs = 0;
          simWordIdx = 0;
          playing = true;
          startSim();
          return buildTtsState(true) as T;
        case "tts_step_sentence":
          activeSentenceIdx = Math.max(
            0,
            Math.min(Math.max(0, activeSentences.length - 1), activeSentenceIdx + Number(args.delta ?? 0)),
          );
          simPlaybackMs = 0;
          simWordIdx = 0;
          if (playing) startSim();
          return buildTtsState(true) as T;
        case "tts_pause":
          playing = false;
          stopSim();
          return buildTtsState(false) as T;
        case "get_tts_state":
          return buildTtsState(true) as T;
        case "tts_preview_text":
          return undefined as T;
        case "validate_rule_regex":
          return undefined as T;
        case "save_pronunciation_rules":
          pronunciations = args.rules as PronunciationRule[];
          return pronunciations as T;
        case "save_ignore_rules":
          ignoreRules = args.rules as IgnoreRule[];
          return ignoreRules as T;
        case "add_bookmark": {
          const bookId = String(args.bookId || book1.id);
          library = library.map((b) =>
            b.id === bookId
              ? {
                  ...b,
                  bookmarks: [
                    ...b.bookmarks,
                    {
                      id: `bm-${Date.now()}`,
                      label: String(args.label || "Bookmark"),
                      sentence_idx: Number(args.sentenceIdx ?? 0),
                      page: (args.page as number | null) ?? null,
                      created_at: Math.floor(Date.now() / 1000),
                    },
                  ],
                }
              : b,
          );
          return (library.find((b) => b.id === bookId) ?? book1) as T;
        }
        case "remove_bookmark": {
          const bookId = String(args.bookId || book1.id);
          const bmId = String(args.bookmarkId || "");
          library = library.map((b) =>
            b.id === bookId ? { ...b, bookmarks: b.bookmarks.filter((bm) => bm.id !== bmId) } : b,
          );
          return (library.find((b) => b.id === bookId) ?? book1) as T;
        }
        case "delete_book": {
          const bookId = String(args.bookId || "");
          library = library.filter((b) => b.id !== bookId);
          if (bookId === activeBookId) {
            stopSim();
            playing = false;
            simPlaybackMs = 0;
            simWordIdx = 0;
          }
          return library as T;
        }
        case "set_sleep_timer": {
          const mode = String(args.mode || "off") as SleepTimerStatus["mode"];
          sleepTimer =
            mode === "off"
              ? { active: false, mode: "off", remaining_sec: null }
              : mode === "end_of_chapter"
                ? { active: true, mode: "end_of_chapter", remaining_sec: null }
                : { active: true, mode: "minutes", remaining_sec: Number(args.minutes ?? 15) * 60 };
          return sleepTimer as T;
        }
        case "import_book_bytes": {
          const filename = String(args.filename || "Imported.txt");
          const created: BookMeta = {
            id: `imported-${Date.now()}`,
            title: filename.replace(/\.[^.]+$/, ""),
            format: "txt",
            stored_filename: filename,
            original_filename: filename,
            added_at: Math.floor(Date.now() / 1000),
            last_opened_at: Math.floor(Date.now() / 1000),
            current_sentence_idx: 0,
            current_page: 1,
            scroll_y: 0,
            total_sentences: 8,
            total_words: 92,
            pdf_header_ignore_pct: 0.06,
            pdf_footer_ignore_pct: 0.06,
            bookmarks: [],
          };
          library = [created, ...library];
          return created as T;
        }
        default:
          return undefined as T;
      }
    },

    async listen<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
      let set = eventListeners.get(event);
      if (!set) {
        set = new Set();
        eventListeners.set(event, set);
      }
      const wrapped = handler as (event: Event<unknown>) => void;
      set.add(wrapped);
      return () => {
        set?.delete(wrapped);
      };
    },

    async openDialog(): Promise<string | null> {
      throw new Error("Use browser file picker fallback in preview");
    },

    async saveDialog(): Promise<string | null> {
      return "/storage/emulated/0/Download/BookReader_Export.mp3";
    },
  };
}
