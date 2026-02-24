#!/bin/bash
# Sign, notarize, and package Tachikoma.app for macOS distribution
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-/Applications/Tachikoma.app}"
IDENTITY="Developer ID Application: Feng Qian (U5627CA9PY)"
KEYCHAIN_PROFILE="notarytool-profile"
ENTITLEMENTS="$SCRIPT_DIR/entitlements.plist"

echo "=== Signing $APP_PATH ==="
echo "Using entitlements: $ENTITLEMENTS"

# Step 1: Sign all native modules (.node and .so files)
echo "Signing native modules..."
find "$APP_PATH" \( -name "*.node" -o -name "*.so" \) -print0 | while IFS= read -r -d '' file; do
  echo "  Signing: $file"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$file"
done

# Step 2: Sign all dylibs
echo "Signing .dylib files..."
find "$APP_PATH" -name "*.dylib" -print0 | while IFS= read -r -d '' file; do
  echo "  Signing: $file"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$file"
done

# Step 3: Sign standalone executables (rg, spawn-helper, ShipIt, etc.)
echo "Signing standalone executables..."
EXECUTABLES=(
  "$APP_PATH/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg"
  "$APP_PATH/Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper"
  "$APP_PATH/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt"
)
for file in "${EXECUTABLES[@]}"; do
  if [ -f "$file" ]; then
    echo "  Signing: $file"
    codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$file"
  fi
done

# Step 4: Sign Electron helper apps (they run V8 and need JIT entitlements too)
echo "Signing helper apps..."
find "$APP_PATH/Contents/Frameworks" -name "*.app" -print0 | while IFS= read -r -d '' helper; do
  echo "  Signing: $helper"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$helper"
done

# Step 5: Sign frameworks
echo "Signing frameworks..."
find "$APP_PATH/Contents/Frameworks" -name "*.framework" -print0 | while IFS= read -r -d '' fw; do
  echo "  Signing: $fw"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$fw"
done

# Step 6: Sign the main app bundle (must be last)
echo "Signing app bundle..."
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP_PATH"

# Step 7: Verify signature
echo "=== Verifying signature ==="
codesign --verify --deep --strict "$APP_PATH"
echo "Signature OK"

# Step 8: Notarize the app (via zip)
echo "=== Creating zip for notarization ==="
ZIP_PATH="$(dirname "$APP_PATH")/Tachikoma.zip"
rm -f "$ZIP_PATH"
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "=== Submitting for notarization ==="
xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$KEYCHAIN_PROFILE" --wait

echo "=== Stapling app ==="
xcrun stapler staple "$APP_PATH"
rm -f "$ZIP_PATH"

# Step 9: Create DMG for distribution
echo "=== Creating DMG ==="
APP_NAME="$(basename "$APP_PATH" .app)"
DMG_PATH="$(dirname "$APP_PATH")/${APP_NAME}.dmg"
rm -f "$DMG_PATH"
hdiutil create -volname "$APP_NAME" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH"

# Step 10: Notarize and staple the DMG
echo "=== Notarizing DMG ==="
xcrun notarytool submit "$DMG_PATH" --keychain-profile "$KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG_PATH"

echo "=== Done! ==="
spctl --assess --type exec "$APP_PATH" && echo "Gatekeeper: APPROVED"
echo "DMG ready for distribution: $DMG_PATH"
