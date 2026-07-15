---
type: status-tracker
product: Baalda
date: 2026-07-13
tags: [baalda, status, roadmap]
---

# Baalda: Build Status

> Live checklist. Update as phases land. Back to index: [[Baalda]].

## Where we are

- **Specs:** ✅ Complete (2026-07-13); see `specs/` (requirements yardstick: [[REQUIREMENTS]]).
- **Build:** 🟢 Phases 0–3 complete. Server (auth + ACL + sync + attachment blob store)
  and desktop (bridge + auth + per-doc sync + presence + sharing UI + attachment sync)
  are wired end-to-end and tested.
- **Deployment:** 🟢 Production-ready (2026-07-15). The sync WebSocket is served on the HTTP
  port at `/sync` (single-port topology), and the repo ships a Dockerfile, `railway.json`
  (pre-deploy migrations + healthcheck), and [[DEPLOY]]. The managed backend is live at
  `https://api.baalda.com`; desktop releases ship via `v*` tags → GitHub Releases → Tauri updater.
- **Next action:** Phase 4 polish / launch decisions (WYSIWYG, vector search, OAuth, iOS).

> **Requirement coverage:** Phases 0–3 deliver **10 of the 12** core requirements,
> including the two no OSS tool combined (#7 AI-editable plain files + #11 built-in real-time collab).
> Deferred: #8 iOS (Phase 4) and #12 open source (a launch/business decision). Full map: [[REQUIREMENTS]].

---

## Build order

Each phase is independently useful and ships something real. Do not start a phase before the prior
one is solid. In particular, do not add networking (Phase 2) before the bridge (Phase 1) is tested.

### Phase 0: Single-user local app _(no CRDT, no server)_ ✅
Smallest useful product: an Obsidian-lite over a local folder of `.md`.
- [x] `create-tauri-app` scaffold (React + Vite + TS). Build on macOS first.
- [x] Rust command surface: `pick_vault`, `list_tree`, `read_note`, `write_note`, `start_watcher`.
- [x] react-arborist file tree fed by `list_tree`, refreshed on watcher events.
- [x] CodeMirror 6 editor (`@codemirror/lang-markdown`); debounced autosave → `write_note`.
- [x] External-edit reload: `file-changed` event reloads the open note.
- [x] SQLite index: `notes` + `notes_fts` (FTS5) + `links` (backlinks) + `tags`. Rebuild on change.
- [x] New/rename/delete note + folder.
- **Milestone:** open a vault, edit a note, save to disk, external edit shows up, search works.
  **AI-editable is free here**: any BYOK LLM edits the `.md` and the watcher reflects it.
- Specs: [[01-desktop-app]], [[02-database-architecture]]

### Phase 1: Local CRDT bridge _(still single-user)_ ✅
De-risk the hardest part before networking.
- [x] One `Y.Text` Y.Doc per note; persist Yjs updates in SQLite.
- [x] file → CRDT ingest (diff-match-patch, origin-tagged transaction).
- [x] CRDT → file egest (debounced serialize + atomic write + `lastWrittenHash`).
- [x] Echo-loop suppression + debounce on both sides.
- [x] Golden markdown round-trip tests; echo-loop test; concurrent file+CRDT edit test.
- **Milestone:** editing through the CRDT and editing the file externally both converge, no loops.
- Specs: [[03-sync-engine]]

### Phase 2: Sync server _(multi-device, single user)_ ✅
- [x] Hocuspocus server + Postgres; store binary Y.Doc only (`doc_updates` + `doc_snapshots`).
- [x] Client network provider (`@hocuspocus/provider`) alongside local persistence (`lib/sync`).
- [x] Better Auth: accounts, email+password (argon2id), server-side sessions; token in OS keychain
  (Rust `keyring` crate, service `com.baalda.context`; `lib/auth` + `lib/api`).
- [x] `users` / `sessions` / `vaults` / `notes` tables; join notes↔docs on `doc_id` (registry
  reconcile writes the server vault id + doc-id map to `.context/config.json`).
- **Milestone:** two of my own devices converge on the same vault through the server. ✔ (proven by the
  env-gated client↔server integration test: two providers converge).
- Specs: [[03-sync-engine]], [[02-database-architecture]], [[04-team-collaboration]]

### Phase 3: Team collaboration ✅
- [x] Better Auth organization plugin: `organization` / `member` / `invitation`; roles owner/admin/member
  (server) + Workspace panel: create org, members, invite by email, pending/accept (client).
- [x] Folder ACL (`folder` / `file` / `share`): view/edit, additive, folder-inherited, highest-wins
  (server) + folder/file Share dialog on right-click (client).
- [x] `/sync-token` endpoint mints short-lived per-doc tokens; Hocuspocus `onAuthenticate` + `readOnly`
  enforce; client mints per doc, refreshes before expiry, and makes the editor read-only for view grants.
- [x] Yjs awareness: live cursors (y-codemirror.next + CSS) + "who's viewing this note" avatars;
  deterministic per-user color.
- [x] Attachment blob store: Postgres **BYTEA** store for v0.1 (S3/R2 via the reserved
  `storage_url` is a production upgrade). Session-authed vault blob routes (upload w/ server-side
  sha256 + per-vault dedupe, list, download), path-validated Rust binary I/O, and a content-hash
  client sync that mirrors `attachments/` both ways (debounced on watcher events; never CRDT-indexed).
  Server snapshot compaction ✔; resumable sync cursors N/A (Yjs SyncStep1/2 + backoff cover reconnect).
- **Milestone:** invite a teammate, share a folder as edit, both see live cursors; unshare cuts sync.
  ✔ (integration test: invite→accept→file share→view-only client's writes rejected; server force-closes
  sockets on revoke).
- Specs: [[04-team-collaboration]]

> **Phase 2+3 client startup ordering (spec 03 §5):** when signed in, the doc-open path pulls the
> server's state FIRST (bridge opens with `seedFromFile:false`), waits for initial sync, then seeds a
> local orphan only if the doc is still empty, preventing split-brain. Remote provider edits DO egest
> to the local `.md` (only `'disk'`-origin changes are dropped).

### Phase 4: Polish / upgrades _(deferred)_ ⬜
- [ ] Structural rich-text CRDT (y-prosemirror / `Y.XmlFragment`) for full WYSIWYG.
- [ ] Vector / hybrid search (Orama) for semantic + AI retrieval.
- [ ] AI-as-CRDT-peer for live collaborative sessions.
- [ ] libSQL at-rest encryption; OAuth / social login (Tauri PKCE deep-link).
- [ ] **iOS app** (Tauri 2, same Rust core) as a dedicated milestone.

---

## Open decisions / risks to revisit

- **Sync backend:** committed to **Hocuspocus** for v0.1 (all-TS, colocates with Better Auth). Revisit
  **y-sweet** (Rust, S3-backed, what Relay forked) if we want zero doc-DB ops or hit Node scale limits.
- **CRDT model:** `Y.Text`-of-markdown for v0.1. Move to structural `Y.XmlFragment` only when WYSIWYG
  is a product requirement (Phase 4); it reintroduces lossy markdown serialization.
- **Bus-factor of references:** Noteriv/memrynote/YAOS are solo-maintainer projects. We study them,
  we don't depend on them. Hocuspocus/Better Auth/Yjs are the funded, safe dependencies.
- **Yjs at scale:** some teams report pain; not a v0.1 concern. Loro is the re-evaluation candidate
  if on-disk CRDT size becomes a cost.
