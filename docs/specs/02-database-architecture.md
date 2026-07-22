---
type: spec
spec: 02-database-architecture
product: Baalda
status: draft-v1
date: 2026-07-13
tags: [baalda, spec, database, sqlite, postgres, storage]
---

# 02 · Database Architecture

Where data lives — on each client and on the server — and why nothing that matters lives *only* in a
database. Overview: [[00-architecture-overview]]. Bridge detail: [[03-sync-engine]]. Index: [[Baalda]].

---

## 1. The governing rule

**`.md` files on disk are the durable source of truth. Every database and CRDT store is a derived,
rebuildable layer.** If we deleted every SQLite file and wiped the server, a user's vault folder
would still be complete and correct. This is the opposite of Joplin and AppFlowy, which bury note
bodies inside SQLite — we copy their *index* design, never their body storage.

## 2. Three stores per client

| Store | Technology | Holds | Rebuildable? |
|---|---|---|---|
| **Vault files** | plain `.md` + attachments on disk | The notes themselves — what the user, AI, and git touch | It *is* the truth |
| **Local index** | SQLite | Search (FTS5), backlinks, tags, folder tree, `doc_id`↔path map, sync cursors | Yes, from the files |
| **CRDT store** | Yjs updates (in SQLite for desktop) | Live doc state + offline edit log | Yes, from the files (re-seed) or server |

### On-disk vault layout

```
VaultRoot/
├── Notes/ … .md                 # source of truth, human/AI/git-editable
├── attachments/ …               # images, pdfs, other blobs
└── .context/                   # hidden app dir — NEVER walked into the note pipeline
    ├── index.sqlite             # local index (this spec, §3)
    ├── crdt/                     # Yjs updates (or kept inside index.sqlite)
    └── config.json              # vault id, device id, server url, settings
```

Hard rule (learned from Obsidian LocalSync): **never let the app's own `.context/` dir get synced
or indexed as notes** — it corrupts the running client and its device identity. `list_tree` and the
watcher skip it.

## 3. Local index schema (SQLite)

Built and kept live by the same watcher/bridge pipeline that already sees every change. SQLite flavor:
**`tauri-plugin-sql` (sqlx)** for MVP; migrate to **libSQL** (`tauri-plugin-libsql`) when we want
at-rest encryption or Turso embedded-replica sync. (Node/Electron builds would use `better-sqlite3`.)

```sql
-- Note registry: the doc_id ↔ path map. doc_id is the stable identity used everywhere.
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,      -- doc_id (stable; == Yjs document id)
  path         TEXT UNIQUE NOT NULL,  -- vault-relative path (mutable — rename updates this)
  title        TEXT,
  mtime        INTEGER,
  sha256       TEXT,                  -- last-seen content hash (echo suppression aid)
  frontmatter  TEXT                   -- parsed YAML frontmatter as JSON
);

-- Full-text search (FTS5, external-content mirroring the note body).
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, body,
  content='',                        -- contentless: we feed it explicitly on each write
  tokenize='unicode61 remove_diacritics 2'
);
-- Query with MATCH; render results with snippet()/highlight().

-- Tags (from #inline-tags and frontmatter `tags:`).
CREATE TABLE tags       (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE note_tags  (note_id TEXT, tag_id INTEGER,
                         PRIMARY KEY (note_id, tag_id));

-- Wiki-links / backlinks: one row per [[link]] occurrence.
CREATE TABLE links (
  id           INTEGER PRIMARY KEY,
  src_note_id  TEXT NOT NULL,         -- note containing the link
  dst_note_id  TEXT,                  -- resolved target; NULL = dangling/unresolved
  dst_path_raw TEXT,                  -- raw [[target]] text
  link_text    TEXT,
  position     INTEGER
);
-- Backlinks panel:  SELECT src_note_id FROM links WHERE dst_note_id = ?
-- Forward links:    SELECT dst_note_id FROM links WHERE src_note_id = ?

-- Folder tree (nested via parent_id; recursive CTE renders the tree).
CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, path TEXT);

-- (Phase 1+) local CRDT persistence — Yjs updates + periodic snapshot per note.
CREATE TABLE yjs_updates  (id INTEGER PRIMARY KEY, doc_id TEXT, update BLOB, created_at INTEGER);
CREATE TABLE yjs_snapshot (doc_id TEXT PRIMARY KEY, snapshot BLOB, state_vector BLOB, seq INTEGER);

-- (Phase 2+) resumable sync cursor per document.
CREATE TABLE sync_state (doc_id TEXT PRIMARY KEY, last_seq INTEGER, last_seen_at INTEGER);
```

