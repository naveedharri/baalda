import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

/**
 * Effective-permission resolver (spec 04 §3, plus locks).
 *
 *   1. Vault owner/admin  -> `edit` on everything in the vault.
 *   2. Else take the MAX of: a share on the file itself, a share on a
 *      containing folder (walking parent_id up to the root), and a
 *      vault-scoped grant (org-wide "Open"/"Read-only", or per-user).
 *   3. `edit > view > none`. Folder grants inherit to descendants; a file
 *      share can only RAISE permission. No matching grant -> `none`.
 *
 * A plain `member` inherits the vault grant and so gets `edit` in a vault that
 * is Shared — which a new vault is, by default (`POST /api/vaults`). With no
 * grant at all (a vault set to Private, or one created while private-by-default
 * was the rule) a member has no content access beyond notes it created: `none`.
 *
 * Denies (permission = 'denied') come in two flavours, both resolved BEFORE the
 * rules above and both applying to owners and admins: a per-USER deny is
 * `none`, full stop; an ORG deny (the item set to Private) leaves only the
 * creator and explicit per-user grants. See {@link isDenied}.
 *
 * Locks (permission = 'locked') are a cap overlay resolved AFTER the rules
 * above: when a lock matches the doc or any ancestor folder — for this user
 * (principal_type 'user') or the whole vault (principal_type 'org') — the
 * result is capped at `view`. Owners/admins are capped too (the point of a
 * lock is protecting content from accidental edits); they can still unlock
 * via the shares API. A lock never GRANTS access: `none` stays `none`.
 */
export type Permission = "edit" | "view" | "none";

const RANK: Record<Permission, number> = { none: 0, view: 1, edit: 2 };

export function maxPermission(a: Permission, b: Permission): Permission {
  return RANK[a] >= RANK[b] ? a : b;
}

type Queryable = Pick<pg.Pool, "query">;

interface DocLocation {
  vaultId: string;
  folderId: string | null;
  organizationId: string;
  /** Creator of the note (null for files, which have no creator column). */
  createdBy: string | null;
}

/**
 * Locate a doc's note collection, folder, and owning organization (the
 * user-facing vault). A doc_id maps to a `notes` row (rich registry) or a
 * `files` row (id == doc_id); we accept either.
 */
