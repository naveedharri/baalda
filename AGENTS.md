# Working on Baalda

## Start here

Read `CLAUDE.md` before implementation. It is the shared, detailed architecture
reference for this repository; this file provides the agent entry point and a
compact working guide. Consult the relevant code and tests before relying on
historical implementation details in either document.

- Product and docs index: `docs/Baalda.md`.
- Design specs: `docs/specs/00`–`04` and `docs/specs/REQUIREMENTS.md`.
- Build status: `docs/STATUS.md`; branding: `docs/BRANDING.md`.
- Contribution rules: `CONTRIBUTING.md`; release process: `docs/RELEASE.md`.
- Use the current package manifests for commands and dependency versions. Older
  documentation still mentions npm; the repository uses pnpm workspaces.

Keep product documentation under `docs/`. Root agent instructions are an exception.
Avoid duplicating the full architecture here; update the shared reference when
changing an architectural contract.

## Product and code map

Baalda (internal codename **Context**) is a local-first desktop knowledge app:
plain Markdown files can be edited by local AI tools while people collaborate
on the same notes in real time.

- `app/`: pnpm + Turborepo monorepo; Node >= 22, pnpm pinned by `packageManager`.
- `app/apps/desktop/src-tauri/`: Tauri v2 / Rust, disk I/O, atomic writes,
  filesystem watcher, derived SQLite index, and OS keychain.
- `app/apps/desktop/src/`: React / TypeScript / Vite, CodeMirror 6 editor,
  Zustand UI state, typed Rust IPC (`lib/ipc.ts`), HTTP client (`lib/api.ts`).
- Desktop `src/lib/bridge/`: Markdown ↔ Yjs reconciliation and local persistence.
- Desktop `src/lib/sync/`: sessions, registry, vault channel, uploads, inbound
  changes, attachments, and bulk synchronization.
- `app/apps/server/src/`: Hono HTTP, Hocuspocus sync, Better Auth, Postgres,
  permissions, blobs, billing, and MCP. Start at `index.ts` / `http/app.ts`.
- Server `src/permissions/`: shared authorization rules; `src/registry/tree-ops.ts`:
  structural operations shared by HTTP and MCP.
- `ee/`: separately licensed commercial features. The website is outside this repo.

## Invariants to preserve

- A stable `doc_id` is identity across disk metadata, SQLite, Yjs, and Postgres.
  Renaming or moving a path must never create a second identity. Server IDs are TEXT.
- Markdown on disk is durable truth; a note's `Y.Text("content")` is live truth.
  Reconcile edits as CRDT operations. Rust performs atomic disk writes; React
  accesses the filesystem only through typed IPC.
- The note sync protocol and persistence use binary Yjs updates. Derived search
  indexes and explicit MCP/public-page content rendering are separate surfaces.
- Preserve both bridge echo guards: ignore disk-origin changes for egest and
  suppress ingest matching `lastWrittenHash`. Watcher/ingest (~150 ms) and egest
  (~300 ms) timings affect convergence.
- Signed-in startup pulls server state before seeding a still-empty orphan.
  Preserve empty-file, deletion, revocation, recovery, and bulk-operation guards;
  transient missing files or incomplete listings must not cause data loss.
- `.context/` is private local metadata. Never include it in user-content walks,
  sync, or indexing; preserve its identity map and CRDT state.
- Keep `rel_path` and `folder_id` consistent. Follow existing case-insensitive
  reconciliation rules for both note and folder paths.
- Keep Rust extension lists, the TS format registry, and sync note-extension
  lists in lockstep. Binary files do not enter the note CRDT pipeline.
- Authorization must agree across the resolver, readable-set listings, HTTP,
  sync, blobs, and MCP. UI caches never authorize writes.
- The editor buffer is Markdown; Yjs owns collaborative undo. Inline-title
  edits rename the file; frontmatter edits use minimal editor transactions.
  Preserve HTML sanitization and packaged-app CSP requirements.
- Use **vault** in product language. `organizationId` identifies the Better Auth
  organization; `vaultId` identifies its note collection. Do not interchange them.

## Commands and verification

Install dependencies with `pnpm install` from `app/` (activate Corepack if needed).

| Task | Directory | Command |
| --- | --- | --- |
| Desktop development | `app/` | `pnpm run dev:desktop` |
| Desktop installer build | `app/` | `pnpm run build:desktop` |
| Workspace builds | `app/` | `pnpm run build` |
| Desktop TS tests | `app/apps/desktop/` | `pnpm test` |
| Desktop Rust tests | `app/apps/desktop/src-tauri/` | `cargo test` |
| Start dev Postgres | `app/apps/server/` | `pnpm run db:up` |
| Apply SQL migrations | `app/apps/server/` | `pnpm run migrate` |
| Server development | `app/apps/server/` | `pnpm run dev` |
| Server tests | `app/apps/server/` | `pnpm test` |
| All workspace TS tests | `app/` | `pnpm test` |

Server setup uses `.env.example`; preserve an existing `.env`. Postgres normally
uses host port 5439, HTTP 3010, and Vite 1420. Clients use same-origin `/sync` and
`/vault-sync`; the legacy dedicated Hocuspocus listener is 3011.

**Server tests wipe the configured dev database.** Verify that the target is a
disposable test database before running them, including through the root test
command. They require Postgres and migrations, run serially, and are not cached.
Desktop sync integration tests are gated by `CONTEXT_IT=1` and need a live server.

Run checks relevant to the change. Bridge changes need convergence/echo/roundtrip
coverage; sync and permission changes need their relevant regression suites.
Report what was actually verified and any prerequisites that prevented checks.
Match surrounding code style; new source files should carry the Apache-2.0 SPDX
header specified in `CONTRIBUTING.md`.

## Branches and repository boundaries

- Feature PRs target `staging`. Inspect the working tree before switching branches
  and preserve unrelated user changes.
- Use the repository's configured author identity for commits and pull requests.
  Do not add AI/tool attribution, generated-by text, or co-author trailers.
- Every push to `staging` triggers a rolling staging prerelease. Production
  releases are driven by the version gate on `main` or a `v*` tag; tags can ship
  immediately to installed apps. Follow `docs/RELEASE.md` for promotion and the
  coordinated four-file version bump. Do not treat pushes/tags as local checks.
- This is a public repository. Never commit credentials, `.env` files, or private
  managed-service operations/configuration. Keep managed-instance work in its
  private repositories and respect the separate `ee/` license.
