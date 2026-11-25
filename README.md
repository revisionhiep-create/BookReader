# BookReader

A self-contained cross-platform (**Windows** & **macOS**) desktop text-to-speech reader built with **Rust** and **Tauri v2**, powered locally by **Gradium Phonon 31M** (`gradium/phonon-31m-en` via `ptts`) across 37 English voices, with optional local **Qwen3-TTS** voice cloning.

No Python runtime, account, or cloud TTS API is required — models and voices download locally into a portable `BookReader_Data/` folder right next to `BookReader.exe` (Windows) or `BookReader.app` (macOS).

**[Download Windows (`BookReader.exe`)](https://github.com/revisionhiep-create/BookReader/releases/latest/download/BookReader.exe)** · **[Download macOS Apple Silicon (`.dmg`)](https://github.com/revisionhiep-create/BookReader/releases/latest/download/BookReader-1.1.0-macos-arm64-portable.dmg)** · **[Download macOS Intel (`.dmg`)](https://github.com/revisionhiep-create/BookReader/releases/latest/download/BookReader-1.1.0-macos-x64-portable.dmg)** · [View Releases](https://github.com/revisionhiep-create/BookReader/releases/latest) · **[Watch Demo](https://youtu.be/9IEjVdOaGtU)**

---

## Demo Video

[![BookReader Demo Video](https://img.youtube.com/vi/9IEjVdOaGtU/maxresdefault.jpg)](https://youtu.be/9IEjVdOaGtU)

Watch the demo on YouTube: **https://youtu.be/9IEjVdOaGtU**

---

## Platform Folders

Platform-specific configs, build/test scripts, docs, and binaries are separated into dedicated folders while sharing the unified frontend (`src/`) and Rust backend (`src-tauri/`):

- **`windows/`** — Windows build script (`windows/build.ps1`), Tauri overlay config, standalone `windows/BookReader.exe`, and [Windows Quick Start (`windows/README.md`)](windows/README.md)
- **`macos/`** — macOS portable `.dmg` packager (`macos/build_portable_dmg.sh`), macOS feature verification suite (`macos/test_macos_features.sh`), Tauri overlay config, and [macOS Quick Start (`macos/README.md`)](macos/README.md)
- **`android/`** — Adaptive Android UI (`android/ui/`), multi-device browser preview lab (`npm run preview:android`), Kotlin `MediaSession` service, emulator launcher (`android/run_in_emulator.ps1`), APK build script, and [Android Guide (`android/README.md`)](android/README.md)

---

## Quick Start

### Windows (`BookReader.exe`)
See [windows/README.md](windows/README.md) for full details.
- Put `BookReader.exe` inside its own dedicated folder (e.g., `C:\BookReader\BookReader.exe`).
- On first launch, Windows SmartScreen may show **"Windows protected your PC"** — click **More info** → **Run anyway**.

### macOS Portable (`BookReader.app` via `.dmg`)
See [macos/README.md](macos/README.md) for full details.
- Open the `.dmg` for your Mac (**Apple Silicon `arm64`** or **Intel `x64`**) and drag `BookReader.app` into its own writable folder (e.g., `~/BookReader/`).
- On first launch (unsigned build), **Right-click** `BookReader.app` → **Open** → **Open** (or run `xattr -cr /path/to/BookReader.app`).
- Portable `BookReader_Data/` is created beside `BookReader.app` (falling back automatically to `~/Library/Application Support/Bookreader/BookReader_Data/` if launched from `/Applications` or a read-only disk image).

### First-Time Setup & Reading
1. **First-Time Voice Engine Setup**: Click **Download Phonon 31M (~65 MB)** to install the 4 core model files into `BookReader_Data/models/`.
2. **Open a Book & Listen**: Click **Import Book** (or open **Library**) and pick a **PDF**, **EPUB**, **DOCX**, or **TXT** file. Click any sentence to jump, or press `Space` to Play/Pause.
3. **Switch Voices or Clone a Custom Voice**: Choose from 37 built-in English voices, or open **Voice Cloning** (`0.6B-Base` ~2.5 GB or `1.7B-Base` ~4.5 GB) with a 3–30s audio clip (uses NVIDIA CUDA on Windows if available, Apple Metal GPU on Apple Silicon, or CPU fallback).
4. **Controls**: Toggle **Closed Captions (CC)** (`A-`/`21px`/`A+`), zoom with `Ctrl`/`⌘` + `+/-` or `Ctrl`/`⌘` + Wheel, toggle **Dark Page** on PDFs, and drag **Header & Footer Ignore Margins** on PDFs.

---

## Features

- **Document Support with Inline Images**: Read **PDF**, **EPUB**, **DOCX** (Word), and **TXT** files while keeping embedded document images intact.
- **37 Local English Voices + Custom Voice Cloning**: Male and female Gradium Phonon 31M English voices downloaded directly inside your portable data directory, plus local **Qwen3-TTS 0.6B-Base** (Fast, ~2.5 GB) / **1.7B-Base** (Best Quality, ~4.5 GB) voice cloning (3–30s reference clips, 5–15s recommended, with optional transcript for high-fidelity ICL mode or instant X-Vector mode) stored under the **Cloned** category.
- **Live Highlighting & Closed Captions (CC)**:
  - Highlights the active sentence accurately on the PDF canvas overlay (without cross-page bleed) or rich text view and scrolls smoothly along the top of the viewport.
  - Toggleable **Closed Captions** bar shows smooth 60–120 FPS latency-compensated word-by-word highlighting with adjustable caption font size (`A-` / `21px` / `A+` in the top toolbar and a slider in **Settings**).
- **Page Zoom & Dark Mode**:
  - Top-toolbar **Page Zoom** controls (`-` / `100%` / `+`), keyboard shortcuts, and `Ctrl+Wheel` across PDF, EPUB, DOCX, and TXT.
  - Toggleable **Dark / Light** theme plus a **Dark Page** toggle in the top toolbar to invert white PDF pages when reading in dark mode.
- **Smart Auto-Scroll ("Back to reading")**:
  - Scroll freely anywhere in a book to re-read or skim ahead while narration continues.
  - Auto-scroll automatically pauses when manual scrolling is detected and displays a **Back to reading** button anchored cleanly above the Closed Captions bar.
- **Draggable Header & Footer Ignore Margins (PDF)**:
  - Drag top and bottom margin lines directly on PDF pages to preview blurred ignore regions so page numbers and running headers are excluded from narration.
- **Pronunciation & Ignore Word Rules + Symbol Sanitization**:
  - Dedicated **Pronunciation** and **Ignore Words** rule editors supporting regex patterns, literal matching, **Match Case**, and **Ignore Word Boundary** toggles, plus instant audio preview.
  - Built-in sanitization cleans expressive repeated punctuation (`!!!!`, `?!`, `...!`, stray `~`), foreign symbol emotes, stray brackets, and optional citation tags before speech synthesis so neural TTS stays natural on light novels and webnovels.
- **Natural Pauses & Pitch-Preserving Speed**:
  - Per-punctuation pause configuration for periods (`.`), commas (`,`), semicolons (`;`), and paragraph breaks.
  - Smooth `0.50x`–`3.00x` WSOLA time-stretching preserves natural pitch, paired with system media key integration and Windows wake lock during playback/export.
- **Search, TOC, Bookmarks, Warmup Banner & Audio Export**:
  - Full-document search (`Ctrl+F`), chapter Table of Contents, automatic position saving with instant bookmark jump, a startup/model-warmup & PDF indexing status banner, chapter/minute sleep timers, and multi-minute offline **WAV / MP3** export with live progress bars.
- **Persistent Window Placement & Multi-Monitor Safeguards**:
  - Remembers your window position, size, and maximized state across launches, and automatically relocates onto active screen real estate if a previously used monitor is disconnected.

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Space` | Play / Pause narration |
| `Left Arrow` / `Right Arrow` | Previous / Next sentence |
| `Ctrl + F` / `⌘ + F` | Open document search |
| `Ctrl + =` / `⌘ + =` | Zoom page in |
| `Ctrl + -` / `⌘ + -` | Zoom page out |
| `Ctrl + 0` / `⌘ + 0` | Reset page zoom to `100%` |
| `Ctrl + Wheel` / `⌘ + Wheel` | Smooth zoom over reader viewport |

*(Shortcuts do not hijack typing when an input field or modal dialog is focused.)*

---

## Data & Settings Storage

BookReader automatically initializes two folders:

- **Portable Assets** (`BookReader_Data/` next to `BookReader.exe` or `BookReader.app` in release builds, or in the workspace root during dev):
  - `BookReader_Data/models/phonon-31m-en/` — downloaded Phonon 31M weights and tokenizer files
  - `BookReader_Data/models/qwen3-tts-0.6b-base/` — downloaded Qwen3-TTS 0.6B-Base weights and 12Hz speech tokenizer (Fast, ~2.5 GB)
  - `BookReader_Data/models/qwen3-tts-1.7b-base/` — downloaded Qwen3-TTS 1.7B-Base weights and 12Hz speech tokenizer (Best Quality, ~4.5 GB)
  - `BookReader_Data/voices/` — downloaded voice conditioning audio files and `cloned/` custom voice prompts
  - `BookReader_Data/books/` — imported copies of your books and cached assets
- **User Preferences** (`%APPDATA%\Bookreader\` on Windows, `~/Library/Application Support/Bookreader/` on macOS):
  - Saved immediately on every setting change: theme, voice, speed, typography, zoom, caption font size, pause durations, dark PDF page state, pronunciation rules, ignore rules, library reading progress/bookmarks, and saved desktop window geometry (`window_state.json`).

---

## Building from Source

See [windows/README.md](windows/README.md) for Windows build instructions and [macos/README.md](macos/README.md) for macOS `.app` & `.dmg` build and feature-testing instructions.

---

## Attribution & Stack

- **TTS Engine**: [Gradium Phonon 31M (`gradium/phonon-31m-en`)](https://huggingface.co/gradium/phonon-31m-en) via [`ptts`](https://crates.io/crates/ptts)
- **Voice Cloning Engine**: [Qwen3-TTS](https://huggingface.co/Qwen) (`0.6B-Base` / `1.7B-Base`) via [`qwen_tts`](https://crates.io/crates/qwen_tts) & [`candle-core`](https://crates.io/crates/candle-core)
- **Desktop Framework**: [Tauri v2](https://v2.tauri.app/) (Rust + Edge WebView2)
- **PDF Rendering**: [PDF.js (`pdfjs-dist`)](https://mozilla.github.io/pdf.js/)
- **Audio & Media**: `cpal`, `hound`, `mp3lame-encoder`, `souvlaki`
