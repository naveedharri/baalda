# Changelog

All notable changes to Baalda are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Performance
- **Startup and note loading, Rust side.** CRDT state, state-vector manifests
  and attachment bytes now cross the desktop IPC boundary as raw bytes in both
  directions (framed; `src/lib/ipcCodec.ts` ↔ `commands.rs`) instead of JSON
  number arrays — the largest measured doc was 17.7 MB of CRDT shipped as
  ≈62 MB of JSON text per open. Thirteen config/vault commands moved off the
  main (painting) thread and the parsed app config is cached in `AppState`, so
  `app_config_dir` + `create_dir_all` is one syscall pair per process rather
  than per call. The open-time index rebuild now skips folder rows whose parent
  and name are unchanged (1,458 pointless writes per open on the measured
  vault), and folder churn alone no longer triggers a whole-vault link
  re-resolution pass. `open_vault` reports per-phase timings (on `VaultInfo`
  and as one log line) and `rebuild` logs one line unconditionally. Release
  builds now use thin LTO, one codegen unit and a stripped binary.

### Changed
- **Launch no longer waits for the network.** The whole UI used to be gated on
  the session restore, which ends in the sync reconcile — a full disk walk, ~14
  serial HTTP round trips and three reads of a `.context/config.json` that is
  1.85 MB on a 6k-note vault — so the window sat on "Loading…" for seconds. The
  boot flag now covers only the vault open: the sidebar paints as soon as the
  tree is in the store, and `initAuth` runs detached behind a generation guard
  (`authInitGen`), so a sign-in/sign-out performed meanwhile always wins over
  the restore that lands after it. Inside the restore, the roster and the
  billing flag run in parallel, `refreshVault`'s three independent GETs run in
  parallel, and seat usage no longer gates the landing. `AccountMenu` gained an
  `authPending` state, so the identity bar names the open vault instead of
  claiming "Local · not synced" while the answer is still in flight.
- **Sync enables in two phases, so a first click is safe.** `SyncManager.enable`
  now primes the registry from the folder's own `.context/config.json` before
  any round trip (`VaultRegistry.primeLocal`), which makes every already-mapped
  note openable *with* a provider — pull-before-seed — while the structural
  reconcile is still running. The prime is a second, narrower flag than
  `enabled` on purpose: the watcher pipeline, the debounced registry pull and
  attachments stay off until the reconcile finishes, because a pull racing a
  reconcile is its own class of bug. A folder whose config carries no
  `organizationId` stamp, or a foreign one, refuses to prime. The landing and
  the vault switch pass `{ background: true }` and return at the prime; "Turn on
  sync" still waits for the whole enable. New pure `lib/sync/openGate.ts` holds
  the rule for a click that beats the prime (wait for a folder we know syncs;
  open at once for one we know is local, or when signed out), with a 3 s belt so
  nothing can wedge the first click.
- **`peek_vault_config` → `peek_vault_stamp`.** The launch path asked three
  times "which vault does this folder belong to?", and every answer shipped the
  folder's entire config — doc-id map included — over IPC to be JSON-parsed in
  the webview. The new command streams the file in Rust and returns just
  `{ organizationId, serverVaultId }`; `rediscoverVaultFolder` now takes those
  typed stamps instead of raw JSON. The registry still reads the full file —
  once per boot, shared between the prime and the reconcile.
- **The reconcile stopped doing work nobody used.** `GET /api/notes` was
  downloaded on every pass to answer one boolean only a just-created vault can
  act on (and `syncStructure` fetches the same endpoint again regardless), so it
  is now requested only when a seed is actually possible. `list_note_titles` —
  which parks on the SQLite write lock held by the background rebuild — became a
  memoized thunk that fires only when some on-disk note is unmapped or missing
  from the server: zero calls on a steady-state relaunch.
- **CRDT compaction counts bytes, not just rows.** The trigger was ">64 updates,
  checked at load", and on a 5,933-note vault it had never fired (busiest doc:
  58 updates) while 28 individual updates were over 1 MB each. `compactBytes`
  (1 MB) now fires alongside `compactThreshold`, and both are checked live as
  well as at load, so a paste or an AI rewrite no longer leaves megabytes of log
  to replay on every open of that note.
