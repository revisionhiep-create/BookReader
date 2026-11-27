# BookReader for macOS (Portable `.dmg`)

This folder holds macOS-specific Tauri configuration, portable `.dmg` packaging scripts, real macOS feature verification scripts, and macOS user instructions.

## Portable Downloads

From [GitHub Releases](https://github.com/revisionhiep-create/BookReader/releases/latest):

- **Apple Silicon (M1 / M2 / M3 / M4 / M5)**: `BookReader-macos-arm64-portable.dmg` (uses Apple Metal GPU + Accelerate)
- **Intel Macs (x64)**: `BookReader-macos-x64-portable.dmg` (uses Apple Accelerate CPU)

## Quick Start for macOS Users

- **Requirements**: macOS 12 Monterey or newer. Built-in **Phonon 31M** (37 English voices) and **Qwen3-TTS** voice cloning run completely offline after downloading weights on first use.

1. **Extract into Your Own Portable Folder**
   - Open the `.dmg` file and drag `BookReader.app` into a dedicated writable folder (for example, `~/BookReader/` or an external drive).
   - BookReader creates `BookReader_Data/` right next to `BookReader.app` to store models, voices, and imported books portably.
   - *(Note: If you place `BookReader.app` in `/Applications` or launch it directly from the read-only `.dmg`, BookReader automatically stores `BookReader_Data/` inside `~/Library/Application Support/Bookreader/BookReader_Data/` instead.)*

2. **First Launch (Unsigned Gatekeeper Notice)**
   - Because this build is not Apple-notarized, macOS Gatekeeper may warn on first launch:
     - **Right-click** (or Control-click) `BookReader.app` → choose **Open** → click **Open**.
     - Or in **Terminal**, run:
       ```bash
       xattr -cr /path/to/BookReader.app
       ```
       and then double-click `BookReader.app`.

3. **Settings & Shortcuts**
   - User preferences, bookmarks, and pronunciation/ignore rules live in `~/Library/Application Support/Bookreader/`.
   - Use `⌘ + F` to search and `⌘ + +` / `⌘ + -` / `⌘ + 0` (or `⌘ + Wheel`) to zoom.

## Building & Feature-Testing on a Mac

```bash
npm install
chmod +x macos/*.sh
./macos/build_portable_dmg.sh aarch64-apple-darwin BookReader-macos-arm64-portable.dmg
./macos/test_macos_features.sh aarch64-apple-darwin BookReader-macos-arm64-portable.dmg
```
