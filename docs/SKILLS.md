# Skills: team AI-skill management (implementation spec)

Status: implemented 2026-10-26 (staging). Three streams built this in parallel: **S** (server), **R**
(Rust + its `ipc.ts` bindings), **U** (desktop TS/React). This file is the contract and the main
sections describe the code as built, including the cross-stream review follow-ups (per-user
markers, release instead of delete for edited copies, the server-switch pause). The Deviations
sections at the end record where each stream bent the original spec. If something here is wrong,
fix the spec first; do not drift silently.

## 0. What we are building

- A vault (Better Auth `organization`, `orgId`) holds a catalog of **skills**. A skill is a folder
  with a root `SKILL.md` (YAML frontmatter `name` + `description`) and any other files.
- Owners/admins create a skill, edit its one server-side **draft**, and **Publish** it into an
  immutable, auto-numbered **version** (1, 2, 3 …) with release notes. Only published versions are
  delivered anywhere.
- Each skill is **Required** (installed for every member, no opt-out) or **Optional** (each member
  opts in per device). An admin may **pin** a version. Effective version = `pinnedVersion ?? latestVersion`.
- Every signed-in desktop installs the effective versions of **all** vaults the user belongs to on
  the current server into two device targets: `claude` = `<claude config dir>/skills/<name>` and
  `agents` = `~/.agents/skills/<name>` (Codex CLI/desktop, Cursor, Gemini CLI, Copilot, OpenCode).
  Never write `~/.codex/skills` (deprecated).
- Free on every plan. Stored in the server's own tables (`bytea`), not blobs, not vault notes.
- MCP gets `list_skills`, `get_skill`, `read_skill_file`.
- v2: download a version as `.zip`, and import skills from GitHub marketplaces (see "Addendum —
  Marketplace import"). There is no publishing to GitHub or claude.ai (removed 2026-10-26).
- UI: Vault Settings → **Skills** (team catalog) and Account Settings → **AI tools** (this machine).
  No sidebar entry.

## 1. Shared rules (all streams)

### 1.1 Skill name

`^[a-z0-9]+(-[a-z0-9]+)*$`, length 1–64 (no leading/trailing/doubled hyphen). Immutable after
creation (no rename in v1; create a new skill instead). Unique per org among live skills (names are
lowercase by rule, so the unique index is on `name` directly). Additionally refused, case-insensitively:
Windows reserved device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`). Names
containing `claude` or `anthropic` are **allowed** but the UI shows a warning (claude.ai's own upload
rejects them).

### 1.2 File paths inside a skill (`relPath`)

- `/`-separated, relative, 1–240 chars total, each component 1–100 chars.
- Refused: empty components, `.`/`..`, a leading `/`, `\`, NUL or control chars, any of `<>:"|?*`,
  a component ending in `.` or space, a Windows reserved device name as a component stem
  (`con.txt` too), and **any component starting with `.`** (no dotfiles; also reserves
  `.baalda-managed.json`).
- Compared case-insensitively for duplicates (`SKILL.md` and `skill.md` cannot coexist).
- `SKILL.md` must exist at the root, exact case.

### 1.3 Caps (server enforces, Rust/TS pre-check)

| Cap | Value | Error code |
|---|---|---|
| Files per draft/version | 1000 | `skill_too_many_files` |
| Bytes per file (decoded) | 5 MiB (5,242,880) | `skill_file_too_large` |
| Bytes per draft/version (decoded total) | 25 MiB (26,214,400) | `skill_too_large` |
| Skills per org (live) | 500 | `skill_limit_reached` (409) |
| Release notes | 2,000 chars | `invalid_notes` |
| `description` | 1–1,024 chars | `invalid_skill` reason `description` |

HTTP bodies carrying files (create, draft PUT/PATCH): route-level `bodyLimit` of 36 MiB (25 MiB
decoded is ~33.4 MiB of base64, plus JSON) → 413 `skill_too_large`.

Size refusals carry `limit` and a plain-words `message` the desktop may show as-is:

| Status | Body |
|---|---|
| 400 | `{ error: "skill_too_many_files", limit: 1000, message: "A skill can have at most 1,000 files." }` |
| 413 | `{ error: "skill_file_too_large", limit: 5242880, message: "Each file in a skill can be at most 5 MB.", path? }` (`path` when the upload named the file) |
| 413 | `{ error: "skill_too_large", limit: 26214400, message: "A skill can be at most 25 MB in total." }` (decoded total over 25 MiB, or the body over 36 MiB) |

### 1.4 SKILL.md validation (publish-time on server; live in the UI editor)

Frontmatter = the text between a first line `---` and the next line `---`. Must parse as a YAML
mapping. `name` must be a string equal to the skill's name. `description` a non-empty string
≤1,024 chars. Other keys are kept verbatim and ignored. Failure → 400
`{ error: "invalid_skill", reason: "missing_skill_md" | "no_frontmatter" | "bad_yaml" | "name_mismatch" | "description" }`.

### 1.5 Hashes

`sha256` = lowercase hex of the file bytes. **Bundle hash** of a draft or version =
sha256 of the UTF-8 string formed by sorting files by `relPath` (byte order) and joining
`relPath + "\0" + sha256 + "\0" + (executable ? "1" : "0") + "\n"`. S and U both implement this
exactly (U for "draft differs from latest" display; S for `nothing_to_publish`).

## 2. Wire types (verbatim — S and U both copy these)

U puts them in `app/apps/desktop/src/lib/skills/types.ts`; S in `app/apps/server/src/skills/types.ts`.

```ts
export type SkillDelivery = "required" | "optional";
export type SkillRole = "owner" | "admin" | "member";

/** A file with content, base64 of the raw bytes. */
export interface SkillFile {
  path: string;            // relPath, §1.2
  sha256: string;
  size: number;            // decoded bytes
  executable: boolean;
  contentBase64: string;
}
/** Upload shape: sha256/size are recomputed and checked by the server if present. */
export interface SkillFileInput {
  path: string;
  contentBase64: string;
  executable?: boolean;    // default false
  sha256?: string;         // when present and wrong → 400 sha_mismatch
}
export interface SkillFileMeta { path: string; sha256: string; size: number; executable: boolean }

export interface SkillVersionSummary {
  version: number;          // 1, 2, 3 …
  bundleSha256: string;
  description: string;      // frozen from SKILL.md at publish
  notes: string;
  fileCount: number;
  totalBytes: number;
  publishedAt: string;      // ISO
  publishedBy: { id: string; name: string } | null;
}

export interface SkillSummary {
  id: string;
  orgId: string;
  name: string;
  description: string;      // latest published description, else the draft's (admins), else ""
  delivery: SkillDelivery;
  pinnedVersion: number | null;
  latestVersion: number | null;      // null = never published
  latestPublishedBy: { id: string; name: string } | null; // publisher of latestVersion; null if never published or user deleted
  latestPublishedAt: string | null;  // ISO, latestVersion's published_at; null if never published
  effectiveVersion: number | null;   // pinnedVersion ?? latestVersion
  draftRevision: number;
  draftDiffers: boolean;             // draft bundle hash != latest version's (true when never published)
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  versions: SkillVersionSummary[];   // newest first
  draftFiles: SkillFileMeta[] | null; // null for members
}

export interface SkillDraft {
  skillId: string;
  revision: number;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
  files: SkillFile[];
}

// SkillSettings was removed 2026-10-26 with the GitHub publish bridge (see "Removed — GitHub
// publish bridge" at the end of this file).

export interface SkillsCatalog {
  role: SkillRole;
  skills: SkillSummary[];        // members: only skills with latestVersion != null
}

/** One entry the desktop installs. Only skills with an effective version appear. */
export interface ManifestSkill {
  skillId: string;
  name: string;
  description: string;           // of the effective version
  delivery: SkillDelivery;
  version: number;               // effective version
  bundleSha256: string;
  files: SkillFileMeta[];        // of the effective version (no content)
}
export interface ManifestOrg {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: SkillRole;
  skills: ManifestSkill[];
}
export interface SkillsManifest {
  serverTime: string;
  orgs: ManifestOrg[];           // EVERY org the user is a member of, even with zero skills
}

/** Vault-channel control frame (server → client). */
export type SkillsChangedFrame = { t: "skills-changed"; orgId: string };
```

## 3. Server (Stream S)

### 3.1 Migration `app/apps/server/migrations/060_skills.sql`

(059 is the latest today. If another 060 lands first, renumber to the next free number and say so.)

```sql
CREATE TABLE skills (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  delivery         TEXT NOT NULL DEFAULT 'optional' CHECK (delivery IN ('required','optional')),
  pinned_version   INTEGER,
  latest_version   INTEGER,
  draft_revision   INTEGER NOT NULL DEFAULT 1,
  draft_description TEXT NOT NULL DEFAULT '',
  draft_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  draft_updated_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_by       TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  deleted_by       TEXT REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX skills_org_name_live ON skills (organization_id, name) WHERE deleted_at IS NULL;
CREATE INDEX skills_org_live ON skills (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE skill_versions (
  id             TEXT PRIMARY KEY,
  skill_id       TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL CHECK (version >= 1),
  bundle_sha256  TEXT NOT NULL,
  description    TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  file_count     INTEGER NOT NULL,
  total_bytes    INTEGER NOT NULL,
  published_by   TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

CREATE TABLE skill_version_files (
  version_id  TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  executable  BOOLEAN NOT NULL DEFAULT false,
  content     BYTEA NOT NULL,
  PRIMARY KEY (version_id, path)
);

CREATE TABLE skill_draft_files (
  skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  executable  BOOLEAN NOT NULL DEFAULT false,
  content     BYTEA NOT NULL,
  PRIMARY KEY (skill_id, path)
);
CREATE UNIQUE INDEX skill_draft_files_ci ON skill_draft_files (skill_id, lower(path));
CREATE UNIQUE INDEX skill_version_files_ci ON skill_version_files (version_id, lower(path));
```

Soft delete: `DELETE` sets `deleted_at/deleted_by`; versions and files stay (no purge job in v1).
A deleted skill disappears from every listing, the manifest and MCP. Its name is free again.
`tests/helpers/db.ts` `TABLES` gains `skill_version_files`, `skill_versions`, `skill_draft_files`,
`skills` (children first).

### 3.2 Server module layout (all new unless noted)

```
src/skills/types.ts        §2 types (verbatim)
src/skills/validate.ts     name/path/caps/frontmatter (uses the `yaml` package), bundleSha256()
src/skills/store.ts        SQL: list/get/create/softDelete/draft read+write/publish/manifest
src/skills/feature.ts      export const SKILLS_FEATURE = "skills";
src/http/routes/skills.ts  createSkillRoutes(): Hono  (mounted at "/api")
src/mcp/skills.ts          listSkillsTool / getSkillTool / readSkillFileTool handlers
```

Edits to existing files (all S): `src/http/app.ts` (mount `app.route("/api", createSkillRoutes())`
next to `createAppearanceRoutes`; add `SKILLS_FEATURE` to `/health` `features`), `src/mcp/tools.ts`
(three tool entries), `src/sync/member-events.ts`, `src/sync/vault-protocol.ts`,
`src/sync/vault-channel.ts`, `src/index.ts`, `tests/helpers/db.ts`, `package.json` +
`app/pnpm-lock.yaml` (add `"yaml": "^2.8.1"` to server dependencies — no YAML parser exists today;
S is the only stream allowed to touch the lockfile).

Auth pattern: copy `routes/appearance.ts` — `getSession(c)` → 401 `{error:"Authentication required"}`;
`ID_RE` check on ids → 404 `not_member`; `orgRole(orgId, userId)` (`permissions/lookup.ts`) → null ⇒
404 `{error:"not_member"}`. Admin-only routes: role not owner/admin ⇒ 403 `{error:"skills_admin_required"}`.
A `skillId` not in that org, or soft-deleted ⇒ 404 `{error:"skill_not_found"}`. Members asking for
an unpublished skill ⇒ 404 `skill_not_found`. New ids: `randomUUID()`.

### 3.3 HTTP routes (all under `/api`, JSON)

| # | Method + path | Who | Request | Response |
|---|---|---|---|---|
| 1 | `GET /skills/manifest` | any signed-in | — | `SkillsManifest` (every org from `member` for this user) |
| 2 | `GET /orgs/:orgId/skills` | member | — | `SkillsCatalog` |
| 3 | `POST /orgs/:orgId/skills` | admin | `{ name: string; files?: SkillFileInput[] }` | 201 `SkillDetail` |
| 4 | `GET /orgs/:orgId/skills/:skillId` | member | — | `SkillDetail` |
| 5 | `PATCH /orgs/:orgId/skills/:skillId` | admin | `{ delivery?: SkillDelivery; pinnedVersion?: number \| null }` | `SkillSummary` |
| 6 | `DELETE /orgs/:orgId/skills/:skillId` | admin | — | `{ ok: true }` |
| 7 | `GET /orgs/:orgId/skills/:skillId/draft` | admin | — | `SkillDraft` |
| 8 | `PUT /orgs/:orgId/skills/:skillId/draft` | admin | `{ baseRevision: number; files: SkillFileInput[] }` (replace all) | `SkillDraft` |
| 9 | `PATCH /orgs/:orgId/skills/:skillId/draft` | admin | `{ baseRevision: number; upsert?: SkillFileInput[]; remove?: string[] }` | `SkillDraft` |
| 10 | `POST /orgs/:orgId/skills/:skillId/draft/reset` | admin | `{ baseRevision: number; version: number }` (draft := that version) | `SkillDraft` |
| 11 | `POST /orgs/:orgId/skills/:skillId/publish` | admin | `{ baseRevision: number; notes?: string }` | 201 `SkillVersionSummary` |
| 12 | `GET /orgs/:orgId/skills/:skillId/versions/:version` | member | — | `SkillVersionSummary & { files: SkillFile[] }` |

Routes #13–#15 (`/orgs/:orgId/skill-settings`, `…/github-sync`) were removed on 2026-10-26, along with
the GitHub publish bridge. See "Removed — GitHub publish bridge" at the end of this file.

Details:
- **#3 create:** validates name (400 `invalid_name`), unique (409 `skill_name_taken`), org cap. With
  no `files`, the draft is seeded with one `SKILL.md`:
  `---\nname: <name>\ndescription: Describe when to use this skill.\n---\n\n# <name>\n`. `draft_revision`=1.
  Delivery defaults to `optional`. Not published, so no frame.
- **#8/#9/#10 draft writes:** inside one transaction, `SELECT … FOR UPDATE` the skill row; if
  `draft_revision <> baseRevision` ⇒ 409 `{error:"stale_draft", revision}`. Validate every path
  (400 `{error:"invalid_path", path}`), base64 (400 `invalid_base64`), sha (400 `sha_mismatch`),
  caps over the *resulting* set. `remove` of a missing path is a no-op; removing `SKILL.md` is
  allowed in the draft (publish refuses it). Increment `draft_revision`, set `draft_updated_*`,
  re-derive `draft_description` from SKILL.md (best effort, '' if invalid). No frame.
- **#11 publish:** same lock + revision check; validate §1.4 against the draft; if the draft's bundle
  hash equals the latest version's ⇒ 409 `nothing_to_publish`. `version = coalesce(latest_version,0)+1`,
  copy draft rows into `skill_version_files`, set `latest_version`. Announce `skills-changed`.
- **#5 patch:** `pinnedVersion` must name an existing version (400 `unknown_version`); `null` unpins.
  Announce. **#6 delete:** announce.
- **#1 manifest:** one query set: orgs from `member` joined to `organization` (name, slug, role), the
  live skills with non-null effective version, their effective version row and its file metadata
  (no content). Must answer in O(orgs+skills) queries
  max 3–4; no per-skill query loop.
- **#12** serves only published versions; any member may read any published version (not only the
  effective one) — needed for history and zip download.
