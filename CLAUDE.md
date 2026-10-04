# Baalda

**Context** is the permanent internal codename; **Baalda** is the brand. A local-first desktop "second
brain" where notes are plain `.md` files on disk that an AI can edit directly **and** that teammates
edit together in real time. Every OSS competitor does one or the other; the whole product is the
*bridge* between them.

- All product docs live under `docs/` (only this `CLAUDE.md` stays at the repo root).
- Docs index: `docs/Baalda.md` · live build status: `docs/STATUS.md` · branding policy: `docs/BRANDING.md`
- Specs (source of truth for design): `docs/specs/00`–`04` + `docs/specs/REQUIREMENTS.md` (the 12-requirement yardstick)

## System landscape (what lives where)

Three pieces; this open-source repo holds the first two.

- **Desktop app** (`app/apps/desktop`) — the product people install. Released by a
  version bump: bump `tauri.conf.json` (+ the other three files) and merge to `main` —
  `.github/workflows/release.yml`'s `gate` job releases only when that version changed
  (a `v*` tag still forces one). It builds installers for **macOS (arm64 + x64),
  Linux x64 and Windows x64**, and **publishes** a GitHub Release with `latest.json`.
  Only macOS is OS-signed (Developer ID + notarized + stapled); Linux/Windows ship
  unsigned, so fresh downloads warn (SmartScreen) — auto-update is unaffected everywhere
  because the updater checks our minisign signature, not an OS certificate.
  There is no draft/review gate — pushing a `v*` tag ships to every running app on its next
  updater poll (Tauri updater polls `releases/latest`).
  Because of that, review happens *before* main: PRs target the long-lived **`staging`** branch,
  and every push to it runs `.github/workflows/staging-release.yml`, which publishes a separate
  auto-updating **"Baalda Staging"** app (`com.baalda.context.staging`, version
  `<base>-staging.<run#>`, server from the `STAGING_SERVER_URL` Actions variable) into one rolling
  GitHub *prerelease* tagged `staging` — invisible to production's updater, which resolves
  `releases/latest` and so skips prereleases. Promotion is a fast-forward `staging` → `main` plus
  the four-file version bump; see `docs/RELEASE.md` → Staging.
- **Backend server** (`app/apps/server`) — open source and self-hostable (Node + Postgres).
  The managed option runs this **same server code**, publicly reachable at
  `https://api.baalda.com`; users choose an instance via the server URL in Settings. There is
  no separate "managed edition" of the server. Self-host/deploy guide: `docs/DEPLOY.md`.
