# Baalda — Sync + App Server

The Node/TypeScript server for **Baalda**: Better Auth (accounts +
organizations), a folder/file ACL, per-doc sync-token minting, and a Hocuspocus
Yjs sync engine backed by Postgres (binary Y.Doc store + compaction).

Implements specs `03-sync-engine`, `04-team-collaboration`, and `02-database-architecture` §5.

## Architecture

```
HTTP API (Hono, port 3010)                 Hocuspocus WS (port 3011)
 ├─ /api/auth/*        Better Auth          onAuthenticate  → verify per-doc JWT,
 │    email+password (argon2id),                              set readOnly for view
 │    sessions, organization plugin         onLoadDocument  → snapshot + replay log
 │    (invitations, members)                onChange        → append binary update,
 ├─ /api/sync-token    mint per-doc JWT                        compact when log > N
 ├─ /api/vaults|folders|notes|files  registry
 ├─ /api/shares        folder/file ACL  ── revoke → closeConnections (instant kill)
 └─ /api/mcp           Model Context Protocol (AI clients) ── writes via the sync server
                              │
                              ▼
                        Postgres (16)
   Better Auth tables · vaults/folders/notes/files · shares
   doc_updates (append log, BYTEA) · doc_snapshots (compacted) · blobs
```

Two listeners share one Node process. **Markdown never travels the wire** — only
binary Yjs updates. The server stores binary Y.Doc only.

## MCP endpoint

The server exposes a **Model Context Protocol** endpoint so any MCP-speaking AI
client can read and write the vault the same way a person does — gated by the
**same** per-file ACL. It's part of this server, not a separate process.

- **Endpoint:** `POST /api/mcp` — JSON-RPC 2.0 over Streamable HTTP (single JSON
  reply; no SSE stream, so `GET`/`DELETE` return 405).
- **Auth:** an MCP token minted from the desktop app's **Vault settings → MCP**
  tab (or `POST /api/mcp/tokens`). Send it as `Authorization: Bearer <token>`
  (or `?key=<token>`). Each token is scoped to one `(user, vault)` pair, so
  the client acts *as that user*: owners/admins get everything, members only what's
  shared with them. Only a sha256 hash is stored; revoke deletes the row.
- **Tools:** `list_vaults`, `list_folders`, `create_folder`, `delete_folder`,
  `list_notes`, `read_note`, `search_notes`, `create_note`, `update_note`,
  `append_note`, `delete_note`.
- **Writes** go through the Hocuspocus sync server: if the note is open they
  mutate the live Y.Doc (persist + broadcast to editors, exactly like a human
  edit); otherwise they persist a detached Yjs update. Either way it re-indexes
  and reaches disk on the next client sync.

```bash
# Example: register with Claude Code
claude mcp add --transport http context http://localhost:3010/api/mcp \
  --header "Authorization: Bearer mcp_…"
```

Token management endpoints (session-authenticated): `GET /api/mcp/tokens`,
`POST /api/mcp/tokens {name}`, `DELETE /api/mcp/tokens/:id`.

## Prerequisites

- Node ≥ 22 (tested on v24), npm
- Docker (for Postgres)

## Setup

From the workspace root (`app/`):

```bash
npm install
```

Then in `apps/server`:

```bash
cp .env.example .env          # adjust JWT_SECRET for anything real
npm run db:up                 # start Postgres in Docker (host port 5439)
npm run migrate               # apply SQL migrations
```

## Run

```bash
npm run dev      # tsx watch (dev)
# or
npm run build && npm run start
```

- HTTP API → `http://localhost:3010`
- Hocuspocus sync → `ws://localhost:3011`
- Health check → `GET /health`