- Any `version` path param not `^[1-9][0-9]{0,8}$` ⇒ 404 `version_not_found`.

### 3.4 Vault-channel frame `skills-changed`

Copy the appearance pipeline exactly:
- `src/sync/vault-protocol.ts`: `export const PS_SKILLS_CHANGED = 0x0f;` (0x01–0x0e are taken),
  `encodePubsubSkillsChanged(orgId)` (byte 0 + UTF-8 JSON `{orgId}`), decode case returning
  `{ type: "skills-changed"; orgId: string }` (null on bad JSON), add the client frame
  `| { t: "skills-changed"; orgId: string }` to the server→client union.
- `src/sync/vault-channel.ts`: `publishSkillsChanged(vaultId, orgId)`; the subscriber branch
  `if (msg.type === "skills-changed") { this.send({ t: "skills-changed", orgId: msg.orgId }); return; }`
  (org-wide like `appearance-changed`, no ACL filter).
- `src/sync/member-events.ts`: `setSkillsChangedPublisher(fn)` + `announceSkillsChanged(orgId)`
  (looks up `vaults WHERE organization_id = $1`, publishes per vault, best effort, logs on error).
- `src/index.ts`: wire `setSkillsChangedPublisher((vaultId, orgId) => void vaultChannel.publishSkillsChanged(vaultId, orgId).catch(broadcastFailed("skills-changed")))`.

