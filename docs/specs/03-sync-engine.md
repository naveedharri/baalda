---
type: spec
spec: 03-sync-engine
product: Baalda
status: draft-v1
date: 2026-07-13
tags: [baalda, spec, sync, yjs, crdt, hocuspocus, bridge]
---

# 03 · Sync Engine

The heart of the product. Real-time collaboration + local-first offline + the file↔CRDT bridge that
reconciles plain markdown with the CRDT. This is where all the hard problems live — build it early,
test it hard. Overview: [[00-architecture-overview]]. Storage: [[02-database-architecture]]. Index: [[Baalda]].

---

## 1. Decisions

| Concern | Choice | Reasoning |
|---|---|---|
| CRDT library | **Yjs** | Production default; the *only* option with mature editor bindings (`y-codemirror.next`) and self-hostable servers we can reuse. Loro is faster/smaller but we'd write bindings ourselves; Automerge is slower and history-heavy; Collabs isn't a contender. |
| CRDT model | **`Y.Text` holding raw markdown** | Lossless file round-trip; trivial bridge; makes AI-edits-a-real-file correct. Structural `Y.XmlFragment` deferred to Phase 4 WYSIWYG. |
| Sync server | **Hocuspocus** (Node, MIT) + Postgres | `onAuthenticate`/`onLoadDocument`/`onStoreDocument`/`readOnly` hooks give auth + persistence + presence out of the box; colocates with the Better Auth TS server. |
| Local persistence | Yjs updates in **SQLite** (desktop) / `y-indexeddb` (web) | Offline edits + instant reload. |
| Transport | WebSocket via `@hocuspocus/provider` | Standard Yjs sync protocol; provider is swappable (y-sweet later without client rewrite). |
| Alternative (documented) | **y-sweet** (Rust, S3-backed) | Exactly what Obsidian Relay forked; native per-doc client tokens; pick it later if we want zero doc-DB ops or hit Node scale. |

We do **not** use: Liveblocks (hosted lock-in), PartyKit (Cloudflare-shaped self-host), ElectricSQL/
PowerSync (Postgres-sync, *not* a text CRDT — wrong layer). We do **not** hand-roll the WebSocket +
update log — Hocuspocus/y-sweet already are that.

## 2. Document model

- **One `Y.Doc` per note**, `doc_id` == the note's stable id (see [[02-database-architecture]]). One
  doc per file keeps auth and loading simple (authorize a `doc_id`, load one doc).
- Each doc holds a single **`Y.Text`** = the raw markdown body. (Frontmatter can ride in the same
  `Y.Text` as literal `---` blocks for MVP; a separate `Y.Map` is a later refinement.)
- The document *name* on the wire encodes scope: e.g. `vault:{vaultId}/note:{docId}`, so the server
  can authorize at the folder/vault level with one membership check (see [[04-team-collaboration]]).

## 3. The Yjs sync protocol (how clients converge)

Standard Yjs `y-protocols`:

1. **SyncStep1** — client sends its **state vector** (a compact `{clientId → clock}` of what it
   already has).
2. **SyncStep2** — server replies with *only* the missing structs + delete set relative to that
   state vector (a diff, not the whole doc). A brand-new client (empty state vector) gets the full
   compacted snapshot; a returning offline client gets only the delta.
3. **Updates** — thereafter, each edit flows as an incremental binary `update` message.

**Persistence + compaction (server):** append every `update` to `doc_updates`; when the log exceeds
N, merge via `Y.mergeUpdates` (or load + `Y.encodeStateAsUpdate`) into one `doc_snapshots` row and
truncate. Serve the snapshot first on first load, then stream deltas. Store **binary Y.Doc only**.

**Awareness/presence** rides the same socket as a separate ephemeral CRDT that is **not persisted** —
see [[04-team-collaboration]] §presence.

## 4. Local-first & offline

Compose two providers on each client (Yjs providers are meshable — run both at once):

- **Local persistence** (`SQLite`/`y-indexeddb`): hydrates the doc instantly on open; the editor
  works fully offline.
- **Network provider** (`@hocuspocus/provider`): syncs to the server when connected.

Offline edits accumulate locally. On reconnect, the SyncStep1/2 exchange merges them **conflict-free**
— no manual merge, no "resolve conflict" dialog. That is inherent to the CRDT. Reconnect uses backoff;
tokens are refreshed (see §7).

## 5. The file ↔ CRDT bridge (the make-or-break piece)

