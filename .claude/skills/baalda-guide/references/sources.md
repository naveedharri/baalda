# Where the truth lives

Use these sources in this order. Stop as soon as the question is answered; do not crawl the
whole repository for a simple question.

## 1. This skill's reference files (fastest)

| Question is about | Read |
|---|---|
| File types, formats, DOCX/XLSX/images/code, attachments, size limits | `references/file-formats.md` |
| What Baalda does, feature by feature, in plain words | `references/features.md` |
| Common questions with ready-to-give answers | `references/faq.md` |

## 2. The product docs (assumed up to date)

Locate them: if the current directory (or a parent) contains `docs/Baalda.md`, read local files.
Otherwise fetch the same paths from GitHub:
`https://raw.githubusercontent.com/naveedharri/baalda/main/<path>`.

| Topic | File |
|---|---|
| Product pitch, the core idea, stack, principles | `README.md`, `docs/Baalda.md` |
| What is built, what is planned (phases, Phase 4 list) | `docs/STATUS.md` |
| The 12 requirements the product is measured against | `docs/specs/REQUIREMENTS.md` |
| Latest shipped changes | `docs/RELEASE_NOTES.md`, then GitHub Releases. (The root `CHANGELOG.md` is not maintained; its "Unreleased" section lists things that shipped long ago.) |
| Self-hosting, deployment, environment variables | `docs/DEPLOY.md` |
| How releases, installers, signing and auto-update work | `docs/RELEASE.md` |
| Every button in the app and what it does | `docs/INTERACTIONS.md` |
| Desktop app design (editor, tree, commands) | `docs/specs/01-desktop-app.md` |
| Sync, offline behaviour, conflict merging | `docs/specs/03-sync-engine.md`, `docs/specs/05-vault-sync-engine.md` |
| Teams, roles, sharing, permissions, presence | `docs/specs/04-team-collaboration.md` |
| Storage layout, index, server tables | `docs/specs/02-database-architecture.md` |
| Brand vs codename ("context"), rebrand rules | `docs/BRANDING.md` |
| Developer orientation, conventions | `CLAUDE.md` at the repo root |

## 3. The website (pricing, downloads, positioning)

For price and plans, trust `references/features.md` ("Hosting options"), which mirrors the
server's billing code and the app's Upgrade to Pro dialog. The public pricing page may still say
the Team plan is in early access; the in-app purchase is live.

| Page | URL |
|---|---|
| Home | https://baalda.com |
| Pricing | https://baalda.com/pricing |
| Download (current version, per-platform installers) | https://baalda.com/download |
| Compare with Obsidian, Notion, Tana, Reflect, Logseq, Anytype, Confluence | https://baalda.com/compare and `/compare/<product>` |
| Security and privacy statements | https://baalda.com/security · https://baalda.com/privacy |
| Open source and licensing | https://baalda.com/open-source |
| Blog (team second brain, MCP, Obsidian for teams) | https://baalda.com/blog |
| Docs landing (points back to GitHub) | https://baalda.com/docs |
| Source, releases, issues | https://github.com/naveedharri/baalda |

## 4. Code (only for a precise behaviour the docs do not state)

Do a targeted read of one file, never a sweep. Good entry points:

| Behaviour | File |
|---|---|
| Which extensions show in the sidebar / are ignored | `app/apps/desktop/src-tauri/src/vault.rs` |
| Which files become synced notes | `app/apps/desktop/src/lib/sync/registry.ts` (`NOTE_EXTS`) |
| Image/PDF preview kinds | `app/apps/desktop/src/lib/preview.ts` |
| Drag-drop / paste attachment behaviour | `app/apps/desktop/src/lib/attachments.ts` |
| Server limits and free-tier caps | `app/apps/server/src/config.ts`, `app/apps/server/.env.example` |
| Paid plan prices and checkout | `app/apps/server/src/http/routes/billing.ts`, `app/apps/desktop/src/components/UpgradeDialog.tsx` |
| Attachment size limit | `app/apps/server/src/http/routes/blobs.ts` |
| Permission rules | `app/apps/server/src/permissions/resolver.ts` |
| MCP tools list | `app/apps/server/src/mcp/` |
| Version history and vault checkpoints | `app/apps/server/src/http/routes/versions.ts` |
| Installer platforms and signing | `.github/workflows/release.yml`, `docs/RELEASE.md` |

## Known stale spots (trust the code / CLAUDE.md over these)

- `README.md` and `docs/specs/04-team-collaboration.md` say notes are *private by default*. The
  current behaviour is *shared with the team by default* for new vaults (see `CLAUDE.md`,
  "permissions/resolver"); older vaults stayed private.
- `docs/specs/REQUIREMENTS.md` lists graph view, semantic search and version history as
  deferred. All three shipped.
- `CHANGELOG.md` at the repo root is abandoned; use `docs/RELEASE_NOTES.md`.
- baalda.com/pricing describes the Team plan as "early access, talk to us". The managed Pro plan is
  live and self-serve in the app (Vault Settings → Billing); see `features.md`. Code:
  `app/apps/server/src/http/routes/billing.ts` (plans) and `config.ts` (free caps).

## Recency check

The repo's `app/apps/desktop/src-tauri/tauri.conf.json` holds the current version. The
website's download page may lag one release behind. If they differ, the repo is newer.