Create (#3) and the marketplace source routes also announce (2026-10-27): the frame refreshes open
Skills pages live (tab grid, skill page, sidebar shortcut, ~150 ms coalesced), not only installs.
Draft writes stay silent. Desktops also poll (§5.4), so a missed frame only delays.

**Required → Optional (2026-10-27):** the toast promises "People can remove it from their computer",
so a device that already holds our copy keeps it: `impliedOptIns` records an opt-in for an Optional
skill with an owned copy on disk and no explicit choice. Turning a skill off on a device now stores
an explicit opt-out (`prefs.optOuts`), which is what stops the rule re-adding it.

### 3.5 MCP (`src/mcp/tools.ts` entries, handlers in `src/mcp/skills.ts`)

The token's org is `ctx.auth.organizationId`, the user `ctx.auth.userId` (see `getAccessDefaultTool`).
All `...READ` annotations. Only live skills with an effective version are visible (members and
admins alike; MCP never exposes drafts).

- `list_skills` `{}` → `{ skills: [{ name, description, version, required: boolean, latestVersion, pinned: boolean }] }`.
- `get_skill` `{ name: string; version?: number }` → `{ name, description, version, notes, publishedAt, skillMd: string, files: [{ path, size, text: boolean }] }`
  (default version = effective).
- `read_skill_file` `{ name: string; path: string; version?: number; maxChars?: number }` →
  `{ path, version, text: string | null, binary: boolean, truncated: boolean }`. Valid UTF-8 ⇒
  `text`, else `binary: true, text: null`. `maxChars` default 50,000, max 200,000.
- Refusals use the existing tool-error pattern with codes `skill_not_found`, `version_not_found`,
  `file_not_found`. Metrics: the existing `mcp.tool.<name>.*` counters apply automatically.

### 3.6 Health

`/health` `features` gains `"skills"` (import `SKILLS_FEATURE`).

## 4. Rust (Stream R)

New module `app/apps/desktop/src-tauri/src/skills_sync.rs` (`pub mod skills_sync;` in `lib.rs`;
commands added to `generate_handler!` next to `agent_runner::detect_agents`). Every command first
calls `crate::agent_runner::trusted_window(&window)?` — change that fn from private to `pub(crate)`
in `agent_runner.rs` (the only edit R makes there). Commands take `window: tauri::Webview` (and
`app: tauri::AppHandle` where noted). Errors: `AppResult<T>` / `AppError`. All serde structs
`#[serde(rename_all = "camelCase")]`; Tauri maps JS camelCase args to snake_case params.

Existing helpers to reuse: `attachments::sha256_bytes(&[u8]) -> String`,
`notefile::write_atomic_fsync(&Path, &[u8])`, crates already present: `zip = 2` (deflate),
`serde_yaml`, `sha2`, `walkdir`, `uuid`, dev `tempfile`. `base64` is NOT a direct dependency today:
R adds `base64 = "0.22"` to `Cargo.toml` (it is already in the lock tree transitively).

### 4.1 Target roots (resolved in Rust only)

```rust
pub enum SkillTarget { Claude, Agents }   // serde: "claude" | "agents"
fn home() -> Option<PathBuf>             // USERPROFILE on Windows, HOME elsewhere (copy agent_runner.rs:165)
fn claude_config_dir(home, env_claude_config_dir: Option<OsString>) -> PathBuf
    // $CLAUDE_CONFIG_DIR if set, non-empty and absolute; else <home>/.claude
fn target_root(target, home, env) -> PathBuf
    // Claude → <claude_config_dir>/skills ; Agents → <home>/.agents/skills
```
Keep the resolvers pure (take home/env as params) so tests use temp dirs. Note: a GUI-launched
macOS app does not see `CLAUDE_CONFIG_DIR` from a shell rc; the UI shows the resolved path.
Refuse (error `skills root is a symlink`) when the root or any existing ancestor between `home`
and the root is a symlink. Create the root with `create_dir_all` on first install only.

### 4.2 Structs

```rust
pub struct SkillFilePayload { path: String, content_base64: String, sha256: String, executable: bool }
pub struct SkillMarker {            // file `<dir>/.baalda-managed.json`
  skill_id: String, org_id: String, server_url: String,
  user_id: Option<String>,          // the signed-in user who installed it; None = legacy marker
  name: String, version: u32,
  bundle_sha256: String, files: BTreeMap<String, String>,  // relPath -> sha256
  installed_at: String,             // RFC3339, set by Rust
}
pub struct SkillOwner { skill_id: String, org_id: String, server_url: String, user_id: String }
// A folder is OURS when skill_id, org_id and server_url match and the marker's user_id is None
// (legacy, matches anyone) or equals owner.user_id. Anything else is another owner: never touched.
pub struct TargetInfo { target: SkillTarget, root: String, root_exists: bool,
  tool_installed: bool,             // Claude: config dir exists; Agents: any of detected_tools
  detected_tools: Vec<String> }     // Agents only: subset of ["codex","cursor","gemini","copilot","opencode"]
                                    // by existence of ~/.codex (or $CODEX_HOME), ~/.cursor, ~/.gemini, ~/.copilot, ~/.config/opencode
pub enum InstalledStatus { Managed, Edited, Unmanaged }   // serde lowercase
pub struct InstalledSkill { name: String, status: InstalledStatus,
  marker: Option<SkillMarker>, edited_files: Vec<String> }   // edited_files: changed/added/missing relPaths
pub enum InstallStatus { Installed, Unchanged, Conflict, Edited }
pub struct InstallOutcome { status: InstallStatus, backup_path: Option<String>, detail: Option<String> }
pub enum RemoveMode { Delete, Release }                 // serde lowercase; missing = Delete
pub enum RemoveStatus { Removed, Released, NotFound, Conflict }
pub struct RemoveOutcome { status: RemoveStatus, backup_path: Option<String> }
pub struct SkillBundle { suggested_name: String, files: Vec<SkillFilePayload>, skipped: Vec<String> }
```

### 4.3 Commands

| Command | Args | Returns | Behaviour |
|---|---|---|---|
| `skills_targets` | — | `Vec<TargetInfo>` | Filesystem checks only (never runs a binary). Called each launch. |
| `skills_scan` | `target` | `Vec<InstalledSkill>` | Lists child dirs of the root (skips names starting with `.` and non-dirs; a symlinked child is reported `unmanaged`). For dirs with a valid marker: hash every regular file except the marker (walkdir, no symlink follow; a symlink inside ⇒ `edited` with that path) and compare to `marker.files`. Also deletes leftover `.baalda-staging-*` / `.baalda-old-*` dirs older than 1 h. Missing root ⇒ `[]`. |
| `skills_install` | `target, name, marker: SkillMarker, files: Vec<SkillFilePayload>, force: bool` | `InstallOutcome` | §4.4 |
| `skills_remove` | `app, target, name, owner: SkillOwner, mode?: RemoveMode` | `RemoveOutcome` | Dir missing ⇒ `NotFound`. No marker, a marker naming another folder, or another owner ⇒ `Conflict` (untouched). `delete` (default): drifted ⇒ backup first, then remove the dir ⇒ `Removed`. `release`: delete ONLY `.baalda-managed.json`, no backup ⇒ `Released` (`backupPath: null`); the folder stays as the user's own and scans as `unmanaged` from then on. |
| `skills_read_folder` | `path` | `SkillBundle` | "Add to team" from On this device (reads that skill's folder). §4.5 |
| `skills_read_zip` | `path` | `SkillBundle` | §4.5; if all entries share one top-level dir, strip it and use it as `suggested_name`, else the zip stem. Refuse entries with `..`/absolute paths and symlink entries (unix mode `0o120000`). Exec bit from unix mode `0o111`. |
| `skills_export_zip` | `dest, name, files: Vec<SkillFilePayload>` | `()` | `dest` comes from the save dialog (`.zip`). Entries `"<name>/<path>"`, deflate, unix mode 0o755 if executable else 0o644. Verify each sha first. Atomic: write `<dest>.tmp` then rename. |
| `skills_backups_dir` | `app` | `String` | `app_local_data_dir()/skill-backups` (created). For "Reveal". |

`name` validated by §1.1 (`invalid skill name`), every `path` by §1.2 (`invalid skill path: …`) —
Rust re-implements both; never trust the webview.

### 4.4 Install algorithm (`skills_install`)

1. Validate name, paths, caps (§1.3), that `marker.name == name`, that `marker.userId` (and
   skillId/orgId/serverUrl) is non-empty (else error `marker is missing its owner`), that `marker.files` has exactly
   the payload paths with the payload shas, and that each decoded payload hashes to its sha
   (mismatch ⇒ error `sha mismatch: <path>`, nothing written).
2. `dir = root/name`. If `dir` exists:
   - is a symlink or has no readable marker ⇒ `Conflict` (detail `unmanaged`);
   - marker `(skillId, orgId, serverUrl)` differs, or its `userId` is set and differs ⇒ `Conflict`
     (detail `other_owner`); a marker without `userId` is a legacy copy and counts as ours (the
     reinstall writes the user into it);
   - marker matches and current files hash exactly to `marker.files` (old marker) and
     `old.bundle_sha256 == marker.bundle_sha256` ⇒ `Unchanged`;
   - drifted (hash ≠ old marker) and `!force` ⇒ `Edited` (untouched);
   - drifted and `force` ⇒ copy `dir` to `backups/<name>-<YYYYMMDD-HHMMSS>/` first, `backup_path` set.
3. Stage in `root/.baalda-staging-<uuid>/`: create dirs, write each file (`write_atomic_fsync`),
   set unix mode 0o755/0o644, write the marker JSON (pretty, `installed_at` now) last. Re-hash the
   staged files against `marker.files`; any mismatch ⇒ delete staging, error.
4. Swap: if `dir` exists rename it to `root/.baalda-old-<uuid>`, rename staging → `dir`, then remove
   the old dir (failure to remove old is logged, not fatal). If the second rename fails, rename the
   old dir back. Return `Installed`.

Backups: `app_local_data_dir()/skill-backups/<name>-<timestamp>/` (copy, never move; symlinks
skipped). Same shape for `skills_remove`.

### 4.5 Reading an upload (`skills_read_folder` / `skills_read_zip`)

Walk without following symlinks; a symlink anywhere ⇒ error `symlinks are not allowed: <path>`.
Skip (listed in `skipped`): any component starting with `.` (incl. `.git`, `.DS_Store`),
`node_modules`, `__pycache__`, `.venv`, `venv`, `dist`, `build`, `target`. Skip files whose path fails
§1.2 (listed in `skipped` with the reason). Enforce §1.3 caps (error, not skip, when exceeded). Set
`executable` from the unix mode (always false on Windows). Root `SKILL.md` missing ⇒ error
`SKILL.md not found at the top of the folder`. `suggested_name` = folder name lowercased with
non-`[a-z0-9]` runs replaced by `-`, trimmed, ≤64.

### 4.6 `ipc.ts` bindings (R owns ONLY this block)

R appends this block at the **end** of `app/apps/desktop/src/lib/ipc.ts`, under the header
`// ---- Skills (skills_sync.rs) ----`, and touches nothing else in that file. U imports these.

```ts
export type SkillTarget = "claude" | "agents";
export interface SkillFilePayload { path: string; contentBase64: string; sha256: string; executable: boolean }
export interface SkillMarker { skillId: string; orgId: string; serverUrl: string; userId: string | null; name: string;
  version: number; bundleSha256: string; files: Record<string, string>; installedAt?: string }
export interface SkillOwner { skillId: string; orgId: string; serverUrl: string; userId: string }
export type SkillRemoveMode = "delete" | "release";
export interface SkillTargetInfo { target: SkillTarget; root: string; rootExists: boolean;
  toolInstalled: boolean; detectedTools: string[] }
export interface InstalledSkill { name: string; status: "managed" | "edited" | "unmanaged";
  marker: SkillMarker | null; editedFiles: string[] }
export interface SkillInstallOutcome { status: "installed" | "unchanged" | "conflict" | "edited";
  backupPath: string | null; detail: string | null }
export interface SkillRemoveOutcome { status: "removed" | "released" | "notFound" | "conflict"; backupPath: string | null }
export interface SkillBundle { suggestedName: string; files: SkillFilePayload[]; skipped: string[] }

export const skillsTargets = () => invoke<SkillTargetInfo[]>("skills_targets");
export const skillsScan = (target: SkillTarget) => invoke<InstalledSkill[]>("skills_scan", { target });
export const skillsInstall = (target: SkillTarget, name: string, marker: SkillMarker,
  files: SkillFilePayload[], force: boolean) =>
  invoke<SkillInstallOutcome>("skills_install", { target, name, marker, files, force });
export const skillsRemove = (target: SkillTarget, name: string, owner: SkillOwner, mode: SkillRemoveMode = "delete") =>
  invoke<SkillRemoveOutcome>("skills_remove", { target, name, owner, mode });
export const skillsReadFolder = (path: string) => invoke<SkillBundle>("skills_read_folder", { path });
export const skillsReadZip = (path: string) => invoke<SkillBundle>("skills_read_zip", { path });
export const skillsExportZip = (dest: string, name: string, files: SkillFilePayload[]) =>
  invoke<void>("skills_export_zip", { dest, name, files });
export const skillsBackupsDir = () => invoke<string>("skills_backups_dir");
```
Rust enum serde: `InstalledStatus`/`InstallStatus` lowercase; `RemoveStatus` camelCase (`notFound`).

GitHub tokens use the EXISTING generic `keychainSet/keychainGet/keychainDelete` (`ipc.ts` ~L1099);
no new Rust command.

## 5. Desktop TS/React (Stream U)

### 5.1 Module layout

```
src/lib/skills/types.ts        §2 verbatim
src/lib/skills/validate.ts     name/path rules (§1.1, §1.2), caps, parseSkillFrontmatter (reuse
                               lib/frontmatter/parse.ts where it fits), bundleSha256 (§1.5, WebCrypto)
src/lib/skills/prefs.ts        device-local prefs (localStorage, every access in try/catch)
src/lib/skills/syncEngine.ts   PURE planner + runner with injected deps (no ipc/api imports)
src/lib/skills/syncHost.ts     wires engine to ipc.ts/api.ts/toast/timers; start/stop; frame hook
src/lib/skills/github.ts       githubTokenKey only (the marketplace-import token's keychain key)
src/lib/skills/marketplace.ts  marketplace import parsers + GitHub reader (see the Addendum)
src/lib/skills/grouping.ts     Skills tab groups: team-made first, then one per import source
src/lib/skills/fileTree.ts     draft editor file tree (folders first, SKILL.md pinned)
src/lib/skills/skillMdEdit.ts  SKILL.md frontmatter split + description span edit
src/lib/skills/__tests__/…     see §7
src/components/skills/SkillsTab.tsx       Vault Settings → Skills (catalog)
src/components/skills/SkillDetail.tsx     page inside the tab (back link, like MemberProfilePage)
src/components/skills/SkillEditor.tsx     draft tree + CodeMirror editor + SKILL.md header, autosave
src/components/skills/SkillCodeEditor.tsx standalone CodeMirror 6 view, one undo history per file
src/lib/skills/publishNotes.ts            one-click Publish's auto release note
src/components/skills/MarketplaceBrowser.tsx  marketplace import page (+ the GitHub token row)
src/components/skills/SkillSourceRow.tsx      an imported skill's source + Pull update
src/components/skills/AiToolsTab.tsx      Account Settings → AI tools (this machine)
```

Existing files U edits: `src/lib/api.ts` (add an `// ---- Skills` block of `ApiClient` methods, one
per route in §3.3, plus `getSkillsManifest()`), `src/lib/settingsTabs.ts` (`"skills"` in
`SettingsTab`, `"ai-tools"` in `AccountSettingsTab`), `src/components/VaultSettingsDialog.tsx` (tab
after `mcp`), `src/components/AccountSettings.tsx` (tab after `notifications`),
`src/lib/sync/vaultProtocol.ts` (parse `skills-changed`), `src/lib/sync/vaultSyncEngine.ts`
(`onSkillsChanged?: (orgId: string) => void` option + branch next to `appearance-changed`),
`src/lib/sync/docSession.ts` (`setOnSkillsChanged(cb)` mirroring `onAppearanceChanged` at ~L1583),
`App.tsx` (or wherever the signed-in session starts) to call `startSkillsSync`/`stop`, and
`lib/serverFeatures.ts` only if a helper is needed (do NOT add `skills` to `REQUIRED_SERVER_FEATURES`).

### 5.2 Device prefs (`prefs.ts`, localStorage key `context.skills.device.v1`)

```ts
interface SkillsDevicePrefs {
  targets: { claude: boolean; agents: boolean };          // default both true
  optIns: Record<string, true>;                            // key `${serverUrl}|${orgId}|${skillId}`
  keepMine: Record<string, true>;                          // key `${serverUrl}|${orgId}|${skillId}|${target}`
  lastRunAt: string | null;
}
```
Server URL normalized like `serverFeatures.ts urlKey` (trim, strip trailing `/`).

### 5.3 Sync engine (pure)

`planSkillsSync(input) → SkillsPlan` where input = `{ serverUrl, userId, manifest: SkillsManifest,
prefs, targets: SkillTargetInfo[], installed: Record<SkillTarget, InstalledSkill[]> }` and the plan
is a list of actions:

```ts
type SkillAction =
  | { kind: "install"; target: SkillTarget; orgId: string; skill: ManifestSkill; fromVersion: number | null }
  | { kind: "remove"; target: SkillTarget; name: string; owner: SkillOwner; mode: "delete" | "release";
      reason: "deleted" | "optedOut" | "lostMembership" | "targetOff" }
  | { kind: "status"; target: SkillTarget; orgId: string; skillId: string; name: string;
      status: "conflict" | "edited" | "keptMine" | "upToDate" };
```
Rules:
- Wanted set per target (target pref on): for each org, each skill with `delivery==="required"` or
  opted-in.
- Owned (`isOurMarker`) = installed entries whose marker `serverUrl` equals the current one AND
  whose `userId` is missing/null (legacy) or equals the signed-in user. Every other marker is
  foreign: never removed (whatever the reason, target off included), never installed over, never
  the holder in a name clash; a foreign copy with a wanted name ⇒ `conflict`. The remove `owner`
  carries the signed-in user's id.
- Name collision between two orgs: the org whose marker already holds the dir keeps it; otherwise the
  first by `orgName` then `orgId`. Others ⇒ `status conflict`.
- Wanted + missing ⇒ install. Wanted + managed by us + `marker.version !== skill.version ||
  marker.bundleSha256 !== skill.bundleSha256` ⇒ install (`fromVersion = marker.version`).
  Wanted + `edited` ⇒ `status edited` (or `keptMine` when in `keepMine`); never install.
  `unmanaged` with the wanted name ⇒ `status conflict`.
- Owned + not wanted ⇒ `remove`, **only** for orgs present in this successful manifest or, for
  `lostMembership`, when the marker's `orgId` is absent from a successful manifest. A failed manifest
  fetch produces no plan at all. `mode` is `release` when the copy is `edited` or `keepMine` is set
  for that (skill, target): only the marker goes and the folder stays as the user's own skill.
  A clean copy gets `delete`. Removals come first in the plan so a freed name can be taken.
- `runSkillsPlan(plan, deps)` fetches version files (`GET …/versions/:v`) once per version, builds
  the marker (`files` map from the response, `bundleSha256` from the manifest, `userId` =
  `deps.userId`), calls `skillsInstall` with `force=false`, passes each remove's `mode`, and checks
  `deps.shouldStop()` before every action (a stopped or halted host runs nothing more). "Use team version" calls `skillsInstall` with `force=true` once and clears
  `keepMine`. "Keep mine" sets `keepMine`. Results feed a store slice for the UI.

### 5.4 Triggers (`syncHost.ts`)

`startSkillsSync({ api, getServerUrl, userId }) → () => void`, active only when signed in and the
server advertises `skills` (an unreadable `/health` skips the run; only a server that answered
without `skills` is "needs an update"). Runs: at start (launch/sign-in, after `skillsTargets()` re-detect), on any
`skills-changed` frame (debounced 500 ms; the frame only triggers a manifest refetch), every 2 min (and on coming back to the app),
and on "Check now". One run at a time (a request during a run queues one trailing run). Server or
account switch: App's effect (keyed on user id + server URL) stops the host and starts a new one.

The API client is shared and `store.setServerUrl` repoints it (with that server's saved token)
before App's effect can stop the old host, so:
- the host is **halted** whenever it is stopped, paused, or `normalizeServerUrl(api.getBaseUrl())`
  differs from the URL it started with; a run checks this before and after `/health`, after the
  manifest fetch, after the scans and between actions, and plans/acts on nothing once halted
  (otherwise the new server's manifest would plan `lostMembership` removals of the old server's
  copies and stamp the new server's skills with the old URL);
- `store.setServerUrl` calls `pauseSkillsSync()` first and resumes in `finally` unless a switch to a
  different URL landed (the effect then replaces the host). Resume triggers one run.

Toasts (`lib/toast.ts toast()`): one per updated skill, `Updated <name> v3 → v4`; first installs in
one run collapse into `Added <name> v1` (one) or `Added N team skills` (several). Removals and
conflicts are silent (visible in AI tools).

### 5.5 UI

Reuse `SettingsModal` tab chrome, `ConfirmDialog.tsx`, existing buttons/pills/tokens
(`--bg-hover`, access pill styles), the `MemberProfilePage` back-link page pattern. No bespoke designs.

**Vault Settings → Skills** (`SkillsTab`): server lacks `skills` ⇒ one line "This server needs an
update to manage skills." and nothing else. Otherwise a list (name, description, `Required`/`Optional`
pill, version `v4` or "Draft only", pinned marker). Admins: **New skill** (name prompt → create →
open detail), **Upload .zip** (Tauri dialog → `skillsReadZip` → create or replace draft of the
matching skill name, showing `skipped`; the Upload folder entry was removed 2026-10-27, and
`skillsReadFolder` now serves only "Add to team" from On this device). Members: read-only list
plus an "Use on this device" switch for Optional skills (writes `optIns`, triggers a run).

**SkillDetail**: header (name, description, delivery select Required/Optional, pin select
"Latest (vN)" / "vK"), tabs or sections: *Draft* (admins: `SkillEditor` — file list, select a text
file (UTF-8 decodable, ≤5 MiB, the per-file cap) to edit in a plain textarea or the app's CodeMirror if cheap, add text
file, delete file, live §1.4 validation, Save = PATCH with `baseRevision`; on 409 `stale_draft`
reload and tell the user), **Publish** (one click, no dialog since 2026-10-27: saves pending edits, then publishes with an auto
note from the changed files, `publishNotes.ts`; shown only when `draftDiffers`, refusals in plain words; was `PublishDialog`: notes, disabled when `!draftDiffers` or
invalid), *Versions* (list with notes, publisher, date; "Download .zip" → save dialog →
`skillsExportZip`; admins: "Restore to draft" → route #10), **Remove from team** (ConfirmDialog,
destructive; the same soft delete, also on each team card's admin ⋯).
`claude`/`anthropic` name warning per §1.1.

**Account Settings → AI tools** (`AiToolsTab`): per target a row: label (`Claude Code` / `Codex,
Cursor, Gemini CLI, Copilot, OpenCode`), resolved root path, "Installed"/"Not installed yet" from
`toolInstalled`/`detectedTools`, an on/off switch (prefs `targets`). Below, every skill this device
handles across vaults: name, vault, version, per-target status (`Up to date`, `Updating`, `Edited
here` with **Keep mine** / **Use team version**, `Name taken by another skill` for conflict, `Kept
yours`), Optional opt-in switch, "Check now", "Open backups folder" (`skillsBackupsDir` + existing
opener).

Shipped layout (2026-10-26 redesign): the Skills tab groups skills ("Shared with your team" first, then
one collapsible group per import source, `lib/skills/grouping.ts`) and shows them as a grid of cards
(the list view and its toggle were removed 2026-10-27; search is a toolbar icon). The "Team | On this
device" toggle counts both sides (the device scan runs once per session, `lib/skills/deviceScan.ts`)
and carries a pulsing dot until "On this device" is first opened on this computer
(`context.skills.deviceSeen`). The draft editor is a file tree (folders first, SKILL.md pinned, hover ⋯ to
delete, "+" for a file or folder) beside a CodeMirror 6 view (markdown in the body font, code in
mono with line numbers, one undo history per file, ⌘S). SKILL.md shows a Name (locked) /
Description header that edits the frontmatter with one span replacement (`skillMdEdit.ts`); a
frontmatter it can't read is shown raw. Drafts autosave about 1 s after typing stops (PATCH with
`baseRevision`); a `stale_draft` stops autosave and offers Load latest. An Expand button gives the
editor the whole settings panel (Esc leaves it).

Skill names are shown with a leading slash (`/team-hello`, `lib/skills/display.ts skillDisplayName`),
display only. A **Team | On this device** toggle (localStorage `context.skills.scope`) switches the
Skills tab to this computer's skills from Rust `skills_scan_device` (read-only), folded by `realPath`
and grouped by `lib/skills/deviceGrouping.ts`: From your team (Baalda-managed, with status), Your
skills (Claude / ~/.agents / Codex personal, tool badges), one group per Claude or Codex plugin,
Claude org (claude.ai) and Codex built-in. A device skill opens a read-only SKILL.md preview (read
through `skills_read_folder` on its `realPath`) with Reveal in Finder; admins can **Share with
team** (now labelled **Add to team**) a non-managed one: create + publish v1 "Added from <name>'s computer", then land on the Team grid with the card ringed (`useHighlightSkill`), refusing a name the
vault already uses.

2026-10-27 polish: cards follow Claude's skills directory: a very light grey fill just under the
panel (`text-primary` 3.5% over `--bg-surface`; 6% on hover, no lift), no border or shadow, 12px
radius; the icon tile is the surface with a hairline and a neutral glyph so it pops (dark: the card
5% lighter than the panel, the tile a touch darker). Three per row, two below
~760px of panel and one below ~480px (container queries on `.skills-scroll` or `.skills-grid-host`), rows of one height,
at least 168px tall. A neutral 40px icon tile (per-card palette tints were tried and dropped), `/name`, a
muted byline directly under the name ("By Sara Lee · v1", "anthropics/skills · v1", "Claude ·
Codex · 7 files", plus "Disabled in Claude" on device cards), and a description clipped at three
lines with a fade on the last line's end instead of "…" (`parts.tsx CardDescription`, only when it
overflows); the status square and
an admin's hover ⋯ sit at the top right. Skeleton cards are neutral (title, byline, three lines). No
logos on cards. Every grid draws the same `parts.tsx SkillCard`: the team and device grids and
Account Settings → AI tools, whose "Agent Skills" list is a grid of these cards too (byline
"v1 · Optional", with the vault name first only for people in more than one vault; the square
carries the state with no separate dot, and its amber "!" opens Keep mine / Use team version, the
name-taken choices, and Check again; the cards there don't open anything). A skill
page (team or device) shows a source pill ("Shared with your team", "From owner/repo", "Your skill",
"Claude plugin", "Claude org") and an "Available in" line of AI tools (`installState.ts
teamAvailability` / `deviceGrouping.ts deviceAvailability`): full when that tool can use the skill
here, faded with the reason when not. Device skills open in the same page as team skills, read
only (`DeviceSkillFiles.tsx` over `skills_list_device_skill_files` / `skills_read_device_skill_file`).
Search is a toolbar icon (⌘F or "/"); the tool filter chips were removed.

### 5.6 GitHub marketplace bridge — removed

Removed on 2026-10-26 with "Claude Chat & Cowork": the desktop no longer builds or pushes a plugin
marketplace. GitHub is only an import source; the admin's token (keychain key `githubTokenKey`) is
managed on the marketplace page and used only for reading repositories.

## 6. File ownership

| Stream | Owns (only it edits) |
|---|---|
| **S** | `app/apps/server/migrations/060_skills.sql`, `app/apps/server/src/skills/**`, `src/http/routes/skills.ts`, `src/mcp/skills.ts`, edits to `src/http/app.ts`, `src/mcp/tools.ts`, `src/sync/vault-protocol.ts`, `src/sync/vault-channel.ts`, `src/sync/member-events.ts`, `src/index.ts`, `tests/helpers/db.ts`, server `package.json`, `app/pnpm-lock.yaml`, new `app/apps/server/tests/skills*.test.ts` |
| **R** | `app/apps/desktop/src-tauri/src/skills_sync.rs`, `src-tauri/src/lib.rs` (mod + handler lines), `src-tauri/src/agent_runner.rs` (only `pub(crate) fn trusted_window`), `src-tauri/Cargo.toml` + `Cargo.lock` (adds `base64 = "0.22"`), the §4.6 block at the end of `src/lib/ipc.ts` |
| **U** | `app/apps/desktop/src/lib/skills/**`, `src/components/skills/**`, `src/lib/api.ts`, `src/lib/settingsTabs.ts`, `src/components/VaultSettingsDialog.tsx`, `src/components/AccountSettings.tsx`, `src/lib/sync/vaultProtocol.ts`, `src/lib/sync/vaultSyncEngine.ts`, `src/lib/sync/docSession.ts`, `App.tsx`/store slice for skills status, desktop tests under `src/lib/skills/__tests__/` and the sync protocol test |

No stream adds npm packages except S (`yaml`). Tauri capabilities: none needed (Rust does all I/O;
dialog plugin is already present — U uses `@tauri-apps/plugin-dialog` `open({directory:true})`,
`open({filters:[{name:"Zip",extensions:["zip"]}]})`, `save({defaultPath:"<name>-v<N>.zip"})`).
Docs (`CLAUDE.md`, `docs/STATUS.md`, this file) are updated by the lead at the end, not by a stream.

## 7. Tests (targeted only; no full suite)

**S** — scratch DB `context_test_skills`, never the dev DB:
```bash
docker exec -i $(docker ps -qf "publish=5439") createdb -U context context_test_skills 2>/dev/null || true
cd app/apps/server && DATABASE_URL=postgres://context:context@localhost:5439/context_test_skills \
  pnpm vitest run tests/skills.test.ts tests/skills-mcp.test.ts tests/skills-protocol.test.ts
```
- `skills.test.ts`: create (seed SKILL.md, invalid name 400, duplicate 409, re-create after delete
  OK); member 403 on every admin route, non-member 404; draft PUT/PATCH revision bump + 409
  `stale_draft`; path validation (`..`, dotfile, `a:b`, CI duplicate); caps at their exact
  boundaries (1001 files, 5 MiB+1 per file, 25 MiB+1 total, a body past 36 MiB; a full 25 MiB version
  downloads intact with and without gzip); publish v1/v2 numbering, `nothing_to_publish`, `name_mismatch`, `missing_skill_md`;
  versions immutable after later draft edits; pin/unpin + `unknown_version`; members see only
  published; manifest lists every membership org (incl. zero skills), effective = pinned ?? latest,
  excludes deleted/unpublished; the removed settings routes answer 404; `/health` has
  `skills`; `skills-changed` announced on publish/patch/delete (stub publisher).
- `skills-mcp.test.ts`: list/get/read through a token for org A cannot see org B; drafts hidden;
  binary file ⇒ `binary: true`; `maxChars` truncation.
- `skills-protocol.test.ts`: `PS_SKILLS_CHANGED` encode/decode round trip, bad JSON ⇒ null.

**R** — `cd app/apps/desktop/src-tauri && cargo test skills_sync` (inline `#[cfg(test)]`, `tempfile`
roots, pure root resolvers; never touch the real home): name/path validators (incl. Windows names);
install fresh; unchanged; update swaps atomically and leaves no `.baalda-*` dirs; unmanaged ⇒
conflict and untouched; other owner ⇒ conflict; drift ⇒ `edited` untouched; `force` backs up then
overwrites; sha mismatch writes nothing; remove with matching/mismatching owner, drifted remove backs
up; symlink inside skill dir ⇒ edited and never followed; symlinked root refused; read_folder skips
dotfiles/node_modules, refuses symlinks, enforces caps, requires SKILL.md; read_zip strips the single
top dir, refuses `..` and symlink entries; export_zip round-trips through read_zip with exec bits;
`CLAUDE_CONFIG_DIR` resolution (absolute honoured, relative ignored).

**U** — `cd app/apps/desktop && pnpm vitest run src/lib/skills src/lib/sync/__tests__/vaultProtocol*`:
- `syncEngine.test.ts`: required vs optional + opt-in; target off ⇒ remove;
  version bump ⇒ install with `fromVersion`; edited ⇒ no install, keepMine ⇒ `keptMine`; unmanaged
  ⇒ conflict; other server's marker never touched; cross-org name collision winner; deleted skill /
  lost membership ⇒ remove; failed manifest ⇒ empty plan.
- `validate.test.ts`: name/path rules equal to §1.1/§1.2 table cases; `bundleSha256` known vector
  (S must use the same vector: files `SKILL.md` = `"---\nname: a\ndescription: b\n---\n"`, not
  executable — both streams assert the same hex, computed once by S and pasted into both tests).
- `github.test.ts`: the token's keychain key. `marketplace.test.ts`, `grouping.test.ts`,
  `fileTree.test.ts`, `skillMdEdit.test.ts`: the import parsers, Skills tab groups, editor tree and
  SKILL.md description span edit (synthetic fixtures only).
- `prefs.test.ts`: defaults, corrupted JSON, throwing localStorage.
- vault protocol: `skills-changed` frame parses; missing `orgId` rejected.

## 8. Docs to update at the end (lead)

Done 2026-10-26: `CLAUDE.md` (Desktop Rust core, sync, settings tabs, server bullet, tables) and
`docs/STATUS.md`. The draft below is kept for history; CLAUDE.md is the corrected version.

`CLAUDE.md`, a new subsection after "Baalda Assistant engine":

> ### Skills (team AI skills, `docs/SKILLS.md`)
> A vault's skills live in server tables (`skills`, `skill_versions`, `skill_version_files`,
> `skill_draft_files`, `skill_sources`, migration 060), never in blobs or notes. Owners/admins edit
> one draft per skill and **Publish** it into an immutable numbered version; only published versions
> are delivered. Effective version = pinned ?? latest. Required skills install for every member;
> Optional ones are opted into per device. `GET /api/skills/manifest` lists every membership org;
> the vault channel's `skills-changed` frame (PS 0x0f) and a 2-min poll (plus a check when the app comes back to the front) trigger a desktop run.
> Rust `skills_sync.rs` writes only `<claude config dir>/skills/<name>` and `~/.agents/skills/<name>`
> (never `~/.codex/skills`), only folders carrying `.baalda-managed.json`, stages then swaps
> atomically, never overwrites local edits without "Use team version" (backup first, app data
> `skill-backups/`), and removes only after a successful manifest. MCP: `list_skills`, `get_skill`,
> `read_skill_file`. `/health` feature `skills`. Free on every plan.

Also: add the five tables to the "Postgres tables" list, `skills` to the `/health` features list,
the three MCP tools to the MCP tool list, `skills_sync.rs` under "Desktop — Rust core", the
`skills-changed` frame next to `appearance-changed`, and a line in `docs/STATUS.md`.

## 9. Open points / known limits

- `CLAUDE_CONFIG_DIR` set only in a shell rc is invisible to the GUI app on macOS; the UI shows the
  resolved path. A launchd-level variable works.
- Claude Desktop Chat/Cowork cannot be reached from local files; a skill's .zip (Versions →
  Download .zip) can be uploaded in claude.ai by hand.
- No purge of soft-deleted skills or old versions in v1 (≤25 MiB per version).
- Opt-ins are per device (not synced across a user's devices) by design.

## Deviations — Stream S

Wire shapes in §2/§3.3 are unchanged. Where the spec was silent or had to bend:

- **Bundle hash vector (§7):** `SKILL.md` = `"---\nname: a\ndescription: b\n---\n"`, not executable ⇒
  file sha `a98e4e3c6591006048de00b4ec52ad408c39cbaf09f591f4f620ea6a17cbfe3e`, bundle
  `e31c3545cce6aa9d32d280b0348168b086082496410f08b32c7b2b5f0bb434b6` (cross-checked with `shasum`).
- **`yaml` dependency:** pnpm recorded `"yaml": "^2.9.1"` (2.9.1 resolved; satisfies `^2.8.1`). The
  lockfile also gains `(yaml@2.9.1)` peer suffixes on the desktop's `vite`/`vitest` entries (peer
  resolution only, no new desktop package).
- **Existing test touched outside §6:** `tests/mcp-access-surface.test.ts` lists every MCP tool name
  and every read-only tool exactly; it now includes `list_skills`, `get_skill`, `read_skill_file`
  (it fails otherwise).
- **Unnamed error codes:** malformed bodies answer 400 `{error:"invalid_request"}` (body not an
  object, non-integer `baseRevision`, `delivery` not required/optional, `files`/`upsert`/`remove` not
  arrays, non-boolean `executable`). `skill_limit_reached` is **409**. A
  non-integer `pinnedVersion` is 400 `unknown_version`; a reset to a non-integer or missing version is
  404 `version_not_found`. `invalid_path` carries `{ path, reason }` (`reason` one of `empty`,
  `too_long`, `forbidden_character`, `empty_component`, `component_too_long`, `dotfile`,
  `trailing_dot_or_space`, `reserved_name`, `duplicate`); `invalid_base64`, `sha_mismatch` and the
  per-file `skill_file_too_large` from an upload carry `path`.
- **Caps raised 2026-10-27** to 1000 files / 5 MiB per file / 25 MiB per version. The size errors are
  now **413** (`skill_file_too_large`, `skill_too_large`; was 400), the body limit answers
  `skill_too_large` (was `payload_too_large`), and every cap refusal carries `limit` and `message`.
  The strict base64 check is a flat character class plus a length-multiple-of-4 test: the old grouped
  regex overflowed V8's regex stack on a multi-megabyte file (a 500 before the raise).
- **Path lengths (§1.2)** count Unicode code points (Rust `chars().count()`, JS `[...s].length`), not
  bytes or UTF-16 units. The reserved-name stem is the text before a component's first `.`.
- **Frontmatter (§1.4):** CRLF line endings and a leading BOM are accepted; `description` must
  contain non-whitespace; duplicate YAML keys are `bad_yaml`. `draft_description` is derived without
  the name check (best effort).
- **Draft PATCH (#9):** an `upsert` whose path matches an existing draft file case-insensitively
  replaces it (so a case-only rename is possible); `remove` matches the exact path.
- **MCP `read_skill_file`:** exact path first, then a case-insensitive match.

## Deviations — Stream R

Command names, argument names and every wire shape in §4.2/§4.6 are unchanged. Behavioural notes:

- Review follow-up (2026-10-26, now in the main text): `SkillMarker.userId` / `SkillOwner.userId`
  and `skills_remove`'s optional `mode` (`delete` | `release`, status `released`).

- `skills_install` also takes `app: tauri::AppHandle` (injected by Tauri; the JS call is unchanged)
  because a forced install writes its backup under app data.
- `Unchanged` requires a clean folder AND the same `bundleSha256`, `version` and `files` map as the
  new marker. A clean folder whose marker names another version is reinstalled (cheap), so a marker
  never stays on an old version number when two versions share a bundle hash.
- A marker whose `name` differs from its folder's name is treated as no marker: `unmanaged` in scan,
  `Conflict`/`unmanaged` on install, `Conflict` on remove. A copied/renamed folder is never ours.
- A root outside home (absolute `CLAUDE_CONFIG_DIR`) is symlink-checked from the config dir down
  (config dir + its `skills`), not up to `/` (macOS `/var`, `/tmp` are system symlinks).
- Uploads: the skip rules run BEFORE the symlink refusal, so a symlink inside a skipped folder
  (`node_modules/.bin/*`, `.venv`) does not fail the upload; any symlink that would be read still
  errors. `node_modules`/`__pycache__`/`venv`/`dist`/`build`/`target` skip folders only (a file
  named `build` is kept). `__MACOSX` (Finder zips) is also skipped and ignored when finding the
  zip's single top folder, as are dot-names. Paths differing only in case: later one is skipped
  (listed), not an error. Webview payloads with a case duplicate are an error.
- Zip: `\` separators are normalised to `/` and `.` components dropped before the `..`/absolute/drive
  checks; more than 20,000 entries is refused; every entry is read through a 5 MiB + 1 cap whatever
  its declared size; exec bits come from the entry's unix mode on every platform.
- Cap error strings: `too many files (max 1000)`, `file too large: <path> (max 5 MiB)`,
  `skill too large (max 25 MiB)` (raised 2026-10-27 from 200 / 1 MiB / 5 MiB: a real 358-file,
  9.3 MiB skill hit the old file cap); path errors `invalid skill path: <path> (<reason>)`.
- Install and remove are serialised by a process-wide lock.

- **Remove from team (2026-10-27):** the skill page's ⋯ and an admin ⋯ on each team card (shown on
  hover beside the status square: Open, Download .zip, Remove from team) share
  `RemoveFromTeamDialog.tsx`: "Remove /x from the team?", "Removes it from everyone's AI tools." plus
  "Your own local copy isn't touched." (or "Your original folder on your computer stays as it is."
  when the skill was added from a computer or an unmanaged folder of that name is on this one),
  busy label "Removing…", toast "Removed /x from the team"; the card fades out before the reload.
  It is `DELETE /skills/:id` (soft delete), so each device's next run removes its clean copies.
- **Name taken by the person's own folder (2026-10-27):** the planner offers an unmanaged folder of
  the wanted name to `skillsInstall` once per version (Rust adopts an identical one as `adopted`,
  which counts as up to date with no toast); a version it refused is remembered for the session
  (`knownConflicts`) and shown as conflict. Fix… then offers **Use team version** (your copy is
  backed up first; `replaceUnmanaged: true`, `syncHost.replaceNameTakenSkill`), **Keep my own**
  (the keep-mine pref, so the planner reports `keptMine` and leaves the folder alone) and
  **Reveal in Finder** (Explorer/file manager elsewhere). "Add to team" from On this device runs a
  sync at once so the original folder is adopted right away. Each conflict carries why
  (`ConflictKind`: `unmanaged` from Rust's `detail`, or `other_owner` for another skill, vault,
  server or user); Use team version and Keep my own appear only for `unmanaged`, and never for a
  symlinked folder (from the device scan). The line under the header says which it is.
- **Name (2026-10-27):** the feature is called **Agent Skills** in the UI (sidebar shortcut, Vault
  Settings tab, page title, "← Agent Skills" back links, the AI tools section). Sentences about the
  items keep "skill(s)"; identifiers, routes, tab ids and prefs keys stay `skills`.
- **Install square tips (2026-10-27):** every square (+, ✓, !, also the marketplace's) shows an
  instant tooltip after 150ms (`SquareTip.tsx`), never the OS `title`. A Required ✓ is fixed, not
  a toggle: a lock badge, a quieter fill, `cursor: help`; hover says "Required by your team · It's
  always installed on everyone's computer and can't be removed." plus the per-tool lines (admins:
  "Change it to Optional on the skill's page."), and a click or Enter/Space opens the same text as
  a popover with "Make optional" (admins; the same PATCH, then a toast) and "Got it". The skill
  page's "✓ Installed for everyone" and the AI tools grid behave the same.
- **Sidebar Skills shortcut (experimental, `SHOW_SKILLS_SHORTCUT`):** at the bottom of the sidebar
  just above the profile section (outside the footer and its divider), its box copied from a file
  tree row (full bleed, 32px, flat hover). A "New" chip shows beside the count for 14 days from its
  first showing on this computer (localStorage `context.skills.newChip.v3`, a timestamp; no storage
  ⇒ the session): a flat inline accent tag 6px after the label (16% fill, 30% hairline, no halo),
  a slow light sweep through its letters only, and nine tiny sparkles over the label and tag on
  staggered 1.6–2.6s loops (2–3 lit at a time); the plain tag under reduced motion. The attention dot and the muted
  team count show as well.

## Addendum — Marketplace import (server)

Status: implemented by Stream S, 2026-10-26, inside migration `060_skills.sql`. The server never
calls GitHub. The desktop fetches marketplaces and skill folders, then records what it imported.

### Schema (in 060)

- `skills.source JSONB` (null for skills made in Baalda).
- `skill_sources (id TEXT pk, org_id → organization ON DELETE CASCADE, repo TEXT CHECK
  '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', ref TEXT NULL, label TEXT NULL, added_by → user, added_at)`.
  It has a unique index on `(org_id, lower(repo), coalesce(ref,''))`.
- `tests/helpers/db.ts` resets `skill_sources` too.

### Wire types (add to both `types.ts` files)

```ts
/** Where an imported skill came from. Recorded by the desktop that fetched it. */
export interface SkillOrigin {
  repo: string;              // "owner/name", ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$, ≤200 chars
  ref: string | null;        // branch/tag asked for, ^[A-Za-z0-9._/-]{1,255}$; null = default branch
  path: string;              // skill folder inside the repo; "" = repo root; ≤500 chars
  commitSha: string;         // lowercase hex, 40 or 64 chars
  treeSha: string;           // the skill folder's tree sha, lowercase hex, 40 or 64 chars
  pluginName?: string | null; // optional; when present a non-empty string ≤100 chars, or null
}

/** A GitHub marketplace admins import skills from. */
export interface SkillSource {
  id: string;
  orgId: string;
  repo: string;
  ref: string | null;
  label: string | null;
  addedBy: { id: string; name: string } | null;
  addedAt: string;           // ISO
}

// Additions to existing types:
//   SkillSummary.source: SkillOrigin | null    (so SkillDetail and every catalog entry carry it)
//   ManifestSkill.source: SkillOrigin | null
```

- `SkillOrigin.path` is a repo path, not a skill `relPath`. Dotted folders like `.claude/skills/pdf`
  are allowed. Refused: control characters, `\`, a `.` or `..` component, and empty components
  (`a//b`, leading or trailing `/`), except that `""` alone means the repo root.
- Unknown keys are refused.
- An omitted `ref` is stored as `null`. An omitted `pluginName` stays omitted.
- Any failure returns 400 `{ error: "invalid_source", key }`, where `key` is the offending field or
  `"source"` when the value is not an object.

### Routes (under `/api`)

| Method + path | Who | Request | Response |
|---|---|---|---|
| `GET /orgs/:orgId/skill-sources` | member | — | `{ sources: SkillSource[] }`, oldest first |
| `POST /orgs/:orgId/skill-sources` | owner/admin | `{ repo: string; ref?: string \| null; label?: string \| null }` | 201 `SkillSource` |
| `DELETE /orgs/:orgId/skill-sources/:sourceId` | owner/admin | — | `{ ok: true }` |

- **Errors:**
  - `invalid_repo` (400)
  - `invalid_ref` (400): `""` is treated as null, not as an error
  - `invalid_label` (400): over 100 chars, or not a string; the label is trimmed and `""` becomes null
  - `skill_source_exists` (409): same repo ignoring case, and same ref (null and `""` are the same)
  - `skill_source_limit_reached` (409): more than 100 sources per org
  - `skill_source_not_found` (404): unknown id, or an id belonging to another org
- **Gates:** the usual 401, plus 404 `not_member` and 403 `skills_admin_required`.
- Sources are not delivered anywhere, so no `skills-changed` frame is sent.

`source` on skills:

- **Create** (`POST /orgs/:orgId/skills`): optional `source?: SkillOrigin | null`.
- **PATCH** (`PATCH /orgs/:orgId/skills/:skillId`): optional `source?: SkillOrigin | null`. `null`
  unlinks the skill. Leaving the key out keeps the stored value. PATCH still announces
  `skills-changed`.
- **Draft PUT** (`PUT /orgs/:orgId/skills/:skillId/draft`): optional `source?: SkillOrigin | null`.
  Use this for a **pull update**: the new content and the new `commitSha`/`treeSha` commit together
  under the same `baseRevision` check. Then Publish as usual. Leaving `source` out keeps it. Draft
  PATCH and draft reset never change it.
- **Version history:** `source` belongs to the skill, not to a version, so it is not stored per
  version.
- **Responses:** `source` is returned (`null` when unset) in `GET /orgs/:orgId/skills`, `GET …/:skillId`,
  the POST/PATCH skill responses, and every `ManifestSkill` in `GET /skills/manifest`.
- **MCP:** unchanged. MCP does not expose `source`.

## Deviations — Stream U

- **Device status store:** the AI tools view reads a module-level store in `lib/skills/syncHost.ts`
  (`useSkillsDeviceState`, the `toast.ts` pattern), not a Zustand slice; `store.ts` is untouched.
- **Frame hook wiring:** `syncHost.ts` exports `notifySkillsChanged(orgId)`; `App.tsx` registers it with
  `syncManager.setOnSkillsChanged(...)` next to `startSkillsSync`, so `syncHost` never imports `docSession`.
- **SKILL.md live check:** `validate.ts parseSkillFrontmatter` is its own narrow reader (plain, quoted and
  `|`/`>` block scalars for `name`/`description`, other keys only structure-checked, `: ` inside a plain
  scalar flagged as `bad_yaml`) instead of `lib/frontmatter/parse.ts`, which refuses the nested keys and
  block scalars skills commonly use. The server's `yaml` parse stays the authority at publish.
- **Extra exports:** `api.ts skillErrorCode(e)` (the `error` code of a refusal); `types.ts
  SkillVersionWithFiles` (route #12's shape, desktop-only section below the verbatim wire types);
  (the GitHub publish helpers listed here earlier were removed with the bridge).
- **Unknown server features:** when `/health` cannot be read (empty feature set), a sync run is skipped
  rather than attempted; the Skills tab still tries the catalog. Only a server that answered without
  `skills` shows "needs an update".
- **Targets:** per §5.3 a target installs whenever its switch is on, whether or not the tool was detected.

## Addendum — Marketplace import

Status: Stream U, 2026-10-26. Admins add skills from GitHub repos without leaving Baalda. The
desktop does every GitHub call; the server stores only sources and each skill's `source`
(see "Addendum — Marketplace import (server)").

### Flow

1. **Vault Settings → Skills → Add from marketplace** (admins). Paste `owner/repo`, a GitHub URL
   (`https://github.com/o/r`, `…/tree/<ref>`), or `owner/repo@ref`, plus an optional branch or tag.
   It is saved as a vault source (`POST /orgs/:orgId/skill-sources`) and opened. Saved sources are
   listed for browsing again and can be removed (no confirm: removing a source never touches skills).
2. **Browse.** `GET /repos/{repo}/commits/{ref ?? "HEAD"}` (commit + root tree sha), then ONE
   `GET /repos/{repo}/git/trees/{treeSha}?recursive=1` (a `truncated` tree is refused). The format
   is detected on that tree, first match wins:
   - **Claude marketplace**: `.claude-plugin/marketplace.json` → `plugins[]`. Sources: a relative
     path string (resolved against `metadata.pluginRoot` when set) or `{source:"github", repo,
     ref?, path?}` (its own commit + tree calls). Any other source type is listed as "not supported
     yet". A plugin's skills: the entry's `skills` paths (anthropics/skills uses this with
     `strict:false`), else `plugin.json`'s `skills` paths (in `<root>/.claude-plugin/plugin.json`),
     plus the default `<root>/skills/*/SKILL.md`. A listed path is a skill folder when it holds
     `SKILL.md`, otherwise its child folders that do.
   - **Codex marketplace**: `.agents/plugins/marketplace.json` with the same `plugins[]` reading
     (a source may also be `{source:"local", path}`), manifests at `<root>/.codex-plugin/plugin.json`.
   - **Skills repo**: every `SKILL.md` whose folder is at most 5 levels deep, outside
     `node_modules`. Covers `anthropics/skills` style and `openai/skills` (`skills/.curated/...`).
   - A marketplace that yields no skills falls back to the skills-repo scan.
   Only each `SKILL.md` is fetched for the listing (name + description); file lists and sizes come
   from the tree. Folder files are fetched only on import. Rows appear as soon as the shape is known
   (`browseMarketplace`'s `onPartial`, every row `pending`) and descriptions fill in, 16 reads at a
   time: a 300-skill marketplace shows its rows in seconds and finishes describing in ~40 s.
3. **Fetching.** With the admin's GitHub token (`githubTokenKey(serverUrl, orgId)`, the same keychain
   entry the marketplace page's "GitHub token" row saves) everything goes through the REST API (`/git/blobs`); without one,
   file bytes come from `raw.githubusercontent.com/{repo}/{commitSha}/{path}` so a public repo costs
   only the two API calls of the 60/hour anonymous budget. At most 6 downloads in flight.
   Errors in plain words: 404 ("can't find it, or it's private: add a token"), rate limit with the
   reset time, 401 (token refused), truncated tree, network.
4. **Import.** Files inside the skill folder follow the upload rules (§4.5): dot-components,
   `node_modules`, `__pycache__`, `.venv`, `venv`, `dist`, `build`, `target`, symlinks and submodules
   are skipped; paths failing §1.2 are skipped; §1.3 caps are checked from tree sizes before any
   download (over a cap ⇒ the row says why and Import is disabled). The skill name is the SKILL.md
   `name` when valid, else the folder name made valid; it must then match SKILL.md for publish.
   A name already used by a vault skill that was not imported from the same `repo` + `path` is
   refused ("A skill named x already exists in this vault."). Import = `POST …/skills` with files
   and `source: { repo, ref, path, commitSha, treeSha, pluginName? }`, then publish v1 with notes
   `Imported from owner/repo@<7-char sha>`. Delivery stays the server default, Optional. A refused
   publish keeps the draft and says why.
5. **Status per row.** A vault skill whose `source.repo` (case-insensitive) and `source.path` equal
   the row's shows **Imported**, or **Update available** when `source.treeSha` differs from the
   folder's tree sha now. **Pull update** writes the upstream files into the draft with the new
   `source` (`PUT …/draft` with `source`), then opens the skill so the admin reviews and publishes.
6. **UI.** Skeleton rows while a source loads, a spinner inside each Import/Pull update button (the
   button is disabled while it runs), a toast when an import or pull finishes, and empty/error
   states. Rows are grouped by plugin for marketplaces; a filter box appears above 12 skills.

### Modules

- `src/lib/skills/marketplace.ts`: pure parsers (`parseRepoInput`, `detectMarketplace` over a tree
  listing + already-fetched manifests, `skillFolderFiles`, `importStatus`) and a small GitHub reader
  (`createGitHubReader({ fetchImpl, token })`: `resolveCommit`, `tree`, `readText`, `readBytes`) plus
  `browseMarketplace` / `fetchSkillFolder`. Tests use synthetic fixtures only.
- `src/components/skills/MarketplaceBrowser.tsx`: the page inside the Skills tab.
- Real-repo smoke script lives OUTSIDE the repo (scratchpad); no fetched content is committed.

### Known limits

- A repo whose recursive tree GitHub truncates (very large monorepos) cannot be browsed; the error
  says so. A per-plugin, non-recursive walk is the fix if it matters.
- Describing reads one SKILL.md per request. With a token, GraphQL could batch ~100 per query.
- Imports keep §1.3 caps: upstream skills over 1 MB per file, 5 MB or 200 files show why and
  cannot be imported.

### Follow-up (cross-stream review)

Changes to §4.2/§4.3/§4.6:

- **`userId` in the marker.** `SkillMarker` gains `userId` (Rust `user_id: Option<String>`,
  `#[serde(default)]`; TS `userId: string | null`), placed after `serverUrl`. `skills_install` requires a non-empty
  `marker.userId` (else error `marker is missing its owner`). Scan returns it; `null` means a marker
  written before the field existed.
- **`SkillOwner` gains `userId: string`.** Ownership = same `skillId` + `orgId` + `serverUrl`, and the
  existing marker's `userId` is `null` (legacy, treated as matching; a reinstall writes the user) or
  equal. Otherwise install ⇒ `Conflict` detail `other_owner`, remove (either mode) ⇒ `conflict`;
  the folder is never touched.
- **`skills_remove` takes `mode?: "delete" | "release"`** (Rust `Option<RemoveMode>`, default
  `delete`). `release` runs the same checks (missing ⇒ `notFound`; no/foreign marker or other
  owner ⇒ `conflict`), then deletes ONLY `.baalda-managed.json` — no backup, files untouched — and
  returns the new status **`released`**. The folder then scans as `unmanaged`.
  TS: `export type SkillRemoveMode = "delete" | "release"`;
  `skillsRemove(target, name, owner, mode: SkillRemoveMode = "delete")`;
  `SkillRemoveOutcome.status: "removed" | "released" | "notFound" | "conflict"`.
- **`skills_export_zip`** writes to a unique hidden sibling `.baalda-export-<uuid>` in the destination
  folder, opened with `create_new` (only a file this call created is ever cleaned up), then renames it
  over `dest`. A fixed `<dest>.tmp` is no longer used.

## Removed — GitHub publish bridge (server)

Status: removed by Stream S on 2026-10-26, when the founder dropped "Claude Chat & Cowork via GitHub
marketplace publish". GitHub stays only as an **import** source: `skill_sources` and `skills.source`
are unchanged (see "Addendum — Marketplace import (server)").

Gone from the server, edited in place in the undeployed migration 060:
- **Table:** `skill_settings`. It held only the bridge fields plus `skip_claude_local`, so the whole
  table is dropped.
- **Routes** (they now answer 404):
  - #13 `GET /orgs/:orgId/skill-settings`
  - #14 `PUT /orgs/:orgId/skill-settings`
  - #15 `POST /orgs/:orgId/skill-settings/github-sync`
- **Wire types:**
  - `SkillSettings` is deleted.
  - `SkillsCatalog.settings` is deleted, so the catalog is now `{ role, skills }`.
  - `ManifestOrg.skipClaudeLocal` is deleted, so every org in the manifest installs the `claude`
    target whenever the device's target switch is on.
- **Error codes that no longer exist:** `invalid_branch`, `invalid_plugin_name`, and `invalid_repo`
  on settings. `invalid_repo` remains on `POST /skill-sources`.
- **Frame:** `skills-changed` is no longer sent for settings. It still fires on publish, PATCH and
  delete.

Desktop side, done by Stream U the same day: the `skipClaudeLocal` remove reason and planner branch,
GitHubSyncPanel, the Skills tab and AI tools Chat rows, the `github.ts` builder/PR client and their
tests, and the api.ts skill-settings calls are gone; the token row moved to the marketplace page.

### Addition: `skills_scan_device` (read-only)

`skillsScanDevice() → { entries: DeviceSkill[]; errors: string[] }` (TS `DeviceSkillScan`, `SkillLocation`,
`DeviceSkill` in the ipc.ts skills block). Lists `<claude config>/skills/*` (`claudePersonal`, minus
`synced/`), `…/skills/synced/<org>/*` (`claudeSynced`), `~/.agents/skills/*`, `$CODEX_HOME|~/.codex`
`/skills/*` (`codexPersonal`) and `/skills/.system/*` (`codexSystem`), installed Claude plugins from
`plugins/installed_plugins.json` (`<installPath>/skills/*`) and Codex plugins enabled in `config.toml`
(`plugins/cache/<marketplace>/<plugin>/<newest version dir>/skills/*`, line-based `[plugins."…"]`
parse, keys that are not plain path components ignored). Reads only SKILL.md (≤64 KiB, frontmatter
`name`/`description`), those two index files (≤4 MiB) and metadata; writes nothing. Size walk stops
at 200 files / 10 MiB (`truncated`), the scan at 2000 entries; errors are per-root strings.
Errors are `{ root, error }` (TS `DeviceScanError`). Preview: `skillsReadDeviceSkillMd(path) →
{ text, truncated }` (`skills_read_device_skill_md`) reads ≤256 KiB of `<path>/SKILL.md` only when
`path` is absolute, has no `.`/`..`, and lies strictly inside the Claude config dir, `~/.agents/skills`,
the Codex home or an installed Claude plugin's installPath (lexical check, so a symlinked skill
previews through its link). `skillsReadFolder` refuses a symlinked folder: "Add to team" passes
`realPath`.
`DeviceSkill.enabled: boolean | null`: Claude plugins from `<claude config>/settings.json`
`enabledPlugins["name@marketplace"]` (read-only; `false` ⇒ false, `true` or absent ⇒ true — on the
reference Mac every installed plugin had a key, all `true`, so "absent ⇒ enabled" is unverified;
project/local settings files are not consulted); a missing or unparseable settings.json ⇒ `null` plus
one error. Codex plugins `true` (only enabled ones are listed). Everything else `null`.
Device skill file tree (read-only, same allowed-roots gate as the preview, `path` as scanned):
`skillsListDeviceSkillFiles(path) → { files: { relPath, size, isSymlink, isBinary }[], truncated }`
(files only, sorted; upload noise rules skip dot-names/`node_modules`/…; nested symlinks listed, never
followed, `isBinary: null`; `isBinary` from the first 8 KiB; cap 2000) and
`skillsReadDeviceSkillFile(path, relPath) → { text, truncated, binary }` (§1.2 validator, no symlink
component, regular file only, ≤512 KiB cut on a char boundary; NUL in the first 8 KiB or invalid
UTF-8 ⇒ `binary: true, text: null`). A file whose name fails §1.2 is listed but not readable.

### Install: adopt and replace an unmanaged folder (2026-10-27)

`skillsInstall(target, name, marker, files, force, replaceUnmanaged = false)`; new status `adopted`.
For an existing folder that is not a symlink and carries no marker of ours (no marker, or one naming
another folder): if its files, read with `skills_read_folder`'s skip rules, equal `marker.files`
exactly (relPath + sha256), only `.baalda-managed.json` is written and the result is `adopted` (no
flag needed, no other file touched). Otherwise `replaceUnmanaged: true` backs the folder up to
`skill-backups/` and installs over it (`installed` + `backupPath`); without the flag it stays
`conflict`/`unmanaged`. Any marker naming another owner (skill, vault, server or user), even under
another folder name, is `conflict`/`other_owner`; a symlinked folder is `conflict`/`unmanaged` — the
flag never applies to either. Drift detection (scan, install, remove) now ignores `.DS_Store`,
`Thumbs.db` and `__pycache__/`, so an adopted folder (or a managed one Finder browsed) is not
"edited" for OS/Python droppings; an update replaces them without a backup.