This is the algorithm that lets plain markdown and the CRDT coexist. Two guards make it safe:
**origin tags** (never react to a change you caused) and a **`lastWrittenHash`** per note (the watcher
ignores the exact bytes it just produced).

Three transaction origins matter: `'disk'` (applied because the file changed), `'editor'` (local user
typing), `'remote'` (arrived from the network provider).

```
STATE per note:  yText, lastWrittenHash

A. DISK → CRDT   (file changed by AI, external editor, git, or our own egest)
   on watcher event (debounced ~150ms, drain a dirty-set):
     fileText = read(path)
     if sha256(fileText) == lastWrittenHash:        # this is our own write echoing back
         return                                     #   → DROP. breaks the loop.
     patches = diff_match_patch(yText.toString(), fileText)
     doc.transact(() => applyPatchesAsInsertDelete(yText, patches), 'disk')

B. CRDT → DISK   (edit from local editor OR from a remote peer)
   yText.observe(evt):
     if evt.transaction.origin == 'disk':           # we caused this from the file; don't write back
         return                                      #   → DROP.
     debounce(~300ms):
       content = serialize(yText)                    # for Y.Text-of-markdown this is just yText.toString()
       lastWrittenHash = sha256(content)             # set BEFORE writing, so A's guard sees it
       atomicWrite(path, content)                    # temp file + rename
       reindex(path)                                 # update SQLite FTS5 / links / tags
```

**Why the loop closes:** B's write triggers A's watcher, but because B set `lastWrittenHash` *before*
writing, A hashes the file, matches, and drops it. (This is YAOS's "content-acknowledged suppression"
and memrynote's origin-parameter mechanism.)

**Why concurrent edits are safe:** both a remote update and a local file change funnel into the same
`Y.Text` as **operations**, so Yjs merges them. We must **never blindly overwrite `Y.Text` from the
file** — always diff into it. The only residual risk is two edits interleaving into locally-invalid
markdown syntax; we accept CRDT merge as MVP behavior and keep note snapshots for recovery.

**Diff frequency matters.** `diff-match-patch` produces clean minimal patches only when called
often on small changes; a giant one-shot diff merges badly against concurrent edits (Automerge's
`updateText` docs warn the same). So: debounce ingest short, keep AI edits localized, and diff against
the CRDT's *current* serialization (never a stale copy) to avoid cursor-yanking re-inserts.

**Startup ordering (prevents split-brain):** on sign-in, **pull from the server first, then seed any
orphan docs from local markdown.** Reversed, stale disk content seeds a doc with a fresh clientID, the
server's SyncStep skips bootstrap, and the device diverges permanently. (memrynote calls this out.)

**Lifecycle ops** (create/rename/delete) are handled as metadata operations keyed by `doc_id`, not by
content diff — a rename must never fork a doc. See [[02-database-architecture]] §5.

## 5b. Editing the vault from outside the app (AI agents, scripts)

The vault folder is a normal folder of `.md` files, and editing it from outside the app is a
supported way to use Baalda — that is the whole point of the bridge. All four filesystem verbs
are safe while the app is open on a synced vault, and each reaches the team live:

| What you do on disk | What happens |
|---|---|
| **Create** a `.md` file | Unmapped path ⇒ a debounced registry pull registers it as a new note and uploads its content. |
| **Edit** a `.md` file | Diff-merged into the note's `Y.Text` as operations (never an overwrite) and pushed, so it merges with whatever a teammate is typing. |
| **Delete** a `.md` file | Propagated as a real soft delete after a **2.5 s grace window**: the note leaves the server and every teammate's device trashes its copy. Your own copy of the text is kept in `.context/trash/<timestamp>/`. |
| **Rename or move** a `.md` file | Recognised as a rename, so the note keeps its `doc_id` — its history, its backlinks, and its shares all survive. |

The grace window exists because a vanished file is not yet a delete: an editor that saves by
unlinking and rewriting, a rename (which the OS reports as two unrelated events), and a
`git checkout` that is about to restore the file all look identical for a few milliseconds. Inside
the window a re-appearing file cancels the delete, and a file whose content matches a note that
just vanished is paired with it as a rename.

Three deliberate refusals, all of them protecting notes you did not mean to lose:

- **A 0-byte file never clears a note.** Emptying a file completely is refused as an ingest (a
  *partial* truncation is a normal edit and applies). Writing an empty placeholder is something
  the app itself does when it materializes a note it hasn't downloaded yet, and treating that as
  an edit would delete the note's content for everyone.
- **A mass disappearance is never propagated.** More than a fifth of the vault vanishing in one
  window (minimum five notes) abandons the whole batch and reports it, because an unmounted
  volume, an evicted cloud folder or a branch switch looks exactly like a bulk delete.
- **A note this device never finished uploading is never deleted from the server.** The only copy
  of that work might be the one you just removed.

Two things stay off-limits to outside writers:

- **`.context/` is the app's own state** (`index.sqlite`, the CRDT store, `config.json`, the local
  trash). It is excluded from the tree walk, the watcher and the index. Never write there, and
  never restore a trashed note by moving it back — copy its text into a new note instead, or the
  restored file re-registers as a brand-new note.