async function locateDoc(
  db: Queryable,
  docId: string,
): Promise<DocLocation | null> {
  const { rows } = await db.query<{
    vault_id: string;
    folder_id: string | null;
    organization_id: string;
    created_by: string | null;
  }>(
    `SELECT loc.vault_id, loc.folder_id, loc.created_by, v.organization_id
       FROM (
         SELECT vault_id, folder_id, created_by FROM notes  WHERE id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT vault_id, folder_id, NULL::text FROM files  WHERE id = $1
       ) loc
       JOIN vaults v ON v.id = loc.vault_id
      LIMIT 1`,
    [docId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    folderId: row.folder_id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
  };
}

/** Walk parent_id up from a folder, collecting all ancestor folder ids (inclusive). */
export async function ancestorFolderIds(
  db: Queryable,
  folderId: string | null,
): Promise<string[]> {
  if (!folderId) return [];
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id
          FROM folders f
          JOIN chain c ON f.id = c.parent_id
     )
     SELECT id FROM chain`,
    [folderId],
  );
  return rows.map((r) => r.id);
}

async function memberRole(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
    [organizationId, userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Highest share permission for a user across a file (if `docId` is set), a set
 * of folders, and the vault itself. Passing `docId = null` resolves a
 * folder resource directly: only the folder rows in `folderIds` (the folder
 * itself + its ancestors) match.
 *
 * Grants come from three scopes, all combined with highest-wins:
 *   - per-user file / folder shares (the classic ACL);
 *   - a vault-scoped grant (resource_type 'vault',
 *     do not rename; resource_id = `organizationId`) — either org-wide
 *     (`principal_type 'org'`, the "Open"/"Read-only" default) or for this user
 *     specifically. A vault-scoped grant is the only thing that reaches notes at
 *     the collection root (folder_id NULL), which have no folder to hang a
 *     share on.
 */
async function sharePermission(
  db: Queryable,
  userId: string,
  docId: string | null,
  folderIds: string[],
  organizationId: string,
  isMember: boolean,
  /** False when an org deny covers this resource — see {@link isDenied}. */
  orgGrantsApply = true,
): Promise<Permission> {
  // Team (org-wide) grants apply ONLY to actual vault members — never to
  // outsiders who merely know a doc id. They can target a specific folder/file
  // ("Share with team", private-by-default) or the whole vault (Open/
  // Read-only). Per-user grants are inherently scoped, so they need no gate.
  //
  // `orgGrantsApply` is how an item set to Private overrides a vault that is
  // Shared: the org branch drops out for that resource, so the vault-wide grant
  // stops reaching it while explicit personal grants still do.
  const orgGrantClause = isMember && orgGrantsApply
    ? `OR (principal_type = 'org' AND principal_id = $4 AND (
            ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
            OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
            OR (resource_type = 'vault' AND resource_id = $4)
          ))`
    : "";
  // $2 (the doc id) is always referenced with an explicit cast + null guard so
  // Postgres can infer its type even for a folder resource, where docId is null
  // and the file branch is inert.
  const { rows } = await db.query<{ permission: string }>(
    `SELECT permission FROM shares
      WHERE permission IN ('view', 'edit')
        AND (
          (principal_type = 'user' AND principal_id = $1 AND (
            ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
            OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
            OR (resource_type = 'vault' AND resource_id = $4)
          ))
          ${orgGrantClause}
        )`,
    [userId, docId, folderIds, organizationId],
  );
  let best: Permission = "none";
  for (const r of rows) {
    if (r.permission === "edit" || r.permission === "view") {
      best = maxPermission(best, r.permission);
    }
  }
  return best;
}

/**
 * True when a lock row covers this resource (a file when `docId` is set, plus
 * any folder in `folderIds`) for this user or the whole vault.
 *
 * Deliberately folder/file only. A vault-scoped lock cannot exist: it would
 * need the same (resource_type, resource_id, principal_type, principal_id) key
 * the vault GRANT already occupies. The vault-wide read-only ceiling is
 * expressed by that grant instead — see {@link vaultBaseline}.
 */
export async function isLocked(
  db: Queryable,
  userId: string,
  docId: string | null,
  folderIds: string[],
): Promise<boolean> {
  // $2 (doc id) is always referenced with a cast + null guard so Postgres can
  // infer its type for a folder resource (docId null → file branch inert).
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE permission = 'locked'
        AND (
          principal_type = 'org'
          OR (principal_type = 'user' AND principal_id = $1)
        )
        AND (
          ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
        )
      LIMIT 1`,
    [userId, docId, folderIds],
  );
  return rows.length > 0;
}

/**
 * The vault's declared posture: the org-wide grant on the vault resource, or
 * null when there is none (the Private posture).
 *
 * This is a **baseline for everyone**, not just for plain members. Read-only
 * says "Everyone can read everything, not edit", and until now it didn't mean
 * everyone: owners, admins and note creators all kept `edit` through shortcuts
 * that ran before any grant was consulted, so the person who chose the setting
 * was the one person exempt from it. When the baseline is `view`, those
 * shortcuts are skipped and the ordinary highest-wins grant lookup decides —
 * which still lets a folder marked Shared, or a personal edit grant, lift an
 * individual out of it. That is exactly what the panel offers.
 */
export async function vaultBaseline(
  db: Queryable,
  organizationId: string,
): Promise<Permission | null> {
  const { rows } = await db.query<{ permission: string }>(
    `SELECT permission FROM shares
      WHERE resource_type = 'vault' AND resource_id = $1
        AND principal_type = 'org' AND permission IN ('view', 'edit')
      LIMIT 1`,
    [organizationId],
  );
  const p = rows[0]?.permission;
  return p === "edit" || p === "view" ? p : null;
}

