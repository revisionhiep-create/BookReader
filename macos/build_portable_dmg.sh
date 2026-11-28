#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-aarch64-apple-darwin}"
if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
  DEFAULT_DMG_NAME="BookReader-macos-arm64-portable.dmg"
else
  DEFAULT_DMG_NAME="BookReader-macos-x64-portable.dmg"
fi
DMG_NAME="${2:-$DEFAULT_DMG_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ -n "${MACOS_FEATURES:-}" ]]; then
  FEATURES="$MACOS_FEATURES"
elif [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
  FEATURES="qwen-metal,qwen-accelerate,ptts-accelerate"
else
  FEATURES="qwen-accelerate,ptts-accelerate"
fi

echo "==> Building BookReader.app for target=$TARGET features=$FEATURES"
rustup target add "$TARGET" >/dev/null 2>&1 || true

npx tauri build \
  --bundles app \
  --target "$TARGET" \
  --config macos/tauri.macos.conf.json \
  --features "$FEATURES"

APP_BUNDLE="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle/macos/BookReader.app"
if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "ERROR: Expected .app bundle not found at $APP_BUNDLE" >&2
  exit 1
fi

echo "==> Ad-hoc signing $APP_BUNDLE"
codesign --force --deep --sign - "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"

STAGE_DIR="$SCRIPT_DIR/staging/$TARGET"
DIST_DIR="$SCRIPT_DIR/dist"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$DIST_DIR"

ditto "$APP_BUNDLE" "$STAGE_DIR/BookReader.app"

cat > "$STAGE_DIR/HOW_TO_USE_PORTABLE.txt" <<'EOF'
BookReader Portable for macOS
=============================

How to install & run portably:
1. Create a folder anywhere you like (for example, ~/BookReader/ or on an external SSD).
2. Drag BookReader.app from this disk image into that folder.
   - BookReader automatically creates a portable "BookReader_Data/" folder right next to BookReader.app
     for downloaded voice models, custom cloned voices, and imported books.
   - Note: If you drag BookReader.app into /Applications, macOS protects /Applications from app writes,
     so BookReader_Data/ will automatically live in ~/Library/Application Support/Bookreader/BookReader_Data/.

First Launch (Unsigned Build / Gatekeeper):
- Right-click (or Control-click) BookReader.app -> click Open -> click Open in the confirmation dialog.
- If macOS still says the app is damaged or from an unidentified developer, open Terminal and run:
    xattr -cr /path/to/BookReader.app
  then open BookReader.app normally.
EOF

DMG_PATH="$DIST_DIR/$DMG_NAME"
rm -f "$DMG_PATH"

echo "==> Packaging portable DMG at $DMG_PATH"
hdiutil create \
  -volname "BookReader Portable" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

ls -lh "$DMG_PATH"