- **Deletes at startup are not propagated.** Until the vault channel is connected *and* a structure
  pull has completed, a missing file is read as "the disk isn't ready yet" and the note is
  re-materialized (with its content, when this device has it) rather than deleted.

For a *scripted* or agent-driven workflow that needs confirmation of each write rather than
fire-and-forget filesystem semantics, use the MCP server instead ([[04-team-collaboration]]): its
tools carry revisions, optimistic-concurrency checks and idempotency keys, and they broadcast the
same way a teammate's edit does.

## 6. Test plan for the bridge (non-negotiable before Phase 2)

- **Golden round-trip:** a corpus of markdown files → into `Y.Text` → serialize → byte-identical out.
- **Echo-loop:** every CRDT→file write must produce zero follow-on CRDT ops.
- **Concurrent edit:** simultaneous local-editor edit + external-file edit converge without loss.
- **AI whole-file rewrite:** a coarse external rewrite during a concurrent local edit is recoverable
  (snapshot exists) and does not clobber silently.
- **Reconnect/offline:** edit offline on two clients, reconnect, both converge.

## 7. Auth & per-document authorization (summary; detail in [[04-team-collaboration]])

- After login (Better Auth session), the client requests a **short-lived per-doc JWT** (`{doc_id,
  readOnly, exp:+10m}`) from our API for each doc it wants to sync.
- The provider passes the token on connect; Hocuspocus verifies it in **`onAuthenticate`**, looks up
  effective permission, and sets `connection.readOnly = true` for view-only grants (server silently
  rejects updates) or throws for no access.
- Scope tokens by folder/vault so one membership check gates every file under a shared folder.
- Short TTLs make revocation near-instant; on unshare we also disconnect live sockets for an instant
  kill. (Note: Hocuspocus historically did not re-auth on reconnect — mint sensible TTLs + refresh.)

## 8. OSS references

- **Obsidian Relay** (`github.com/No-Instructions/Relay`, MIT) — the north-star product: Yjs +
  (forked) y-sweet, local-first, share-a-folder. Take the product shape and folder-scoping.
- **Hocuspocus** (`github.com/ueberdosis/hocuspocus`, MIT) — the server; `onAuthenticate`,
  `onLoadDocument`/`onStoreDocument`, `readOnly`, presence. Obey "store binary Y.Doc only."
- **memrynote** (`docs.memrynote.com/architecture/crdt`) — the bridge: origin tagging, single-writer,
  pull-before-seed ordering, y-leveldb, markdown-nesting preservation markers.
- **YAOS** (`github.com/kavinsood/yaos`) — the bridge: per-file `Y.Text`, dirty-set draining,
  content-acknowledged suppression.
- **Inkeep OpenKnowledge** — dual-observer Yjs↔markdown byte-faithful sync + MCP AI edits.
- **y-protocols / y-sweet / y-indexeddb / y-codemirror.next** — sync protocol, S3 server alternative,
  offline persistence, editor binding. Reuse directly.
- **crdt-benchmarks** (`github.com/dmonad/crdt-benchmarks`) — to re-validate Loro vs Yjs later.

## 9. MVP build order (sync)

1. Yjs `Y.Doc` + CodeMirror binding; two browser tabs editing one `Y.Text` live (no persistence).
2. Add local persistence (`y-indexeddb`/SQLite) → reload + offline work locally.
3. Stand up Hocuspocus + Postgres locally → real-time across machines; binary `doc_updates`/
   `doc_snapshots` + compaction.
4. Add JWT auth in `onAuthenticate` + folder-scoped authz + `readOnly`.
5. **Build the file↔CRDT bridge (§5)** on the desktop client with loop avoidance; run the full test
   plan (§6). This is the gate to everything real.
6. Add awareness (cursors/presence).
7. Harden: reconnect/backoff, snapshot/compaction job, markdown round-trip tests in CI.

**Deferred:** Loro migration, per-keystroke version history, y-sweet/edge deploy, AI-as-CRDT-peer.
