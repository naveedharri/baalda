---
type: product-spec-index
product: Baalda
brand: Baalda
status: phases-0-3-complete · phase-4-planned
date: 2026-07-13
tags: [baalda, second-brain, spec, build-from-scratch]
---

# Baalda

**Context** is the product an owner buys: the shared, always-current context your team *and* your
AI both work from. **Baalda** is the brand. This folder is the build spec: what we are building,
why, the chosen stack, and the live status.

> [!success] The one-line pitch
> An Obsidian-like, local-first "second brain" where your notes are plain `.md` files an AI can edit
> directly **and** your team edits them together in real time. Every existing OSS tool does one or
> the other. We built the tool that does both.

---

## The goal

Build **Baalda** from scratch, smallest-useful-thing first, nothing fancy. We reuse *patterns and
architecture* from open-source projects (Noteriv, OpenKnowledge, Relay, Hocuspocus, Better Auth)
but write our own code. We do not ship other people's code.

The seed research scanned 41 OSS Obsidian-like apps
against **12 requirements** and found **none satisfies all 12**. Those 12 are now our product
requirements. See [[REQUIREMENTS]] for the full list and how each maps to a spec and phase. The
reason no tool passed is structural, not a gap in the market:

- **AI-editable plain `.md`** needs loose markdown on disk as the source of truth.
- **Real-time collaboration** is always built on CRDTs (Yjs), whose state is an opaque binary blob.

Those two are mutually exclusive across every candidate. The decision was never "which tool". It
was "which half do we build". We build the bridge between them. That bridge is the whole product.

---

## The crux (read this first, it is the entire design)

`.md` files on disk are the **durable source of truth** (what the user, the AI, and git touch).
A per-note **Yjs `Y.Text` holding the raw markdown string** is the **live source of truth** while a
note is open or syncing. A **bidirectional bridge** keeps them equal:

- **file → CRDT:** watcher fires → diff old-vs-new text → apply as `Y.Text` ops in an origin-tagged
  transaction. Yjs merges it with any concurrent remote edits.
- **CRDT → file:** Yjs update event (debounced) → serialize `Y.Text` to markdown → atomic write,
  recording a `lastWrittenHash` so the watcher ignores its own write (breaks the echo loop).

Because both directions funnel into the same CRDT as *operations* (never whole-file overwrites), a
human typing and an AI rewriting a paragraph **merge** instead of clobbering. Using
`Y.Text`-of-markdown (not a structural CRDT) makes "AI edits a real file" trivially correct and the
round-trip lossless. Full detail: [[03-sync-engine]].

---

## The stack (decisive)

| Layer | Choice |
|---|---|
| Desktop shell | **Tauri v2** (Rust core; native iOS/Android from the same core) |
| UI | **React + Vite + TypeScript** |
| Editor | **CodeMirror 6** (`@codemirror/lang-markdown`); the buffer *is* the file |
| File tree | **react-arborist** (virtualized) |
| Filesystem | **Rust** `std::fs`/`tokio::fs` + debounced watcher |
| CRDT | **Yjs**, `Y.Text`-of-markdown |
| Local index | **SQLite** (FTS5 search + backlinks + tags), derived/rebuildable |
| Sync server | **Hocuspocus** (Yjs, Node) + **Postgres** |
| Auth + teams | **Better Auth** (organization plugin) + argon2id + server sessions |
| Permissions | folder ACL (view/edit, additive, highest-wins) gating per-doc sync tokens |
| Presence | Yjs **awareness** (live cursors + "who's here") |

---

## The specs

| Spec | Covers |
|---|---|
| [[REQUIREMENTS]] | The 12 core requirements + supporting features, each mapped to a spec and phase (the yardstick) |
| [[00-architecture-overview]] | How the four pillars fit; the md↔CRDT bridge; full data-flow diagram; principles |
| [[01-desktop-app]] | Tauri 2 shell, React/CM6, react-arborist, the Rust command surface, editor UX |
| [[02-database-architecture]] | On-disk vault layout, local SQLite index schema, server Postgres + Yjs binary stores |
| [[03-sync-engine]] | Yjs + Hocuspocus, the Yjs sync protocol, the file↔CRDT bridge algorithm + loop-avoidance |
| [[04-team-collaboration]] | Better Auth org model, folder ACL, how permissions gate the sync engine, presence |
| [[05-vault-sync-engine]] | Vault-wide always-on background sync; stateless relay + pluggable PubSub (Redis for HA); bridge tiering |

---

## Deployment

Self-hosting and production deployment (Docker, Railway, env vars, the single-port `/sync`
topology) are covered in [[DEPLOY]]. The managed backend is live at `https://api.baalda.com`;
the desktop app points at it (or at any self-hosted instance) via the server URL in Settings.

Cutting a desktop release — the `v*` tag flow, updater vs. OS code signing, and the
macOS notarization setup — is covered in [[RELEASE]].

---

## Status

See [[STATUS]] for the live build checklist.

- **Now:** Phases 0 through 3 are complete and wired end-to-end: local app, CRDT bridge, sync
  server, and team collaboration, plus MCP, locks, join codes, semantic search, and a graph view.
- **Next:** Phase 4 polish and launch decisions (WYSIWYG, vector search, OAuth, iOS).

---

## Guiding principles

1. **Files are sacred.** `.md` on disk is the source of truth. Any DB/CRDT is a derived, rebuildable
   layer. If we lose the server tomorrow, the user still has their vault.
2. **The bridge is the product.** Everything hard lives in file↔CRDT reconciliation. Build it early,
   test it hard (golden round-trip tests, echo-loop tests, concurrent-edit tests).
3. **Smallest useful thing first.** Ship a single-user local Obsidian-lite before any networking. Each
   phase is independently useful.
4. **Rust owns disk; UI is stateless about files.** The web UI never touches the filesystem. It
   calls typed Rust commands and subscribes to events.
5. **Reuse patterns, not code.** Study the OSS references, own our implementation.
6. **Self-hostable, no vendor lock-in.** Everything runs on our infra (Tauri + Node + Postgres).
