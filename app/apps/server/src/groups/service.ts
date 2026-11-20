// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { setAuditActor } from "../audit/access.js";
import { pool as defaultPool } from "../db/pool.js";
import {
  canManageMemberAccess,
  type AccessChangeDeps,
} from "../permissions/access-management.js";
import { docsForResource, docsForResources, orgRole } from "../permissions/lookup.js";

/**
 * Access groups (migration 097): named sets of a vault's members that only ADD
 * access. The grant rules live in the resolver (`rowsGroupGrant`) and the
 * readable set (`vault-docs.ts`); a group's grants are written through the
 * ordinary bulk-access path with a `group` audience. This module owns the
 * groups themselves and their membership.
 *
 * Management is owner/admin, like every access write. Adding or removing a
 * person follows `canManageMemberAccess` (an admin never changes the owner's
 * access, a group included). Every change that can NARROW someone (removing a
 * member, deleting a group) disconnects the docs the group's grants reach so
 * their sockets re-authenticate, and every change tells the vault channel to
 * recompute readable sets (`onAclChanged`).
 */

type Db = pg.Pool | pg.PoolClient;

export class GroupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
  ) {
    super(message);
  }
}

export const GROUP_COLORS = ["violet", "green", "orange", "blue", "pink", "yellow", "teal", "red"] as const;
const MAX_GROUPS_PER_ORG = 200;
const MAX_MEMBERS_PER_CALL = 500;

export interface GroupGrant {
  resourceType: "vault" | "folder" | "file";
  resourceId: string;
  permission: "edit" | "view";
  /** The folder/note/file path, null for the whole vault (or a gone item). */
  path: string | null;
}

export interface GroupSummary {
  id: string;
  name: string;
  color: string | null;
  autoJoin: boolean;
  createdAt: string;
  memberIds: string[];
  /** Pending invitations that join this group on acceptance. */
  invited: { invitationId: string; email: string }[];
  /** Owners/admins only (null for plain members). */
  grants: GroupGrant[] | null;
  /** Owners/admins only: how many skills this group gets. */
  skillCount: number | null;
}

async function requireManager(db: Db, orgId: string, userId: string): Promise<string> {
  const role = await orgRole(orgId, userId, db);
  if (role !== "owner" && role !== "admin") {
    throw new GroupError("Only the vault owner or an admin can manage groups", 403, "access_manager_required");
  }
  return role;
}

async function loadGroup(db: Db, orgId: string, groupId: string) {
  const { rows } = await db.query<{ id: string; name: string; color: string | null; auto_join: boolean }>(
    "SELECT id, name, color, auto_join FROM access_groups WHERE id = $1 AND organization_id = $2",
    [groupId, orgId],
  );
  if (!rows[0]) throw new GroupError("That group does not exist", 404, "group_not_found");
  return rows[0];
}

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > 60) {
    throw new GroupError("A group name is 1 to 60 characters", 400, "invalid_name");
  }
  return name;
}

function cleanColor(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && (GROUP_COLORS as readonly string[]).includes(raw)) return raw;
  throw new GroupError("Unknown group colour", 400, "invalid_color");
}

/** Every group of the vault with its members and (for managers) its grants. */
export async function listGroups(orgId: string, viewerId: string, db: Db = defaultPool): Promise<{
  groups: GroupSummary[];
  canManage: boolean;
}> {
  const role = await orgRole(orgId, viewerId, db);
  if (!role) throw new GroupError("You are not a member of this vault", 403, "not_member");
  const manager = role === "owner" || role === "admin";
  const [groups, members, invited] = await Promise.all([
    db.query<{ id: string; name: string; color: string | null; auto_join: boolean; created_at: Date }>(
      `SELECT id, name, color, auto_join, created_at FROM access_groups
        WHERE organization_id = $1 ORDER BY lower(name), id`,
      [orgId],
    ),
    db.query<{ group_id: string; user_id: string }>(
      `SELECT group_id, user_id FROM access_group_members WHERE organization_id = $1 ORDER BY added_at`,
      [orgId],
    ),
    db.query<{ group_id: string; invitation_id: string; email: string }>(
      `SELECT ig.group_id, i.id AS invitation_id, i.email
         FROM invitation_groups ig JOIN invitation i ON i.id = ig.invitation_id
        WHERE i."organizationId" = $1 AND i.status = 'pending' AND i."expiresAt" > now()`,
      [orgId],
    ),
  ]);
  const grants = manager ? await grantsByGroup(db, orgId) : null;
  const skills = manager
    ? await db.query<{ group_id: string; n: string }>(
        `SELECT sga.group_id, count(*) AS n
           FROM skill_group_access sga JOIN skills s ON s.id = sga.skill_id
          WHERE s.organization_id = $1 AND s.deleted_at IS NULL
          GROUP BY sga.group_id`,
        [orgId],
      )
    : null;
  const skillCount = new Map((skills?.rows ?? []).map((r) => [r.group_id, Number(r.n)] as const));
  return {
    canManage: manager,
    groups: groups.rows.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      autoJoin: g.auto_join,
      createdAt: new Date(g.created_at).toISOString(),
      memberIds: members.rows.filter((m) => m.group_id === g.id).map((m) => m.user_id),
      invited: invited.rows
        .filter((i) => i.group_id === g.id)
        .map((i) => ({ invitationId: i.invitation_id, email: i.email })),
      grants: grants ? grants.get(g.id) ?? [] : null,
      skillCount: manager ? skillCount.get(g.id) ?? 0 : null,
    })),
  };
}

