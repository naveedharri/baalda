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
  `https://api.baalda.com`; desktop releases ship via `v*` tags → signed installers → Tauri updater.
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
  (server) + Vault panel (Vault Settings): create org, members, invite by email, pending/accept (client).
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

### Push-to-talk voice broadcast ✔
- [x] Hold-to-talk on the vault relay: 16 kHz mono PCM16 chunks ride a new binary frame
  (`VOICE_FRAME`) on `/vault-sync`, fanned out vault-wide via `PS_VOICE` like `member-joined`
  (audio is addressed to the team, and the vault token already proves membership). The speaker
  is stamped from the token, never trusted from the payload.
- [x] **Nothing is persisted** — no blob, no row, no file, no history. A chunk is played and
  dropped; a listener who was offline simply missed it. Adds no storage and no retention policy.
- [x] Capture `getUserMedia` → `AudioWorklet` → downsample → PCM16; playback schedules buffers
  back-to-back on an `AudioContext` cursor so the stream is gapless. Zero new dependencies:
  no Opus/wasm encoder, no `MediaRecorder` container problem, no WebRTC/SFU. The `fmt` wire
  field leaves room for a native WebCodecs Opus path later without a protocol change.
- [x] Per-speaker leaky-bucket rate limit on the relay (the channel had no abuse guard before).
- [x] Older clients are protected by a `hello` capability flag — a new *binary* frame would
  otherwise be misparsed as a doc update, and releases auto-update.
- **Milestone:** two teammates in one vault, one holds the talk button, the other hears them
  live with nothing written to disk on either side. ✔ (unit-tested end to end through the relay;
  real-hardware audio between two machines still unverified)
- **Known limitation (narrowed):** note **content** is no longer TTL-bound — member removal and
  org deletion now publish `acl-changed`, so a removed member's readable set empties at once and
  every doc is dropped. What remains is the vault-**wide** frames that are deliberately not
  doc-gated (voice, `member-joined`): the socket itself survives, so a removed member can still
  hear audio and see joins until it drops or their vault token expires (≤600s). Closing that
  needs a `PS_MEMBER_REMOVED` frame each connection self-terminates on.
- Specs: [[05-vault-sync-engine]] (transport), [[04-team-collaboration]] (membership gate)

### Access & vault shape ✔ (v0.1.30)
Six changes that together make a vault something a team can actually govern.
- [x] **Access panel is a real tree.** Folders expand in place and pull their contents in on demand
  (the sidebar loads folders lazily, so a flat list could only ever show what someone had already
  clicked elsewhere) — which is what made the notes *inside* a folder reachable for the first time.
  Row-building lives in `lib/accessTree.ts` so the "an un-listed folder is expandable, not empty"
  rule is pinned by a test.
- [x] **Private, at two scales.** A new `shares.permission = 'denied'` row (migration 018) — the
  only row in the model that SUBTRACTS. Per-**member** (`principal_type 'user'`) it blocks one
  person and beats everything, authorship included. Per-**item** (`principal_type 'org'`) it takes
  a folder or note out of the team's reach, leaving only the people shared with by name — which is what finally made item-Private work at all: clearing an item's own grants left
  the vault-wide grant still reaching it, so Private snapped straight back to Shared. Both are
  mirrored in the readable-set dual. See [[04-team-collaboration]] §3.
- [x] **Access settings apply to the person setting them.** The owner/admin and note-creator
  branches were shortcuts that ran *before* any grant was consulted, so a vault set to Read-only
  still let its owner edit and a folder set to Private still showed up for them — the one person
  who couldn't check their own restriction was the one who made it. Both shortcuts are now skipped
  under item-Private and under a Read-only vault, so the posture is a ceiling for everyone; a
  folder marked Shared, or naming yourself in the per-member list, is the way back out. The panel's
  "who can access" list now resolves through the same branches as the enforcer — the two disagreed
  on a member's own note, and a list that contradicts what it describes is worse than no list.