/**
 * True when a `denied` row covers the resource — the file itself or any
 * ancestor folder — for `principal`.
 *
 * There are two kinds, and the difference is the whole design:
 *
 * - **user deny** (`principal_type 'user'`) — the Access panel's per-member
 *   *Private*. Absolute: resolved before every allow rule, so it beats the
 *   vault-wide grant, an explicit per-user grant, an admin's blanket edit and
 *   the "creator of the note" escape hatch. That last one is the point —
 *   "keep this away from Sam" has to mean it on the notes Sam wrote.
 *
 * - **org deny** (`principal_type 'org'`) — the *item* set to Private. It says
 *   "this folder is not shared with the team", and it exists because clearing
 *   an item's own rows could never achieve that: a vault-wide Open grant still
 *   reached the item, so Private silently snapped back to Shared. It leaves the
 *   creator and explicit per-user grants standing and drops everything
 *   org-scoped — which is exactly "only you and people you share it with".
 *
 * Both apply to **owners and admins**. A restriction its author is exempt from
 * cannot be checked by its author, and "it works, take my word for it" is not a
 * thing to ship in an access panel. The safety net is not an exemption, it is
 * that the *management* gate is role-based and separate: `canManage` in
 * `http/routes/shares.ts` asks for owner/admin and never for effective
 * permission, so an owner can always lift a restriction they applied to
 * themselves — and the desktop's Access list is built from the local folder, so
 * the row to do it from never disappears either.
 */
export async function isDenied(
  db: Queryable,
  principalType: "user" | "org",
  principalId: string,
  docId: string | null,
  folderIds: string[],
): Promise<boolean> {
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE permission = 'denied'
        AND principal_type = $4 AND principal_id = $1
        AND (
          ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
        )
      LIMIT 1`,
    [principalId, docId, folderIds, principalType],
  );
  return rows.length > 0;
}

export async function effectivePermission(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
): Promise<Permission> {
  const loc = await locateDoc(db, docId);
  if (!loc) return "none";

  const folderIds = await ancestorFolderIds(db, loc.folderId);

  // Denies are first and unconditional. Both kinds outrank the role branch
  // below: what you set in the Access panel applies to you too, or a vault
  // owner can never see the effect of their own restriction and has to take it
  // on trust. The escape hatch is elsewhere and role-based — managing shares
  // (`canManage` in http/routes/shares.ts) is gated on owner/admin, never on
  // effective permission, so an owner can always lift what they set.
  if (await isDenied(db, "user", userId, docId, folderIds)) return "none";
  const itemPrivate = await isDenied(db, "org", loc.organizationId, docId, folderIds);

  const role = await memberRole(db, loc.organizationId, userId);
  // A Read-only vault caps EVERY shortcut below it (see `vaultBaseline`).
  const readOnlyVault = (await vaultBaseline(db, loc.organizationId)) === "view";
  let granted: Permission;
  if (itemPrivate) {
    // Private = "nobody, until you name them". ONLY explicit per-user grants
    // survive — not the org grant, not the admin shortcut, and not authorship.
    //
    // Authorship is the one that had to go last and is the one that matters:
    // in a vault you set up yourself you wrote nearly everything, so a Private
    // that spares the author is a Private you can never observe, and "it works,
    // trust me" is not a thing to ship in an access panel. Naming yourself in
    // the list below is how you get back in.
    granted = await sharePermission(
      db,
      userId,
      docId,
      folderIds,
      loc.organizationId,
      false,
      false,
    );
  } else if (readOnlyVault) {
    granted = await sharePermission(
      db,
      userId,
      docId,
      folderIds,
      loc.organizationId,
      role !== null,
    );
  } else if (role === "owner" || role === "admin") {
    granted = "edit";
  } else if (role !== null && loc.createdBy && loc.createdBy === userId) {
    // Private-by-default: a member always has edit on a note they created, even
    // with no explicit share (that's what makes "my private notes" work). The
    // `role !== null` gate is load-bearing: a user REMOVED from the vault must
    // lose this grant (their session outlives removal), else they keep edit on
    // notes they authored and can re-mint sync tokens indefinitely.
    granted = "edit";
  } else {
    granted = await sharePermission(
      db,
      userId,
      docId,
      folderIds,
      loc.organizationId,
      role !== null, // isMember — gates the org-wide grant
    );
  }

  // Cap overlay: a matching lock caps at view; it never grants.
  if (granted !== "none" && (await isLocked(db, userId, docId, folderIds))) {
    return "view";
  }
  return granted;
}

/**
 * Precomputed context for resolving many users against ONE resource (used by the
 * "who can access" view). Built once, then reused per member so we don't re-walk
 * the folder ancestry for each user.
 *
 * - file resource:   `docId` = the doc id, `folderIds` = ancestors of its folder.
 * - folder resource: `docId` = null,       `folderIds` = the folder + its ancestors.
 */
export interface AccessContext {
  organizationId: string;
  docId: string | null;
  folderIds: string[];
  /**
   * Creator of the note this context describes (null for a folder, or a file).
   *
   * Carried so the "who can access" list applies the same creator rule the
   * enforcer does. Without it the panel reported `none` for a member's own
   * note in a Private vault while `effectivePermission` handed them `edit` —
   * the panel and the thing it describes disagreeing, which is worse than
   * either answer alone.
   */
  createdBy: string | null;
}

export interface ResolvedAccess {
  permission: Permission;
  /** True when a lock reduced an otherwise-`edit` member down to `view`. */
  capped: boolean;
  /** True when the `none` came from an explicit per-member deny, not from an
   *  absent grant — the UI says "No access · blocked" rather than "not shared". */
  denied?: boolean;
}

export async function buildAccessContext(
  resourceType: "folder" | "file",
  resourceId: string,
  db: Queryable = defaultPool,
): Promise<AccessContext | null> {
  if (resourceType === "file") {
    const loc = await locateDoc(db, resourceId);
    if (!loc) return null;
    return {
      organizationId: loc.organizationId,
      docId: resourceId,
      folderIds: await ancestorFolderIds(db, loc.folderId),
      createdBy: loc.createdBy,
    };
  }
  // folder: resolve its owning vault (organization), then walk itself + ancestors.
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT v.organization_id
       FROM folders f JOIN vaults v ON v.id = f.vault_id
      WHERE f.id = $1 LIMIT 1`,
    [resourceId],
  );
  const org = rows[0]?.organization_id;
  if (!org) return null;
  return {
    organizationId: org,
    docId: null,
    folderIds: await ancestorFolderIds(db, resourceId),
    createdBy: null, // folders have no creator column in the ACL context
  };
}

