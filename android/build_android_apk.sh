#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-split}" # split | universal | aarch64 | x86_64

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Building frontend bundle"
npm run build

GEN_ANDROID="$REPO_ROOT/src-tauri/gen/android"
if [[ ! -d "$GEN_ANDROID" ]]; then
  echo "==> Initializing Tauri Android project"
  npx tauri android init --ci --skip-targets-install --config android/tauri.android.conf.json
fi
npx tauri icon src-tauri/icons/icon.png --fit contain || true
grep -n "minSdk" "$GEN_ANDROID/app/build.gradle.kts" || true

echo "==> Installing BookReaderPlaybackService.kt and patching AndroidManifest.xml"
KOTLIN_DEST="$GEN_ANDROID/app/src/main/java/com/bookreader/android"
mkdir -p "$KOTLIN_DEST"
cp "$SCRIPT_DIR/kotlin/BookReaderPlaybackService.kt" "$KOTLIN_DEST/BookReaderPlaybackService.kt"
cp "$SCRIPT_DIR/kotlin/MainActivity.kt" "$KOTLIN_DEST/MainActivity.kt"

MANIFEST="$GEN_ANDROID/app/src/main/AndroidManifest.xml"
python3 - "$MANIFEST" <<'PY'
import sys
import xml.etree.ElementTree as ET

manifest_path = sys.argv[1]
ANDROID_NS = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", ANDROID_NS)

tree = ET.parse(manifest_path)
root = tree.getroot()

perms = [
    "android.permission.INTERNET",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.WAKE_LOCK",
]
existing_perms = {
    el.get(f"{{{ANDROID_NS}}}name")
    for el in root.findall("uses-permission")
}
for perm in perms:
    if perm not in existing_perms:
        el = ET.Element("uses-permission")
        el.set(f"{{{ANDROID_NS}}}name", perm)
        root.insert(0, el)

app_el = root.find("application")
if app_el is not None:
    svc_name = "com.bookreader.android.BookReaderPlaybackService"
    existing_svcs = {
        el.get(f"{{{ANDROID_NS}}}name")
        for el in app_el.findall("service")
    }
    if svc_name not in existing_svcs:
        svc = ET.SubElement(app_el, "service")
        svc.set(f"{{{ANDROID_NS}}}name", svc_name)
        svc.set(f"{{{ANDROID_NS}}}exported", "false")
        svc.set(f"{{{ANDROID_NS}}}foregroundServiceType", "mediaPlayback")

tree.write(manifest_path, encoding="utf-8", xml_declaration=True)
PY

case "$MODE" in
  split)
    TARGETS=(aarch64 x86_64)
    EXTRA_FLAGS=(--split-per-abi)
    ;;
  universal)
    TARGETS=(aarch64 x86_64)
    EXTRA_FLAGS=()
    ;;
  aarch64)
    TARGETS=(aarch64)
    EXTRA_FLAGS=()
    ;;
  x86_64)
    TARGETS=(x86_64)
    EXTRA_FLAGS=()
    ;;
  *)
    echo "Unknown mode '$MODE'. Use: split | universal | aarch64 | x86_64" >&2
    exit 1
    ;;
esac

for t in "${TARGETS[@]}"; do
  case "$t" in
    aarch64) rustup target add aarch64-linux-android >/dev/null 2>&1 || true ;;
    x86_64) rustup target add x86_64-linux-android >/dev/null 2>&1 || true ;;
  esac
done

echo "==> Building Android APK (mode=$MODE targets=${TARGETS[*]})"
npx tauri android build \
  --apk \
  "${EXTRA_FLAGS[@]}" \
  --target "${TARGETS[@]}" \
  --config android/tauri.android.conf.json

APK_DIR="$GEN_ANDROID/app/build/outputs/apk"
DIST_DIR="$SCRIPT_DIR/dist"
mkdir -p "$DIST_DIR"

sign_if_needed() {
  local src_apk="$1"
  local out_apk="$2"
  if [[ "$src_apk" != *-unsigned.apk ]]; then
    cp -f "$src_apk" "$out_apk"
    return 0
  fi

  local sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  local apksigner=""
  if [[ -n "$sdk_root" && -d "$sdk_root/build-tools" ]]; then
    apksigner="$(find "$sdk_root/build-tools" -name apksigner -type f | sort -V | tail -n 1 || true)"
  fi
  if [[ -z "$apksigner" ]]; then
    echo "WARNING: apksigner not found; copying unsigned APK to $out_apk" >&2
    cp -f "$src_apk" "$out_apk"
    return 0
  fi

  local ks="${ANDROID_KEYSTORE_PATH:-$HOME/.android/debug.keystore}"
  local ks_pass="${ANDROID_KEYSTORE_PASS:-android}"
  local key_alias="${ANDROID_KEY_ALIAS:-androiddebugkey}"
  local key_pass="${ANDROID_KEY_PASS:-android}"

  if [[ ! -f "$ks" ]]; then
    mkdir -p "$(dirname "$ks")"
    keytool -genkey -v -keystore "$ks" -storepass "$ks_pass" -alias "$key_alias" \
      -keypass "$key_pass" -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US"
  fi

  "$apksigner" sign \
    --ks "$ks" \
    --ks-pass "pass:$ks_pass" \
    --ks-key-alias "$key_alias" \
    --key-pass "pass:$key_pass" \
    --out "$out_apk" \
    "$src_apk"
  "$apksigner" verify "$out_apk"
}

find_and_stage() {
  local pattern="$1"
  local dest_name="$2"
  local found=""
  found="$(find "$APK_DIR" -type f -name "$pattern" | head -n 1 || true)"
  if [[ -z "$found" ]]; then
    echo "ERROR: No APK matching $pattern in $APK_DIR" >&2
    exit 1
  fi
  sign_if_needed "$found" "$DIST_DIR/$dest_name"
  echo "Staged $DIST_DIR/$dest_name"
}

echo "==> Built APKs:"
find "$APK_DIR" -type f -name "*.apk" || true

if [[ "$MODE" == "split" ]]; then
  find_and_stage "*arm64*.apk" "BookReader-android-arm64.apk"
  find_and_stage "*x86_64*.apk" "BookReader-android-x86_64.apk"
elif [[ "$MODE" == "universal" ]]; then
  find_and_stage "*universal*.apk" "BookReader-android-universal.apk"
elif [[ "$MODE" == "aarch64" ]]; then
  find_and_stage "*.apk" "BookReader-android-arm64.apk"
elif [[ "$MODE" == "x86_64" ]]; then
  find_and_stage "*.apk" "BookReader-android-x86_64.apk"
fi

ls -lh "$DIST_DIR"