/** Every group grant in the org with the path it sits on. */
async function grantsByGroup(db: Db, orgId: string): Promise<Map<string, GroupGrant[]>> {
  const { rows } = await db.query<{
    principal_id: string;
    resource_type: "vault" | "folder" | "file";
    resource_id: string;
    permission: "edit" | "view";
    path: string | null;
  }>(
    `SELECT s.principal_id, s.resource_type, s.resource_id, s.permission,
            CASE s.resource_type
              WHEN 'folder' THEN (SELECT f.path FROM folders f WHERE f.id = s.resource_id)
              WHEN 'file' THEN coalesce(
                (SELECT n.rel_path FROM notes n WHERE n.id = s.resource_id AND n.deleted_at IS NULL),
                (SELECT fi.path FROM files fi WHERE fi.id = s.resource_id))
              ELSE NULL
            END AS path
       FROM shares s
      WHERE s.org_id = $1 AND s.principal_type = 'group'
      ORDER BY s.resource_type = 'vault' DESC, path`,
    [orgId],
  );
  const out = new Map<string, GroupGrant[]>();
  for (const r of rows) {
    // A row on an item that no longer exists grants nothing; leave it out.
    if (r.resource_type !== "vault" && r.path === null) continue;
    const list = out.get(r.principal_id) ?? [];
    list.push({ resourceType: r.resource_type, resourceId: r.resource_id, permission: r.permission, path: r.path });
    out.set(r.principal_id, list);
  }
  return out;
}

/** The groups each listed person belongs to (any member may read this). */
export async function groupsByUser(db: Db, orgId: string): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ user_id: string; group_id: string }>(
    `SELECT m.user_id, m.group_id
       FROM access_group_members m JOIN access_groups g ON g.id = m.group_id
      WHERE m.organization_id = $1
      ORDER BY lower(g.name)`,
    [orgId],
  );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.group_id]);
  return out;
}

async function checkTargets(db: Db, orgId: string, actorId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  if (userIds.length > MAX_MEMBERS_PER_CALL) {
    throw new GroupError(`At most ${MAX_MEMBERS_PER_CALL} people at once`, 400, "invalid_members");
  }
  const { rows } = await db.query<{ user_id: string; role: string }>(
    `SELECT "userId" AS user_id, role FROM member WHERE "organizationId" = $1 AND "userId" = ANY($2::text[])`,
    [orgId, userIds],
  );
  if (rows.length !== userIds.length) {
    throw new GroupError("Everyone added to a group must be a member of this vault", 404, "member_not_found");
  }
  const actorRole = await orgRole(orgId, actorId, db);
  for (const r of rows) {
    if (!canManageMemberAccess(actorRole, r.role, r.user_id === actorId)) {
      throw new GroupError("An admin cannot change the owner's groups", 403, "access_manager_required");
    }
  }
}

