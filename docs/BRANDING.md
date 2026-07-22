---
type: policy
product: Baalda
status: active
date: 2026-07-14
tags: [baalda, branding, rebrand, policy]
---

# Branding Policy

How the brand name and the permanent internal identifiers relate, and exactly what may and may not
change on a future rebrand. Read this before touching anything that says "Baalda" or "context".

## Why this exists

The project has already been renamed once. The first time around, the brand
name had leaked into the database user/password, the Postgres container and volume names, the vault's
hidden directory, localStorage keys, env var names, the JWT issuer, the MCP server name, and the
keychain service. A rename therefore meant chasing the brand through data, not just docs and UI strings.
That must never happen again. Every identifier that touches storage, protocols, or on-disk state now
uses the permanent codename **"context"**, never the brand. Only three layers exist; a rebrand touches
exactly one of them.

## Layer 1, BRAND ("Baalda"): cheap to change

The brand name may appear **only** in these places. A rebrand touches this list and nothing else:

- All prose in `docs/**` and this file.
- Root community files: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `TRADEMARK.md`, `NOTICE`,
  `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `LICENSE` copyright line.
- `.github/**` (issue templates, PR template, `workflows/release.yml` release name/URLs).
- `ee/README.md`, `ee/LICENSE`.
- `app/apps/desktop/src-tauri/tauri.conf.json`: `productName` and window title.
- `app/apps/desktop/index.html`: `<title>`.
- `app/apps/desktop/src/lib/brand.ts`: the single brand-constants module; all desktop UI strings
  import the brand name from here, never hardcode it.
- `app/apps/server/src/brand.ts`: the single brand-constants module for any server-emitted strings
  that are allowed to show the brand (e.g. email templates), never protocol identifiers.
- `app/apps/desktop/src-tauri/src/commands.rs`: the user-visible managed notes root folder constant
  (`~/Baalda`).
- `app/apps/desktop/src-tauri/Cargo.toml`: `description` / `authors`.
- The GitHub repo name and its URLs (`github.com/naveedharri/baalda`).

**Rule: a rebrand touches only this list.** If you find the brand name anywhere else, that is a bug.
Move it into `brand.ts` (or the docs equivalent) and reference it from there.

## Layer 2, NEUTRAL codename "context": permanent, never rebrand

"Context" is the permanent internal codename for the product idea (the shared, always-current context
your team and your AI work from). It is brand-independent by design and must **never** be replaced by
the brand name. Everywhere it appears:

- Postgres: user `context`, password `context`, database `context`, container `context-pg`, volume
  `context_pgdata`.
- `DATABASE_URL`: `postgres://context:context@localhost:5439/context`.
- Vault-internal hidden directory: `.context/` (holds `index.sqlite`, `config.json`, the local CRDT
  store).
- `localStorage` key prefix: `context.*`.
- Env vars: `CONTEXT_IT`, `CONTEXT_SERVER`.
- Sync JWT issuer: `context`. Hocuspocus instance name: `context-sync`.
- MCP `serverInfo` name: `context` (and the suggested CLI alias, `claude mcp add ... context`).
- npm root package name: `context`.
- Dev test account: `test@context.local` / `Context-Test-2026!`.

**Rule: never put the brand in anything durable.** That means storage, identifiers, protocol names,
paths, table names, and endpoints. If a new piece of durable state needs a name, name it after the
product idea ("context"), not the brand of the week.

## Layer 3, FROZEN identifiers: set once, never again

These two identifiers were set once, on this rebrand, and must **never change again**, not even on a
future rebrand:

- Tauri bundle identifier: `com.baalda.context`
- Keychain service: `com.baalda.context`

Changing either orphans every existing install's keychain entry and app data (macOS/Windows key
scoping and Tauri's per-bundle-id storage are keyed on this string). Precedent: Slack still ships as
`com.tinyspeck.slack` years after the Tiny Speck → Slack rebrand, for exactly this reason. If Baalda
rebrands again, the bundle id and keychain service stay `com.baalda.context` forever.

## How to rebrand (should take under an hour)

1. Pick the new brand name.
2. Update Layer 1's list only: `brand.ts` (desktop + server), `tauri.conf.json` productName + window
   title, `index.html` title, the `commands.rs` managed-root folder name, `Cargo.toml`
   description/authors, docs prose, root community files, `.github/**`, `ee/`, and the GitHub repo
   name/URLs.
3. Grep the whole repo (excluding `node_modules`, `target`, `.git`) for the old brand name and fix any
   stray hit. It belongs in Layer 1 only.
4. Do **not** touch anything in Layer 2 (the `context` codename) or Layer 3 (the frozen bundle
   id/keychain service). If a diff touches either, stop. That is the bug this policy exists to prevent.
5. Verify: existing installs keep their keychain entries and vault data; only user-visible strings
   change.

## Precedent: the workspace → vault terminology rename

This layering discipline is not only for the brand. When the user-facing unified entity was renamed from
"workspace" to **"vault"**, the same "change the surface, freeze the durable" split applied — sorted into
three tiers:

- **Tier A (user-visible strings):** UI labels, error prose, docs, seeded welcome notes — all changed
  freely (clients display these, they never pattern-match them).
- **Tier B (internal identifiers):** desktop component/action/CSS names and server function names that
  modelled the concept were renamed (`refreshWorkspace`→`refreshVault`, `WorkspaceSettingsDialog`→
  `VaultSettingsDialog`, `get_workspace_root`→`get_vaults_root`, …). The real data key `organizationId`
  stayed — only the concept *name* moved.
- **Tier C (wire/DB/config literals):** first frozen byte-for-byte for a safe rollout, then — the
  product being pre-launch with no external users — retired in one coordinated pass: migration 013 renamed
  the `workspace_id` columns to `org_id`, rewrote `resource_type = 'workspace'` → `'vault'`, and renamed
  `mcp_oauth_workspace` → `mcp_oauth_vault`, with the 402 tokens, billing JSON fields, and
  `FREE_MAX_VAULTS` env var renamed on both client and server in the same change. The one surface that
  keeps a compatibility shim is the desktop config file: `#[serde(alias = "workspace_root")]` still reads
  pre-rename `config.json` files. Post-launch, tier C would have stayed frozen — that is the point of the
  tiering.

The through-line is identical to a rebrand: **rename what users read, never rename what storage,
protocols, or shipped clients depend on.** See the root `CLAUDE.md` terminology glossary for the full
frozen list.
