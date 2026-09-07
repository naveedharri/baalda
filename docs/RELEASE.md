# Releasing the Baalda desktop app

**The version bump *is* the release.** Bump it in all four places — they must
agree or the build fails the tag/version check — and merge to `main`. There is no
tag to push by hand: the workflow sees the version changed and tauri-action
creates `v<version>` for you.

- `app/apps/desktop/src-tauri/tauri.conf.json` ← the one the `gate` job reads
- `app/apps/desktop/package.json`
- `app/apps/desktop/src-tauri/Cargo.toml`
- `app/apps/desktop/src-tauri/Cargo.lock` (the `desktop` package entry)

```bash
# bump the four files to 0.2.0, then:
git commit -am "Release v0.2.0" && git push origin main   # ← ships
```

Run `pnpm install --frozen-lockfile` from `app/` after bumping. A desynced
lockfile fails *every* platform job at the install step, several minutes in.

### What triggers a release, and what doesn't

| Event | Releases? |
| --- | --- |
| Merge to `main` **with** a changed `tauri.conf.json` version | ✅ builds + publishes |
| Merge to `main` with the version unchanged (docs, refactors, fixes) | ❌ `gate` skips in ~15s |
| Merge to `main` at a version that already has a release | ❌ refuses, won't overwrite |
| Push a `v*` tag | ✅ forced, ignores the diff |
| Actions → release → *Run workflow* | ✅ forced (and can turn notarization off) |

Gating on the version is not caution, it's the only workable rule: the updater
compares versions and the release is named `v__VERSION__`, so shipping main twice
at one version would collide with the existing tag and hand clients an "update"
they rightly ignore. The forced tag path exists to re-run a build that died for
infrastructure reasons without burning a version number.

A `concurrency: release` group means one release at a time, and `cancel-in-progress`
is **false** on purpose — killing a run mid-notarization throws away an Apple
submission already paid for in wall-clock.

`.github/workflows/release.yml` builds bundles for **macOS (arm64 + x64), Linux
(x64) and Windows (x64)** and publishes a GitHub Release with the installers plus
`latest.json` (the updater manifest).

| Platform | Runner | Artifacts | OS signing |
| --- | --- | --- | --- |
| macOS arm64 | `macos-latest` | `.dmg`, `.app.tar.gz` | Developer ID + notarized + stapled |
| macOS x64 | `macos-latest` | `.dmg`, `.app.tar.gz` | Developer ID + notarized + stapled |
| Linux x64 | `ubuntu-22.04` | `.AppImage`, `.deb`, `.rpm` | **none** |
| Windows x64 | `windows-latest` | `.exe` (NSIS), `.msi` | **none** |

**Only macOS is OS-signed.** Windows downloads trip SmartScreen's "unrecognized
app" warning (More info → Run anyway) until an Authenticode/EV certificate is
wired into `WINDOWS_CERTIFICATE`; Linux has no signing story to wire up. That
affects *fresh downloads only* — **auto-update is unaffected on every platform**,
because the updater verifies our minisign signature over the bundle rather than
any OS certificate.

Jobs run one at a time (`max-parallel: 1`) because every job calls tauri-action,
which creates the Release if it is missing — in parallel they race to create the
same tag. Serial costs wall-clock: budget ~35-45 min for a four-platform release.