## Ports & env (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://context:context@localhost:5439/context` | Postgres. Docker maps host **5439** → container 5432 (avoids a local 5432 Postgres). |
| `JWT_SECRET` | dev placeholder | Better Auth crypto **and** HS256 per-doc sync JWTs. **Change in production.** |
| `BETTER_AUTH_URL` | `http://localhost:3010` | Base URL Better Auth uses for links. |
| `PORT` | `3010` | HTTP API. |
| `HOCUSPOCUS_PORT` | `3011` | Sync WebSocket. Kept separate from the HTTP port for clarity; both run in one process. |
| `SYNC_TOKEN_TTL_SECONDS` | `600` | Per-doc JWT TTL (spec: 5–15 min). |
| `COMPACTION_THRESHOLD` | `50` | Merge `doc_updates` into a snapshot when the log exceeds this. |

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Run with `tsx watch`. |
| `npm run build` | `tsc` → `dist/` (strict, ESM). |
| `npm run start` | Run the built server. |
| `npm run db:up` / `db:down` | Start/stop the Postgres container. |
| `npm run migrate` | Apply `migrations/*.sql` via the tiny pg runner. |
| `npm test` | Vitest integration suite (needs `db:up` + `migrate`). |

## Auth flow (client)

1. `POST /api/auth/sign-up/email` / `/sign-in/email` → session; the response
   carries a `set-auth-token` header (opaque session token) to store in the OS keychain.
2. Authenticate subsequent requests with `Authorization: Bearer <token>` (bearer
   plugin) **or** the session cookie.
3. Organization plugin endpoints under `/api/auth/organization/*`:
   `create`, `invite-member`, `accept-invitation`, `list-invitations`, `list-members`, …

## Sync flow

1. Client registers its vault/folders/notes via the registry API to obtain `doc_id`s.
2. `POST /api/sync-token { docId }` → `{ token, readOnly, permission }` (403 if none).
3. Client connects `@hocuspocus/provider` to `ws://…:3011` with document name
   `vault:{vaultId}/note:{docId}` and the token. `onAuthenticate` verifies the
   token matches the doc and sets `readOnly` for view grants.

## Permissions (spec 04 §3)

`effectivePermission(userId, docId)`:
1. Vault **owner/admin → edit** on everything.
2. Else **max** of: a share on the file itself + any share on a containing folder
   (walking `parent_id` up). Folder grants inherit to descendants; a file share can
   only **raise**.
3. `edit > view > none`. No grant → **no sync access** (403 at token mint;
   the socket can't be opened without a valid token).

On **share revoke**, live sockets for affected docs are force-closed immediately.

## Migrations

Plain SQL in `migrations/`, applied in filename order by `src/db/migrate.ts`
(tracked in a `_migrations` table).

- `001_better_auth.sql` — generated by `npx @better-auth/cli generate`. Columns
  are **camelCase and quoted** (Kysely pg adapter). Regenerate rather than hand-edit.
- `002_app_tables.sql` — registry, ACL, and binary Yjs stores.

## Tests

```bash
npm run db:up && npm run migrate
npm test
```

23 tests: argon2id sign-up/sign-in, org create + invite (48h) + accept, the
permission-resolver matrix (owner/admin/member/inheritance/file-override/highest-wins),
`/sync-token` (200 edit / 200 view read-only / 403 / 404 / 401), binary
persistence + compaction, and end-to-end Yjs (two providers converge, a read-only
client's edits are rejected, revoke disconnects a live socket).

## Deviations from the spec sketch

- **IDs are `TEXT`, not `UUID`.** Better Auth emits `TEXT` ids; keeping every id
  `TEXT` lets `shares.resource_id` reference either a folder or a file without a
  type-tagged cast, and lets the client supply its own stable `doc_id`s (UUID
  strings). The join-by-`doc_id` contract and binary stores are unchanged.
- **Two listeners, one process, two ports** (3010 HTTP / 3011 WS) — simplest clean
  split; can be collapsed to one port later.
- **Blob storage is `BYTEA`** in Postgres for the MVP (S3/R2 later); `storage_url`
  column reserved.
- **Both `notes` and `files`** exist per the spec; `notes` is the rich per-note
  registry (title/rel_path/soft-delete), `files` the minimal mapping. The resolver
  and token minting accept a `doc_id` from either.