/** Resolve one user's effective access against a prebuilt {@link AccessContext}. */
export async function resolveAccessForUser(
  ctx: AccessContext,
  userId: string,
  role: string | null,
  db: Queryable = defaultPool,
): Promise<ResolvedAccess> {
  if (await isDenied(db, "user", userId, ctx.docId, ctx.folderIds)) {
    return { permission: "none", capped: false, denied: true };
  }
  const itemPrivate = await isDenied(db, "org", ctx.organizationId, ctx.docId, ctx.folderIds);
  // Mirrors `effectivePermission` branch for branch. They MUST agree: this one
  // renders the "who can access" list, and a list that disagrees with the
  // enforcer is worse than no list.
  const readOnlyVault = (await vaultBaseline(db, ctx.organizationId)) === "view";
  const isCreator = role !== null && !!ctx.createdBy && ctx.createdBy === userId;
  const granted: Permission = itemPrivate
    ? // Private: only explicit per-user grants survive — authorship included.
      await sharePermission(db, userId, ctx.docId, ctx.folderIds, ctx.organizationId, false, false)
    : readOnlyVault
      ? await sharePermission(
          db,
          userId,
          ctx.docId,
          ctx.folderIds,
          ctx.organizationId,
          role !== null,
        )
      : role === "owner" || role === "admin"
        ? "edit"
        : isCreator
          ? "edit"
          : await sharePermission(
              db,
              userId,
              ctx.docId,
              ctx.folderIds,
              ctx.organizationId,
              role !== null, // isMember — gates the org-wide grant
            );

  if (granted === "none") return { permission: "none", capped: false, denied: itemPrivate };

  const locked = await isLocked(db, userId, ctx.docId, ctx.folderIds);
  if (locked && granted === "edit") return { permission: "view", capped: true };
  if (locked) return { permission: "view", capped: false };
  return { permission: granted, capped: false };
}