- **Billing → Transfer is a dialog, not a one-item menu.** Clicking Transfer on
  a Pro vault now opens a dialog that names the vault the subscription is
  leaving, lists every eligible destination as a selectable card with its seat
  count and Free plan, pre-selects the only candidate when there is just one,
  and explains what happens to both vaults before the confirm. When some owned
  vaults are missing it says why (already on Pro). `ConfirmDialog` gained a
  `confirmDisabled` prop so the confirm waits for a pick.
- **Faster launch, smaller app.** The window now stays hidden until the UI has
  actually painted, so no blank frame precedes the app (a Rust timer reveals it
  anyway after 1.5s if the webview never gets that far). The editor
  (CodeMirror), the illustrated avatars, the graph, the settings dialog, the
  welcome screen, and the sign-in and share dialogs each load on demand, which
  cuts the startup bundle from 2.05 MB to ~890 KB; the editor and avatar chunks
  are prefetched right after the first paint, so the first click still feels
  instant. Also targets the oldest supported WKWebView (Safari 13, matching
  `minimumSystemVersion` 10.15) instead of Vite's newer default, drops 3.2 MB
  of unreferenced brand art and Vite template SVGs from every installer, loads
  only the wordmark the current theme shows, and removes an unused font
  dependency.

### Added
- **Boot instrumentation.** `lib/perf.ts` marks `script`, `react-mount`,
  `tree-ready`, `tree-painted`, `auth-resolved`, `sync-primed`, `sync-enabled`,
  `reconcile-done` and `index-ready` — one `performance.mark` plus one
  `[boot] <name> +Nms` line each, which `mirrorConsoleToTerminal` puts in the
  `tauri dev` terminal. `tree-painted` is the number the user feels;
  `reconcile-done` is the one that must not regress.
- **Leave a vault you don't own** (#121). Members and admins get a **Leave**
  action in Vault Settings → Vaults. The server ends the membership the same way
  an admin's removal does — membership row, shares granted to you, your live
  sync sockets, and the vault is unpinned from your sessions — and, when email
  is configured, tells the owner you left and sends you a receipt. On the
  device you leave from the vault goes for good: out of the switcher and
  recents, and its folder moves to the OS Trash instead of lingering as a local
  copy. The owner is refused (`409 owner_cannot_leave`) and pointed at Delete.
  New route `POST /api/orgs/:orgId/leave`; two new email templates.
