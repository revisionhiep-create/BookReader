# BookReader

A self-contained Windows desktop text-to-speech reader built with **Rust** and **Tauri v2** (Edge WebView2), powered locally by **Gradium Phonon 31M** (`gradium/phonon-31m-en` via `ptts`) across all 37 English male and female voices.

No Python runtime or cloud TTS API is required — on first launch, BookReader downloads the Phonon 31M model and English voice prompts into a portable folder alongside the executable and runs inference locally on your machine.

---

## Features

- **Document Support with Inline Images**: Read **PDF**, **EPUB**, **DOCX** (Word), and **TXT** files while keeping embedded document images intact.
- **37 Local English Voices + Custom Voice Cloning**: Male and female Gradium Phonon 31M English voices downloaded directly inside your portable data directory, plus local **Qwen3-TTS 0.6B-Base** (Fast, ~2.5 GB) / **1.7B-Base** (Best Quality, ~4.5 GB) voice cloning (5–15s reference clips with optional transcript for high-fidelity ICL mode or instant X-Vector mode) stored under the **Cloned** category.
- **Live Highlighting & Closed Captions (CC)**:
  - Highlights the active sentence directly on the PDF canvas overlay or rich text view and scrolls smoothly along the top of the viewport.
  - Toggleable **Closed Captions** bar shows real-time word-by-word highlighting with adjustable caption font size (`A-` / `21px` / `A+` in the top toolbar and a slider in **Settings**).
- **Page Zoom & Dark Mode**:
  - Top-toolbar **Page Zoom** controls (`-` / `100%` / `+`), keyboard shortcuts, and `Ctrl+Wheel` across PDF, EPUB, DOCX, and TXT.
  - Toggleable **Dark / Light** theme plus a **Dark Page** toggle in the top toolbar to invert white PDF pages when reading in dark mode.
- **Smart Auto-Scroll ("Back to reading")**:
  - Scroll freely anywhere in a book to re-read or skim ahead while narration continues.
  - Auto-scroll automatically pauses when manual scrolling is detected and displays a **Back to reading** button anchored cleanly above the Closed Captions bar.
- **Draggable Header & Footer Ignore Margins (PDF)**:
  - Drag top and bottom margin lines directly on PDF pages to preview blurred ignore regions so page numbers and running headers are excluded from narration.
- **Pronunciation & Ignore Word Rules + Symbol Sanitization**:
  - Dedicated **Pronunciation** and **Ignore Words** rule editors supporting regex patterns, literal matching, **Match Case**, and **Ignore Word Boundary** toggles.
  - Built-in sanitization cleans foreign symbol emotes, stray brackets, and optional citation tags before speech synthesis.
- **Natural Pauses & Pitch-Preserving Speed**:
  - Per-punctuation pause configuration for periods (`.`), commas (`,`), semicolons (`;`), and paragraph breaks.
  - Smooth `0.50x`–`3.00x` WSOLA time-stretching preserves natural pitch, paired with system media key integration and Windows wake lock during playback/export.
- **Search, TOC, Bookmarks, Sleep Timer & Audio Export**:
  - Full-document search (`Ctrl+F`), chapter Table of Contents, saved position bookmarks, chapter/minute sleep timers, and multi-minute offline **WAV / MP3** export with live progress bars.
- **Persistent Window Placement & Multi-Monitor Safeguards**:
  - Remembers your window position, size, and maximized state across launches, and automatically relocates onto active screen real estate if a previously used monitor is disconnected.

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Space` | Play / Pause narration |
| `Left Arrow` / `Right Arrow` | Previous / Next sentence |
| `Ctrl + F` | Open document search |
| `Ctrl + =` / `Ctrl + +` | Zoom page in |
| `Ctrl + -` | Zoom page out |
| `Ctrl + 0` | Reset page zoom to `100%` |
| `Ctrl + Mouse Wheel` | Smooth zoom over reader viewport |

*(Shortcuts do not hijack typing when an input field or modal dialog is focused.)*

---

## Data & Settings Storage

BookReader automatically initializes two folders:

- **Portable Assets** (`BookReader_Data/` next to `BookReader.exe` in release builds, or in the workspace root during dev):
  - `BookReader_Data/models/phonon-31m-en/` — downloaded Phonon 31M weights and tokenizer files
  - `BookReader_Data/models/qwen3-tts-0.6b-base/` — downloaded Qwen3-TTS 0.6B-Base weights and 12Hz speech tokenizer (Fast, ~2.5 GB)
  - `BookReader_Data/models/qwen3-tts-1.7b-base/` — downloaded Qwen3-TTS 1.7B-Base weights and 12Hz speech tokenizer (Best Quality, ~4.5 GB)
  - `BookReader_Data/voices/` — downloaded voice conditioning audio files and `cloned/` custom voice prompts
  - `BookReader_Data/books/` — imported copies of your books and cached assets
- **User Preferences** (`%APPDATA%\Bookreader\` on Windows):
  - Saved immediately on every setting change: theme, voice, speed, typography, zoom, caption font size, pause durations, dark PDF page state, pronunciation rules, ignore rules, library reading progress/bookmarks, and saved desktop window geometry (`window_state.json`).

---

## Building from Source (Windows)

### Prerequisites

- [Rust toolchain](https://rustup.rs/) (2024 edition)
- [Node.js](https://nodejs.org/) (LTS) and npm
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 10/11)

### Setup & Commands

```powershell
# Install frontend dependencies
npm install

# Run in development mode (hot-reloads Vite + Tauri backend)
npm run tauri dev

# Verify frontend TypeScript & Vite bundle
npm run build

# Run Rust backend unit tests
cargo test --manifest-path src-tauri/Cargo.toml

# Build standalone release executable
npx tauri build --no-bundle
```

The compiled executable is emitted to `src-tauri\target\release\BookReader.exe` (and copied to `BookReader.exe` in the repository root for release convenience).

---

## Attribution & Stack

- **TTS Engine**: [Gradium Phonon 31M (`gradium/phonon-31m-en`)](https://huggingface.co/gradium/phonon-31m-en) via [`ptts`](https://crates.io/crates/ptts)
- **Desktop Framework**: [Tauri v2](https://v2.tauri.app/) (Rust + Edge WebView2)
- **PDF Rendering**: [PDF.js (`pdfjs-dist`)](https://mozilla.github.io/pdf.js/)
- **Audio & Media**: `cpal`, `hound`, `mp3lame-encoder`, `souvlaki`
