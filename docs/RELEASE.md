# Releasing the Baalda desktop app

The desktop app ships via a git tag. Bump the version in all four places — they
must agree or the build fails the tag/version check:

- `app/apps/desktop/src-tauri/tauri.conf.json`
- `app/apps/desktop/package.json`
- `app/apps/desktop/src-tauri/Cargo.toml`
- `app/apps/desktop/src-tauri/Cargo.lock` (the `desktop` package entry)

Then push a matching `v*` tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` builds bundles for **macOS only** (arm64 + x64)
and publishes a GitHub Release with the installers plus `latest.json` (the updater
manifest). Windows and Linux are commented out of the build matrix — macOS is the
only platform with OS signing wired up, so it's the only one we ship. Re-enable
them by uncommenting the two matrix entries.

> ⚠️ **The release goes live automatically.** `releaseDraft` is `false`, so the
> moment the build finishes `releases/latest` points at the new version and every
> running app updates on its next updater poll. There is no review gate — pushing
> a `v*` tag ships to all users. Flip `releaseDraft` back to `true` in
> `release.yml` if you want to inspect bundles before they go out.

## The notarization switch

`release.yml` has one line that decides whether a tag push notarizes:

```yaml
env:
  NOTARIZE_ON_TAG: 'no'   # 'yes' = sign + notarize, 'no' = sign only
```

**It is currently `'no'`.** Apple stopped processing this account's notarization
submissions on 2026-08-03 (see below), and notarization is the only step that can
wedge a release. With it off, a tag push still produces Developer ID signed,
hardened-runtime bundles and publishes normally; the only cost is that a **fresh
download** shows Gatekeeper's "cannot be verified" prompt until the user does
right-click → Open. **Auto-update is completely unaffected** — the updater checks
the minisign signature, not Apple's ticket.

To notarize a single run without touching the file, use the manual trigger:
Actions → release → *Run workflow* → `notarize: true`.

**Turning it back on** — once Apple recovers:

```bash
gh workflow run notary-probe.yml --ref main   # then read the run's log
```

If the queue shows recent submissions reaching `Accepted` rather than piling up
as `In Progress`, set `NOTARIZE_ON_TAG: 'yes'` and cut the next release normally.

## When notarization hangs

**Symptom.** The build compiles and signs in ~7 minutes, logs `Notarizing …`, and
then nothing. The job used to run to GitHub's 6-hour default; it is now bounded at
`timeout-minutes: 35`, so it fails in a bearable time instead.

**This is not a repo problem, and it is worth not re-diagnosing from scratch.**
When it happened for v0.1.9 and v0.1.10, every layer was tested and cleared:

| Suspect | Verdict |
| --- | --- |
| Certificate / signing | Fine — signs in 1s, valid chain to Apple Root CA |
| Credentials | Fine — `notarytool history` authenticates instantly |
| Runner network | Fine — reaches `appstoreconnect.apple.com` in <200 ms |
| Runner image | Not it — macOS 26, 15 and 14 all behave identically |
| Concurrent submissions | Not it — a lone serialized submission wedged too |
| Upload | Fine — submissions are accepted and get IDs |

What actually failed is Apple **processing** what it accepted. A 173-byte junk zip
sat `In Progress` exactly as long as a real app did, so it has nothing to do with
the bundle. At the time, 7 of 8 submissions were stuck, two of them for 20 hours,
while Apple's status page reported the service green.

**Diagnosing it in ~2 minutes** — `notary-probe.yml` (workflow_dispatch) prints
the account's submission queue. Submissions accumulating as `In Progress` and
never reaching `Accepted` is the signature. Do not spend 35-minute release cycles
guessing; run the probe.

**Worth checking once** at [developer.apple.com/account](https://developer.apple.com/account),
since both silently stall processing rather than returning an error:

- an unaccepted **Apple Developer Program License Agreement**
- a lapsed or not-yet-active **membership**

## Cutting a release from your Mac

When CI cannot ship — Apple is down, GitHub is down, or you need a build now —
the whole release can be produced locally. The artifacts are identical to CI's.

**Prerequisites** (verify before building, each failure mode is silent):

```bash
# 1. The Developer ID identity must be listed.
security find-identity -v -p codesigning

