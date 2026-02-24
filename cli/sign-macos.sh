#!/bin/bash
# Sign, notarize, and package Tachikoma.app for macOS distribution
# Uses the build output directly from the gulp package task
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCH="${VSCODE_ARCH:-arm64}"
IDENTITY="Developer ID Application: Feng Qian (U5627CA9PY)"
KEYCHAIN_PROFILE="notarytool-profile"
ENTITLEMENTS="$SCRIPT_DIR/entitlements.plist"

BUILD_DIR="$(dirname "$REPO_ROOT")"
APP_PATH="$BUILD_DIR/VSCode-darwin-${ARCH}/Tachikoma.app"
OUT_DIR="$BUILD_DIR/VSCode-darwin-${ARCH}"
DMG_PATH="$OUT_DIR/Tachikoma.dmg"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: Build output not found at $APP_PATH"
  echo "Run 'gulp vscode-darwin-${ARCH}-min' first to build the app."
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "=== Signing $APP_PATH ==="
echo "Using entitlements: $ENTITLEMENTS"

# Step 1: Sign all Mach-O binaries (native modules, dylibs, executables) in one pass
echo "Signing all Mach-O binaries..."
find "$APP_PATH" -type f -print0 | while IFS= read -r -d '' file; do
  # Check if the file is a Mach-O binary
  if file "$file" | grep -q "Mach-O"; then
    echo "  Signing: $file"
    codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$file"
  fi
done

# Step 2: Sign Electron helper apps (they run V8 and need JIT entitlements too)
echo "Signing helper apps..."
find "$APP_PATH/Contents/Frameworks" -name "*.app" -print0 | while IFS= read -r -d '' helper; do
  echo "  Signing: $helper"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$helper"
done

# Step 3: Sign frameworks
echo "Signing frameworks..."
find "$APP_PATH/Contents/Frameworks" -name "*.framework" -print0 | while IFS= read -r -d '' fw; do
  echo "  Signing: $fw"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$fw"
done

# Step 4: Sign the main app bundle (must be last)
echo "Signing app bundle..."
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP_PATH"

# Step 5: Verify signature
echo "=== Verifying signature ==="
codesign --verify --deep --strict "$APP_PATH"
echo "Signature OK"

# Step 6: Notarize the app (via zip)
echo "=== Creating zip for notarization ==="
ZIP_PATH="$(mktemp -d)/Tachikoma.zip"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "=== Submitting for notarization ==="
xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$KEYCHAIN_PROFILE" --wait

echo "=== Stapling app ==="
xcrun stapler staple "$APP_PATH"
rm -f "$ZIP_PATH"

# Step 7: Create DMG using VS Code's create-dmg.ts
echo "=== Creating DMG ==="
rm -f "$DMG_PATH"
export VSCODE_ARCH="$ARCH"
export VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"
npx tsx "$REPO_ROOT/build/darwin/create-dmg.ts" "$BUILD_DIR" "$OUT_DIR"

# Rename output from VSCode-darwin-{arch}.dmg to Tachikoma.dmg
if [ -f "$OUT_DIR/VSCode-darwin-${ARCH}.dmg" ]; then
  mv "$OUT_DIR/VSCode-darwin-${ARCH}.dmg" "$DMG_PATH"
fi

# Set the DMG file icon
VOLUME_ICON="$APP_PATH/Contents/Resources/Tachikoma.icns"
if [ -f "$VOLUME_ICON" ] && command -v fileicon &>/dev/null; then
  echo "Setting DMG file icon..."
  fileicon set "$DMG_PATH" "$VOLUME_ICON"
fi

# Step 8: Notarize and staple the DMG
echo "=== Notarizing DMG ==="
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG_PATH"

echo "=== Done! ==="
spctl --assess --type exec "$APP_PATH" && echo "Gatekeeper: APPROVED"
echo "DMG ready for distribution: $DMG_PATH"