- [x] **Losing access de-syncs the file.** A revocation used to leave the `.md` on the ex-reader's
  disk, which made it cosmetic — they could open the note in any editor forever. It now moves to
  the vault's trash on every device that had it, alongside the existing tombstone path, with three
  rails: it only fires when the server actually answered about deletions (`tombstones !== null`),
  it trashes rather than destroys, and it refuses any doc whose content this device never confirmed
  upstream, so a permission change can't take work that exists nowhere else. Revocations are capped
  separately from deletions and more loosely — a whole shared folder leaving at once is ordinary,
  a mass delete rarely is. An ACL change now also triggers the registry re-pull that carries this
  out, so it lands in seconds instead of waiting for a restart. Restoring access re-materialises
  the file and it hydrates on open — a permission toggle is never a one-way door.
- [x] **The Access list reads the server's structure, not this machine's disk.** New owner/admin
  endpoint `GET /api/vaults/:id/access-tree` (ids and paths, no content, deliberately not ACL
  filtered). Every other listing is filtered, which is right for sync and fatal for administration:
  once Private removed the file, the panel — which drew its rows from the disk — lost the only row
  the restriction could be lifted from. Kept as a separate endpoint rather than a flag on the sync
  listings, because an unfiltered response reaching the reconciler would have it materialise notes
  it has no right to sync. Management stays role-gated
  (`canManage`) so an owner can always undo what they applied to themselves. Note this governs
  **sync, not disk**: losing access has never deleted anyone's local `.md` files, so the items stay
  in your own sidebar — they just go read-only/no-access and leave every teammate's vault.
- [x] **Permission writes narrate themselves.** Applying a mode is several round trips plus a socket
  kick; the panel now says "Applying…" instead of looking stuck.
- [x] **Reveal in Finder** on any note/folder — notes really are files on disk, so the shortest
  bridge to the rest of the machine belongs in the context menu.
- [x] **Freeze vault root** (General settings). A structural latch, not a permission: once the top
  level is settled, nothing new lands beside it — for everyone, owners included, because the
  accidental root folder is nearly always created by someone who does have permission. Only
  owner/admin lifts it. Enforced on the HTTP registry AND the MCP tools; re-registering a root item
  that predates the latch still works, so freezing can't break sync.
- [x] **One popover select, everywhere.** The Access panel's per-member picker was the last native
  `<select>` in the product; it now uses the Members page's popover (`MenuSelect`, which `RoleSelect`
  is also a wrapper over). The Freeze-root checkbox became an animated `Switch` — a setting like
  that is a decision, and a knob that slides confirms it landed.
- [x] **Account menu leads with Home.** The popover's top row was a second copy of the identity
  card that its own trigger already shows permanently in the sidebar footer. Home takes that row
  instead; it was previously below the fold on an account with several vaults.
- [x] **Shareable note links.** `baalda://note/<vault>/<doc>` via `tauri-plugin-deep-link`
  (+ single-instance, so a click on Windows/Linux doesn't spawn a second app). The link carries
  **identity, not access** — ids only, resolved against whoever opens it — and is keyed by `doc_id`,
  so it survives every rename and move.
- [x] **Vault revert is owner *or admin*.** It's the recovery half of an action admins could already
  take; owner-only left a team whose owner was away able to take checkpoints and not use them.
- [x] **Item colors sync.** `folders.color` / `notes.color` ride the registry pull, keyed by id so a
  rename keeps the tint. Colors set before a vault gained sync are adopted upward once.

### Google sign-in on an existing password account ✔ (v0.1.30)
- [x] `account_not_linked` on the Google callback for anyone who first signed up with a password —
  i.e. everyone except users created *through* Google, who had nothing to link. The cause was a
  Better Auth default, not our code: `accountLinking.requireLocalEmailVerified` is **true** unless
  set, and it refuses to link while the local row is unverified. `requireEmailVerification` is off
  (no email round-trip in the MVP), so every password sign-up has `emailVerified = false` forever
  — which made the `accountLinking` block dead code from the day it was written.
- [x] Set `requireLocalEmailVerified: false`. **A knowingly-taken trade:** the check exists because,
  with no verification at sign-up, someone can register an address they don't own, and linking then
  joins the real owner to the squatter's account rather than locking them out. Accepted because the
  squat is already possible without linking and Google's verified email is the strongest signal we
  have. **Email verification at sign-up is the real fix** and is still owed.
- [x] Pinned by a config test — the failure mode was a silent default, so the three options that
  have to agree (`enabled`, `trustedProviders`, `requireLocalEmailVerified`) are asserted together.

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
