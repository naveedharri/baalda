---
type: spec
spec: 05-vault-sync-engine
product: Baalda
status: draft-v1
date: 2026-07-15
tags: [baalda, spec, sync, yjs, crdt, hocuspocus, vault, scale, ha]
---

# 05 · Vault Sync Engine (background, vault-wide, always-on)

Sync is no longer a thing that happens *when you open a note*. Every note you're authorized to see
stays continuously current on disk via a vault-wide feed, independent of the UI. Opening a note
becomes instant because the doc is already live. Builds on the per-doc engine in [[03-sync-engine]];
ACL model from [[04-team-collaboration]]; storage from [[02-database-architecture]]. Index: [[Baalda]].

> **What "vault" means in this spec.** Here "vault" = the **server note-collection scope** keyed by
> `vaultId` — the `vaults` table row from [[02-database-architecture]], i.e. one always-on feed
> (`/vault-sync`, topic `vault:{vaultId}`) covering that collection's docs. This is **1:1 in practice**
> with the *user-facing vault* (the Better Auth `organization`, formerly "workspace"), so the "team,
> <50 members" whose edits fan out on a vault topic is simply that org's membership. This resolves the
> spec-02 (vault = child of the org) vs. the team-scoped reading here: they are the same unit seen from
> the storage layer vs. the collaboration layer. All `vaultId`/`vault:*`/`/vault-sync` identifiers are
> the collection handle and stay unchanged.

---

## 1. Why

The engine in [[03-sync-engine]] syncs **one note at a time** — the open one. `docSession` holds a
single `current: DocSync`; opening a note calls `closeCurrent()` and tears down the previous note's
sync. Server-only notes are materialized to disk as **empty stubs** that "hydrate lazily when the note
is opened." Consequences that contradict the product promise (`.md` on disk is the durable source of
truth, always current):

- A note not yet opened on this device is **blank on disk** until first click.
- The moment you switch away, a note **stops receiving** live updates.
- Opening a synced note **blocks on a server round-trip** (`whenSynced`, up to 5s) before content shows.

Goal: **disk is always the current truth for the whole vault, in real time, regardless of what's open.**

## 2. Decisions

| Concern | Choice | Reasoning |
|---|---|---|
| Sync unit | **The vault**, not the open note | One always-on feed per vault keeps every authorized doc current. Open/closed is a UI state, not a sync trigger. |
| Direction of the vault feed | **Downstream-only** (server→client→disk) | You can't type into a closed note. Upstream stays on the per-doc path (§6). Halves the new surface and keeps writes auditable. |
| Background presence | **None** | Content-only per product decision — you shouldn't appear "present" in notes you aren't looking at. Presence stays a per-open-note (Hocuspocus) concern. |
| Server memory model | **Stateless relay** — no resident `Y.Doc` for background | Backfill served from `loadDocState()` (Postgres); fanout relays opaque blobs by `doc_id`. Server RAM is bounded by docs being *edited*, not docs that *exist*. This is the single rule that makes it scale. |
| Fanout scope | **Per-vault topic**, ACL-filtered per subscriber | Cost of one edit ∝ concurrent members of *that vault* (a team, <50), **not** total users. |
| Cross-process fanout | **Pluggable PubSub adapter**: in-memory default, Redis when `REDIS_URL` set | Self-host stays Postgres-only (no new infra). Managed instance sets `REDIS_URL` for N-instance HA + rolling deploys. Same code path. |
| Backfill economy | **State-vector diffs** | Client sends `{docId → stateVector}` manifest; server streams only missing updates. An up-to-date device costs ~zero. `doc_snapshots.state_vector` already exists. |
| Client memory model | **Hot/cold tiering** with eviction | Hot docs resident (live `Y.Doc` + bridge); cold docs apply-transiently-from-SQLite-then-evict. Client RAM bounded by the hot set, not vault size. |
| Open note | **Unchanged Hocuspocus** (edit + presence + cursors) | Opening *promotes* an already-live doc and attaches an editor; it no longer creates or awaits sync. |

We do **not** keep a Hocuspocus provider per background doc (connection + memory blowup), broadcast
background presence, or hold resident server-side `Y.Doc`s for unopened notes.

