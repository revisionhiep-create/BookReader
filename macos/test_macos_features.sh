#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-aarch64-apple-darwin}"
DMG_NAME="${2:-BookReader-macos-arm64-portable.dmg}"

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

echo "==> 1. Verifying frontend TypeScript & Vite build"
npm run build

echo "==> 2. Running full Rust unit test suite for $TARGET ($FEATURES)"
cargo test --release --manifest-path src-tauri/Cargo.toml --target "$TARGET" --features "$FEATURES"

APP_BUNDLE="$REPO_ROOT/src-tauri/target/$TARGET/release/bundle/macos/BookReader.app"
DMG_PATH="$SCRIPT_DIR/dist/$DMG_NAME"
BIN_REL="Contents/MacOS/BookReader"

echo "==> 3. Verifying .app bundle structure, architecture, and signature"
test -f "$APP_BUNDLE/Contents/Info.plist"
test -x "$APP_BUNDLE/$BIN_REL"
test -f "$APP_BUNDLE/Contents/Resources/icon.icns"
lipo -info "$APP_BUNDLE/$BIN_REL"
codesign --verify --deep --strict "$APP_BUNDLE"

if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
  lipo -info "$APP_BUNDLE/$BIN_REL" | grep -q "arm64"
else
  lipo -info "$APP_BUNDLE/$BIN_REL" | grep -q "x86_64"
fi

echo "==> 4. Testing portable folder mode + full feature self-test + live Phonon TTS synthesis"
PORTABLE_TEST_DIR="$(mktemp -d /private/tmp/bookreader_portable_test.XXXXXX)"
cleanup() {
  if [[ -n "${MOUNT_POINT:-}" ]] && mount | grep -q "$MOUNT_POINT"; then
    hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$PORTABLE_TEST_DIR"
}
trap cleanup EXIT

ditto "$APP_BUNDLE" "$PORTABLE_TEST_DIR/BookReader.app"
TEST_CONFIG_DIR="$PORTABLE_TEST_DIR/TestConfig/Bookreader"

INIT_OUT="$(BOOKREADER_CONFIG_DIR="$TEST_CONFIG_DIR" "$PORTABLE_TEST_DIR/BookReader.app/$BIN_REL" --check-portable-init)"
echo "$INIT_OUT"
echo "$INIT_OUT" | grep -q "DATA_DIR=$PORTABLE_TEST_DIR/BookReader_Data"
test -d "$PORTABLE_TEST_DIR/BookReader_Data/models"
test -d "$PORTABLE_TEST_DIR/BookReader_Data/voices"
test -d "$PORTABLE_TEST_DIR/BookReader_Data/books"

"$PORTABLE_TEST_DIR/BookReader.app/$BIN_REL" --self-test --self-test-live-tts

echo "==> 5. Mounting $DMG_PATH and testing read-only DMG fallback behavior"
test -f "$DMG_PATH"
MOUNT_POINT="$(mktemp -d /private/tmp/bookreader_dmg_mount.XXXXXX)"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly

test -d "$MOUNT_POINT/BookReader.app"
test -f "$MOUNT_POINT/HOW_TO_USE_PORTABLE.txt"

RO_INIT_OUT="$(BOOKREADER_CONFIG_DIR="$TEST_CONFIG_DIR" "$MOUNT_POINT/BookReader.app/$BIN_REL" --check-portable-init)"
echo "$RO_INIT_OUT"
echo "$RO_INIT_OUT" | grep -q "DATA_DIR=$TEST_CONFIG_DIR/BookReader_Data"
"$MOUNT_POINT/BookReader.app/$BIN_REL" --self-test

hdiutil detach "$MOUNT_POINT"
rmdir "$MOUNT_POINT" || true
MOUNT_POINT=""

echo "==> ALL MACOS PORTABLE & FEATURE TESTS PASSED for $TARGET!"