**Linux is pinned to `ubuntu-22.04`, not `ubuntu-latest`,** because a binary
linked against a newer glibc will not start on older distros; 22.04 is the oldest
image still shipping `libwebkit2gtk-4.1-dev`, which buys Ubuntu 22.04+/Debian 12+
coverage. ⚠️ GitHub begins deprecating that image **2026-09-17** and removes it
**2027-04-17** ([runner-images#14254](https://github.com/actions/runner-images/issues/14254)).
Before then either move to `ubuntu-24.04` and accept the higher glibc floor, or
build Linux in a container — and update the `if:` on the Linux deps step to match.

> ⚠️ **The release goes live automatically.** `releaseDraft` is `false`, so the
> moment the build finishes `releases/latest` points at the new version and every
> running app updates on its next updater poll. There is no review gate — pushing
> a `v*` tag ships to all users. Flip `releaseDraft` back to `true` in
> `release.yml` if you want to inspect bundles before they go out.

## Staging

There is no review gate on a production release, so the review happens *before*
it: on a `staging` branch that produces its own installable, auto-updating app
pointed at a **staging server**.

### The branch model

`staging` is long-lived and equals `main` plus whatever is under test.

1. **PRs target `staging`**, not `main`.
2. Merging one pushes `staging`, which builds **Baalda Staging** and replaces the
   rolling `staging` prerelease. Testers' staging apps auto-update into it.
3. When the batch is proven, **promote**: fast-forward `staging` onto `main` and
   bump the four version files.

```bash
git checkout main && git pull
git merge --ff-only staging     # refuses if main has commits staging lacks
# bump the four version files (see the top of this doc), commit, then:
git push origin main            # ← this is what ships to users
git checkout staging && git merge --ff-only main && git push origin staging
```

`--ff-only` is the point of the model: if it refuses, something landed on `main`
that never went through staging, and that is worth knowing before you ship. Fix it
by merging `main` into `staging` first, letting CI and a tester see the result.

Re-syncing `staging` onto `main` afterwards pushes `staging` again and so builds
one more staging app, of code identical to what just shipped. Harmless, and it
keeps the two branches from drifting.

> ⚠️ **The version bump has to be in the commit that becomes `main`'s new tip.**
> `release.yml`'s `gate` compares `tauri.conf.json`'s version against `HEAD^` —
> the *parent commit*, not the previous `main`. Fast-forward a batch whose bump
> sits three commits back and the gate sees an unchanged version between the last
> two commits, reports "nothing to release", and ships nothing. Bumping on `main`
> after the fast-forward (as above) always satisfies this. Bumping on `staging`
> works too, but only as the batch's final commit — and one more merge after it
> silently costs you the release. Recover with a `v<version>` tag push, which
> forces a build regardless of the diff.

Suggested branch protection: require `ci` on both `main` and `staging`, and allow
only fast-forward merges into `main` (GitHub: linear history + no force pushes).

### The rolling `staging` prerelease

`.github/workflows/staging-release.yml` builds the same four platforms as
production and publishes into **one GitHub prerelease permanently tagged
`staging`**. A `prepare` job deletes that release *and its tag* before the matrix
runs, so the first matrix job recreates both at the new commit and the other three
upload into it. That is why the updater endpoint can be a fixed URL:

```
https://github.com/naveedharri/baalda/releases/download/staging/latest.json
```

The staging app polls that; production polls `releases/latest`. The two can never
cross, and not only because the URLs differ — **`releases/latest` excludes
prereleases**, and the staging release is one. That wall holds even if the config
overlay is ever fumbled.

| | Production | Staging |
| --- | --- | --- |
| Trigger | version bump merged to `main`, or a `v*` tag | any push to `staging` |
| Tag | `v<version>`, one per release | `staging`, rolling (deleted + recreated) |
| Version | `0.1.47` | `0.1.47-staging.<run number>` |
| Product name | Baalda | Baalda Staging |
| Bundle identifier | `com.baalda.context` | `com.baalda.context.staging` |
| Server | built-in default (`api.baalda.com`) | `STAGING_SERVER_URL` variable |
| Updater manifest | `releases/latest/download/latest.json` | `releases/download/staging/latest.json` |
| Windows bundle | `.msi` + `.exe` | `.exe` (NSIS) only |
| `cancel-in-progress` | `false` | `true` |

**The version is a semver prerelease** — `<base>-staging.<run_number>`, where base
is `tauri.conf.json`'s version. It sorts *below* the base version, so nothing on
the production channel would ever treat it as an upgrade, and it is monotonic
within the staging channel because `run_number` only increases (semver compares
numeric prerelease identifiers numerically, so `-staging.9` < `-staging.10`).
⚠️ **`run_number` resets if the workflow file is renamed.** Rename it and the next
staging build looks *older* than the installed one; bump the base version at the
same time if you ever do.

**Windows is NSIS-only on staging.** An MSI cannot carry a non-numeric semver
prerelease — `tauri-bundler`'s WiX path bails with *"optional pre-release
identifier in app version must be numeric-only"* — while the NSIS path ignores the
prerelease and synthesises the numeric `VIProductVersion` Windows wants. The cost
is that staging does not rehearse production's Windows *update* path (which goes
through the MSI); everything else about the app is identical.

**One required piece of setup, and it is not in this repo:** a repo Actions
**variable** named `STAGING_SERVER_URL` (Settings → Secrets and variables →
Actions → Variables) holding the staging server's base URL. The workflow's
`prepare` job fails with a clear message when it is empty, or when it points at
`api.baalda.com` — a staging app that silently fell back to the production server
would be worse than no staging channel. It is a *variable* rather than a secret
because it cannot be kept secret: Vite inlines it into the JS bundle, and we
publish that bundle. Treat the staging server as internet-facing.

### How the app is turned into a different app

`tauri build` takes a repeatable `-c/--config`, and the workflow passes two
overlays that merge onto `tauri.conf.json` in order:

- `app/apps/desktop/src-tauri/tauri.staging.conf.json` — **committed.** The
  identity: `productName`, `identifier`, and the updater endpoint.
- `src-tauri/tauri.staging.build.conf.json` — **generated per run** (gitignored).
  The run-numbered `version` and this platform's `bundle.targets`.

The merge is RFC 7386 JSON Merge Patch (`json_patch::merge`, via tauri-utils'
`merge_config`), which means **arrays are replaced, not concatenated** — the
overlay's one-element `endpoints` array *removes* production's endpoint rather
than adding to it. Relative `--config` paths resolve against `app/apps/desktop`,
which is both the CLI's working directory under tauri-action and the base
tauri-action itself uses, so one relative path is right for both. tauri-action
parses `--config` out of `args` on its own, which is how it learns the overlaid
`productName` and `version` and so looks for the right artifact filenames and
substitutes the right `__VERSION__`.

The updater **signing key is deliberately shared** with production. The minisign
public key is compiled into the app from `tauri.conf.json` and the overlay does
not touch it, so staging builds must be signed by the same private key or they
would reject their own updates. Channel separation is the endpoint, not the key.

### Installing the staging app next to the real one

Download the installer from the `staging` prerelease on the Releases page (it is
marked *Pre-release*). Because the bundle identifier differs, macOS treats it as a
separate application: it installs to `/Applications/Baalda Staging.app`, gets its
own Dock icon, and Tauri hands it **its own app-config directory**
(`~/Library/Application Support/com.baalda.context.staging`), so the vault path and
server URL it remembers never mix with the released app's. macOS builds are
Developer ID signed and notarized exactly like production, so the install is clean.

Three things that are **not** isolated, in descending order of how much they can
hurt you:

1. **Vault folders.** A vault's `.context/config.json` binds that folder to one
   server's vault id and doc-id map. Opening a folder you also use with the
   released app points the same notes at two servers, and the result is not a
   merge — it is divergence you cannot unpick. **Use a fresh, throwaway folder.**
2. **The `baalda://` link scheme.** Both apps register it and the OS picks a single
   handler, so a shared note link may open in the other app. This is not fixable
   without breaking staging deep links outright, since the server mints
   `baalda://` URLs.
3. **The OS keychain service**, which is the frozen `com.baalda.context` in both
   builds (see `keychain.rs`). Session items are keyed `session-v2:<serverUrl>`,
   so a staging app on the staging server and a released app on the production
   server never touch the same item — the different server URL is what separates
   them, not the app. Point the staging app at the *production* server, though,
   and both apps contend for one keychain item whose macOS ACL belongs to whichever
   app created it, which is exactly how you earn the "Baalda wants to use your
   confidential information" password prompt.

### Notes on the staging workflow

`concurrency: staging-release` has **`cancel-in-progress: true`**, the opposite of
production. A superseded staging build is worth nothing — the tester wants the
newest commit, and the rolling release only ever holds one version — so a newer
push kills the older run. The cost is throwing away an Apple notarization already
paid for in wall-clock, which is a fair trade on a test channel and not on a real
one. Everything else matches production: `max-parallel: 1`, no `timeout-minutes`,
and the same `notarize: false` escape hatch under Actions → *staging-release* →
*Run workflow*.

`release.yml` cannot be triggered by a `staging` push — it listens only on `main`
and `v*` tags. `ci.yml` runs on pushes to `staging` as well as `main`, so the suite
has seen the exact commit a tester is installing.

A `workflow_dispatch` from a branch other than `staging` is allowed and is a handy
way to get a single PR into a tester's hands; it logs a warning, because the
`staging` tag then points at that ref.

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

### Slow is not the same as wedged (learned on v0.1.12)

The release job has **no `timeout-minutes`** — it runs to GitHub's 6-hour default.
That is deliberate, and it replaced a 120-minute cap that was actively harmful.

v0.1.12 is the case that settled it. Both macOS jobs died in `Notarizing`: the
aarch64 job hit the 120-minute cap at 1h55m, and the x86_64 job died at 1h49m when
`notarytool`'s status poll returned `NSURLErrorDomain -1009 … No network route` —
a transient runner DNS failure, [known flaky](https://github.com/electron/notarize/issues/219)
on GitHub's macOS images. Nothing published. But the probe run the next morning
showed **both** submissions (`bd2708e5…`, `cfa7884f…`) as `Accepted`. We had thrown
away a release Apple was in the middle of approving.

So distinguish two failures that look identical in the log:

- **Slow queue** — the submission is fine and will land; the only correct response
  is to wait. Capping the job converts a slow success into a hard failure.
- **Transient runner network error** — the poll dies mid-flight with a `-1009`
  or `-1001`. The submission itself usually still completes; check `notarytool
  history` before assuming the build was bad.

Tauri has no retry or timeout around notarization polling. Its only lever is a
`--no-wait` flag ([PR #13521](https://github.com/tauri-apps/tauri/pull/13521)),
which skips stapling and so is not an option for us. Waiting is the whole strategy.

**Before re-tagging after a notarization failure, always run the probe first.** If
the failed run's submission id shows `Accepted`, Apple's queue is not your problem.

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