## 3. Architecture

Three pieces. The server work reuses the existing `onChange` choke point and `loadDocState`.

### 3.1 Server — Vault Replication Channel (new, stateless relay)

A WebSocket protocol served on the **same single port** as Hocuspocus + Hono (the `/sync` HTTP-upgrade
topology already in place), at a distinct path (`/vault-sync`). Lifecycle:

1. **Subscribe** — client connects with a **vault-scoped token** (§7) + `vaultId`.
2. **Authorize** — resolve the subscriber's readable doc set for that vault via
   `effectivePermission(userId, docId)` over vault notes + shares. `view`/`locked` grants stream
   content (view = read); no grant → doc is absent from the set, never sent.
3. **Manifest handshake** — client sends `{docId → stateVector}` for what it already has. Server diffs
   each against stored state (`doc_snapshots.state_vector` + log) and streams only the delta via
   `Y.encodeStateAsUpdate(doc, clientStateVector)` computed from `loadDocState`. New device → full set
   (throttled, §4); current device → nothing.
4. **Live fanout** — the existing `onChange` (`sync/hocuspocus.ts`) publishes `{vaultId, docId, update}`
   to the **per-vault PubSub topic**. The channel relays each blob to subscribers who pass the ACL
   filter. No new per-doc listeners; one topic per vault.
