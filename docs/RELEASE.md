# Releasing the Baalda desktop app

The desktop app ships via a git tag. Bump the version in
`app/apps/desktop/src-tauri/tauri.conf.json` **and** `app/apps/desktop/package.json`,
then push a matching `v*` tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` builds bundles for macOS (arm64 + x64), Windows,
and Linux, and drafts a GitHub Release with the installers plus `latest.json`
(the updater manifest). The release is a **draft** — review it, then click
**Publish**. Only then does `releases/latest` point at it and do running apps
see the update (the Tauri updater polls `releases/latest`).

## Two kinds of signing

- **Updater signing (minisign)** — already configured. `TAURI_SIGNING_PRIVATE_KEY`
  proves an update genuinely came from us; the matching `pubkey` lives in
  `tauri.conf.json`. This is what makes auto-update safe. It is **not** what makes
  a fresh download install cleanly.
- **OS code signing + notarization** — what a first-time download needs so the OS
  doesn't block it. Set up per platform below.

## macOS code signing

Without this, a downloaded `.dmg`/`.app` trips Gatekeeper
(*"Baalda is damaged and can't be opened"* / *"unidentified developer"*) and users
must right-click → Open or run `xattr -cr`. A stable Developer ID signature also
stops the repeated macOS Keychain password prompt during normal use.

**One-time setup:**

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) ($99/yr).
2. Create a **Developer ID Application** certificate in the Apple Developer portal,
   download it, and export it from Keychain Access as a `.p12` (with a password).
3. Base64-encode the `.p12`: `base64 -i cert.p12 | pbcopy`.
4. Create an **app-specific password** at [appleid.apple.com](https://appleid.apple.com)
   (Sign-In and Security → App-Specific Passwords) — this is `APPLE_PASSWORD`, not
   your account password.
5. Add these as repo **Actions secrets** (Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `APPLE_CERTIFICATE` | base64 of the exported `.p12` |
   | `APPLE_CERTIFICATE_PASSWORD` | password for the `.p12` |
   | `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
   | `APPLE_ID` | your Apple account email |
   | `APPLE_PASSWORD` | the app-specific password from step 4 |
   | `APPLE_TEAM_ID` | your 10-character team id |

Once present, `tauri-action` imports the cert into a temporary keychain, signs
with the hardened runtime using `entitlements.plist`, and notarizes automatically.
No workflow changes are needed — the env vars are already wired in `release.yml`
and stay inert on Windows/Linux and until the secrets exist.

The entitlements (`app/apps/desktop/src-tauri/entitlements.plist`) grant the two
JIT/executable-memory keys the WKWebView needs under the hardened runtime. The app
is intentionally **not** sandboxed — it reads and writes the user's vault anywhere
on disk.

## Windows code signing (optional)

Unsigned Windows installers still run but show a SmartScreen
*"Windows protected your PC"* warning. To remove it, obtain an OV/EV code-signing
certificate and add Tauri's Windows signing config; this is optional and can be
deferred.

## Linux

No OS-level signing gate. Bundles install as-is.
