---
type: spec
spec: 04-team-collaboration
product: Baalda
status: draft-v1
date: 2026-07-13
tags: [baalda, spec, auth, teams, permissions, presence]
---

# 04 · Team Collaboration

Accounts, teams, folder sharing, permissions, and presence — the layer that turns a single-user vault
into a shared team brain. The through-line: **auth owns identity + membership; a small ACL owns
content access; both resolve into short-lived per-doc tokens that gate the sync engine.** Overview:
[[00-architecture-overview]]. Sync: [[03-sync-engine]]. Index: [[Baalda]].

---

## 1. Decisions

| Concern | Choice | Reasoning |
|---|---|---|
| Auth library | **Better Auth** | TypeScript, framework-agnostic, runs in *our* Node process against *our* Postgres. No separate service, no per-MAU pricing, self-hostable. Ships an **organization plugin** = teams/members/invitations for free. (Lucia is deprecated; Kratos is a heavy separate service; Clerk/Auth0 aren't self-hostable; Supabase Auth tilts toward platform lock-in — the strong second choice if we ever buy the platform.) |
| Password hashing | **argon2id** | Current OWASP default (memory-hard). Configure Better Auth to use it (its built-in default is scrypt). |
| Sessions | **Server-side sessions** (opaque token in Better Auth's `session` table) | We need **instant revocation** — remove someone from a team or unshare a folder and their access must die now. A long-lived stateless JWT can't be revoked. |
| Sync tokens | short-lived **per-doc JWTs** minted from the session (5–15 min TTL) | Fine to be stateless *here* because they're short and scoped; this is what the sync socket consumes. |
| Teams model | Better Auth **organization plugin** (`organization` = **vault**, the user-facing entity) | owner / admin / member roles out of the box. |
| Sharing model | **folder-based per-resource ACL**, view/edit, additive, highest-wins | The pattern every reference (Relay, Outline, Docmost, Notion) converged on. |
| Desktop login (MVP) | in-app email+password form → session token in **OS keychain** | Simplest; no browser round-trip. OAuth via Tauri PKCE deep-link is Phase 4. |

## 2. Team data model (Better Auth generates most of this)

Terminology: a Better Auth **organization** = our **vault** — the user-facing unified entity (Local /
Synced / Remote states), formerly called a "workspace". (Storage-layer note: the separate Postgres
`vaults` table is a *child* of the organization — the "note collection" that keeps the `vault*` column/
wire names; in practice it is 1:1 with the org, so the user perceives one vault. See
[[02-database-architecture]] and [[05-vault-sync-engine]].)

```
user         (id, email UNIQUE, name, email_verified, image, created_at)
account      (id, user_id, provider_id, password /*argon2id*/, ...)   -- credentials / OAuth links
session      (id, user_id, token UNIQUE, expires_at,
              active_organization_id, ip_address, user_agent)
organization (id, name, slug UNIQUE, logo, created_at)                -- = vault (user-facing; the team)
member       (id, organization_id, user_id, role, created_at,         -- role: owner|admin|member
              UNIQUE(organization_id, user_id))
invitation   (id, organization_id, email, role, inviter_id,
              status /*pending|accepted|canceled|expired*/, expires_at /*now()+48h*/)
-- deferred past MVP: team, team_member (sub-groups within an organization)
```

Roles for MVP — keep exactly three (matches Notion/Outline/Docmost): **owner** (billing, delete/
transfer the vault), **admin** (manage members, invitations, settings), **member** (basic access).

## 3. Sharing & permissions

### The industry pattern (what the references do)

- **Obsidian Relay** — sharing is **folder-based** ("Shared Folders"); never reads outside a shared
  folder. Access today is coarse (owner + members via a share key) — we improve on it with a real ACL.
- **Outline** — permissions on **Collections** (folders) + later per-document overrides; **additive,
  highest wins**.
- **Docmost** — **Spaces** (folders) with Full / Edit / View, assignable to users or groups; highest
  across paths wins.

Consistent takeaway: **folder is the primary unit of sharing; permissions are additive; highest
wins; file-level override is a later add-on.**

### Our model: RBAC for membership + per-resource ACL for content

Use **RBAC** for vault membership (§2) and a **per-resource ACL** for content sharing — the hybrid
everyone converged on. Pure RBAC can't say "share *this folder* with Bob as viewer"; pure ACL is
tedious for org-wide roles. Do both.

```sql
-- folders/notes/files key off vault_id → the vaults (note-collection) row, which belongs to one org.
folder (id, vault_id, path, parent_id NULL)          -- shareable folders in the vault
file   (id PK == doc_id, vault_id, folder_id, path)  -- vault file ↔ Yjs doc mapping

shares (
  id             TEXT PK,
  org_id         TEXT,   -- FK → organization.id (the vault the share lives in)
  resource_type  TEXT,   -- 'folder' | 'file' | 'vault' (vault-wide grant; migrations 008 + 013)
  resource_id    TEXT,   -- folder id or file/doc id (org id for the 'vault' grant)
  principal_type TEXT,   -- 'user' (MVP) | 'team' (later)
  principal_id   TEXT,
  permission     TEXT,   -- 'view' | 'edit'
  created_by     TEXT,
  created_at     TIMESTAMPTZ,
  UNIQUE(resource_type, resource_id, principal_type, principal_id)
)
```

> The org-wide "share with team" grant is stored as a `shares` row with `resource_type = 'vault'`
> (added as `'workspace'` in migration 008, renamed in migration 013). Its `resource_id` — like the
> `org_id` column — is the vault (organization) id, never the `vaults` note-collection row.

**Effective permission** for a user on a file:
1. Vault `owner`/`admin` → `edit` on everything in the vault.
2. A note's **creator** → `edit` on their own note.
3. Else take the **max** of: any `share` on the file itself, any `share` on a containing folder
   (walk `parent_id` up), and any vault-wide grant — each either **per-user** or an org-wide
   **"share with team"** grant.
4. `edit > view > none`. No matching grant → **no sync access**.

**Private by default:** a new vault grants nothing org-wide, so members see only what they create
or what's shared with them / the team. (Owner sets the whole vault to Shared/Read-only, or shares
individual folders, in the Access panel; vaults created before this stay Open.)

Folder grants are **inherited by descendants**; a file-level `share` can only *raise* permission
(Outline's "read-only collection + writable document" pattern).

## 4. How permissions gate the sync engine (the important part)

The ACL controls **which Yjs documents a socket may open, and read-only vs read-write**. Flow:

1. Desktop client holds a Better Auth **session token** (from OS keychain).
2. Before syncing a file, client calls our API: `POST /sync-token { doc_id }`.
3. Server validates the session, computes effective permission (§3), and:
   - `edit` → mint a per-doc JWT `{doc_id, readOnly:false, exp:+10m}`
   - `view` → mint `{doc_id, readOnly:true, exp:+10m}`
   - `none` → **403**
4. Client connects the Yjs provider to Hocuspocus with that token.
5. Hocuspocus `onAuthenticate` verifies it → sets `connection.readOnly` for view grants (rejects
   updates) or throws for invalid tokens. **A user physically cannot open a socket to a doc they
   weren't granted.**
6. Short TTLs → revocation is minutes; on unshare we also **disconnect live sockets** for an instant
   kill.

Authorize at the **document (file)** level even though sharing is expressed at the **folder** level —
resolve folder→files when minting tokens. One Yjs doc per markdown file makes this mapping clean.

## 5. Presence & awareness

Use the **Yjs awareness protocol** (exposed by the Hocuspocus provider) — a separate ephemeral CRDT
of small JSON per client that auto-clears on disconnect. It is *not* persisted.

**MVP:**
- **Live cursors + selections** in an open note — `awareness.setLocalStateField('user', {name, color,
  cursor})`; the CM6 binding (`y-codemirror.next`) renders remote cursors automatically.
- **"Who's in this note" avatars** — derived from awareness states on that doc.
- **Basic online status** — a user is "online" if they have awareness state on any doc.

**Defer:** vault-wide "who's online" dashboard, last-seen/viewing history, typing indicators,
follow-mode, cursor chat.

## 6. Invitations / onboarding a teammate into a shared folder

Two steps (Better Auth invitation flow + our `shares`):

**A. Into the vault:** admin invites by email → `invitation` row (`pending`, `+48h`) → email
with a signed accept link → invitee signs up / logs in / accepts → `member` row with the invited role.

**B. Into a specific folder:** on "Share folder → add person," create a `shares` row
(`resource_type='folder'`, `permission='view'|'edit'`). If the invitee isn't a member yet, create the
vault `invitation` *and* stage the pending folder share keyed by email; materialize it on accept.
On accept, the client's next `/sync-token` call succeeds and the folder's files begin syncing.

MVP shortcut (from Relay, hardened): a **folder share link** that grants `edit` on join — but scope it
to *existing vault members* to avoid Relay's "anyone with the key" gap.

## 7. Desktop auth flow

- **MVP (email+password):** render the login form *in* the app, POST to the Better Auth server, store
  the returned session token in the **OS keychain** (Tauri Stronghold / `keyring` crate — never
  plaintext localStorage). No browser round-trip.
- **Phase 4 (OAuth/social):** open the system browser, use **PKCE** + a **loopback callback**
  (`tauri-plugin-oauth`, a localhost server) or a custom-scheme deep link (`tauri-plugin-deep-link`).
  Never pass tokens through the deep link — pass a short-lived code and exchange it in-app.

## 8. OSS references

- **Better Auth** (`github.com/better-auth/better-auth`, MIT) — use directly; the org plugin *is* our
  teams/members/invitations schema and flows.
- **Obsidian Relay** (MIT) — folder-based sharing + local-first server-relay + self-host-with-central-
  auth split; the closest analog. Improve on its coarse "anyone with key" access with our ACL.
- **Docmost** (AGPL — read for ideas) — Space permission trio (Full/Edit/View), additive highest-wins,
  Hocuspocus as a separate scalable collab process.
- **Outline** (BSL — read for ideas) — collection-primary + document-override permissions; minimal
  viewer-role semantics.
- **Hocuspocus** (MIT) — `onAuthenticate` + `connection.readOnly` is the exact per-doc gating hook.
- **Notty** (study only) — auth + per-user data isolation; scope every query by the owning vault (org) id.

## 9. MVP build order (team collaboration — Phase 3)

1. **Accounts** — Better Auth email+password (argon2id), server sessions, email verification +
   password reset; desktop stores the token in the OS keychain; in-app login form.
2. **One vault + invite teammates** — organization plugin; owner/admin/member; email invitations
   (48h, accept flow).
3. **Sync wired to auth** — `/sync-token` mints short-lived per-doc tokens from the session; Hocuspocus
   enforces (§4).
4. **Share a folder with view/edit** — `folder`/`file`/`shares`; additive, highest-wins, inherited;
   tokens honor the read-only flag. **This is the core feature.**
5. **Presence** — live cursors + "who's viewing" avatars via awareness.

**Defer:** OAuth/social login, teams/subgroups, custom/granular roles, file-level overrides,
external/public sharing, comments/mentions, activity feed, audit logs, SSO/SAML, MFA, multiple
vaults per user (Better Auth supports these — add when asked).