export async function createGroup(
  orgId: string,
  actorId: string,
  input: { name: unknown; color?: unknown; autoJoin?: unknown; memberIds?: unknown },
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<{ id: string }> {
  await requireManager(db, orgId, actorId);
  const name = cleanName(input.name);
  const color = cleanColor(input.color ?? null);
  const autoJoin = input.autoJoin === true;
  const memberIds = Array.isArray(input.memberIds)
    ? [...new Set(input.memberIds.filter((x): x is string => typeof x === "string" && !!x))]
    : [];
  await checkTargets(db, orgId, actorId, memberIds);
  const { rows: count } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM access_groups WHERE organization_id = $1",
    [orgId],
  );
  if (Number(count[0]?.n ?? 0) >= MAX_GROUPS_PER_ORG) {
    throw new GroupError(`A vault can have at most ${MAX_GROUPS_PER_ORG} groups`, 409, "group_limit_reached");
  }
  const id = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await setAuditActor(client, actorId);
    try {
      await client.query(
        `INSERT INTO access_groups (id, organization_id, name, color, auto_join, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, orgId, name, color, autoJoin, actorId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw new GroupError("A group with that name already exists", 409, "group_name_taken");
      }
      throw e;
    }
    for (const userId of memberIds) {
      await client.query(
        `INSERT INTO access_group_members (group_id, organization_id, user_id, added_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [id, orgId, userId, actorId],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // A new group has no grants yet, so nothing can change for anyone.
  void deps;
  return { id };
}

export async function updateGroup(
  orgId: string,
  actorId: string,
  groupId: string,
  input: { name?: unknown; color?: unknown; autoJoin?: unknown },
  db: pg.Pool = defaultPool,
): Promise<void> {
  await requireManager(db, orgId, actorId);
  const group = await loadGroup(db, orgId, groupId);
  const name = input.name === undefined ? group.name : cleanName(input.name);
  const color = input.color === undefined ? group.color : cleanColor(input.color);
  const autoJoin = input.autoJoin === undefined ? group.auto_join : input.autoJoin === true;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await setAuditActor(client, actorId);
    await client.query(
      `UPDATE access_groups SET name = $3, color = $4, auto_join = $5, updated_at = now()
        WHERE id = $1 AND organization_id = $2`,
      [groupId, orgId, name, color, autoJoin],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") {
      throw new GroupError("A group with that name already exists", 409, "group_name_taken");
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The docs a group's grants reach, for the socket kick after a narrowing
 * change. A whole-vault grant reaches every doc in the org.
 */
async function docsReachedByGroup(db: Db, orgId: string, groupId: string) {
  const { rows } = await db.query<{ resource_type: "vault" | "folder" | "file"; resource_id: string }>(
    `SELECT resource_type, resource_id FROM shares WHERE principal_type = 'group' AND principal_id = $1`,
    [groupId],
  );
  if (rows.some((r) => r.resource_type === "vault")) return docsForResource("vault", orgId, db);
  return docsForResources(
    rows
      .filter((r): r is { resource_type: "folder" | "file"; resource_id: string } => r.resource_type !== "vault")
      .map((r) => ({ resourceType: r.resource_type, resourceId: r.resource_id })),
    db,
  );
}

async function vaultIdsOf(db: Db, orgId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM vaults WHERE organization_id = $1", [orgId]);
  return rows.map((r) => r.id);
}

/** Kick the docs a group reaches (narrowing) and tell every collection. */
async function afterGroupChange(
  db: Db,
  orgId: string,
  docs: { vaultId: string; docId: string }[],
  deps: AccessChangeDeps,
): Promise<number> {
  let disconnected = 0;
  for (const d of docs) {
    try {
      deps.disconnectDoc?.(d.vaultId, d.docId);
      if (deps.disconnectDoc) disconnected++;
    } catch {
      // best effort: the change is committed
    }
  }
  for (const v of await vaultIdsOf(db, orgId)) deps.onAclChanged?.(v);
  return disconnected;
}

async function groupHasSkills(db: Db, groupId: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM skill_group_access WHERE group_id = $1 LIMIT 1", [groupId]);
  return (rowCount ?? 0) > 0;
}

export async function deleteGroup(
  orgId: string,
  actorId: string,
  groupId: string,
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<{ disconnectedDocs: number; skillsChanged: boolean }> {
  await requireManager(db, orgId, actorId);
  await loadGroup(db, orgId, groupId);
  // Read BEFORE the delete: the trigger drops the group's share rows with it.
  const docs = await docsReachedByGroup(db, orgId, groupId);
  const skillsChanged = await groupHasSkills(db, groupId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await setAuditActor(client, actorId);
    await client.query("DELETE FROM access_groups WHERE id = $1 AND organization_id = $2", [groupId, orgId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { disconnectedDocs: await afterGroupChange(db, orgId, docs, deps), skillsChanged };
}

export async function addGroupMembers(
  orgId: string,
  actorId: string,
  groupId: string,
  userIds: unknown,
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<{ added: number; skillsChanged: boolean }> {
  await requireManager(db, orgId, actorId);
  await loadGroup(db, orgId, groupId);
  const ids = Array.isArray(userIds)
    ? [...new Set(userIds.filter((x): x is string => typeof x === "string" && !!x))]
    : [];
  if (ids.length === 0) throw new GroupError("Pick at least one person", 400, "invalid_members");
  await checkTargets(db, orgId, actorId, ids);
  let added = 0;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await setAuditActor(client, actorId);
    for (const userId of ids) {
      const r = await client.query(
        `INSERT INTO access_group_members (group_id, organization_id, user_id, added_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [groupId, orgId, userId, actorId],
      );
      added += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // Adding only widens: no kick, but readable sets grow, so tell the channel.
  if (added > 0) await afterGroupChange(db, orgId, [], deps);
  return { added, skillsChanged: added > 0 && (await groupHasSkills(db, groupId)) };
}

export async function removeGroupMember(
  orgId: string,
  actorId: string,
  groupId: string,
  userId: string,
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<{ removed: boolean; disconnectedDocs: number; skillsChanged: boolean }> {
  await requireManager(db, orgId, actorId);
  await loadGroup(db, orgId, groupId);
  await checkTargets(db, orgId, actorId, [userId]);
  const client = await db.connect();
  let removed = false;
  try {
    await client.query("BEGIN");
    await setAuditActor(client, actorId);
    const r = await client.query(
      "DELETE FROM access_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, userId],
    );
    removed = (r.rowCount ?? 0) > 0;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (!removed) return { removed, disconnectedDocs: 0, skillsChanged: false };
  const docs = await docsReachedByGroup(db, orgId, groupId);
  return {
    removed,
    disconnectedDocs: await afterGroupChange(db, orgId, docs, deps),
    skillsChanged: await groupHasSkills(db, groupId),
  };
}

/** Groups picked on an invitation; applied when it is accepted. */
export async function rememberInvitationGroups(
  db: Db,
  orgId: string,
  invitationId: string,
  groupIds: string[],
): Promise<void> {
  if (groupIds.length === 0) return;
  await db.query(
    `INSERT INTO invitation_groups (invitation_id, group_id)
     SELECT $1, g.id FROM access_groups g WHERE g.organization_id = $2 AND g.id = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [invitationId, orgId, groupIds],
  );
}

/** Validate group ids for an invitation: every one must belong to the vault. */
export async function validGroupIds(db: Db, orgId: string, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new GroupError("groupIds must be a list", 400, "invalid_groups");
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && !!x))];
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM access_groups WHERE organization_id = $1 AND id = ANY($2::text[])",
    [orgId, ids],
  );
  if (rows.length !== ids.length) throw new GroupError("Unknown group", 404, "group_not_found");
  return ids;
}

/**
 * Apply the groups chosen on accepted invitations (Better Auth accept hook and
 * the join-code path), then forget them. Best-effort, like invitation access:
 * membership is already committed.
 */
export async function applyInvitationGroups(
  input: { invitationIds: readonly string[]; organizationId: string; userId: string },
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<number> {
  if (input.invitationIds.length === 0) return 0;
  try {
    const { rows } = await db.query<{ group_id: string; inviter_id: string }>(
      `SELECT ig.group_id, i."inviterId" AS inviter_id
         FROM invitation_groups ig JOIN invitation i ON i.id = ig.invitation_id
         JOIN access_groups g ON g.id = ig.group_id AND g.organization_id = i."organizationId"
        WHERE ig.invitation_id = ANY($1::text[]) AND i."organizationId" = $2`,
      [[...input.invitationIds], input.organizationId],
    );
    let added = 0;
    for (const r of rows) {
      const res = await db.query(
        `INSERT INTO access_group_members (group_id, organization_id, user_id, added_by)
         SELECT $1, $2, $3, (SELECT id FROM "user" WHERE id = $4)
          WHERE EXISTS (SELECT 1 FROM member WHERE "organizationId" = $2 AND "userId" = $3)
         ON CONFLICT DO NOTHING`,
        [r.group_id, input.organizationId, input.userId, r.inviter_id],
      );
      added += res.rowCount ?? 0;
    }
    await db.query("DELETE FROM invitation_groups WHERE invitation_id = ANY($1::text[])", [[...input.invitationIds]]);
    if (added > 0) await afterGroupChange(db, input.organizationId, [], deps);
    return added;
  } catch (err) {
    console.error("[invitations] applying invitation groups failed:", (err as Error).message);
    return 0;
  }
}
