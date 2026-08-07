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
- `tree.rs` — recursive walk to nested `TreeNode`; surfaces `.md`/`.html` only.
- `notefile.rs` — **atomic writes** (temp + rename), `sha256_hex`.
- `parse.rs` — `parse_note` → title / tags / `[[wikilinks]]` / frontmatter.
- `index.rs` — SQLite at `<vault>/.context/index.sqlite` (WAL): `notes` (id=`doc_id`, path UNIQUE),
  FTS5 `notes_fts`, `tags`/`note_tags`, `links`, `folders`, `yjs_updates`, `yjs_snapshot`. Notes keyed by
  `doc_id`; `rebuild` preserves ids and never wipes the CRDT tables; `rename_note` rewrites paths by id so
  backlinks survive moves.
- `watcher.rs` — `notify` recursive watcher, 150ms-debounced, emits `file-changed {path, kind}`.
- `attachments.rs` — path-validated binary I/O under `attachments/`; never enters the note/CRDT pipeline.
- `keychain.rs` — `keyring` crate, service `com.baalda.context`; trait-based so tests use a fake.

Tauri events to the UI: **`vault-opened`** and **`file-changed`** (the only two).

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
  takes a recovery snapshot first.
- **Egest (CRDT→disk):** debounced 300ms; set echo hash, atomic write (Rust re-indexes on write).
- CRDT persistence: every `doc.on("update")` appends to the SQLite log; compact into a snapshot past ~64 updates.

### Desktop — sync (`src/lib/sync/`)
- `docSession.ts` (`syncManager`) — owns the registry, current `DocSync`, presence, attachments.
- `syncManager.ts` (`DocSync`) — `HocuspocusProvider` over the bridge's `Y.Doc`; doc name
  `vault:<vaultId>/note:<docId>`. Token is a **function** re-minted per (re)connect via `POST /api/sync-token`;
  403 → `no-access`. WS URL derived from the server URL (`deriveWsUrl`): explicit port 3010 →
  legacy dedicated port 3011; any other/no port → same-origin `ws(s)://…/sync` (single-port topology).
- `startup.ts` (`decideSeed`) — **split-brain rule**: when signed in, pull from server FIRST, then seed a
  local orphan only if the doc is still empty. Reversing this causes permanent divergence.
- `registry.ts` — reconciles local vault ↔ server vault/folders/notes, persists the doc-id map to
  `.context/config.json`, materializes server-only notes as empty files (hydrate lazily).
- `tokenRefresh.ts` — re-mint 60s before JWT expiry. `attachments.ts` — content-hash (sha256) diff, upload/download.

### Desktop — React (`src/`)
`store.ts` is a Zustand **UI view-state mirror only** (vault, tree, open note, auth/session, org members,
sync status, locks, prefs). Editor is CodeMirror 6 + `y-codemirror.next` (`yCollab`) — the buffer *is* the
markdown. In `collab` mode CM6 history/onChange are dropped so Yjs owns undo. Graph view is a hand-rolled
canvas force sim (no deps). Live-preview and inline-HTML rendering sanitize aggressively (drop
script/style/iframe, strip `on*`/`javascript:`).

### Server (`app/apps/server/src/`)
Two listeners, one Node process (`index.ts`): Hocuspocus WS (:3011) + Hono HTTP (:3010). The same
Hocuspocus instance is also served on the HTTP port at `/sync` (`sync/http-upgrade.ts`) so the whole
server runs behind a single port/domain — that's what production deploys use (Dockerfile +
`railway.json` + `docs/DEPLOY.md`; migrations run pre-deploy via `node dist/db/migrate.js`). MCP writes
flow through the same sync server via `createDocWriter` so AI edits persist/broadcast like human edits.
- `auth/auth.ts` — Better Auth; **argon2id** (overrides default scrypt) via `@node-rs/argon2`; `bearer` +
  `organization` plugins (org = **vault**, the user-facing unified entity — Local / Synced / Remote states;
  roles owner/admin/member; 48h invitations). Session token is
  opaque (instant revocation), stored client-side only in the OS keychain.