**Indexing rules.** On every note write (from the bridge), re-parse the markdown we already diffed:
update `notes` (title/mtime/sha256/frontmatter), replace `notes_fts` body, re-extract `#tags` and
`[[links]]`. **On rename, update `links.dst_note_id` by `doc_id`, never by path** — links must never
break on a move. FTS5 gives AND/OR/NOT/NEAR and incremental updates; it's the right MVP search. Orama
hybrid/vector search is a Phase-4 upgrade for semantic/AI retrieval.

## 4. Local CRDT persistence (Phase 1+)

- One `Y.Doc` (a `Y.Text` of the raw markdown) per note; `doc_id` == `notes.id`.
- Persist as an **append-only `yjs_updates` log + periodic `yjs_snapshot`** compaction (load doc →
  `Y.encodeStateAsUpdate` → write one snapshot → truncate the log when it exceeds N rows). This
  mirrors `y-leveldb`'s "updates + separate state-vector" model.
- Desktop keeps this in `index.sqlite`; a browser build would use `y-indexeddb`. Same append+snapshot
  shape either way.

## 5. Server-side storage (Phase 2+)

Two stores, each doing what it's best at — the AFFiNE server shape (Postgres + binary Yjs):

### A. Binary Yjs document store (the collaboration hot path)

Managed by Hocuspocus's persistence hooks (see [[03-sync-engine]]). **Store the Y.Doc as its binary
`Uint8Array` update — never as parsed JSON/markdown rebuilt into a doc**, or updates duplicate on
reconnect (Hocuspocus's explicit rule).

```sql
-- append-only Yjs update log (hot write path)
CREATE TABLE doc_updates   (id BIGSERIAL PRIMARY KEY, doc_id UUID NOT NULL,
                            seq BIGINT, update BYTEA NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
-- periodic merged snapshot to bound replay length
CREATE TABLE doc_snapshots (doc_id UUID PRIMARY KEY, snapshot BYTEA, state_vector BYTEA,
                            seq BIGINT, updated_at TIMESTAMPTZ);
-- attachments (bytea for MVP; S3/R2 in production)
-- blobs.org_id is the org (vault) id — deliberately not named vault_id, which the same table also
-- uses for the note-collection row (→ vaults.id). See the terminology note below §5B.
CREATE TABLE blobs         (id UUID PRIMARY KEY, doc_id UUID, org_id UUID, sha256 TEXT,
                            size BIGINT, mime TEXT, storage_url TEXT, created_at TIMESTAMPTZ);
```

**Compaction:** when a doc's log exceeds N updates, load it, `Y.encodeStateAsUpdate`, write one
`doc_snapshots` row, truncate the log. A new client gets the snapshot; an offline client gets only
the delta since its state vector.

### B. Relational store — Postgres (identity, org, permissions, metadata)

Owned by Better Auth + our ACL (detail in [[04-team-collaboration]]); shown here for the whole picture.

```sql
users        (id, email UNIQUE, name, avatar_url, created_at)
organization (id, name, slug UNIQUE, logo, created_at)          -- = vault (the user-facing entity)
member       (id, organization_id, user_id, role, created_at)    -- role: owner|admin|member
invitation   (id, organization_id, email, role, inviter_id, status, expires_at)
session      (id, user_id, token UNIQUE, expires_at, active_organization_id, ip, ua)

vaults       (id, organization_id, name, created_at)             -- note collection: child of the org (1:1 in practice)
folders      (id, vault_id, parent_id NULL, name, path, sort)    -- nested via parent_id
notes        (id, vault_id, folder_id, title, rel_path, doc_id,  -- doc_id → doc_updates/snapshots
              created_by, created_at, updated_at, deleted_at NULL)
files        (id PK == doc_id, vault_id, folder_id, path)        -- vault file ↔ CRDT doc mapping
shares       (id, resource_type, resource_id, principal_type, principal_id, permission, ...)
```

**The join key is `doc_id`.** `notes.rel_path` mirrors the on-disk path, but the stable identity is
`notes.id`/`doc_id`, so a rename or move never forks a document across the file / CRDT / relational
worlds. `deleted_at` gives soft-delete + recovery.

> **Terminology (workspace→vault rename).** The word "vault" appears at two layers here — resolve the
> apparent overlap this way:
> - The **user-facing vault** is the Better Auth **`organization`** (formerly "workspace"): the thing a
>   user opens, syncs, shares, and is billed for. Its data key stays `organization_id`.
> - The **`vaults` table row** is that org's **note collection** — the storage child (`vault_id`) that
>   `folders`/`notes`/`files` hang off. One org owns one note collection in practice (registry adopts the
>   org's oldest vault), so the user perceives a single vault; the two are 1:1.
> - The **on-disk `VaultRoot`** (§1) is the *Local* state of the same user-facing vault.
>
> All `vault_id` / `vaults` names are kept as the storage-layer collection handle. The `org_id`
> columns (`blobs`, `shares`; renamed from `workspace_id` in migration 013) hold the organization id —
> they are *not* the note-collection `vault_id`.

## 6. How AI edits fit the data layer

MVP: the AI edits the `.md` file on disk (via MCP filesystem tools); the file→CRDT bridge carries it
into the index and to collaborators (Inkeep OpenKnowledge's exact design). The bridge — not a special
AI path — is the safety mechanism, because the file write is *diffed into CRDT ops*, so an AI edit and
a concurrent human edit merge. The one hazard is an AI rewriting a whole note at once (a coarse diff
that can clobber a concurrent edit); mitigations: prefer localized AI edits (patch a section, not the
file), small/debounced ingest diffs, and a snapshot before applying a large diff so it's recoverable.
Post-MVP, AI-as-CRDT-peer (agent applies fine-grained ops directly) is strictly safer for live
sessions — deferred to Phase 4.

## 7. OSS references

- **Inkeep OpenKnowledge** — Postgres + Yjs + markdown-on-disk; the closest prior art for the whole
  data model and AI-edits-file flow.
- **Obsidian LocalSync** (`github.com/elcomtik/obsidian-local-sync`) — the local append-`fileUpdate`
  + per-file `_fileSnapshot` tables and the "never sync the app state dir" rule. Take directly.
- **AFFiNE** — the Postgres + binary-Yjs server shape (docs + blobs + snapshots).
- **markdown-vault-mcp** — a working SQLite FTS5 + tags + sections index over a markdown vault.
- **Notty** — "SQLite is a derived index, markdown files are the source of truth" (study only).
- **AppFlowy / Joplin** — good index design; **counter-examples** for body storage (they put note
  bodies in the DB — we do not).

## 8. MVP build order (data layer)

1. **Phase 0:** `index.sqlite` with `notes` + `notes_fts` + `links` + `tags` + `folders`; rebuilt by
   the watcher on every change. Delivers search + backlinks over plain files. No CRDT, no server.
2. **Phase 1:** add `yjs_updates` + `yjs_snapshot` for local CRDT persistence.
3. **Phase 2:** stand up Postgres + Hocuspocus stores (`doc_updates`/`doc_snapshots`); add
   `users`/`session`/`vaults`/`notes`/`files`.
4. **Phase 3:** add `organization`/`member`/`invitation`/`folders`/`shares` + `blobs`; server-side
   snapshot compaction; resumable `sync_state`.
5. **Phase 4 (deferred):** libSQL at-rest encryption + Turso replica sync; Orama vector/hybrid search.
