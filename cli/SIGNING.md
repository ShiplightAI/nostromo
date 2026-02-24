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

## Sign, Notarize, and Package

The script handles everything: signing all binaries (inside-out), notarization, and DMG creation.

```bash
./cli/sign-macos.sh /Applications/Tachikoma.app
```

What it does:
1. Signs all native modules (`.node`, `.so`, `.dylib`)
2. Signs standalone executables (`rg`, `spawn-helper`, `ShipIt`)
3. Signs Electron helper apps (Renderer, GPU, Plugin)
4. Signs frameworks
5. Signs the main app bundle
6. Notarizes the app with Apple
7. Creates a `.dmg` and notarizes it

Output: `Tachikoma.dmg` in the same directory as the app.

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