5. **Revocation** — on share revoke, publish a `drop {docId}` control message so subscribers evict the
   doc locally (mirrors `disconnectDoc`'s instant-kill for the open-note path).

The channel never instantiates a `Y.Doc` for relay. Backfill reads Postgres; fanout forwards opaque
bytes. (An edit already round-trips through Hocuspocus, which owns the authoritative in-memory doc for
*open* docs; the channel is downstream of `onChange`.)

### 3.2 Server — PubSub adapter (new seam)

```
interface PubSub {
  publish(topic: string, payload: Uint8Array): Promise<void>;
  subscribe(topic: string, handler: (payload: Uint8Array) => void): () => void; // returns unsubscribe
}
```

- **InMemoryPubSub** — default. Single process; a `Map<topic, Set<handler>>`. Zero deps.
- **RedisPubSub** — when `REDIS_URL` is set. `ioredis` pub/sub; topic = `vault:{vaultId}`. Enables N
  server instances to share fanout, so any client can connect to any instance (no sticky sessions on
  the vault channel — it's a stateless relay).

Selected once at boot from env. Nothing else in the codebase knows which is running.

### 3.3 Client — Vault Sync Engine (new)

One connection per vault, owns:
- a **doc-state registry** (`docId → {stateVector, tier, lastUpdate}`), persisted so reconnects send a
  cheap manifest;
- the **backfill queue** (§4);
- update routing: an inbound `{docId, update}` is dispatched to that doc's bridge (hot) or applied
  transiently (cold, §3.4).

Replaces the "sync happens in `docSession.openDoc`" coupling. `docSession` keeps only the **open-note**
Hocuspocus session (edit + presence).

### 3.4 Client — Bridge tiering (extends `bridge/noteBridge.ts`)

`noteBridge` is already pure TS with injected I/O and does CRDT→disk egest with the `lastWrittenHash`
echo guard. Run it **headless** (no CodeMirror) for background docs.

- **Hot tier** — recently opened/edited docs (cap **~100**, LRU): resident live `Y.Doc` + headless
  bridge, **bidirectional** (also ingests local disk edits, §6).
- **Cold tier** — the long tail: **not resident**. An inbound update for a cold doc → hydrate the doc
  from **local SQLite** (`yjs_snapshot` + `yjs_updates`, which now exist for every synced doc) → apply
  update → egest to `.md` → persist the new update/snapshot → **evict**. Cost only when it changes.
- **Egest coalescing** — background writes reuse the 300ms debounce and batch, so disk + the Rust
  watcher don't thrash.

**Opening a note** = promote its doc to hot (already live → instant), attach CodeMirror + the
Hocuspocus provider for presence/cursors. **Closing** = detach editor + presence; the bridge stays
live in the hot tier until evicted.

## 4. The "smart" scheduler (overload + delay control)

- **Tiered, prioritized backfill.** At launch/reconnect: sync **recently-opened + recently-modified**
  docs first (foreground tier), then drain the long tail through a **bounded-concurrency queue**
  (`BACKFILL_CONCURRENCY`, default 6) at low priority. Perceived freshness is instant on what the user
  cares about; the tail trickles without a thundering herd.
- **State-vector diffs** make steady-state re-syncs ~free (idle reconnect ⇒ "you're current").
- **Push, not poll.** Silent until `onChange` fires. One connection, tiny binary frames.
- **Server backpressure.** Coalesce pending updates per doc into one merged update before sending to a
  slow subscriber (Yjs updates merge cleanly).
- **Jittered reconnect** absorbs the herd on server restart / rolling deploy.

## 5. Scale & HA

Cost of one edit ∝ **concurrent members of the edited vault**, not total users. 1000 users across
~100 vaults ≈ 10 sends/edit. Idle WS connections are cheap; each active client holds ~2 (vault channel
+ open-note Hocuspocus). Postgres does thousands of small `appendUpdate` inserts/sec; the bridge
debounces so it's per-edit-batch, not per-keystroke.

| Tier | Requirements | Path |
|---|---|---|
| Launch → hundreds concurrent | Single instance, `InMemoryPubSub`, per-vault fanout, stateless relay | Ships in this spec |
| Thousands / HA / rolling deploys | `REDIS_URL` set ⇒ `RedisPubSub` (vault channel) **+** Hocuspocus Redis extension (open-note editing consistent across instances) ⇒ N instances behind a load balancer | Same code; config + the Hocuspocus adapter |

The stateless-relay rule keeps server RAM bounded by *active editing*, so a 50k-note vault with nobody
editing costs ≈ zero server memory. The open-note (Hocuspocus) path is the only stateful one; its Redis
extension lets editing docs live consistently on any instance, which is what makes rolling deploys and
horizontal scale safe.

## 6. Upstream writes & correctness

- **Downstream (vault channel):** server→disk only. Reuse the `lastWrittenHash` guard so a background
  egest doesn't re-ingest as a watcher event.
- **Upstream stays per-doc.** Closed notes can't be typed into. The one case a closed note changes
  locally is a **disk edit** (AI writing `.md` directly — see [[00-architecture-overview]] step 6 — or
  a git pull). The Rust `file-changed` event maps path→`doc_id` and **promotes the doc to hot**, whose
  bidirectional headless bridge ingests (`origin=disk`) and pushes through the normal Hocuspocus path.
  **MCP** writes already flow through the sync server (`createDocWriter`), so they arrive down the
  channel like any peer edit.
- **Split-brain rule preserved** ([[03-sync-engine]] §5 / `decideSeed`): a headless doc seeds from disk
  only if it's a genuine local orphan the server doesn't know. Pull-before-seed still holds.
- **Open note** keeps the full Hocuspocus provider; the engine just hands it an **already-live**
  `Y.Doc` instead of creating one and awaiting `whenSynced`.

## 7. Auth

- **Vault-scoped token** — a variant of `tokens/sync-token.ts` scoped to `(userId, vaultId)` rather than
  one `doc_id`. The channel still ACL-filters **per doc** on fanout and backfill, so the token widens
  *connection* scope, not *data* scope. Fewer round-trips than per-doc mint for hundreds of docs.
- Minted from the same session; TTL reuses `SYNC_TOKEN_TTL_SECONDS`; refreshed like the per-doc token
  (`tokenRefresh.ts`).
- Per-doc tokens for the **open-note** Hocuspocus path are unchanged.

## 8. Config / env (server)

`REDIS_URL` (optional; unset ⇒ in-memory pub/sub, single instance) · `BACKFILL_CONCURRENCY` (6) ·
`VAULT_SYNC_PATH` (`/vault-sync`) · `HOT_DOC_CAP` (client-side, 100). Self-host default runs exactly as
today (Postgres only). `docker-compose.yml` gains an **optional** `redis` service under a compose
profile so it isn't started by default.

## 8b. Bulk engine (bootstrap + batch)

The channel above is the *live* path. It is the wrong shape for the two moments a
device has to move a whole vault at once — turning on sync for an existing local
vault, and joining a big team — where it costs a network round trip and, for
content, a WebSocket handshake **per note**. The bulk engine is the cold path for
exactly those two moments. It adds no new write rules: every item lands through
the same functions the single-item routes call (`registry/batch-ops.ts`,
`sync/doc-batch.ts`), so a batch and N singles produce the same rows and the same
refusal codes. Only the transport is removed.

### Registration — `POST /api/vaults/:vaultId/{folders,notes,files}/batch`

`{ items: [...] }` → `{ results: [...] }`, one result per item **in the caller's
order**, each `created | adopted | conflict | error` with a `code`
(`path_folder_mismatch`, `no_write_access`, `root_frozen`, `doc_id_conflict`).
Request-level refusals are 400 `invalid_body` / `batch_too_large`.

- Folders carry `path`, never `parentId`: the **server sorts the batch by depth
  and resolves parents in-request**, which is what deletes the client's
  level-by-level loop. A whole tree ships in one call, in any order.
- Notes carry `relPath` (+ optional `folderPath`), never `folderId`, for the same
  reason — no cross-chunk ordering hazard.
- The echoed `relPath` / `path` is the row's **canonical** spelling, exactly as
  the single routes echo it, so a device whose disk spells a path differently
  adopts ours instead of re-registering its own on every pass.
- Items run **autocommit on one pooled connection**, not one transaction per
  chunk: a `23505` on a same-path race is an *adopt*, and a transaction would
  turn it into a rollback of the other 199 items.
- One `registry` broadcast per request, and only if something actually changed.

### Content push — `POST /api/vaults/:vaultId/docs/batch`

`{ items: [{ docId, update /* base64 Yjs V1 */, expectEmpty? }] }` →
`{ results: [{ docId, status, code, error }] }`, status
`applied | skipped | conflict | denied | too_large | error`.

Three safety rules, in the order they bite:

1. **Per-item permission is the existing `effectivePermission`**, memoised per
   request and run at `BACKFILL_CONCURRENCY`, scoped to docs with a live row in
   *this* vault. Deliberately not a second, set-based "editable docs" query: a
   disagreement between two permission algebras would not surface as a 403, it
   would be a healing **loop** — the client is told a doc is empty, pushes, is
   refused, and `ready.empty` names it again on the next connect, forever.
   Anything that is not `edit` answers `denied` / `no_edit_permission`.
2. **`expectEmpty` is re-checked under the per-doc lock.** It means "I seeded
   this update from my local FILE because you told me the doc was empty". If the
   server's stored state now has content, the answer is `conflict` and nothing is
   applied — otherwise a slow client pastes a stale file over a teammate's live
   text. Without `expectEmpty` the update is an ordinary CRDT merge and applies
   unconditionally.
3. **`skipped` means the merge captured nothing**, i.e. the server already held
   every op. That is the idempotency proof: a retried push appends no row.

A live document is taken first (`hocuspocus.documents`), so a bulk push lands in
every open editor the same second, exactly like a teammate's keystroke; otherwise
the detached applier hydrates, applies, appends, publishes and re-indexes.
Ceilings: 16 MB body, `BATCH_MAX_DECODED_BYTES` decoded in total, and
`MAX_NOTE_MB` **in bytes** per item → `too_large`.

### Bootstrap download — `POST /api/vaults/:vaultId/bootstrap` + `GET …/:sessionId`

The POST takes `{ have?: string[] }` (docs the client already holds) and returns
`{ sessionId, docs, bytes, emptyDocs, emptyTruncated, expiresAt }`. It
**materialises** the caller's ACL-resolved doc list into `bootstrap_session_docs`
once, ordered by `rel_path COLLATE "C"`, which buys three things: every page
after it is an index-only keyset read instead of a re-run of the permission CTEs;
"exactly once across pages" is provable, because the set is rows rather than a
query that could move; and `bytes` is an honest progress denominator.

The split is the important part:

- **`docs` (stored bytes > 0) is the DOWNLOAD set.**
- **`emptyDocs` (readable notes the server holds nothing for) is the UPLOAD
  set** — the client seeds those from its own disk. Capped at 5,000 with
  `emptyTruncated`. This list is what lets a 5,000-note enable heal in **one**
  pass instead of three `ready.empty` rounds at the channel's 2,000 cap.

Only notes are in a session; a `files` row has no CRDT and its bytes travel
through the blob store.

The GET returns a gzip binary page (`application/vnd.baalda.bootstrap`), with
`X-Baalda-Cursor` (**absent ⇒ drained**), `X-Baalda-Docs`, `X-Baalda-Bytes`
(uncompressed) and an `ETag`. Layout, little-endian:

```
"BLDB" | ver u8=1 | flags u8=0 | docCount u32 | reserved u16
docCount × ( docIdLen u8 | pathLen u16 | updateLen u32 | docId utf8 | relPath utf8 | update )
```

Yjs **V1** only (the store is V1 — yjs#687 makes V2 merges unsafe); `flags` is
the reserved seam, and a decoder that meets an unknown flag refuses the page
rather than guessing. Pages read `doc_snapshots` and `doc_updates` inside ONE
`REPEATABLE READ` transaction, so a concurrent `compact()` cannot split a doc's
snapshot from its log; they merge with `Y.mergeUpdates`, never a `Y.Doc`. A doc
larger than a page ships alone. 410 `session_expired` past the TTL; 503 +
`Retry-After` `bootstrap_busy` past `BOOTSTRAP_CONCURRENCY`.

Measured on 5,000 synthetic notes (4.1 MB of CRDT state): session creation
115 ms, full drain 732 ms over 20 pages, 0.2 MB gzipped, **5 queries per page**
regardless of the doc count.

### Keyset pagination + `mode: "live-only"`

`GET /api/{notes,folders,files}?vaultId=&limit=&after=` → `{ …, nextAfter? }`,
ordered by path `COLLATE "C"`, with **tombstones on the last page only** (the
subtraction they exist for is meaningless against a slice). **Omitting `limit` is
today's exact behaviour** — every shipped client reads these listings as the
complete truth and deletes what is missing, so a default page cap would have an
old client remove every row past it.

A client that is pulling its cold state over the bootstrap routes sends
`mode: "live-only"` on the vault-channel `hello`. The server skips `backfill()`
and still sends `ready`: `empty` and `revoked` are what the client *acts* on and
cost one query and none respectively. `behind` may come back empty, because it is
a by-product of the backfill diff this mode skips — the bootstrap session's
byte-sized doc list answers the same question.

## 9. Phased rollout

- **A — PubSub seam.** `PubSub` interface + `InMemoryPubSub` + `RedisPubSub` (`ioredis`), env wiring,
  optional compose profile. No behavior change. Unit tests for both adapters.
- **B — Vault channel (server).** `/vault-sync` WS, vault token, manifest handshake + state-vector diff
  backfill, `onChange` → publish → ACL-filtered fanout, `drop` on revoke. Stateless relay.
- **C — Vault Sync Engine (client).** Per-vault connection, doc-state registry (persisted), update
  routing, backfill queue with priority + concurrency cap + jittered reconnect.
- **D — Headless bridge tiering.** Hot/cold tiers, LRU eviction, cold apply-transient-evict from SQLite,
  egest coalescing.
- **E — Open-note integration.** Opening promotes a live doc + attaches editor/presence; remove the
  content-blocking `whenSynced` await; retire sync-on-open in `docSession`.
- **F — HA.** Hocuspocus Redis extension for the open-note path; multi-instance deploy + rolling-deploy
  notes in `docs/DEPLOY.md`.
- **G — Tests + load.** Bridge tiering suites; a fanout/backfill integration test; a load harness
  simulating N vaults × M members to validate the per-vault-fanout claim.

## 10. Open defaults (override if wrong)

- **Hot-doc cap = 100** (LRU by open/edit recency). Tunable via `HOT_DOC_CAP`.
- **Vault-scoped token** (one per vault) over per-doc tokens for background sync — server still filters
  per doc.

Both are chosen for the launch tier and revisitable without reshaping the architecture.
