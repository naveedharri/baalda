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

## Signing and notarization are part of the release

Two different things happen to the app, and only one of them is under our
control:

- **Code signing** answers "who built this and has it been altered?" Every build
  is signed with our Developer ID certificate and hardened runtime. Instant,
  never fails.
- **Notarization** answers "has Apple scanned this binary for malware?" Tauri
  uploads the app, Apple scans it and returns a ticket, and Tauri staples that
  ticket into the bundle. The upload is instant; **how long Apple takes to scan is
  entirely Apple's call** — for this account it has ranged from two minutes to
  over a day.

Both happen inside `release.yml`, in one pass, before anything is published.
`NOTARIZE_ON_TAG: 'yes'` is the default and should stay that way. Order matters
and Tauri gets it right: the `.app` is signed → notarized → **stapled**, and only
then is the `.dmg` built around it. So the ticket travels inside the app itself
and survives being dragged to `/Applications`, and Gatekeeper can verify it with
no network.

This is how essentially every macOS app ships — Zed and Lapce both notarize and
staple inline in their release job, as do ~94 public repos invoking
`notarytool submit --wait` directly from a workflow.

**The trade we are accepting:** a release is only as fast as Apple's notary queue,
and if that queue stalls, the job fails and *nothing* publishes. That is the right
failure mode. A green release carrying a bundle Gatekeeper will refuse is worse
than no release — it looks shipped and is broken. tauri-action does not create the
GitHub Release until the build succeeds, so a failed run leaves nothing behind to
clean up (the wedged v0.1.9 run left no `v0.1.9` release at all).

**Auto-update never depends on any of this.** `latest.json` points only at the
`.app.tar.gz` bundles, which the updater validates with our minisign key, not
Apple's ticket. Notarization only affects a *fresh download* of the `.dmg`.

### The escape hatch

When Apple's queue is wedged and a fix has to ship anyway, run the workflow by
hand with notarization off:

Actions → **release** → *Run workflow* → `notarize: false`

That produces a signed, hardened-runtime build that publishes normally. The cost
is that fresh downloads hit Gatekeeper's "cannot be verified" prompt until a later
notarized version replaces them. Existing users are unaffected — they auto-update.

Do this from the Actions UI rather than by editing `NOTARIZE_ON_TAG`, so the
switch can never be left off by accident.

### Confirming a release is clean

```bash
gh release download v0.1.11 --pattern '*_aarch64.dmg'
hdiutil attach Baalda_0.1.11_aarch64.dmg
xcrun stapler validate /Volumes/Baalda/Baalda.app
spctl -a -vv /Volumes/Baalda/Baalda.app
```

`spctl` says `accepted` + `source=Notarized Developer ID` when the ticket is in
place. Before that it says `rejected` + `source=Unnotarized Developer ID`, which
means signed-but-not-scanned — not insecure, but Gatekeeper will block a fresh
download.

## When notarization hangs

**Symptom.** Submissions upload fine and get ids, then sit at `In Progress`
indefinitely — sometimes for a day or more — while Apple's status page reads green
and a sibling submission from the same minute comes back `Accepted`.

**This is Apple, it is expected for a young account, and it is not worth
re-diagnosing.** Apple DTS ([thread 782674](https://developer.apple.com/forums/thread/782674),
[thread 822109](https://developer.apple.com/forums/thread/822109)):

> Occasionally, some uploads are held for in-depth analysis and may take longer to
> complete. As you notarize your apps, the system will learn how to recognize them,
> and you should see fewer delays.

Reported waits on new accounts run to ~4 days before the backlog clears and normal
minutes-long turnaround begins. Apple's own escalation threshold is **one week** —
below that, Developer Support will tell you to wait.

Every layer on our side was tested and cleared when this first hit (v0.1.9/v0.1.10):

| Suspect | Verdict |
| --- | --- |
| Certificate / signing | Fine — signs in 1s, valid chain to Apple Root CA |
| Credentials | Fine — `notarytool history` authenticates instantly |
| Runner network | Fine — reaches `appstoreconnect.apple.com` in <200 ms |
| Runner image | Not it — macOS 26, 15 and 14 all behave identically |
| Concurrent submissions | Not it — a lone serialized submission wedged too |
| Upload | Fine — submissions are accepted and get IDs |
| Bundle contents | Not it — a 173-byte junk zip stuck exactly as long as the app |
| License agreement / membership | Checked in the portal, nothing pending |

**Things that look like fixes but are not:**

- *Switching to an App Store Connect API key.* Our Apple ID credentials
  authenticate and upload correctly; the delay is downstream of auth. (If you ever
  do switch: a **Team** key with the Developer role is required — Personal keys are
  not eligible for the Notary API — and you must drop `--apple-id`/`--team-id`.)
- *Re-running the release.* Every attempt adds another submission to the queue
  that is already the bottleneck. Run the probe first; only re-tag once it shows
  submissions being `Accepted` again.
- *A different runner image, or notarizing locally.* Same queue.

**What to actually do while it is stalled:** ship with `notarize: false` if the
release cannot wait (see the escape hatch above), and otherwise leave it alone.
Apple's own escalation threshold is a week; before that, Developer Support will
tell you to wait. Each successful notarization teaches their system to recognize
our builds, so this fades on its own.

**Checking the queue** — `notary-probe.yml` (workflow_dispatch) prints the
account's submission history in ~10 seconds:

```bash
gh workflow run notary-probe.yml --ref main
```

Submissions reaching `Accepted` within minutes means Apple has warmed to the
account and delays should stop.

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