- **Website + managed service** — lives outside this public repo. The README links
  [baalda.com](https://baalda.com) as the managed option, and that is the only mention this
  repo gets.

**Boundary rule:** this repo is public. Never commit anything about how *our* managed instance
is operated — hosting/provider, deploy config for our instance, domains/DNS, dashboards,
billing, or secrets. Managed-service work happens in private repos; commercial-only *features*
(if source-available) go under `ee/`.

## The one idea to hold in your head

`.md` files on disk are the **durable source of truth**. A per-note Yjs **`Y.Text` holding the raw
markdown string** is the **live source of truth** while a note is open/syncing. A bidirectional bridge
keeps them equal — both directions apply as CRDT *operations* (never whole-file overwrites), so a human
typing and an AI rewriting a paragraph **merge** instead of clobbering.

Two invariants everything depends on:
- **Key by `doc_id`, never by path.** A note's identity is a stable UUID shared across the `.md` file,
  the Yjs doc, the SQLite row, and the Postgres `notes`/`files` row. Renames/moves must never fork a note.
- **The server stores binary Y.Doc only.** Markdown never travels the wire — only opaque binary Yjs
  updates. Each client re-derives its own `.md` files and search index.

## Repo layout

Monorepo at `app/` (pnpm workspaces + Turborepo; pnpm pinned via `packageManager`, activate with
`corepack enable`); all docs and specs live under `docs/`.

```
app/
├── apps/desktop/   Tauri v2 app. Rust core (src-tauri/) + React/Vite/TS UI (src/)
└── apps/server/    Node/TS: Hono HTTP + Hocuspocus WS + Postgres + Better Auth + MCP
docs/               Baalda.md (index) · STATUS.md · specs/
```

**Division of labor:** Rust owns *all* disk I/O and a derived SQLite index. The React/TS layer owns the
note buffer via the md↔CRDT bridge and all networked sync. The UI never touches the filesystem directly —
it calls typed Rust commands (`src/lib/ipc.ts`) and hits the server over HTTP (`src/lib/api.ts`).

## Build & run

Prereqs: Node ≥ 22, Rust/cargo, Docker (for Postgres). Run `pnpm install` once from `app/`.

**Server** (from `app/apps/server/`):
```bash
cp .env.example .env      # change JWT_SECRET for anything real
pnpm run db:up            # Postgres 16 in Docker, host port 5439
pnpm run migrate          # apply migrations/*.sql in order
pnpm run dev              # tsx watch; HTTP :3010, Hocuspocus WS :3011, GET /health
```

**Desktop** (from `app/`): `pnpm run dev:desktop` (= `pnpm --filter desktop tauri dev`; Vite on :1420).
Build: `pnpm run build:desktop`.

## Test

- Everything: `pnpm test` from `app/` (= `turbo run test`, both workspaces; desktop's task is
  content-hash cached, server's never is — `apps/server/turbo.json` sets `cache: false` because it
  mutates the shared Postgres).
- Server (`app/apps/server`): `pnpm test` (vitest). **Requires `db:up` + `migrate` first.** Runs serially
  against a shared Postgres (`fileParallelism: false`).
- Desktop TS (`app/apps/desktop`): `pnpm test` (vitest, node env). The bridge suites (`echo`, `concurrent`,
  `rewrite`, `roundtrip`) are the crown jewels — they gate correctness of the whole product. The sync
  `integration` test is env-gated (`CONTEXT_IT=1`, needs a live server).
- Desktop Rust: `cargo test` in `src-tauri/` (unit tests inline per module + `tests/index_integration.rs`).

> ⚠️ Running `pnpm test` in `apps/server` wipes the dev DB (users/orgs/vaults). Re-seed afterward.

## Architecture by layer

### Desktop — Rust core (`app/apps/desktop/src-tauri/src/`)
Commands registered in `lib.rs`; `AppState` (`state.rs`) is one `Mutex` over `{ vault, index, watcher }`.
Errors: single `AppError(String)` (`error.rs`).
- `vault.rs` — path safety (`resolve_in_vault` rejects `..`/absolute/escape); ignores `.context/`, `.git`, dotfiles.
- `tree.rs` — recursive walk to nested `TreeNode`; surfaces exactly `vault.rs ALLOWED_EXTS` (notes,
  images, pdf, office docs, audio/video, csv/json/code, zip) and hides the root `attachments/` folder.
  **`ALLOWED_EXTS` and `NOTE_EXTS` are ONE contract with the desktop's format registry**
  (`src/lib/formats.ts` — `SURFACED_EXTS`/`NOTE_EXTS`, the single authority for what a file is: how it
  surfaces, opens, embeds, uploads and syncs) and with the `NOTE_EXTS` literals in `sync/registry.ts` /
  `sync/inbound.ts`; `formatsLockstep.test.ts` reads those source files and fails on any drift. Only
  `NOTE_EXTS` (md, markdown, mdx, txt, html, htm, canvas) are CRDT notes and index rows; a viewer
  choice is display-only and never promotes a file into the bridge. The webview CSP in
  `tauri.conf.json` is pinned by `src/__tests__/csp.test.ts` — Tauri injects it only in packaged
  builds, `frame-src`/`media-src` must allow `asset:`, `http://asset.localhost` (Windows) and
  `https://asset.localhost`, and dev never exercises it.
- `notefile.rs` — **atomic writes** (temp + rename), `sha256_hex`.
- `parse.rs` — `parse_note` → title / tags / `[[wikilinks]]` / frontmatter. `derive_title`
  (frontmatter `title:` → first H1 → stem) is the **index/search/wikilink** title — `index.rs`
  resolves links by basename *then* title and `notes_fts` has a title column — while the **UI
  displays the filename stem** (`src/lib/notePath.ts noteLabel`); that asymmetry is deliberate
  (`aliases` would unify it later). New notes are created **empty** (`notefile.rs create_note`).
- `index.rs` — SQLite at `<vault>/.context/index.sqlite` (WAL): `notes` (id=`doc_id`, path UNIQUE),
  FTS5 `notes_fts`, `tags`/`note_tags`, `links`, `folders`, `yjs_updates`, `yjs_snapshot`. Notes keyed by
  `doc_id`; `rebuild` preserves ids and never wipes the CRDT tables; `rename_note` rewrites paths by id so
  backlinks survive moves.
- `watcher.rs` — `notify` recursive watcher, 150ms-debounced (1000ms ceiling), emits ONE batched
  `files-changed {changes: [{path, kind}]}` per drain. `kind` is `modified` | `removed` | `tree`, derived
  from an existence check rather than forwarded from `notify` (whose event kinds and rename pairing we
  deliberately ignore); a rename therefore arrives as an unpaired `removed` + `modified` in one batch.
- `attachments.rs` — path-validated binary I/O under `attachments/`; never enters the note/CRDT pipeline.
- `keychain.rs` — `keyring` crate, service `com.baalda.context`; trait-based so tests use a fake.

Tauri events to the UI: **`vault-opened`** and **`files-changed`** (the only two).

### Desktop — the bridge (`src/lib/bridge/`)
Pure TS with dependency-injected I/O so it runs under vitest in Node. `adapter.ts` wires production I/O.
`noteBridge.ts` = one `Y.Doc` with a single `Y.Text("content")` per note. Transaction origins:
`ORIGIN_DISK`, `ORIGIN_EDITOR`, `ORIGIN_REMOTE`.

**Loop avoidance — two guards you must never break:**
1. `onTextChange` ignores `disk`-origin transactions (don't write back what we just read in).
2. `lastWrittenHash`: egest hashes the bytes *before* writing; ingest drops any file read whose hash
   equals it (our own echo).

- **Ingest (disk→CRDT):** debounced 150ms; diff current serialization vs file (diff-match-patch), apply as
  `Y.Text` insert/delete under `disk` origin. A large diff ratio (>0.6, e.g. an AI whole-file rewrite)
  takes a recovery snapshot first. If a transaction races the file read, hash, or snapshot,
  retain the pre-read CRDT and apply the disk diff on that branch, then merge its operations
  into the live doc. Never re-diff older file bytes against newly arrived peer content: that
  turns peer additions into deletions. Ignore repeat reads of the merged disk input until
  the combined result is written; allocate the branch only when a transaction actually races.
- **Egest (CRDT→disk):** debounced 300ms; set echo hash, atomic write (Rust re-indexes on write).
- CRDT persistence: every `doc.on("update")` appends to the SQLite log; compact into a snapshot past ~64 updates.

### Desktop — sync (`src/lib/sync/`)
- `docSession.ts` (`syncManager`) — owns the registry, current `DocSync`, presence, attachments.
- `syncManager.ts` (`DocSync`) — `HocuspocusProvider` over the bridge's `Y.Doc`; doc name
  `vault:<vaultId>/note:<docId>`. Token is a **function** re-minted per (re)connect via `POST /api/sync-token`;
  403 → `no-access`. WS URL derived from the server URL (`deriveWsUrl`): ALWAYS same-origin
  `ws(s)://<server>/sync`, like the vault channel's `/vault-sync`. (It used to bump an explicit
  `:3010` to the dedicated `:3011`, which broke every single-port self-host — the Compose bundle
  publishes only 3010 — so content never uploaded while structure synced fine, #79.)
- `startup.ts` (`decideSeed`) — **split-brain rule**: when signed in, pull from server FIRST, then seed a
  local orphan only if the doc is still empty. Reversing this causes permanent divergence.
- `registry.ts` — reconciles local vault ↔ server vault/folders/notes, persists the doc-id map to
  `.context/config.json`, materializes server-only notes create-only (`write_note_if_missing`) and then
  fills them in from THIS device's local CRDT when it has one (`InboundHost.materializeContent` →
  `NoteBridge.writeThrough`); with no local CRDT the file stays 0 bytes and hydrates lazily on open or
  from the vault channel's backfill. Each path it creates is remembered for exactly one watcher echo
  (`consumeMaterialized`), so the app's own placeholder is never mistaken for an external edit.
- `tokenRefresh.ts` — re-mint 60s before JWT expiry. `attachments.ts` — content-hash (sha256) diff, upload/download.
- **External writers are first-class** (`handleLocalFileChanged` in `docSession.ts`): a watcher event for a
  non-open note routes to the sync layer — unmapped/structural changes trigger the debounced registry pull
  (register + upload), mapped notes get a debounced `ContentUploader` run with `force` + `ingestFromFile`
  (diff-merge the file into the CRDT via `NoteBridge.ingestNow`, echo-guarded fast-path skips our own egest
  echoes; the `divergedDocs` set forces a connect for out-of-band merges by resident bridges / cold applies).
  `NoteBridge.hydrate` also ingests the file on reopen when it moved on while the doc was closed.
  Edits to mapped, unopened notes made while the app was closed are detected at launch, once the
  session is live, by comparing the index `notes.sha256` with `diskBase` (`list_disk_drift`,
  `sync/closedAppEdits.ts`) and pushed through the same ingest + push queue in chunks of 50 (#284);
  padlocked notes, notes the server says this user cannot edit (an unanswered check counts as
  read-only) and notes whose file already equals the local CRDT are never pushed.
- **Disk deletes ARE propagated** (`SyncManager.drainDiskDeletes`, #93), after a `DISK_DELETE_GRACE_MS`
  (2.5 s) window that filters everything which merely looks like a delete: a `modified` for the same path
  cancels it (an editor's unlink-and-rewrite save, a rename-back), the file is re-checked on disk
  (`ipc.noteExists`), and a pending delete whose doc text hashes equal to an unmapped file that appeared in
  the same window is a RENAME — `registry.renamePath` + `ipc.rebindNoteId` keep the `doc_id` (a batch that
  queued a delete also defers its registry pull, or the new path would register as a second note first).
  Survivors call `registry.deletePath` — or `registry.deletePaths` → `POST /notes/delete-batch`
  above `BULK_THRESHOLD_DOCS`,
  both pooled — the SAME soft delete the sidebar's Delete makes, never `ipc.deletePath` (the file
  is already gone). Three refusals: a doc that is not `isPushed` (its only copy may be local), a session
  that is not yet live (`liveSince` = vault channel `synced` + one completed pull, so a missing file at
  startup re-materializes instead), and more than `max(5, ceil(mapped * 0.2))` deletes in one window — judged
  FIRST, before any server call. Over the cap with the root present and the session live, the batch is
  HELD, not abandoned (#221): a banner asks "Delete for everyone / Restore", the pull skips the held docs;
  with the root gone it is still refused silently, because an unmounted volume
  looks exactly like a bulk delete. A mapped FOLDER that vanishes while an unmapped folder appears is
  paired first (`drainFolderMoves`: ≥80% of its notes present at the same sub-path with matching content
  ⇒ ONE server folder move, every id kept; below that, per-note pairing then the drain). A vanished vault
  root pauses every materialize/register/delete step, closes the tabs and offers Restore here (recreate
  it at the old path and sync down — the Set-up prompt's empty-folder path) or Locate folder… (its
  open-folder path) from the banner, Settings → Vaults and the launch prompt (#228). The ingest side is
  guarded too: a 0-byte file never clears a populated doc (`allowTruncateFromDisk`, default false). A disk delete the server refuses on the creator rule (403
  `delete_not_creator` / `folder_has_others_items`, per item in a batch) is put back, never retried:
  `registry.restoreRefusedDelete` re-creates the file create-only, fills it from the local CRDT, owes
  one `consumeMaterialized` echo and records one `restoredFromServer` entry (detail
  `NOT_CREATOR_DETAIL`, `lib/sync/deletePolicy.ts`), the held banner's Delete for everyone included.
- **`ready.empty` is filtered against disk** (`SyncManager.settleServerEmpty`): the server names every
  readable doc it holds no CRDT for on each connect, but a doc whose LOCAL file is empty too has nothing
  to push — it is marked pushed + badged synced and never queued (a vault with 307 zero-byte `_Index.md`
  stubs used to "re-sync 307 notes" on every reload). Files over `MAX_NOTE_BYTES` (10 MB, the server's
  `MAX_NOTE_MB`) fail once, permanently, without a socket (`permanentFailures`) instead of being rejected
  by the server on every reconnect.
- **`ready.behind` is the other authority** (`SyncManager.handleServerBehind`, #98): the server's backfill
  diff (`loadDocDiff`) treats a client whose state vector *covers* the server's as up to date — unequal is
  not behind — and flags `clientAhead` when the client holds ops the server never received; those docs are
  named on `ready.behind` and queued for a push exactly like `ready.empty` ones. Before this, 40 notes with
  unflushed local edits re-downloaded a 2-byte empty diff on every connect ("Syncing 40/40" on each
  reload) and the edits never left the device.
- **`ready.revoked` is the third doc list** (`docSession.handleServerRevoked`): on every connect the
  server names the docs the client's own hello manifest claims that are NOT in its readable set
  (`vault-channel.ts revokedFromManifest`, `REVOKED_CAP` 2000, pure set arithmetic, no query) — bounded
  by what the client holds, never by the vault. It fires ahead of `setStatus("synced")`, because that
  flip arms the pull the authority is meant to cover; that ordering is what cleans up a member whose app
  was closed when the owner went Private, on their next launch. A revoked file leaves the disk only when
  all seven hold: both listings 200; the server ANSWERED the tombstone question; `isLive()`; an ACL
  signal ≤60 s old (`ready.revoked`, batched `revoked`, or `reauth`); the group fits `revokeCap = max(20, ceil(mapped*0.5))`
  OR the server NAMED this doc; the access-check agrees where the cap lift is what saved it; and the doc
  is `pushed` or the file is empty. The named list is NOT a second opinion — `/api/notes` and
  `revokedFromManifest` both call `listReadableDocsInVault`, so it only catches a racy short answer; the
  real cross-check is `POST /api/vaults/:id/access-check` (`InboundPlan.needsAccessCheck`, measured on
  the revoked group BEFORE any refusal → `registry.confirmRevocations`, chunked in slices of
  `ACCESS_CHECK_MAX` — mirrored in `lib/api.ts`, pinned by `accessCheckBound.test.ts`), and a
  disagreement, an unanswered id, a throw on ANY slice or the 30 s `ACCESS_CHECK_TIMEOUT_MS` abort
  LEAVES the whole group (a refused id also leaves the named set via
  `InboundHost.revocationRefused`). The named set unions across the session
  (`handleServerReauth` never clears it; `onServerDrop` feeds the live path) and a truncated list keeps
  its 2000 as the allow-list for older peers. Clients advertising `revocation-batches` receive all
  named revocations in frames of at most 2000 ids (before `ready` on connect, before `reauth` live).
  `hello.held` includes mapped notes without a local state vector; `hello.files` carries binaries.
  Doc-bound tree binaries sync three-way (`attachments.ts planBinarySync`) against a per-`files`-id
  base sha persisted as `config.json fileBases`: local==base ⇒ download the teammate's version,
  server==base ⇒ upload with `baseSha` (server 409 `stale_base` if it moved on), no base or both
  changed ⇒ server canonical, local copy to `.context/trash` (`copy_to_trash`) first — never a flip.
  A local binary this device knows by a `files` id the server TOMBSTONED (`GET /vaults/:id/file-tombstones`,
  ids from `file_tombstones` with no live row) is `toTrash`: copied to `.context/trash`, removed, its id
  forgotten — never re-uploaded, which used to undo a teammate's delete (#215). Id match only; a
  failed listing means no suppression that pass.
  Clients advertising `bulk-regrant` receive `bootstrap` for live grants of 25 or more
  notes, then pull the registry and use the HTTP bulk downloader. Bootstrap pages are
  gzip without `Content-Encoding`; the desktop explicitly inflates before decoding.
  Active backfill retains download progress across buffer pauses, and open read-only
  notes compare the pre-pull file with confirmed server content before reporting an edit.
  The named-list and independent access-check guards still apply. Confirmed access changes may
  remove empty folders even with a named note list; folder removal is always non-recursive, after
  note checks, and unannounced mass removals retain their cap.
  Large local note removals use `delete_files_batch` in chunks of at most 64, including revoked CRDT
  cleanup, and report a throttled `removing` phase with a remaining-item count. Confirmed deletions
  and revocations are OUTRIGHT via Rust `delete_file`
  (`rel_path_is_ignored` FIRST, so
  `.context` AND `.context/config.json` are refused, then a directory refusal; `deletePath` stays the
  sidebar's recursive one), regardless of authorship. A revoked removal also `docStore.drop`s +
  `ipc.clearYjsDoc`s, so `ready` stops re-naming it. The deletion cap is never lifted. Separate
  read-only reconciliation preserves a divergent local edit in `.context/trash` before replacing it
  with the server's canonical content; deletion and revocation never create those recovery copies.
- **Offline reconciliation** (`sync/ackedSv.ts`, `registry.ts`, `reconcileReport.ts`): the gate for an
  inbound delete / revocation is UNSEEN WORK, not `pushed` (a badge). `ackedSv` is the per-doc Yjs state
  vector the server is known to cover — recorded on Hocuspocus `synced`, a batch-push ack, the per-doc uploader's flushed editable
  push (`ContentUploader` `markAcked`), a one-step create's `sv` and
  `ready.covered` (NOT on a backfill/bootstrap apply: a server diff proves nothing about local ops),
  merged by max, persisted as `config.json ackedSv` — and
  `registry.unseenWorkVerdict` answers `none` (stale device: accept outright), `unseen` (local ops or a
  file hash ≠ `diskBase` the server never saw: recovery copy under `.context/trash` FIRST, then apply)
  or `unknown` (unprovable: the old "left on disk" refusal). A same-path create from two devices stays
  two notes: the later one by `created_at` is renamed `<stem> (conflict YYYY-MM-DD).<ext>`
  (`conflictPath`) and registered as its own note — never adopted onto the other's id. A rename made
  while the app was closed is paired back by content hash at startup (`pairClosedAppRenames`) so the
  `doc_id` survives. Every such action is recorded as a `ReconcileKind` (`restoredFromServer`,
  `deletedByTeammate`, `renamedConflict`, `keptLocally`, `selfRevoked`, `folderKept`,
  `externalEditSaved`) and shown once per session as one plain-words summary (`ReconcileBanner`,
  details in the Activity panel's Review changes); nothing in the report persists. `selfRevoked` is a
  revocation caused by an access change THIS device made for the signed-in user in the last 60 s
  (`sync/selfAccessChanges.ts` `markSelfAccessChange`/`isSelfAccessChange`): the same safety outcome
  as `keptLocally`, reported quietly and left out of the "N changes to review" count.
  `reconcileReport.forgetReadable(docIds)` drops `keptLocally`/`deletedByTeammate`/`selfRevoked`
  entries for docs the server lists again on a later pull, so regained access shrinks the banner.
- **One-step creates** (`registry.ts registerNotesBatched`, pure packing/classification in
  `sync/seedRegister.ts`): when the server's `/health` `features` (cached per server URL,
  `lib/serverFeatures.ts cachedServerFeatures`) lists `notes-with-state`, EVERY new note, 1 or
  20,000, registers through `notes/batch` WITH its binary Yjs state (`state` = base64
  `encodeStateAsUpdate`, `textSha256` an alarm only) — `BULK_THRESHOLD_DOCS` no longer gates creates
  and no new note opens a socket to upload. Chunks: 100 items / 4 MiB decoded (`packSeedChunks`); an
  item over 4 MiB goes alone up to `MAX_NOTE_BYTES`, past that it registers without state. The state
  is the local CRDT, or for an empty doc a THROWAWAY doc seeded from the file
  (`docSession.buildNoteState`, never the open note): the live doc is seeded only after the server
  says it holds those exact ops. Per item (`classifySeedResult`): `applied`/`covered` ⇒
  `noteSeeded` = `markPushed` + `recordAck(sv)` (never before the response — a crash leaves the note
  unpushed and the retry answers `covered`); `conflict` on our own id, or `adopted` onto ANOTHER id
  ⇒ `noteNeedsMerge`, never applying local state onto a doc the server already filled (that is the
  note-doubling bug); a missing `seeded` ⇒ old server, today's register-then-push. The merge is HTTP
  (`docSession.httpMergeOnce`): `bootstrap` with `only` (≤100 ids), start from an EMPTY local doc +
  the server's state, fold the file in with the uploader's post-pull routine, push the result
  through docs/batch WITHOUT `expectEmpty`, then ack; without `bootstrap-only` or on a failed pull
  it falls back to the per-doc uploader. **Decided 2026-10-04:** on `adopted`/`conflict` with
  differing text the SERVER text wins, the local text is saved to `.context/trash` (the fresh
  bridge's `unagreedFile` → `saveAside`) and reported once as `conflictKeptServer` in the reconcile
  banner and the Activity review; a clean adopt (empty or identical local text) reports nothing. This is not the
  `conflictPath` rule: `resolveSamePathConflicts` runs on the pull BEFORE registration and only for
  an unmapped non-empty local file at the path of a server note this device has never agreed on, in
  a collection it has a baseline for, so those stay two notes (`(conflict YYYY-MM-DD)`); `adopted`
  is what registration meets when that step did not apply (first sync without a baseline adopts
  by path on purpose, or the server row appeared after the listing), and `conflict` is our own id
  already filled. A merge for the open note (or the path of an open adopt loser) is parked and
  runs when the note closes. The eager single `registerNote` (a note opened before the
  pass, `registry.ts eagerSeed`) sends state the same way through `POST /api/notes` and settles the
  answer through the same `noteSeeded` / `noteNeedsMerge` hooks; an empty note, or one the host
  will not build (`buildNoteState` refuses the open note, whose `DocSync` owns its content), still
  registers without state. `ContentUploader`
  is now a fallback only — servers lacking `notes-with-state`/`bootstrap-only`, the HTTP merge's
  explicit fallback, and closed-note / read-only-rebase follow-ups not yet moved to HTTP — and is
  deleted once `MIN_CLIENT_VERSION` retires those servers.
- **No 0-byte placeholders when a bootstrap will deliver** (`registry.ts pendingFromBootstrap`,
  `InboundHost.bootstrapWillDeliver`): a pull large enough for the bulk path (`useBulkPath`) whose
  bootstrap is guaranteed to run records server-only notes instead of writing placeholders, and the
  bootstrap creates them WITH content (a fresh device joining a 20,000-note vault used to show
  20,000 empty files for the whole download). Small arrivals (a teammate's new note, a grant under
  the bulk threshold) are deferred too while the vault channel is connected, live and backfilling
  (`sync/deferredArrival.ts`): the first content frame's cold apply creates the file with its text
  through `apply_bootstrap_batch` (create-only, `markMaterialized`), and whatever has not arrived in
  `DEFERRED_ARRIVAL_WAIT_MS` (2 s), or on a channel drop, gets its placeholder; until then the note
  is simply not on disk, so the sidebar has nothing to open. Placeholders are still written now for
  docs the server holds no state for (`ready.empty`), docs this device holds CRDT for
  (`materializeContent` fills them), D5 restores, and everything when nothing will deliver. When
  the download ends however it ends, `materializePendingFromBootstrap` writes create-only
  placeholders for what it did not deliver (the server-empty `ready.empty` class, or a cancelled
  run), re-resolved by `doc_id`. The pending set is memory only, never persisted as done: an
  interrupted run leaves files missing and the next pull finds them again.
- **The open note's "was removed" banner waits** (`lib/openNoteRemoval.ts`, wired in `App.tsx`): a
  rename (in-app, Finder, an AI agent, a folder move) also reports the old path as `removed`, and
  setting the banner on that raw event flashed "was removed" on every rename until the move was
  paired. The check now runs after `DISK_DELETE_GRACE_MS` + `OPEN_NOTE_REMOVED_SLACK_MS` (500 ms) and
  shows only if the open note STILL sits on that path and `ipc.noteExists` says missing (a throw
  shows nothing); `noteRemovedSynced` is sampled when the file vanished. `store.renameNoteFileExact`
  re-points the open note, tabs, order and sorts right after the disk rename, BEFORE the server
  PATCH (a PATCH failure only warns). Empty notes pair too (`sync/emptyRename.ts
  pickUniqueEmptyRename`): every 0-byte placeholder hashes the same, so a renamed empty note used to
  reach the server as delete + create; the drain now pairs one only when exactly one empty note went
  and exactly one empty unmapped file appeared, sharing a basename or a parent folder.
- **Paths compare case-insensitively everywhere** — notes (`samePath`) AND folders in `planInbound`, like
  the server's `lower(path)` unique indexes and the outbound `registry.ts` adoption. A vault whose disk
  said `Projects/community` while the server said `Projects/Community` (with empty server folders under
  it) used to create and remove the same directories on alternate pulls, each pass re-triggering the next
  through the watcher's `tree` event: one idle client pulled the full registry every ~1.5 s (#98).

### Desktop — React (`src/`)
`store.ts` is a Zustand **UI view-state mirror only** (vault, tree, open note, auth/session, org members,
sync status, locks, prefs). Editor is CodeMirror 6 + `y-codemirror.next` (`yCollab`) — the buffer *is* the
markdown. In `collab` mode CM6 history/onChange are dropped so Yjs owns undo. Graph view is a hand-rolled
canvas force sim (no deps). Live-preview and inline-HTML rendering sanitize aggressively (drop
script/style/iframe, strip `on*`/`javascript:`). The editor's horizontal inset lives on **`.cm-line`**
via `--editor-pad-x`, never on `.cm-content`: `drawSelection()` reads the first line's padding and is
blind to the content element's, so a centring pad there made every full-line selection rect overrun the
margins — block replace widgets (which are `.cm-content`'s direct children) get the inset back through
the shared `cm-block-inset` class.

Live preview reveals markdown at **two scopes** (`lib/editor/reveal.ts`): LINE for the markers that
shape a line (`#`, `>`, the task dash, block widgets) and TOKEN for inline ones (`**`, `==`, `%%`,
`` ` ``, `[]()`), where `tokenOwner` finds the inline node a marker delimits and only a selection
touching THAT node unfolds it. A blurred editor has no active line at all. Obsidian-flavoured syntax
lives in `lib/editor/ofm/` — note the node names `OfmComment*`, because `@lezer/markdown` already owns
`Comment`/`CommentBlock` and `configure()` silently skips a duplicate name. The editor's `#tag` rule
(`ofm/hashtag.ts`) and Rust's `TAG_RE` (`parse.rs`) are ONE contract: change one, change both, or a
tag becomes visible but unsearchable.

Above the body sit two more block decorations, both React inside a CM6 widget (`lib/editor/noteHeader.ts`;
`updateDOM` returns **true** so the host node — and the focused `<input>` — survives a remote keystroke,
and the title widget's `eq()` compares only `{path, readOnly, hasFrontmatter, mode}`, never doc content):
- **The inline title** is the note's *filename*. Committing it is a **rename** (`store.renameNoteFileExact`,
  the no-dedup half of `renameNoteFile`), never a CRDT edit; an illegal or taken name is refused inline
  (`lib/editor/titlePlan.ts`) instead of being silently suffixed.
- **The Properties panel** replaces the frontmatter range. Every edit is a **minimal span replacement**
  (`lib/frontmatter/parse.ts` gives doc-absolute spans, `edit.ts` plans the changes) dispatched as an
  ordinary editor transaction, so it reaches the `.md`, the index and Yjs undo exactly like typing.
  YAML outside the supported flat subset is **never rewritten** — it renders as source under a banner.
  Per-vault types live in `.context/types.json`; the Visible/Hidden/Source mode is a device-local pref.
  `frontmatterView(state)` is the single authority for which of the three renderings the region gets —
  two block replaces over one range would throw.

Vault Settings has ONE **Members and access** tab (id `members`; the old `access` tab and
`AccessPanel.tsx` are gone): `components/MembersAccessTab.tsx`, `MemberProfilePage.tsx` (a PAGE
inside Vault Settings with a back link, not a dialog; rows open it on click; tabs Personal info /
Access / Activity), `InvitePeopleDialog.tsx`, pure logic in `lib/membersAccess.ts`. Owners/admins see the
**Everyone in <vault>** row (Can edit / Can view / No access = wire `open`/`readonly`/`private`), the
**New members** row ("For notes made before they joined": Can edit / Can view / No access
= `join_default`), and a per-person Access cell (Can edit everything / Can view everything /
No access / Custom) plus a ⋯ menu (View profile, Manage access, Make admin/member, Remove). Plain
members get a read-only roster from `GET /orgs/:orgId/members/overview`. "Owners and admins can always
manage access" means *manage*, never an exemption from the caps they set. No UI shows or creates
per-folder Everyone overrides; changing the Everyone row (`PUT team-access`) clears any that exist. One person's per-folder checkboxes live in
their profile's Access tab and apply immediately through the atomic bulk-access API (users
audience); the tree updates optimistically and re-reads only the affected subtree plus its ancestors,
never a fresh `listAccessTree`. The Access tab has a segmented icon toggle (top-right) between two
views, persisted per device in localStorage `context.memberAccess.view`: **List** (that
checkbox tree with the "Across the vault" level) and **Board** (default; `MemberAccessBoard.tsx`, the same
bulk-access writes, one resource per write): columns Can edit / Can view / No access, rows moved by
drag-and-drop or arrows, grey ancestor rows showing only the path (up to 5 levels), a "Set
everything to" menu with Reset to vault default and per-column Add all / Remove all. A single-row
move applies at once with no confirm and no undo; the app's standard toast states the result
("Sara can now view X."). **Confirms are for destructive changes only**, i.e. a target of No access
(`private`): the Everyone row, a person's vault-wide level, a List row/note change, the board's Set
everything to → No access, Remove all and Reset to vault default. Can view, Can edit, Add all, Set
everything to → Can view and the New members row never confirm. Access levels are colour-coded
everywhere (List and Members-table pills, board column headers, drag highlight, landing pulse):
Can edit green, Can view amber, No access grey, Custom/Mixed neutral, from `--access-{edit,view,none}-{bg,fg}`
in `src/styles/tokens.css` (light and dark).
Board drag uses **pointer events**, never native HTML5 drag-and-drop: Tauri's `dragDropEnabled`
swallows HTML5 drag events inside the webview, so they never fire. A press becomes a drag after
4px, the drop target is the whole column band under the pointer, and moves animate (lift, column
highlight, landing).
Personal info shows Name, Email, Role, Joined ("…, invited by X"), Last active and Status
(Online/Away from vault presence); Activity renders `GET …/members/:userId/activity`. Vault Settings
no longer has an Updates tab (version + Check for updates live in Account Settings → About), and
each settings dialog cross-links the other bottom-left. Hover/pressed colours are one accent tint
app-wide (`--bg-hover`/`--bg-active` in `tokens.css`). A quiet tip under the list links to the MCP tab. The vault mode is **unknown until fetched** (`lib/teamAccessCache.ts` seeds the paint
from localStorage but can never authorise a write); `lib/accessMode.ts` `effectiveTeamMode` stays
the single authority for resolved modes, mirroring `permissions/resolver.ts` at the org level.
`readonly` is the item-level combined grant+cap (the vault posture still stores `view`).

Automatic sidebar colours are a deterministic, account-personal fallback for FOLDERS without an
explicit manual colour (files stay neutral unless coloured by hand). A broad palette hashes stable item identities, then resolves collisions
within each ordered sibling group so the two preceding rows do not repeat; explicit synced colours
always win and participate in that neighbour check. Automatic colours are stable across restarts and
can be turned off in Account Settings → Appearance; they are ON by default (an explicit off is
kept). The palette pairs baalda.com's pastel fills with a deeper outline of the same hue.

Vault Health tab removed 2026-10-04 (#289); vault-level sync state surfaces only through the sidebar
badge, the reconcile banner / Activity review and file previews. `vaultSyncStatus` (vault channel) stays
independent of the open note's `syncStatus`, which still controls editor permissions; a note-level
refusal is not lost vault membership.
An attachment-local-only notice is driven only by the server's explicit
`attachment_sync_requires_pro` refusal. Do not infer it from a Free plan label:
the vault may be Pro, and billing-disabled self-hosts may still sync attachments.
The notice shows in file previews while notes continue to report their own sync state.
The vault Settings list shows account memberships and this app profile's recent
local folders, not a scan of the managed root. Production and staging have
separate recents even when they share a root; Open existing reopens a folder.

The **backend-behind notice** (`components/BackendBehindNotice.tsx`, pure logic in
`lib/serverFeatures.ts`) is a persistent, non-dismissible line at the bottom of the sidebar, above the
identity bar. It polls `GET /health` (on server URL / user / vault change and every 10 min) and shows
only when the server ANSWERED and lacks a feature in `REQUIRED_SERVER_FEATURES` (`notes-with-state`)
— keyed off `features`, never the version string; an old `{ ok: true }` counts as lacking all of
them. Unreachable or unparseable ⇒ unknown ⇒ nothing (a flaky network never raises it). Copy depends
on the host: the managed `api.baalda.com` says the server is being updated; any other server tells
the self-hoster to update it. Clicking opens Account Settings → About. The verdict is a store
mirror (`backendStatus`) and never gates sync on its own; the sync layer reads the same cached
feature set.

### Server (`app/apps/server/src/`)
Two listeners, one Node process (`index.ts`): Hocuspocus WS (:3011) + Hono HTTP (:3010). The same
Hocuspocus instance is also served on the HTTP port at `/sync` (`sync/http-upgrade.ts`) so the whole
server runs behind a single port/domain — that's what production deploys use (Dockerfile +
Railway IaC in `app/.railway/railway.ts`, applied with `railway config apply` from `app/` — the repo-root
`railway.json` is the legacy copy new Railway services ignore — + `docs/DEPLOY.md`; migrations run
pre-deploy via `node dist/db/migrate.js`). MCP writes
flow through the same sync server via `createDocWriter` so AI edits persist/broadcast like human edits.
- `auth/auth.ts` — Better Auth; **argon2id** (overrides default scrypt) via `@node-rs/argon2`; `bearer` +
  `organization` plugins (org = **vault**, the user-facing unified entity — Local / Synced / Remote states;
  roles owner/admin/member; invitations last `INVITATION_EXPIRES_HOURS`, default 7 days, and may carry
  an access level — `invitation_access`, applied as a per-user vault row on acceptance by the
  `afterAcceptInvitation` hook AND the join-code path, see `src/members/`). Session token is
  opaque (instant revocation), stored client-side only in the OS keychain.
  Desktop "Remember password" is a separate explicit opt-in: `rememberedPassword.ts`
  keeps only the last successfully authenticated password in the OS keychain,
  bound to server URL and email. Logout clears the session but retains this saved
  login; turning the switch off deletes it. The old email-only preference does
  not opt existing users into password storage. No password enters localStorage.
  Failed email sign-ins are throttled per lowercased email string (`auth/signin-throttle.ts`,
  Postgres `signin_throttle`, migration 036; wrapped around `POST /api/auth/sign-in/email` in
  `http/app.ts`): 5 failures in 15 min lock the account from ANY IP with 429 + `Retry-After`,
  1 → 5 → 15 min on repeat lockouts; success and `onPasswordReset` clear it. Unknown addresses
  are counted identically, so the response never reveals whether an account exists (#237).
- `http/routes/` — `registry` (vaults/folders/notes/files), `shares` (folder/file ACL), `orgs` (join codes),
  `members` (`GET /orgs/:orgId/members/overview` — roster + `last_seen_at`, access levels for
  owner/admin only, plus `invitedBy` = inviter of the latest accepted invitation for that email, null
  for the owner or a join-by-code; `GET /orgs/:orgId/members/:userId/activity?limit=50` (max 100) —
  `{events}` newest first: `joined` (+ invitedBy), `created`, `edited` (authored `note_versions` +
  `notes.last_edited_*`, one per doc per UTC day), `accessGranted` (per-user share rows; `path` null
  when the caller cannot see the resource); owner/admin or self, else 403; 404 `not_member`;
  created/edited filtered to the CALLER's readable set, no role exemption;
  `DELETE /orgs/:orgId/members/:userId/shares` (`createMemberShareRoutes`, the Access tab Board's "Reset
  to vault default") → `{removed, disconnectedDocs}`: one transaction deletes every per-user share row
  the member holds in the org (vault/folder/file, their own `denied`/`locked` too, so it can widen as
  well as narrow), leaves `member_access_snapshots` alone, disconnects docs that left their readable
  set (before/after) and fires `onAclChanged` per vault; owner → anyone, admin → plain members or
  self, else 403 `access_manager_required`; 404 `not_member`;
  `POST /orgs/:orgId/invitations` {emails, role, access}),
  `graph` (nodes/edges + semantic search), `sync-token`, `blobs` (attachment store), `mcp`, `billing`,
  `public-links` (`/api/notes/:docId/public-link` mint/inspect/revoke + public `GET /p/:token`
  read-only page — token is the capability; renders via the escape-first `render/note-html.ts`,
  no renderer deps).
- `billing/` — Polar behind `provider.ts`; `store.ts` is the ONLY writer of a `subscriptions` row and
  always persists the provider's returned state. One vault = one subscription (409 `already_subscribed`).
  Managed billing gives new accounts two free unsubscribed vaults and reserves standalone-file sync for
  Pro vaults. Migration 031 snapshots the prior benefits per user: existing accounts keep three free
  vaults, but standalone-file sync still requires Pro. An active or past-due Pro vault unlocks standalone-file
  sync for all its members; billing-disabled self-hosts remain unlimited.
  Deleting a vault cancels **at period end first** and aborts the delete if the provider refuses (502
  `subscription_cancel_failed`; Better Auth's own org-delete is off via `disableOrganizationDeletion`).
  The row then outlives the org as a **tombstone** — migration 024 dropped the cascade and added
  `deleted_at`/`org_name`/`owner_user_id` — so a late webhook is stored, not FK-failed and retried
  forever. Webhooks resolve by `provider_subscription_id` first, then metadata, which is what lets
  `POST /api/billing/orgs/:orgId/transfer` (owner; un-cancels at Polar) move one; `/mine` reconciles.
- `sync/hocuspocus.ts` — `onAuthenticate` verifies the per-doc JWT & sets `readOnly` for view grants;
  `onChange` appends the binary update + schedules re-index. `disconnectDoc` force-closes sockets on revoke.
- `yjs/persistence.ts` — binary-only store: `doc_updates` append log + `doc_snapshots` (compact past
  `COMPACTION_THRESHOLD`).
- `versions/shrink-guard.ts` — both write paths (Hocuspocus `onChange`, `applyDetached`) report an
  update that leaves ≤20% of a ≥200-char note; the prior text becomes a `pre-shrink` version (#200).
  It never refuses the update: a CRDT client keeps its op, so a refusal would re-push forever.
  `versions/recovery.ts` proposes (never applies) restores for already-damaged notes; apply is a
  forward write with a `pre-revert` version, owner/admin only.
- **Checkpoints** (`versions/checkpoints.ts`, `capture.ts`, `revert.ts`). A note's FIRST server
  content never triggers the daily checkpoint, by any route (`capture.ts isFirstContent`: no
  snapshot and ≤1 stored update, both write paths append before they report) — 13 of 21 notes in
  one reported checkpoint were structure-only because the seed itself fired it. **Deferral**
  (`maybeDailyCheckpoint`): a note created within `CHECKPOINT_DEFER_MS` (120 s) the server holds no
  content for, a `pending` blob, or a `files` row with no ready blob means a device is mid-upload;
  the capture is deferred and asked again `CHECKPOINT_DEFER_RETRY_MS` (30 s) later, until
  `CHECKPOINT_MAX_DEFER_MS` (30 min) takes it anyway. **Top-up**: first content arriving within
  `CHECKPOINT_TOPUP_WINDOW_MS` (1 h) of an automatic checkpoint that stored the note structure-only
  is added to it (collected per vault for 30 s, one pass). **Binaries**: each capture pins every
  registered tree file's ready blob and every `attachments/` drop in `vault_checkpoint_blobs`
  (migration 047, no byte copies: content-addressed). Pins are kept by the DATABASE rather than by
  every delete site: a `BEFORE DELETE` trigger on `blobs` retires a pinned Postgres-store row's bytes
  into `checkpoint_blob_bytes`; on S3 `blobs/gc.ts objectStillReferenced` counts a pin; when the last
  pin of a (vault, sha) goes (prune, vault delete) an `AFTER DELETE` trigger drops the retired bytes
  and re-queues the object for the drain, which checks liveness again. Postgres-store pins are capped
  at `CHECKPOINT_BLOB_MAX_POSTGRES_BYTES` (2 GiB) per checkpoint; past it files are structure-only
  and logged. **Revert** restores pinned files under their SAME `files` id: same sha ⇒ skip;
  different bytes ⇒ a ready row on the pinned bytes (the newer one is pinned by the revert's undo
  checkpoint); row gone ⇒ re-registered, its `file_tombstones` entry cleared (else every desktop
  trashes it again), blob recreated. Missing bytes or a path now held by another file ⇒ skipped
  and logged.
- `permissions/resolver.ts` — `effectivePermission(userId, docId)`: owner/admin → edit; a note's
  **creator** → edit on their own note; else max of file/folder shares (walk `parent_id` up) — either
  per-user or an org-wide "share with team" grant — plus any vault-wide grant; a `locked` share caps at
  view even for admins. **The vault posture is a baseline for everyone** (`vaultBaseline`): Read-only
  caps every shortcut at view; a vault that was never shared withdraws the owner/admin shortcut but
  keeps authorship (the private-by-default space); and **`sealed`** — an org `denied` row on the
  vault resource, which is what Everyone → No access now writes — withdraws authorship too, so
  nobody reads anything until a grant lifts it. An org grant on a folder/note still lifts out of a
  sealed vault (a floor, not a wall); an *item* set to Private drops those too, because there the
  point is withdrawing one item from a team that can otherwise reach it. Creation follows reading:
  `vaultRootWritable` refuses a root create in a sealed vault, since a note you cannot read is not
  worth making. **Deletion narrows further by authorship** (`http-gates.ts canDeleteItem`, behind
  every note/file/folder delete route, the note batch and MCP `delete_*`): owners and admins delete
  anything, a plain member only notes, files and folders they created (a row with no `created_by`,
  e.g. a file registered before migration 049, counts as someone else's) → 403 `delete_not_creator`,
  and a member's folder delete is refused whole with 403 `folder_has_others_items` when anything in
  its subtree was created by someone else; checkpoint revert, restore and trash purge are exempt.
  **A per-user row on the vault resource is that person's ABSOLUTE level**
  (`personalVaultLevel`, "person wins either way"): for them alone it replaces the org posture, the
  join snapshot, the owner/admin shortcut and authorship — `edit` = edit everywhere, `view` = view
  everywhere (raises AND caps), `denied` = nothing, and org (Everyone) folder/file grants do not lift
  it; only that person's own folder/file rows do. Item-level per-user rows still override inside
  their subtree and locks still cap. **Among ONE user's own per-user rows, the deepest wins**: a
  per-user file row beats that user's ancestor-folder row in either direction (file `edit` over
  folder `readonly`/`view`/`denied`; file `denied` over folder `edit`), and a per-user folder row
  beats their vault-level row. Org-principal `readonly`/`locked`/`denied` rows keep their cap
  semantics and still cap per-user grants. (Why: the Board's Can view on a folder writes a per-user
  folder `readonly`, which used to swallow a later per-user file `edit` inside it.) `ResolverCache.personal(db, orgId, userId)` memoises that level
  once per request (`canEditFolder`, `vaultRootWritable`, `resolveAccessForUser`). Lockstep: `effectivePermission` + `resolveAccessForUser` + the
  indexed/cached paths, `vault-docs.ts vaultAccess.personal`, `http-gates.ts`
  `canEditFolder`/`vaultRootWritable`, `POST /shares` (accepts a per-user vault `denied`) and
  `GET /vaults/:id/locks` (synthetic `vault:<orgId>` lock when the caller's personal level is `view`;
  their own per-user vault `edit` is a lift). `GET team-access` also returns
  `posture: edit|view|sealed|none`. Keep
  `vault-docs.ts vaultAccess` in lockstep: it reads the same grant rather than short-circuiting on the
  role, which is what makes the readable set, the folder tree, blob reads, the graph, MCP search, the
  registry pull and `ready.revoked` follow the posture for free. Management stays role-based
  (`shares.ts canManage`), so an owner can always undo what they set; two gates that used to ride on
  the role now ask for content access too — minting a public link, and a whole-vault checkpoint
  revert (which needs vault-wide read, 403 `no_vault_wide_access`). `edit > view > none`; no grant → no sync access (403 at token mint). A blob that carries a
  `doc_id` is judged by this same resolver (`canReadAttachment` / `canWriteBlob` in
  `permissions/http-gates.ts`), so a folder share reaches the FILES in it and not only the notes;
  a hash-named `attachments/` blob has no doc to resolve and keeps the older heuristic — vault-wide
  readers see all, a scoped member only what a readable note references. **New
  vaults are shared with their team by default** — `POST /api/vaults` creates the org-wide `edit`
  grant, but only alongside the org's *first* collection, so re-running it can't resurrect a grant an
  owner revoked via Access → Private. (This reverses the private-by-default posture of 2026-07-21,
  which left an invited teammate on an empty sidebar with no way to ask for access.) Vaults that
  predate the reversal are untouched: no grant means private, and the owner flips it in Access. Keep
  this in lockstep with `permissions/vault-docs.ts` (the readable-set dual that gates live sync +
  registry listings). The Access panel's vault-level control is **"Entire vault"** and **enforces** a
  mode rather than defaulting it: `PUT /api/orgs/:orgId/team-access` (`http/routes/shares.ts`,
  owner/admin) clears every org-principal row on every folder/file in the org's collections and
  upserts the vault row, all in one transaction — per-**user** rows survive, so people shared with by
  name keep their access. `GET` on the same path returns the mode plus the surviving overrides, which
  is what lets the panel confirm with exact counts before writing. Grants rank `edit=2 > view=1 >
  everything else 0` (`locked`/`denied` grant nothing, they only cap), and **only a narrowing kicks
  sockets**: a cleared item row kicks its docs iff its rank exceeds the target's, the posture kicks
  every doc iff it dropped — so Read-only→Shared and Private→Shared kick nobody, Shared→Read-only and
  →Private kick everything. `grantId` is stable (the vault row is upserted in place, deleted only for
  Private) and a no-op re-apply clears nothing, kicks nobody and broadcasts nothing.
  `GET /vaults/:id/locks` reports the Read-only posture as a synthetic `vault` lock row (id
  `vault:<orgId>`, `permission: 'locked'`) plus the **lifts** — the surviving org `edit` rows and the
  caller's own per-user `edit` rows — so the sidebar can padlock everything except what a grant frees.
  The desktop can no longer CREATE a per-item team lock (the row menu's "Lock for everyone" and the
  selection bar's Lock were retired: they conflict with the per-person access model); legacy
  `locked` rows still render as padlocks and owners/admins remove them with the row menu's or
  selection bar's Unlock, shown only on rows that carry such a row (`FileTree.tsx`).
  Delete is creator-only for plain members: the row menu's Delete and the selection bar's trash are
  disabled ("Only the person who created this, or an admin, can delete it") unless
  `registry.isAuthoredByMe` says every item is theirs, from authorship ids learned off the listing's
  `createdBy` (missing = someone else's); owners/admins are ungated and a racing 403 toasts that sentence.
  Renaming a note someone ELSE created (`PATCH /api/notes/:id`, `registry/rename-guard.ts`) is
  refused when it adds a `(conflict YYYY-MM-DD)` suffix (409 `conflict_rename_refused`) and
  budgeted at 100 per (user, vault) per 5 min (429 `rename_rate_limited`) — a burst brake after one
  client renamed 619 teammates' notes (2026-09-30). The desktop's same-path step also refuses to
  treat a note it holds local CRDT for as a clash, renames none past `samePathConflictCap`, and marks
  its own moves (`isOwnMove`) so the disk-delete drain and `pairClosedAppRenames` never pair them.
  Creates are gated by `permissions/http-gates.ts` `canCreateIn` (= `canEditFolder` in a folder;
  `vaultRootWritable` at the root, which a per-user vault-scoped `edit` lifts) and attachment uploads by
  `canWriteAttachment` (vault posture only — a blob has no folder to resolve a lock against); refusals
  carry `code: "no_write_access"` and are checked BEFORE the `root_frozen` latch. `onAuthenticate`
  re-resolves `effectivePermission` at connect, so a pre-revocation edit token cannot be replayed for the
  rest of its TTL.
  Future-member access is separate from the live vault posture. Migration 032 adds an org
  `join_default` (Private by default), per-membership snapshots and an ordered ACL revision, and
  migration 033 seeds that default ONCE from each existing vault's posture (org-wide vault grant
  `edit` → `open`, `view` → `readonly`, sealed or ungranted → `private`) so a Shared team sees no
  change. A vault created later gets `open` alongside its org-wide `edit` grant (`POST /api/vaults`,
  first collection only), so people who join afterwards see the notes that already exist. Only
  content that already existed when someone joined uses that snapshot; a team grant written before
  a Private join stays hidden, while a later Everyone action has a newer revision and deliberately
  opens the selected subtree. Existing memberships have no snapshot and are unchanged. The default
  and atomic bulk mutation live in `permissions/access-management.ts`, shared by HTTP and MCP, and
  management remains owner/admin-only even when the manager cannot read the selected content.
  `POST /vaults/:vaultId/access-check` (member-gated, `ACCESS_CHECK_MAX` 2000, `runPool` at
  `config.backfillConcurrency`) answers per-doc `effectivePermission` so the desktop can cross-check a
  revocation against the resolver rather than against the listing that announced it; an id with no row
  in this vault is left UNANSWERED, never `none`. `listDocsInVault`'s deleted branch resolves a
  hard-deleted folder's ancestry from `folder_tombstones` (`d.deleted_at >= n.created_at`, so a dead
  tombstone cannot claim a note created later) — without it a folder delete reaches a share-only
  member as a REVOCATION (no tombstone) instead of a deletion.
- `trash/` — per-vault note Trash (migration 035). Every soft delete (`softDeleteSet` in
  `trash/retention.ts`: single, batch, folder cascade, MCP, checkpoint revert) stamps `deleted_by` and
  `purge_after = now() + TRASH_RETENTION_DAYS` (30). Inside that window pushes into the deleted doc are
  ACCEPTED — token mint, `onAuthenticate` and the batch push resolve through `trash/access.ts
  syncPermission` (live resolver first, then `effectivePermission(..., { includeDeleted: true })`; a
  hard-deleted folder's shares no longer reach it) — and the note stays deleted. `DELETE /notes/:id`
  now evicts live sockets like MCP. `GET /vaults/:id/trash` (member; `listDeletedReadableDocsInVault`;
  `hasUnsyncedContributions` = a `doc_updates` row after `deleted_at`; cap 2000) and
  `POST /notes/:id/restore` (edit on the tombstoned doc or owner/admin; taken path ⇒
  `<stem> (restored YYYY-MM-DD).<ext>`; recreates a hard-deleted parent chain under its
  `folder_tombstones` ids; 410 `purged` once purged; still allowed past `purge_after` until the job runs)
  live in `trash/service.ts`. Version list/read work on a deleted note; revert is 409 `note_deleted`.
  `purgeExpiredTrash` (hourly, `trash/scheduler.ts`, started only from `index.ts`) stamps `purged_at` and
  drops CRDT, versions, index/links/blob_refs and per-note shares but KEEPS the `notes` row as a permanent
  tombstone, so a device offline past the window still hears "deleted" rather than an absent id (which
  would land on the revocation path). The vault channel's `ready` names `tombstones` (held ids that are
  soft-deleted, purged included; never also in `revoked`) and `covered` (manifest docs whose state vector
  the server covers; omitted in live-only), and `refreshAcl` keeps deleted docs out of live
  `revoked`/`drop`. A read-only socket's dropped edit is reported to its user as a `rejected` frame
  (`beforeSync` hook, throttled).
- `GET /health` (`http/app.ts`) answers `{ ok, version, minDesktopVersion, features }`: `version`
  is the server package version read once at startup, `minDesktopVersion` the live
  `client-version.ts` floor (null when off), `features` today `notes-with-state`
  (`registry/seed-on-register.ts`), `bootstrap-only` (`routes/bootstrap.ts`) and `files-with-bytes`
  (`routes/blobs.ts`). A missing `features` means none. Desktops pick their path from it once per
  server URL; the per-item `seeded` flag stays the fallback.
- **Registration with state** (`registry/seed-on-register.ts`, used by `POST
  /api/vaults/:vaultId/notes/batch` in `routes/bulk.ts` and `POST /api/notes` in
  `routes/registry.ts`): an item may carry `state` (base64 Yjs update) + `textSha256`. `parseState`
  validates and size-checks it BEFORE registration, so a malformed (`invalid_state`) or oversized
  (`note_too_large`, 413 on the single route) state never gets a row. The row then goes in through
  `registerNotes`/`registerNote` exactly as before — quota, `canCreateIn`, `root_frozen`,
  `path_folder_mismatch`, adopt-by-path, 23505 — the register connection is released, and only then
  `seedRegistered` writes state, through `applyDocPushBatch` with `expectEmpty` and the bulk seed
  origin, so the live Hocuspocus branch, shrink guard, fan-out and indexing apply unchanged (a CTE
  inserting row + update together would have bypassed all of them). State goes ONLY to a row this
  call created, or a row that already carried the SAME id in this vault (an old client or an
  interrupted run registered it and never pushed), after `syncPermission` and a covered check under
  the doc lock. Per item: `seeded`, `content` = `applied` | `covered` (server already held every op:
  a retry after a lost response) | `conflict` (row already holds other text; nothing written) |
  `skipped` (adopted onto a DIFFERENT id) | `refused` (+`reason`), and `sv` = the submitted state's
  vector, safe for the client's `recordAck`, when seeded. Items without `state` answer exactly as
  before. Caps: 16 MiB raw body always; with any state, ≤`BATCH_MAX_DOCS` (100) items and
  ≤`BATCH_MAX_DECODED_BYTES` (4 MiB) decoded, a single item up to `MAX_NOTE_MB` (400
  `batch_too_large`). `registry-changed` is published AFTER the apply, so a receiver's pull finds
  content, not a placeholder.
- `POST /vaults/:vaultId/bootstrap` takes `only: string[]` (≤`BATCH_MAX_DOCS`, 400
  `batch_too_large`): the session covers exactly those ids, unreadable or unknown ones silently
  dropped, never a 403. It is the desktop's HTTP pull-then-merge.
- **One-step file upload** (`files-with-bytes`, `routes/blobs.ts`, migration 048
  `blobs.pending_register`): `POST /vaults/:id/blobs/intent` may carry `register: { docId, relPath,
  folderId? }`; the Pro gate and a dry-run `registerFile` (adopt-by-path, `path_folder_mismatch`,
  create permission, frozen root, rolled back) run at intent BEFORE any row exists, with the same
  statuses/codes as `POST /api/files`. The registration waits on the pending blob row, and
  `complete` creates the `files` row in the SAME transaction that marks the blob ready, then
  broadcasts `registry-changed` (`setBlobRegistryNotifier`). A never-completed upload is collected
  by the pending sweep with its registration: no `files` row without bytes. Without the feature the
  old `POST /api/files` + intent → PUT → complete flow is unchanged. The desktop uses it for a NEW
  tree binary (no `files` id known) when the server advertises the feature (`attachments.ts
  oneStepRegister`): no `POST /api/files` / `preregisterFiles`, the id is recorded from the intent's
  `file` (dedupe, or `adopted` = bind to that row) or complete's; a 402
  `attachment_sync_requires_pro` registers nothing and raises the usual notice, and any other
  registration refusal sends that file down the old path once.
- `metrics/sync-metrics.ts` — in-process counters, no deps, no DB writes, reset on restart. Every 60 s,
  only when something changed, one line `[sync-metrics] {"windowS":60,"counters":{…}}` with DELTAS
  (sum across lines and instances): `seed.applied`/`appliedBytes`/`covered`/`conflict`/`refused`/
  `invalid`, `ready.empty.count` and `ready.behind.count` (+`.connects`, `.bucket.0|1-10|11-100|101-2000`),
  `checkpoint.captures`, `checkpoint.docs.text`/`structureOnly`/`oversized`, `checkpoint.deferred.<reason>`.
  Each capture also logs `[checkpoint] vault=… notes= text= structureOnly= oversized= blobs= ms=`. Ids
  and counts only, never paths or text.
- `tokens/sync-token.ts` — HS256 per-doc JWT (`jose`), TTL `SYNC_TOKEN_TTL_SECONDS` (default 600).
- `mcp/` — JSON-RPC 2.0 over Streamable HTTP at `POST /api/mcp` (no SSE; GET/DELETE → 405). Tools:
  `list_vaults/list_folders/create_folder/move_folder/delete_folder/list_notes/read_note/search_notes/create_note/update_note/append_note/edit_note/move_note/delete_note/list_attachments/read_attachment_text/move_file/delete_file`.
  `delete_file` shares `deleteRegisteredFile` (`http/routes/registry.ts`) with `DELETE /api/files/:id`;
  `move_file` re-registers the id at a new path through `registerFile`, like `POST /api/files`.
  `read_note` returns a `revision` (sha256 of the body); `update_note`/`append_note`/`edit_note` take an
  optional `expectedRevision` and refuse a stale write (the check runs under the doc writer's per-doc
  lock, so check + apply are atomic). `edit_note` applies exact-anchor replace/insert/delete ops (an
  anchor must match exactly once unless `all`), `update_note` sends only the changed span, and
  `append_note` accepts an `idempotencyKey` so a retried call cannot append twice.
  Structural tools (create/move/delete of folders and notes) broadcast `registry-changed` with a
  `null` origin, and content writes fan out through `createDocWriter`, so an AI edit lands live on
  every open app exactly like a teammate's. `delete_folder` refuses a non-empty folder unless
  `recursive: true`. Move/delete semantics live in `src/registry/tree-ops.ts`, shared with the HTTP
  registry routes so the two surfaces cannot drift.
  `search_notes` ranks `blob_text` beside `note_index` and tags every hit `kind: "note" | "file"`
  (opt out with `includeFiles: false`); `list_attachments` / `read_attachment_text` serve the
  EXTRACTED TEXT of a file, never its bytes, through `filterReadableBlobs` / `canReadAttachment`.
  There is deliberately no `attach_file` — base64 over JSON-RPC with no idempotency key, against a
  byte path built to avoid exactly that (see the note in `tools.ts`).
  Token = `mcp_…` minted from desktop Vault Settings → MCP; scoped to one (user, vault), gated by
  the **same** per-file ACL. Only a sha256 hash is stored.
- `index/` — `embedder.ts` is a dependency-free 256-dim hashed bag-of-words (works air-gapped;
  `OPENAI_API_KEY` swap noted but not wired). `indexer.ts` derives search + wikilink graph from Yjs state.
- `db/migrate.ts` — plain SQL in `migrations/*.sql`, applied in filename order, tracked in `_migrations`.

**Postgres tables** — Better Auth (`user`, `session`, `account`, `organization`, `member`, `invitation`;
camelCase quoted, migration 001), app tables (all ids `TEXT`, migration 002+): `vaults`, `folders`, `notes`
(id==doc_id, soft-delete via `deleted_at`), `files` (id==doc_id), `shares`, `doc_updates`, `doc_snapshots`,
`blobs` (`doc_id` = the `files` row these bytes are, or NULL for an `attachments/` drop — m028),
`blob_text` (a file's extracted text + vector; derived, purgeable, cascades with the blob and the
vault — m028), `invitation_access` (access chosen at invite, applied then deleted on accept — m046;
the same migration adds `member.last_seen_at`, stamped at most every 10 min), `org_join_codes`, `note_index`, `note_links`, `mcp_tokens`, `public_links` (one
plaintext token per note; revoke = DELETE), `vault_checkpoint_blobs` + `checkpoint_blob_bytes`
(checkpoint binary pins and retired Postgres-store bytes — m047), `blobs.pending_register`
(a one-step file upload's registration, applied at `complete` — m048).

## Server env vars (`app/apps/server/.env`)
`DATABASE_URL` (Docker host port **5439**→5432) · `JWT_SECRET` (Better Auth crypto **and** sync JWTs —
change in prod) · `BETTER_AUTH_URL` · `PORT` (3010) · `HOCUSPOCUS_PORT` (3011) · `SYNC_TOKEN_TTL_SECONDS`
(600) · `COMPACTION_THRESHOLD` (50) · `TRASH_RETENTION_DAYS` (30) · `CORS_ORIGINS` (optional) · `OPENAI_API_KEY` (optional) ·
`EMAIL_FROM` + `SMTP_URL` | `RESEND_API_KEY` (optional; turns on password reset, sign-up verification
and invitation emails — `src/email/mailer.ts`; unset ⇒ none offered, like Google OAuth) · `BUG_REPORT_EMAIL` (optional; with email on, the desktop's sidebar bug icon emails reports
there, Reply-To = reporter — `http/routes/bug-reports.ts`; unset ⇒ the icon is hidden).

## Conventions & gotchas

- **`doc_id` is identity.** Never resolve or store a note by path across layers.
- **`rel_path` and `folder_id` must agree.** A note/file/folder's location is stored twice; the server
  derives or validates the parent from the path on every create and move
  (`registry/tree-ops.ts` `resolveParentFolder` / `planNoteMove` / `planFolderMove`; mismatch → 400
  `path_folder_mismatch`) and the root-freeze latch judges the *resolved* parent. Migration 022 repaired
  the drift that let a phantom root folder appear (2026-08-27).
- **`.context/` is sacred and hidden** — never walk, sync, or index it. It holds `index.sqlite`, the CRDT
  store, and `config.json` (server vault id + doc-id map; travels with the vault).
- **The folder's stamp outranks the profile's binding when it names a vault this account cannot see.**
  `planTurnOnSync` (`lib/vault/turnOnSync.ts`) returns `blocked-foreign` (`foreignFolderMessage`)
  even when `orgVaults` binds the path to a visible vault, and `planUnsyncStamp` takes `boundOrgId`
  so a stamp/binding mismatch answers "foreign" locally without asking the server. Before, a
  production vault id 404'd on a local server, showed the "made local only" banner and could wipe
  the stamp.
- **Reuse patterns, not code.** We study OSS references (Noteriv, Relay, Hocuspocus, Better Auth) but write
  our own implementation.
- **Debounce timings are load-bearing:** watcher/ingest ~150ms, egest ~300ms. Changing them affects the
  echo-loop and convergence tests.
- **IDs are `TEXT`, not `UUID`** server-side (Better Auth emits TEXT; lets `shares.resource_id` reference a
  folder or a file, and lets clients supply stable doc_ids).
- **Intentional spec deviations** (documented in-code): `index.rs` uses a *self-contained* FTS5 table (not
  the spec's contentless one) because `snippet()` needs content; `SearchPanel` renders the Rust FTS snippet
  via `dangerouslySetInnerHTML`, relying on Rust emitting only sanitized `<mark>` tags.
- Product identifier: `com.baalda.context`; Tauri `productName` is "Baalda".
- **Terminology — "vault" (the workspace→vault rename).** *Vault* is the single user-facing name for the
  unified entity (Local / Synced / Remote states). It maps to two internal things that are 1:1 in practice:
  (1) the **user-facing vault = the Better Auth `organization`** — its data key stays `organizationId`; only
  the *concept name* changed (identifiers like `refreshVault`/`joinVault`, UI copy, docs); and (2) the
  **note collection = the Postgres `vaults` table row** (`vaultId`), the storage child that keeps all its
  `vault*` wire/DB names. The rename went all the way down (pre-launch, no compat window): migration 013
  renamed `shares`/`blobs.workspace_id` → `org_id` (org-id columns; `vault_id` already means the
  collection), rewrote the org-wide grant value `resource_type = 'workspace'` → `'vault'` (+ CHECK), and
  renamed `mcp_oauth_workspace` → `mcp_oauth_vault`; the 402 tokens are `vault_limit_reached` /
  `member_limit_reached`, the billing JSON fields `vaultsPerUser` / `membersPerVault`, and the env var
  `FREE_MAX_VAULTS`. The word *workspace* now survives only as pnpm's `pnpm-workspace.yaml` tooling
  term plus the Rust `#[serde(alias = "workspace_root")]` that keeps pre-rename desktop config files
  loadable.

## Build state (see `docs/STATUS.md`)

Phases 0–3 are complete and wired end-to-end: local Obsidian-lite → local CRDT bridge → sync server
(multi-device) → team collaboration (orgs, folder ACL, presence, attachments) — plus MCP, locks, join
codes, semantic search, and a graph view. Deferred to Phase 4: structural WYSIWYG CRDT, richer vector
search, AI-as-CRDT-peer, at-rest encryption, OAuth, and an iOS app.

Embedded attachments under `attachments/` without a standalone `files` identity sync on Free,
subject to storage quotas and existing blob ACLs. Bytes remain in the configured blob store,
not in Yjs. A standalone-file Pro refusal must not stop embedded transfers. Rich note copy
embeds attachment bytes in sanitized clipboard HTML; paste imports them into the destination
vault. Plain-text clipboard fallback remains Markdown.

Existing embedded links and blob IDs are retained across the Free attachment-policy
update; no note rewrite or blob migration is required. Missing embedded paths are
restored even if identical bytes already exist at another local path, without
overwriting occupied paths. Legacy whole-list Pro refusals can be re-probed on
a sync pass after a one-minute cooldown, allowing a running updated desktop to
recover when its server is upgraded.

### Baalda Assistant engine

AI’s Baalda Assistant provides user-reviewed agent repairs. `http/routes/housekeeper.ts` hosts the optional
`app/apps/server/housekeeper/index.mjs` module (override with `HOUSEKEEPER_MODULE`) without a
static build dependency. Every request checks vault membership and a non-deleted
`pro` subscription in `active`/`past_due` on Cloud. Self-hosters with
`BAALDA_DEPLOYMENT=self-hosted` have access. The Apache-2.0 module uses the server-side
OpenRouter SDK through swappable Decisions/chat adapters. Personal provider keys live in the desktop OS keychain and are supplied per inference request; the server does not persist them. Candidate reads use per-note permissions and apply/undo use
`DocWriter.editContent` with revision/span guards under its lock. Preview tokens
are scoped to user/vault, expire, and live in bounded process memory. No sync wire
format or bridge timing changes. Setup, limits and isolated tests:
[Baalda Assistant](docs/HOUSEKEEPER.md). Keys are user-owned and stored in the desktop OS keychain; inference supplies them per request. Diagnostic review sends aggregate counts only and returns allowlisted next-step recommendations. Advanced diagnostic tools live in AI (the Health tab is gone).

Baalda Agents follow observe → investigate → propose → approve → execute → verify.
Finding cards are data-driven; models choose allowlisted capabilities, while
existing permission-checked tools own changes. Link and filename changes require
concrete previews. Never interpret generated text as executable tool authority.

On Cloud servers Free vaults can register 20,000 live notes. New note
registration and MCP creation serialize quota checks with the same per-vault
session advisory lock (`billing/note-quota.ts`). Existing notes remain adoptable
at/above the cap; no data is deleted. `note_limit_reached` prompts an upgrade but
does not stop reconciliation of existing notes. Self-hosters and
active paid subscriptions bypass this note cap.
