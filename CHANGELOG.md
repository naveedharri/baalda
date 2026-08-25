# Changelog

All notable changes to Baalda are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Public note links.** The share button now offers Private and Public: Public
  mints `https://<server>/p/<token>` — a server-rendered read-only page anyone
  with the link can open (images included, served token-scoped; never SVG).
  Revocable anytime from the same menu; revoked/unknown/deleted all serve one
  identical 404. New `public_links` table (migration 020) and an escape-first
  markdown renderer with no new dependencies.
- **Private links queue through sign-in.** A shared link opened while signed
  out now raises the sign-in dialog and opens the note right after auth; a link
  into a vault with no folder on the device parks on the folder prompt and opens
  once one is chosen. The wait for a first sync extends while sync is visibly
  working, and connectivity failures are named instead of implying no access.

### Changed
- Rebranded the project to Baalda (brand only; the internal
  "context" codename, storage identifiers, and bundle/keychain id are
  unchanged; see `docs/BRANDING.md`).

### Added
- Open-source project setup: Apache-2.0 `LICENSE`, `NOTICE`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `TRADEMARK.md`, and GitHub issue/PR
  templates.

## [0.1.30] - 2026-08-22

Access control, and the vault's shape.

### Added
- **Shareable note links.** A share icon in the note header copies
  `baalda://note/<vault>/<doc>`; opening it switches vault if needed and lands on
  the note. The link carries ids only, resolved against whoever opens it, and is
  keyed by `doc_id` so it survives every rename and move. Adds
  `tauri-plugin-deep-link` plus `tauri-plugin-single-instance`, so a click on
  Windows/Linux reaches the running app instead of starting a second one.
- **Private, at two scales** (`shares.permission = 'denied'`, migration 018) —
  the only row in the model that subtracts. Per-**member** it blocks one person
  and beats everything, authorship included. Per-**item** it takes a folder or
  note out of the team's reach, leaving only people shared with by name.
- **Freeze vault root** (Settings → General): a structural latch that closes the
  vault's top level to new folders and notes. Applies to everyone, lifted only by
  an owner/admin, and enforced on the HTTP registry *and* the MCP tools.
- **Reveal in Finder** on any note or folder in the sidebar (platform-labelled).
- `GET /api/vaults/:id/access-tree` — the vault's whole structure for the Access
  panel (owner/admin, ids and paths only, deliberately not ACL-filtered) so an
  item you have made Private stays administrable after its file leaves your disk.
- Item colours on the server (`folders.color` / `notes.color`), keyed by id.

### Changed
- **Access settings now apply to the person setting them.** The owner/admin and
  note-creator branches were shortcuts that ran before any grant was consulted,
  so a Read-only vault still let its owner edit and a Private folder still showed
  up for its author. Both are skipped under item-Private and under a Read-only
  vault. Managing shares stays role-gated, so an owner can always lift what they
  applied to themselves.
- **Losing access de-syncs the note from disk**, alongside the existing tombstone
  path. It only fires when the server actually answered about deletions, it moves
  the file to the vault's recoverable trash rather than destroying it, and it
  refuses any doc whose content the device never confirmed upstream. Revocations
  are capped separately from deletions and more loosely. Restoring access
  re-materialises the file.
- **Vault revert is owner *or* admin** — it is the recovery half of an action
  admins could already take.
- **Item colours sync to the team** and survive a rename; colours set before a
  vault gained sync are adopted upward once.
- The Access panel is a real tree: folders expand in place and pull their
  contents in on demand, which is what made the notes *inside* a folder reachable
  at all. Permission writes now say "Applying…" instead of appearing stuck.
- One popover select everywhere (`MenuSelect`, which `RoleSelect` now wraps),
  replacing the last native `<select>`; the freeze-root checkbox became an
  animated `Switch`; the account menu leads with **Home** instead of repeating the
  identity card its own trigger already shows.

### Fixed
- **Google sign-in failed with `account_not_linked` on any account created with a
  password.** Better Auth's `accountLinking.requireLocalEmailVerified` defaults to
  true and refuses to link while the local row is unverified — and with
  `requireEmailVerification` off, every password sign-up is unverified forever,
  which made the account-linking config dead code. Now set to false. Trade-off:
  without verification at sign-up an address can be squatted, so email
  verification remains the real fix and is still owed.
- The "who can access" list resolved through different branches than the enforcer
  and reported *No access* on a member's own note while the sync token granted
  edit. They now mirror each other.
- The Access panel's dropdown was clipped by the settings card, which becomes the
  containing block for `position: fixed` children because its entry animation
  keeps a `transform` applied. The menu is portalled to `<body>`.
- The Access item list no longer nests its own scroll region inside the settings
  page's, which sliced rows in half at the top edge.

## [0.1.0] - 2026-07-14

### Added
- Local-first desktop app (Tauri v2 + React/TS) with Markdown files as the
  source of truth.
- Markdown ↔ CRDT bridge (Yjs `Y.Text`) with echo-loop guards and convergence.
- Sync server (Hono HTTP + Hocuspocus WS + Postgres) for multi-device sync.
- Team collaboration: organizations, folder/file ACLs, presence, live cursors,
  attachments, locks, and join codes.
- MCP endpoint for AI clients, gated by the same per-file permissions.
- Local search (SQLite FTS5), backlinks, tags, and a graph view.
- Semantic search via a dependency-free hashed embedder.

[Unreleased]: https://github.com/naveedharri/baalda/compare/v0.1.30...HEAD
[0.1.30]: https://github.com/naveedharri/baalda/releases/tag/v0.1.30
[0.1.0]: https://github.com/naveedharri/baalda/releases/tag/v0.1.0