- `http/routes/` — `registry` (vaults/folders/notes/files), `shares` (folder/file ACL), `orgs` (join codes),
  `graph` (nodes/edges + semantic search), `sync-token`, `blobs` (attachment store), `mcp`.
- `sync/hocuspocus.ts` — `onAuthenticate` verifies the per-doc JWT & sets `readOnly` for view grants;
  `onChange` appends the binary update + schedules re-index. `disconnectDoc` force-closes sockets on revoke.
- `yjs/persistence.ts` — binary-only store: `doc_updates` append log + `doc_snapshots` (compact past
  `COMPACTION_THRESHOLD`).
- `permissions/resolver.ts` — `effectivePermission(userId, docId)`: owner/admin → edit; a note's
  **creator** → edit on their own note; else max of file/folder shares (walk `parent_id` up) — either
  per-user or an org-wide "share with team" grant — plus any vault-wide grant; a `locked` share caps at
  view even for admins. `edit > view > none`; no grant → no sync access (403 at token mint). **New
  vaults are shared with their team by default** — `POST /api/vaults` creates the org-wide `edit`
  grant, but only alongside the org's *first* collection, so re-running it can't resurrect a grant an
  owner revoked via Access → Private. (This reverses the private-by-default posture of 2026-07-21,
  which left an invited teammate on an empty sidebar with no way to ask for access.) Vaults that
  predate the reversal are untouched: no grant means private, and the owner flips it in Access. Keep
  this in lockstep with `permissions/vault-docs.ts` (the readable-set dual that gates live sync +
  registry listings).
- `tokens/sync-token.ts` — HS256 per-doc JWT (`jose`), TTL `SYNC_TOKEN_TTL_SECONDS` (default 600).
- `mcp/` — JSON-RPC 2.0 over Streamable HTTP at `POST /api/mcp` (no SSE; GET/DELETE → 405). Tools:
  `list_vaults/list_folders/create_folder/delete_folder/list_notes/read_note/search_notes/create_note/update_note/append_note/delete_note`.
  Token = `mcp_…` minted from desktop Vault Settings → MCP; scoped to one (user, vault), gated by
  the **same** per-file ACL. Only a sha256 hash is stored.
- `index/` — `embedder.ts` is a dependency-free 256-dim hashed bag-of-words (works air-gapped;
  `OPENAI_API_KEY` swap noted but not wired). `indexer.ts` derives search + wikilink graph from Yjs state.
- `db/migrate.ts` — plain SQL in `migrations/*.sql`, applied in filename order, tracked in `_migrations`.

**Postgres tables** — Better Auth (`user`, `session`, `account`, `organization`, `member`, `invitation`;
camelCase quoted, migration 001), app tables (all ids `TEXT`, migration 002+): `vaults`, `folders`, `notes`
(id==doc_id, soft-delete via `deleted_at`), `files` (id==doc_id), `shares`, `doc_updates`, `doc_snapshots`,
`blobs`, `org_join_codes`, `note_index`, `note_links`, `mcp_tokens`.

## Server env vars (`app/apps/server/.env`)
`DATABASE_URL` (Docker host port **5439**→5432) · `JWT_SECRET` (Better Auth crypto **and** sync JWTs —
change in prod) · `BETTER_AUTH_URL` · `PORT` (3010) · `HOCUSPOCUS_PORT` (3011) · `SYNC_TOKEN_TTL_SECONDS`
(600) · `COMPACTION_THRESHOLD` (50) · `CORS_ORIGINS` (optional) · `OPENAI_API_KEY` (optional).

## Conventions & gotchas

- **`doc_id` is identity.** Never resolve or store a note by path across layers.
- **`.context/` is sacred and hidden** — never walk, sync, or index it. It holds `index.sqlite`, the CRDT
  store, and `config.json` (server vault id + doc-id map; travels with the vault).
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