- **Tabs for open files.** Every note you open now stays open as a tab in a
  strip under the header — click to switch, × or middle-click to close, and
  closing the active tab lands on its neighbour. Tabs follow renames and moves
  (yours and teammates'), close when their file is deleted, and are scoped to
  the vault (switching vaults starts a fresh strip).

### Fixed
- **A queued local-change push could park forever.** `runLocalChangePush`
  returned without re-arming its drain timer when the vault engine was not up
  yet, leaving the queued notes waiting on a timer nothing would set again. It
  now retries, exactly like the uploader-busy branch beside it.
- **Sidebar presence no longer waits out the backfill.** A client announced
  which note it was viewing only after the server's `ready` — i.e. after the
  entire vault download — and the roster round that reveals everyone *else* is
  triggered by that same first announce. On any real vault that read as
  "teammates don't show up" for many seconds on every launch and reconnect. The
  announce now rides right behind `hello`, and the server parks a frame that
  races its auth I/O and replays it once the connection is subscribed.
- **Public note links.** The share button now offers Private and Public: Public
  mints `https://<server>/p/<token>` — a server-rendered read-only page anyone
  with the link can open (images included, served token-scoped; never SVG).
  Revocable anytime from the same menu; revoked/unknown/deleted all serve one
  identical 404. New `public_links` table (migration 020) and an escape-first
  markdown renderer with no new dependencies.
- **Private links queue through sign-in.** A shared link opened while signed
  out now raises the sign-in dialog and opens the note right after auth; a link
  into a vault with no folder on the device parks on the folder prompt and opens
  once one is chosen. The wait for a first sync extends while sync is visibly
  working, and connectivity failures are named instead of implying no access.

### Changed
- Rebranded the project to Baalda (brand only; the internal
  "context" codename, storage identifiers, and bundle/keychain id are
  unchanged; see `docs/BRANDING.md`).

### Added
- Open-source project setup: Apache-2.0 `LICENSE`, `NOTICE`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `TRADEMARK.md`, and GitHub issue/PR
  templates.

## [0.1.30] - 2026-08-22

Access control, and the vault's shape.

### Added
- **Shareable note links.** A share icon in the note header copies
  `baalda://note/<vault>/<doc>`; opening it switches vault if needed and lands on
  the note. The link carries ids only, resolved against whoever opens it, and is
  keyed by `doc_id` so it survives every rename and move. Adds
  `tauri-plugin-deep-link` plus `tauri-plugin-single-instance`, so a click on
  Windows/Linux reaches the running app instead of starting a second one.
- **Private, at two scales** (`shares.permission = 'denied'`, migration 018) —
  the only row in the model that subtracts. Per-**member** it blocks one person
  and beats everything, authorship included. Per-**item** it takes a folder or
  note out of the team's reach, leaving only people shared with by name.
- **Freeze vault root** (Settings → General): a structural latch that closes the
  vault's top level to new folders and notes. Applies to everyone, lifted only by
  an owner/admin, and enforced on the HTTP registry *and* the MCP tools.
- **Reveal in Finder** on any note or folder in the sidebar (platform-labelled).
- `GET /api/vaults/:id/access-tree` — the vault's whole structure for the Access
  panel (owner/admin, ids and paths only, deliberately not ACL-filtered) so an
  item you have made Private stays administrable after its file leaves your disk.
- Item colours on the server (`folders.color` / `notes.color`), keyed by id.

### Changed
- **Access settings now apply to the person setting them.** The owner/admin and
  note-creator branches were shortcuts that ran before any grant was consulted,
  so a Read-only vault still let its owner edit and a Private folder still showed
  up for its author. Both are skipped under item-Private and under a Read-only
  vault. Managing shares stays role-gated, so an owner can always lift what they
  applied to themselves.
- **Losing access de-syncs the note from disk**, alongside the existing tombstone
  path. It only fires when the server actually answered about deletions, it moves
  the file to the vault's recoverable trash rather than destroying it, and it
  refuses any doc whose content the device never confirmed upstream. Revocations
  are capped separately from deletions and more loosely. Restoring access
  re-materialises the file.
- **Vault revert is owner *or* admin** — it is the recovery half of an action
  admins could already take.
- **Item colours sync to the team** and survive a rename; colours set before a
  vault gained sync are adopted upward once.
- The Access panel is a real tree: folders expand in place and pull their
  contents in on demand, which is what made the notes *inside* a folder reachable
  at all. Permission writes now say "Applying…" instead of appearing stuck.
- One popover select everywhere (`MenuSelect`, which `RoleSelect` now wraps),
  replacing the last native `<select>`; the freeze-root checkbox became an
  animated `Switch`; the account menu leads with **Home** instead of repeating the
  identity card its own trigger already shows.

### Fixed
- **Google sign-in failed with `account_not_linked` on any account created with a
  password.** Better Auth's `accountLinking.requireLocalEmailVerified` defaults to
  true and refuses to link while the local row is unverified — and with
  `requireEmailVerification` off, every password sign-up is unverified forever,
  which made the account-linking config dead code. Now set to false. Trade-off:
  without verification at sign-up an address can be squatted, so email
  verification remains the real fix and is still owed.
- The "who can access" list resolved through different branches than the enforcer
  and reported *No access* on a member's own note while the sync token granted
  edit. They now mirror each other.
- The Access panel's dropdown was clipped by the settings card, which becomes the
  containing block for `position: fixed` children because its entry animation
  keeps a `transform` applied. The menu is portalled to `<body>`.
- The Access item list no longer nests its own scroll region inside the settings
  page's, which sliced rows in half at the top edge.

## [0.1.0] - 2026-07-14

### Added
- Local-first desktop app (Tauri v2 + React/TS) with Markdown files as the
  source of truth.
- Markdown ↔ CRDT bridge (Yjs `Y.Text`) with echo-loop guards and convergence.
- Sync server (Hono HTTP + Hocuspocus WS + Postgres) for multi-device sync.
- Team collaboration: organizations, folder/file ACLs, presence, live cursors,
  attachments, locks, and join codes.
- MCP endpoint for AI clients, gated by the same per-file permissions.
- Local search (SQLite FTS5), backlinks, tags, and a graph view.
- Semantic search via a dependency-free hashed embedder.

[Unreleased]: https://github.com/naveedharri/baalda/compare/v0.1.30...HEAD
[0.1.30]: https://github.com/naveedharri/baalda/releases/tag/v0.1.30
[0.1.0]: https://github.com/naveedharri/baalda/releases/tag/v0.1.0