# 2. The local updater key must match the one compiled into the app.
#    (Both sides are newline-stripped — the files differ only in a trailing \n.)
a=$(tr -d '\n' < ~/.tauri/opencontext.key.pub)
b=$(python3 -c "import json;print(json.load(open('app/apps/desktop/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey'])" | tr -d '\n')
[ "$a" = "$b" ] && echo "updater key OK" || echo "MISMATCH — do not publish"
```

Check 2 is the one that matters most and the one nothing else will catch: if the
keys differ, every client silently rejects the update and simply never upgrades,
with no error logged anywhere.

**Three local-only obstacles**, none of which exist on CI runners:

1. **Anaconda's `xattr` shadows the system one** and does not support `-r`. Tauri
   runs `xattr -cr <bundle>` before signing, so the build dies with
   `failed to run xattr`. Fix: `export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"`.
2. **`bundle_dmg.sh` drives Finder through `osascript`**, which cannot reach the
   window server from a detached process. A build started with `nohup … &` fails
   at `error running bundle_dmg.sh`. **Run the build in the foreground.**
3. **Every DMG run leaves a `dmg.*` scratch volume mounted**, and the next run
   trips over it. Detach leftovers between targets:
   `for v in /Volumes/dmg.*; do hdiutil detach "$v" -force; done`

**Build** — once per target, in the foreground:

```bash
cd app/apps/desktop
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/opencontext.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID   # omit -> skip notarization

npx tauri build --target aarch64-apple-darwin
for v in /Volumes/dmg.*; do hdiutil detach "$v" -force 2>/dev/null; done
npx tauri build --target x86_64-apple-darwin
```

Each target must end with **`Finished 1 updater signature`**. Without the `.sig`,
auto-update is dead on arrival.

**Verify before publishing** — a wrong architecture or a bad signature fails
silently on users' machines:

```bash
# right arch in the right tarball
tar xzf Baalda_0.1.10_darwin-x86_64.app.tar.gz && lipo -archs Baalda.app/Contents/MacOS/desktop
# valid Developer ID signature
codesign --verify --deep --strict --verbose=2 Baalda.app
```

**Publish.** `latest.json` must list one entry per platform key
(`darwin-aarch64`, `darwin-x86_64`), each pointing at the **`.app.tar.gz`** — not
the `.dmg` — with `signature` set to the full contents of the matching `.sig`
file. Then:

```bash
gh release create v0.1.10 --title "Baalda v0.1.10" --notes-file notes.md \
  Baalda_0.1.10_darwin-aarch64.dmg Baalda_0.1.10_darwin-x86_64.dmg \
  Baalda_0.1.10_darwin-aarch64.app.tar.gz Baalda_0.1.10_darwin-aarch64.app.tar.gz.sig \
  Baalda_0.1.10_darwin-x86_64.app.tar.gz Baalda_0.1.10_darwin-x86_64.app.tar.gz.sig \
  latest.json
```

**Confirm the update path** actually resolves — this is the endpoint the app polls:

```bash
curl -sL https://github.com/naveedharri/baalda/releases/latest/download/latest.json
```

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
The env vars are wired in `release.yml`; on Windows/Linux they are ignored.

> ⚠️ It is all six or none. An **empty** `APPLE_CERTIFICATE` still makes tauri
> attempt a keychain import and fails the macOS build — it does not fall back to
> ad-hoc signing. If you fork this repo and don't have an Apple account, comment
> out the whole `APPLE_*` block in `release.yml` rather than leaving the secrets
> unset. Ad-hoc builds are then what you get (right-click → Open to launch).

`tauri.conf.json` pins `bundle.macOS.signingIdentity` to `"-"` (ad-hoc) so local
`build:desktop` runs work without a certificate. That is **not** a conflict: the
`APPLE_SIGNING_IDENTITY` env var takes precedence over the config value in CI.

The entitlements (`app/apps/desktop/src-tauri/entitlements.plist`) grant the two
JIT/executable-memory keys the WKWebView needs under the hardened runtime. The app
is intentionally **not** sandboxed — it reads and writes the user's vault anywhere
on disk.

## Windows code signing (optional)

> Not currently built — `windows-latest` is commented out of the release matrix.
> This section applies whenever it is re-enabled.

Unsigned Windows installers still run but show a SmartScreen
*"Windows protected your PC"* warning. To remove it, obtain an OV/EV code-signing
certificate and add Tauri's Windows signing config; this is optional and can be
deferred.

## Linux

> Not currently built — `ubuntu-22.04` is commented out of the release matrix.

No OS-level signing gate. Bundles install as-is.
