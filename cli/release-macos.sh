#!/bin/bash
# Build, sign, notarize, and package Tachikoma.app for macOS distribution
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCH="${VSCODE_ARCH:-arm64}"
KEYCHAIN_PROFILE="notarytool-profile"
RELEASE_VERSION="$(node -p "require('$REPO_ROOT/product.json').releaseVersion")"

BUILD_DIR="$(dirname "$REPO_ROOT")"
APP_PATH="$BUILD_DIR/VSCode-darwin-${ARCH}/Tachikoma.app"
OUT_DIR="$BUILD_DIR/VSCode-darwin-${ARCH}"
DMG_PATH="$OUT_DIR/Tachikoma-v${RELEASE_VERSION}.dmg"

# Step 1: Build the app bundle
echo "=== Building Tachikoma v${RELEASE_VERSION} (darwin-${ARCH}) ==="
cd "$REPO_ROOT"
npx gulp "vscode-darwin-${ARCH}-min"

mkdir -p "$OUT_DIR"

# Step 2: Sign app via build/darwin/sign.ts
echo "=== Signing $APP_PATH ==="
export VSCODE_ARCH="$ARCH"
export CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: Feng QIAN (U5627CA9PY)}"
npx tsx "$REPO_ROOT/build/darwin/sign.ts" "$BUILD_DIR"

# Step 3: Verify signature
echo "=== Verifying signature ==="
codesign --verify --deep --strict "$APP_PATH"
echo "Signature OK"

# Step 4: Notarize the app (via zip)
echo "=== Creating zip for notarization ==="
ZIP_PATH="$(mktemp -d)/Tachikoma.zip"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "=== Submitting for notarization ==="
xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$KEYCHAIN_PROFILE" --wait

echo "=== Stapling app ==="
xcrun stapler staple "$APP_PATH"
rm -f "$ZIP_PATH"

# Step 5: Create DMG using VS Code's create-dmg.ts
echo "=== Creating DMG ==="
rm -f "$DMG_PATH"
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

# Step 6: Notarize and staple the DMG
echo "=== Notarizing DMG ==="
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG_PATH"

echo "=== Done! ==="
spctl --assess --type exec "$APP_PATH" && echo "Gatekeeper: APPROVED"
echo "DMG ready for distribution: $DMG_PATH"
