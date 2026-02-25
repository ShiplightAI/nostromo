# macOS Code Signing & Notarization

## Prerequisites

- Apple Developer ID Application certificate installed
- App-specific password generated at https://account.apple.com (Sign-In and Security → App-Specific Passwords)

## Credentials

- **Apple ID**: feng.qian@gmail.com
- **Team ID**: U5627CA9PY

## One-time Setup: Store Credentials in Keychain

```bash
xcrun notarytool store-credentials "notarytool-profile" \
  --apple-id "feng.qian@gmail.com" \
  --team-id "U5627CA9PY" \
  --password "<app-specific-password>"
```

## Check Signing Identity

```bash
security find-identity -v -p codesigning
```

Look for: `Developer ID Application: Feng Qian (U5627CA9PY)`

## Build, Sign, Notarize, and Package

```bash
./cli/release-macos.sh
```

What it does:
1. Builds the app bundle via `gulp vscode-darwin-arm64-min`
2. Signs all binaries, helpers, frameworks, and the main app bundle
3. Notarizes the app with Apple
4. Creates a `.dmg` using VS Code's `create-dmg.ts` (with `dmg-background-stable.tiff`)
5. Notarizes the DMG

Output: `../VSCode-darwin-arm64/Tachikoma-v{version}.dmg`

### Entitlements

The `entitlements.plist` grants permissions required by Electron/V8:
- `allow-jit` — V8 JIT compilation
- `allow-unsigned-executable-memory` — V8 writable+executable memory
- `disable-library-validation` — loading third-party `.node` native modules

## Troubleshooting

- If `codesign` fails, ensure the Developer ID Application certificate is in your Keychain.
- If notarization is rejected, check the log:
  ```bash
  xcrun notarytool log <submission-id> --keychain-profile "notarytool-profile"
  ```
- If the app crashes after signing, check that helper apps in `Contents/Frameworks/*.app` are signed with entitlements (the script handles this).
- The Keychain "confidential information" prompt on first launch after re-signing is expected — macOS ties stored credentials to the code signature.
