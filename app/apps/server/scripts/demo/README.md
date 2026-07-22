# Demo harness — big team vault + live multiplayer

A named, committed harness for **demoing / screen-recording** Baalda at scale. It
builds a large, realistic team vault and then drives live multiplayer
activity so you can film presence circles + moving remote cursors across a busy
vault.

Nothing personal is committed: the seed **reads** a source vault at run time from
a path you set in your (git-ignored) `.env`; only these scripts live in git.

## What it creates

- **1 organization** (the user-facing vault) — name from `DEMO_ORG_NAME`
- **15 members with real logins** — you as owner + 14 synthetic teammates
  (2 admins, 12 members), all sharing one password. You log in as yourself
  (OAuth or email+password); the simulator drives the other 14.
- **1 vault** mirroring the source vault's real folder tree + file content,
  **plus** synthetic `Team Journal/` notes (standups, meetings, status, people)
  so the tree exceeds the target size and looks busy
- an **org-wide "Open" (edit) grant** so every member can open every note
- generated **per-folder index notes** (`<Folder>/_Index.md`) + a root
  `_Vault Index.md`, and a full **search + wikilink-graph index**

## Prerequisites

```bash
cd app/apps/server
pnpm run db:up          # local Postgres (host port 5439)
# .env must exist with JWT_SECRET, and set at least DEMO_SOURCE_VAULT (below)
```

Set these in your **git-ignored `.env`** (real values never get committed):

```
DEMO_SOURCE_VAULT=/absolute/path/to/the/vault/to/mirror
DEMO_ORG_NAME=Your Vault Name
DEMO_ORG_SLUG=your-vault
DEMO_VAULT_NAME=Your Vault Name
DEMO_OWNER_EMAIL=you@example.com     # the account you log in as
DEMO_OWNER_NAME=You
```

## Quickest path

```bash
pnpm run demo     # reseed from scratch, then auto-launch the live teammates
```

Or run the two phases separately (`pnpm run seed:demo:reset` then `pnpm run demo:activity`).

Useful env overrides:

| Var | Default | Meaning |
|-----|---------|---------|
| `DEMO_SOURCE_VAULT` | `./demo-source-vault` | source vault to mirror |
| `DEMO_TARGET_NOTES` | `6000` | grow the tree to at least this many notes |
| `DEMO_MAX_IMPORT` | all | cap real files imported |
| `DEMO_PASSWORD` | `demopass1234` | shared login password |
| `DEMO_FOCUS` | — | crowd only notes whose path contains this string |

The seed prints every account's email + the shared password at the end.

## Record

1. Start the server (`pnpm run dev`) and the desktop app; sign in as your owner
   account (OAuth, or email+password with the shared password), server URL
   `http://localhost:3010`.
2. Launch the live teammates: `pnpm run demo:activity`. It connects the other 14
   members as headless clients, concentrates them on a **hot set** of notes, and
   prints _which files to open on camera_. Open one and you'll see multiple
   profile circles + labelled, coloured remote carets gliding around, with
   occasional live typing. `Ctrl-C` disconnects everyone cleanly.

## Notes / honesty

- 15 users can't be on all N files at once. The simulator makes a **hot set**
  genuinely crowded (2–3 people each) and prints those paths; use `DEMO_FOCUS` to
  point everyone at whatever folder you're filming.
- Transient "typing" only touches **safe** notes (`Team Journal/` + index notes)
  and is inserted-then-removed, so seeded content is left unchanged. Cursors on
  real imported notes only move; they don't edit.
- Colours match the app exactly — the simulator reuses the same `colorForUser`
  hash as the desktop presence ring/avatar.

## OAuth note

If you log in with Google using an email that the seed already created as an
email+password account, Better Auth only auto-links to a trusted provider when
the existing account's email is **verified**. The seed marks the owner account
verified for exactly this reason; if you change the owner after seeding, either
re-seed or set `"emailVerified" = true` on that user.

## Files

- `config.ts` — env config, the 15-person roster, `colorForUser`, helpers
- `content.ts` — vault walk, folder planning, synthetic notes, index notes
- `seed-demo-org.ts` — the seed (`pnpm run seed:demo`)
- `simulate-activity.ts` — the live simulator (`pnpm run demo:activity`)
