# BookReader

A self-contained Windows desktop text-to-speech reader built with **Rust** and **Tauri v2** (Edge WebView2), powered locally by **Gradium Phonon 31M** (`gradium/phonon-31m-en` via `ptts`) across 37 English voices, with optional local **Qwen3-TTS** voice cloning.

No Python runtime, account, or cloud TTS API is required — models and voices download locally into a portable `BookReader_Data/` folder next to `BookReader.exe`.

---

## Quick Start for Windows Users (BookReader.exe)

- **Requirements**: Windows 10 or Windows 11 (64-bit). Microsoft Edge WebView2 is preinstalled on Windows 10/11 (if missing on an older Windows 10 install, get the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)). No NVIDIA GPU or CUDA installation is required to launch or read — built-in voices run smoothly on CPU, and optional Qwen3-TTS voice cloning automatically uses NVIDIA CUDA if installed and falls back to CPU otherwise.

1. **Download & Place in Its Own Folder**
   - Download `BookReader.exe` from the [GitHub Releases page](https://github.com/revisionhiep-create/BookReader/releases/latest) (or directly from the repository root).
   - Put `BookReader.exe` inside its own dedicated folder (for example, `C:\BookReader\BookReader.exe`) rather than loosely on your Desktop or in `Downloads`, because BookReader creates a portable `BookReader_Data\` folder right beside the `.exe` for models, voices, and imported books.

2. **First Launch (Windows SmartScreen)**
   - Double-click `BookReader.exe`. Because this is an unsigned standalone build, Windows Defender SmartScreen may display **"Windows protected your PC"**. Click **More info** → **Run anyway**.

3. **First-Time Voice Engine Setup**
   - On first launch, a **First-Time Voice Engine Setup** popup appears. Click **Download Phonon 31M (~65 MB)** and wait for the 4 model files to finish downloading into `BookReader_Data\models\`.

4. **Open a Book & Listen**
   - Click **Import Book** (or open **Library** in the left sidebar) and select a **PDF**, **EPUB**, **DOCX**, or **TXT** file.
   - Click any sentence to jump directly to it, or press `Space` (or click the **Play** button in the top toolbar) to start/pause narration.
   - **Note on Startup Warmup**: When reopening BookReader to a large PDF or starting playback for the first time in a session, a top status banner displays model warmup and page indexing progress (typically ~10–15 seconds) before jumping straight to your auto-saved reading position.

5. **Switch Voices or Clone a Custom Voice**
   - Click the voice button in the top toolbar to choose from 37 built-in English male and female voices.
   - Open **Voice Cloning** in the left sidebar to clone a custom voice from a **3–30 second** audio clip (5–15 seconds recommended) with an optional reference transcript for higher accuracy. Choose between **0.6B-Base (Fast, ~2.5 GB)** and **1.7B-Base (Best Quality, ~4.5 GB)**.

6. **Reading Controls & Pronunciation Tips**
   - Toggle **Closed Captions (CC)** in the top toolbar and adjust caption text size with `A-` / `21px` / `A+`.
   - Zoom pages with `-` / `100%` / `+` or `Ctrl + Mouse Wheel`, toggle **Dark Page** in Dark Mode to invert bright PDF pages, and use the **Header & Footer Ignore Margins** toolbar button on PDFs to drag blurred ignore lines over running headers and page numbers.
   - In **Pronunciation** / **Ignore Words** (left sidebar), all saved rules are active automatically. Enter a word and a natural English phonetic replacement (e.g., `gacha` → `gotcha` or `gah-chah`), test it with the `▶` preview button, and click **Add** / **Update** (or press `Enter`) to save. Leave **Use Regex** unchecked for plain words.

7. **Updating to a Newer Version**
   - Close BookReader and replace `BookReader.exe` in your folder with the new `BookReader.exe`. Your `BookReader_Data\` folder and `%APPDATA%\Bookreader\` settings, rules, and bookmarks remain intact.

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
- [Visual Studio 2022 C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Desktop development with C++)
- [Node.js](https://nodejs.org/) (LTS) and npm
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 10/11)
- Optional: NVIDIA CUDA Toolkit if building the default `qwen-cuda` feature from source (CUDA DLLs are delay-loaded so the compiled `BookReader.exe` still launches and runs cleanly on CPU-only PCs)

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
- **Voice Cloning Engine**: [Qwen3-TTS](https://huggingface.co/Qwen) (`0.6B-Base` / `1.7B-Base`) via [`qwen_tts`](https://crates.io/crates/qwen_tts) & [`candle-core`](https://crates.io/crates/candle-core)
- **Desktop Framework**: [Tauri v2](https://v2.tauri.app/) (Rust + Edge WebView2)
- **PDF Rendering**: [PDF.js (`pdfjs-dist`)](https://mozilla.github.io/pdf.js/)
- **Audio & Media**: `cpal`, `hound`, `mp3lame-encoder`, `souvlaki`
