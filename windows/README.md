# BookReader for Windows (`BookReader.exe`)

This folder holds Windows-specific configuration, build scripts, and the standalone portable `BookReader.exe` release binary.

## Quick Start for Windows Users

- **Requirements**: Windows 10 or Windows 11 (64-bit). Microsoft Edge WebView2 is preinstalled on Windows 10/11 (if missing on an older Windows 10 install, get the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)). No NVIDIA GPU or CUDA installation is required — built-in voices run on CPU, and optional Qwen3-TTS voice cloning automatically uses NVIDIA CUDA if installed and falls back to CPU otherwise.

1. **Download & Place in Its Own Folder**
   - Download **[BookReader.exe](https://github.com/revisionhiep-create/BookReader/releases/latest/download/BookReader.exe)** from [GitHub Releases](https://github.com/revisionhiep-create/BookReader/releases/latest).
   - Place `BookReader.exe` in its own folder (e.g., `C:\BookReader\BookReader.exe`) rather than loosely on Desktop or Downloads, because it creates `BookReader_Data\` right beside the `.exe`.

2. **First Launch (Windows SmartScreen)**
   - Double-click `BookReader.exe`. Because this is an unsigned standalone build, Windows Defender SmartScreen may show **"Windows protected your PC"**. Click **More info** → **Run anyway**.

3. **Updating**
   - Close BookReader and replace `BookReader.exe` with the newer `BookReader.exe`. Your `BookReader_Data\` folder and `%APPDATA%\Bookreader\` preferences remain intact.

## Building from Source on Windows

From the repository root:

```powershell
npm install
powershell -ExecutionPolicy Bypass -File windows/build.ps1
```

The compiled executable is emitted to `src-tauri\target\release\BookReader.exe` and copied to `windows\BookReader.exe`.
