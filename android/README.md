# BookReader for Android

Adaptive Android port of **BookReader** powered by **Tauri v2**, **Phonon 31M** (37 local English voices), PDF.js, and background `MediaSession` narration.

*(Voice cloning via Qwen3-TTS is intentionally excluded on Android to keep the APK compact, responsive, and memory-efficient.)*

---

## Installing on Your Android Phone

**Latest Phone Download:** **[BookReader-android-arm64.apk](https://github.com/revisionhiep-create/BookReader/releases/latest/download/BookReader-android-arm64.apk)** *(Android 8.0+ / ARM64 phones & tablets)*

1. Download **`BookReader-android-arm64.apk`** on your phone from [GitHub Releases](https://github.com/revisionhiep-create/BookReader/releases/latest).
2. Tap the downloaded APK in Chrome / your browser downloads or **Files** app.
3. If Android asks, turn on **"Allow from this source"** (**Install unknown apps**) for that browser/file manager, then tap **Install**.
   - **No Developer Mode or PC needed:** Package ID `com.bookreader.android` and its release signing key are officially registered in Android Developer Console.
4. Open **BookReader** and tap **Allow** on the notification prompt so lock-screen and notification media controls work during background reading.
5. On first launch, tap **Download Phonon 31M (~65 MB)**, then tap **Import Book** to open a PDF, EPUB, DOCX, or TXT file.

---

## 1. Adaptive Screen Sizes

BookReader Android adapts automatically across all Android display sizes (`dp`) and orientations:

- **Compact (`< 600px` — Portrait Phones `360–430dp`)**:
  - Slim Top Bar (`Menu`, `Book Title`, `Search`, `Quick Aa`)
  - Collapsible Bottom Thumb-Zone Player Dock (shrinks to a floating mini pill)
  - Closed Captions (CC) docked directly above the Player Dock (drops cleanly to the bottom edge when collapsed)
  - Slide-Over Navigation Drawer + Hybrid Bottom Sheets (`Quick Reader Aa`, `Voices`, `Speed`, `Sleep Timer`) + Full-Screen Pages (`Settings`, `Library`, `Chapters & Bookmarks`, `Rules`, `Export`)
- **Medium (`600–839px` — Foldables, Small Tablets & Phone Landscape)**:
  - Centered prose column (`max-width: 640px`), 2-column Voice Picker, and short-height compaction in landscape (`<= 480px` tall)
- **Expanded (`>= 840px` — Large Tablets)**:
  - Touch-friendly pinned collapsible sidebar, 3-column Voice Picker, and centered dialogs

---

## 2. Fast Local UI Verification (`npm run preview:android`)

You can inspect and interact with the real BookReader Android UI side-by-side across phone, foldable, tablet, and landscape viewports directly in your desktop browser without needing an emulator:

```bash
npm run preview:android
```

---

## 3. Running on an Android Emulator (Windows `x86_64` + Android Device Hub)

If you don't have Java or the Android NDK installed locally, GitHub Actions (`.github/workflows/android-build-and-release.yml`) automatically builds **both**:
- `BookReader-android-arm64.apk` (real Android phones & tablets)
- `BookReader-android-x86_64.apk` (Windows `x86_64` Android Emulator)

To install and run the CI `x86_64` APK in the **Android Device Hub**:

1. Ensure the **Android CLI** (`android`) is installed (`android init`).
2. Download `BookReader-android-x86_64.apk` from the GitHub Actions `android-apk-x86_64` artifact.
3. Run:
   ```powershell
   .\android\run_in_emulator.ps1 -ApkPath C:\path\to\BookReader-android-x86_64.apk
   ```
4. Open the **Android Device Hub** pane and click **Mirror** to interact with BookReader live.

---

## 4. Building APKs Locally (Optional)

Requires **JDK 17**, **Android SDK + NDK 27**, and Rust Android targets (`aarch64-linux-android`, `x86_64-linux-android`):

```bash
./android/build_android_apk.sh split      # Outputs arm64 + x86_64 APKs into android/dist/
./android/build_android_apk.sh universal  # Outputs a single dual-ABI APK
```
