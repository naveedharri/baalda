// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { withAuditActor } from "../audit/access.js";
import { pool as defaultPool } from "../db/pool.js";
import { canManageMemberAccess, type AccessChangeDeps, type AccessMode, type AccessResource } from "../permissions/access-management.js";
import { docsForResource, orgRole } from "../permissions/lookup.js";
import {
  buildAccessContextFromIndex,
  createResolverCache,
  indexedRowsFor,
  loadAccessIndex,
  ownSettingDepth,
  raisingGroups,
  resolveAccessForUser,
  rowsGroupGrant,
  type AccessIndex,
  type ShareRow,
} from "../permissions/resolver.js";
import { GroupError } from "./service.js";

/**
 * "Ask first" for group changes (Folder and Access, decided 2026-11-27).
 *
 * A setting just for a person decides for them over their groups, so a group
 * change can't reach someone whose own setting covers that place. Before a
 * group change (its access, or adding people to it) the desktop asks the
 * server who would be HELD BACK: people the group would give more than they
 * have there, kept from it by a setting just for them. For each, the owner or
 * admin picks Keep (the default: nothing is written) or "Let Sales decide",
 * which either removes the person's own setting when it sits on that very
 * place, or saves a "Sales may raise Sam here" mark when it comes from higher
 * up ({@link letGroupDecide}). Apply then re-checks and reports what changed.
 */

type Db = pg.Pool;
type Level = "edit" | "view" | "none";
const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2 };

export interface HeldPerson {
  userId: string;
  resourceType: "vault" | "folder" | "file";
  resourceId: string;
  /** What they have there now. */
  current: Level;
  /** What the group gives there (after the proposed change). */
  groupGives: Level;
  /** Where the setting just for them that decides sits: on this very place
   *  ("here": Let decide removes it) or higher up ("above": a mark). */
  ownAt: "here" | "above";
  /** The decisive own setting's place. */
  ownPlace: { resourceType: string; resourceId: string };
  /** The place's name (last path segment); null for the whole vault. */
  placeName?: string | null;
}

async function requireManager(orgId: string, userId: string, db: Db): Promise<string> {
  const role = await orgRole(orgId, userId, db);
  if (role !== "owner" && role !== "admin") {
    throw new GroupError("Only the vault owner or an admin can manage access groups", 403, "access_manager_required");
  }
  return role;
}

async function groupRow(db: Db, orgId: string, groupId: string): Promise<{ memberIds: string[] }> {
  const g = await db.query("SELECT 1 FROM access_groups WHERE id = $1 AND organization_id = $2", [groupId, orgId]);
  if (g.rowCount === 0) throw new GroupError("That group no longer exists", 404, "group_not_found");
  const { rows } = await db.query<{ user_id: string }>(
    "SELECT user_id FROM access_group_members WHERE group_id = $1",
    [groupId],
  );
  return { memberIds: rows.map((r) => r.user_id) };
}

const toLevel = (p: string): Level => (p === "edit" ? "edit" : p === "view" ? "view" : "none");

function chainKeys(index: AccessIndex, ctx: { docId: string | null; folderIds: string[] }): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (ctx.docId) out.push(["file", ctx.docId]);
  for (const f of ctx.folderIds) out.push(["folder", f]);
  out.push(["vault", index.organizationId]);
  return out;
}

/**
 * Who a proposed group change would not reach because of a setting just for
 * them. `access` = the group's new level on some places; `addUserIds` =
 * people about to join the group.
 *
 * Both directions count (2026-11-28): the group gives MORE than their own
 * setting allows (asked wherever that setting sits), or LESS than a setting
 * just for them on that very place (No access is one of the three levels, so
 * a group's No access over someone's own Can edit is a clash to decide). A
 * lower group level under an own setting that sits higher up is not asked:
 * the group's No access never takes anything away, and "use the group's"
 * there would have to change their whole wider setting.
 */
export async function heldByOwnSettings(
  input: {
    orgId: string;
    actorUserId: string;
    groupId: string;
    access?: { resources: AccessResource[]; mode: AccessMode };
    addUserIds?: string[];
  },
  db: Db = defaultPool,
): Promise<HeldPerson[]> {
  await requireManager(input.orgId, input.actorUserId, db);
  const { memberIds } = await groupRow(db, input.orgId, input.groupId);
  const index = await loadAccessIndex(db, input.orgId);
  const cache = createResolverCache();
  const roles = new Map(
    (await db.query<{ userId: string; role: string }>(
      'SELECT "userId", role FROM member WHERE "organizationId" = $1',
      [input.orgId],
    )).rows.map((r) => [r.userId, r.role] as const),
  );

  // The places to judge and what the group gives on each.
  // `only`: judge one person here (a place of their own settings).
  const places: Array<{ resourceType: "vault" | "folder" | "file"; resourceId: string; gives?: Level; only?: string }> = [];
  let people: string[];
  if (input.access) {
    const gives: Level = input.access.mode === "open" ? "edit" : input.access.mode === "readonly" ? "view" : "none";
    for (const r of input.access.resources) places.push({ ...r, gives });
    people = memberIds;
  } else {
    const { rows } = await db.query<{ resource_type: "vault" | "folder" | "file"; resource_id: string }>(
      `SELECT resource_type, resource_id FROM shares
        WHERE principal_type = 'group' AND principal_id = $1 AND permission IN ('view', 'edit')`,
      [input.groupId],
    );
    for (const r of rows) places.push({ resourceType: r.resource_type, resourceId: r.resource_id });
    people = [...new Set(input.addUserIds ?? [])].filter((u) => roles.has(u));
    // Their own settings, where the group may give less than they have.
    if (people.length) {
      const own = await db.query<{ resource_type: "vault" | "folder" | "file"; resource_id: string; principal_id: string }>(
        `SELECT DISTINCT resource_type, resource_id, principal_id FROM shares
          WHERE org_id = $1 AND principal_type = 'user' AND principal_id = ANY($2::text[])
            AND permission IN ('edit', 'view', 'readonly', 'denied')`,
        [input.orgId, people],
      );
      for (const r of own.rows) {
        places.push({ resourceType: r.resource_type, resourceId: r.resource_type === "vault" ? input.orgId : r.resource_id, only: r.principal_id });
      }
    }
  }

  const out: HeldPerson[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    const ctx = place.resourceType === "vault"
      ? (place.resourceId === input.orgId ? { organizationId: input.orgId, docId: null, folderIds: [] as string[], createdBy: null, createdAt: new Date(0) } : null)
      : await buildAccessContextFromIndex(index, place.resourceType === "file" ? "file" : "folder", place.resourceId, db, cache);
    if (!ctx || ctx.organizationId !== input.orgId) continue;
    const rows: ShareRow[] = indexedRowsFor(index, ctx.docId, ctx.folderIds);
    const gives: Level = place.gives ?? toLevel(rowsGroupGrant(rows, [input.groupId], ctx.docId, ctx.folderIds, input.orgId));
    // Whether the group has a say here at all. A Can view or Can edit just
    // picked for the group here always counts. A No access just picked counts
    // only where a grant of the group's from above still reaches (the server
    // then writes the group's No access here; elsewhere it just removes the
    // group's row and the group gives nothing). When people are ADDED, only a
    // setting of the group's on this place or above it counts. A group with
    // nothing here gives nothing, which is not "less" than anyone's own level
    // (2026-11-28 five-app test: adding people to an EMPTY group, or Remove all
    // on a group, asked about everyone's own Can edit everything, and "Use the
    // group's for everyone" would have taken all their access away).
    const isThisPlace = (r: ShareRow) =>
      r.resource_type === place.resourceType &&
      r.resource_id === (place.resourceType === "vault" ? input.orgId : place.resourceId);
    const speaks = input.access
      ? input.access.mode !== "private" ||
        toLevel(rowsGroupGrant(rows.filter((r) => !isThisPlace(r)), [input.groupId], ctx.docId, ctx.folderIds, input.orgId)) !== "none"
      : rows.some(
          (r) =>
            r.principal_type === "group" &&
            r.principal_id === input.groupId &&
            (r.permission === "view" || r.permission === "edit" || r.permission === "denied"),
        );
    for (const userId of place.only ? [place.only] : people) {
      const key = `${userId}\u0000${place.resourceType}\u0000${place.resourceId}`;
      if (seen.has(key)) continue;
      const depth = ownSettingDepth(rows, userId, ctx.docId, ctx.folderIds, input.orgId);
      if (depth === null) continue; // their groups decide here: the change reaches them
      const current = toLevel((await resolveAccessForUser(ctx, userId, roles.get(userId) ?? null, db, cache, index)).permission);
      if (gives === current) continue;
      const [ownType, ownId] = chainKeys(index, ctx)[depth]!;
      const ownAt = depth === 0 || (place.resourceType === "vault" && ownType === "vault") || (ownType === place.resourceType && ownId === place.resourceId) ? "here" : "above";
      if (RANK[gives] > RANK[current]) {
        const groups = index.memberGroups?.get(userId) ?? [];
        const marks = index.raises?.get(userId) ?? [];
        if (raisingGroups(marks, [...groups, input.groupId], depth, ctx.docId, ctx.folderIds, input.orgId).includes(input.groupId)) continue;
      } else if (ownAt !== "here" || !speaks) {
        continue; // lower, under a wider setting of theirs, or where the group says nothing: never asked
      }
      seen.add(key);
      out.push({
        userId,
        resourceType: place.resourceType,
        resourceId: place.resourceId,
        current,
        groupGives: gives,
        ownAt,
        ownPlace: { resourceType: ownType, resourceId: ownId },
      });
    }
  }
  // Name each place so the desktop needn't know it (a place of someone's own
  // setting may be one the group's board doesn't show).
  const ids = [...new Set(out.filter((h) => h.resourceType !== "vault").map((h) => h.resourceId))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { rows } = await db.query<{ id: string; path: string }>(
      `SELECT id, path FROM folders WHERE id = ANY($1::text[])
       UNION ALL SELECT id, rel_path FROM notes WHERE id = ANY($1::text[])
       UNION ALL SELECT id, path FROM files WHERE id = ANY($1::text[])`,
      [ids],
    );
    for (const r of rows) if (r.path) names.set(r.id, r.path.split("/").filter(Boolean).pop() ?? r.path);
  }
  for (const h of out) h.placeName = h.resourceType === "vault" ? null : names.get(h.resourceId) ?? null;
  return out;
}

/**
 * "Let Sales decide" for each entry (person + place): remove the setting just
 * for them when it sits on that place, else save a "Sales may raise them
 * here" mark. Re-checks each person afterwards and reports what they have
 * there now. Owners and admins only; never for someone the actor may not
 * manage (`canManageMemberAccess`). An AI agent never calls this (MCP keeps).
 */
export async function letGroupDecide(
  input: {
    orgId: string;
    actorUserId: string;
    groupId: string;
    entries: Array<{ userId: string; resourceType: "vault" | "folder" | "file"; resourceId: string }>;
  },
  deps: AccessChangeDeps = {},
  db: Db = defaultPool,
): Promise<Array<{ userId: string; resourceType: string; resourceId: string; action: "removed" | "marked" | "skipped"; before: Level; after: Level }>> {
  const actorRole = await requireManager(input.orgId, input.actorUserId, db);
  if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > 1000) {
    throw new GroupError("entries must hold 1–1000 items", 400, "invalid_entries");
  }
  const { memberIds } = await groupRow(db, input.orgId, input.groupId);
  const roles = new Map(
    (await db.query<{ userId: string; role: string }>(
      'SELECT "userId", role FROM member WHERE "organizationId" = $1',
      [input.orgId],
    )).rows.map((r) => [r.userId, r.role] as const),
  );
  const before = await loadAccessIndex(db, input.orgId);
  const cacheBefore = createResolverCache();
  type Ctx = NonNullable<Awaited<ReturnType<typeof buildAccessContextFromIndex>>>;
  // A place in THIS vault, or null (an id from another vault is never touched).
  const ctxOf = async (index: AccessIndex, cache: ReturnType<typeof createResolverCache>, e: { resourceType: string; resourceId: string }): Promise<Ctx | null> => {
    if (e.resourceType === "vault") {
      return e.resourceId === input.orgId
        ? { organizationId: input.orgId, docId: null, folderIds: [] as string[], createdBy: null, createdAt: new Date(0) } as unknown as Ctx
        : null;
    }
    if (e.resourceType !== "folder" && e.resourceType !== "file") return null;
    const ctx = await buildAccessContextFromIndex(index, e.resourceType, e.resourceId, db, cache);
    return ctx && ctx.organizationId === input.orgId ? ctx : null;
  };
  const levelAt = async (index: AccessIndex, cache: ReturnType<typeof createResolverCache>, e: { userId: string; resourceType: string; resourceId: string }): Promise<Level> => {
    const ctx = await ctxOf(index, cache, e);
    if (!ctx) return "none";
    return toLevel((await resolveAccessForUser(ctx, e.userId, roles.get(e.userId) ?? null, db, cache, index)).permission);
  };
  const OWN = new Set(["edit", "view", "readonly", "denied"]);
  // removed: their own setting on this very place goes (plus a mark when
  // another own setting above would still decide); marked: a "may raise" mark.
  const plan: Array<{ e: (typeof input.entries)[number]; action: "removed" | "marked" | "skipped"; mark: boolean; before: Level }> = [];
  for (const e of input.entries) {
    const ctx = await ctxOf(before, cacheBefore, e);
    const manageable = canManageMemberAccess(actorRole, roles.get(e.userId), e.userId === input.actorUserId);
    const b = ctx ? await levelAt(before, cacheBefore, e) : "none";
    if (!ctx || !manageable || !memberIds.includes(e.userId)) {
      plan.push({ e, action: "skipped", mark: false, before: b });
      continue;
    }
    const rows = indexedRowsFor(before, ctx.docId, ctx.folderIds);
    const depth = ownSettingDepth(rows, e.userId, ctx.docId, ctx.folderIds, input.orgId);
    if (depth === null) {
      // Nothing of their own decides here: the group already reaches them,
      // and a mark would silently apply to an own setting made later.
      plan.push({ e, action: "skipped", mark: false, before: b });
      continue;
    }
    const placeKey = `${e.resourceType}\u0000${e.resourceType === "vault" ? input.orgId : e.resourceId}`;
    const ownRowHere = (before.shares.get(placeKey) ?? [])
      .some((r) => r.principal_type === "user" && r.principal_id === e.userId && OWN.has(r.permission));
    // The group gives LESS than they have (2026-11-28): using the group's
    // removes their own setting here (their whole-vault level included), so
    // their groups decide. A mark could only raise, so nothing else applies.
    const groupGives = toLevel(rowsGroupGrant(rows, [input.groupId], ctx.docId, ctx.folderIds, input.orgId));
    if (RANK[groupGives] < RANK[b]) {
      if (!ownRowHere) {
        plan.push({ e, action: "skipped", mark: false, before: b });
        continue;
      }
      plan.push({ e, action: "removed", mark: false, before: b });
      continue;
    }
    const ownHere = e.resourceType !== "vault" && ownRowHere;
    if (!ownHere) {
      plan.push({ e, action: "marked", mark: true, before: b });
      continue;
    }
    // Without the row here, would another own setting higher up still decide?
    const rest = rows.filter((r) => !(r.principal_type === "user" && r.principal_id === e.userId &&
      r.resource_type === e.resourceType && r.resource_id === e.resourceId));
    const above = ownSettingDepth(rest, e.userId, ctx.docId, ctx.folderIds, input.orgId);
    plan.push({ e, action: "removed", mark: above !== null, before: b });
  }
  const touched: Array<{ resourceType: "vault" | "folder" | "file"; resourceId: string }> = [];
  await withAuditActor(input.actorUserId, async (client) => {
    for (const p of plan) {
      if (p.action === "skipped") continue;
      const rid = p.e.resourceType === "vault" ? input.orgId : p.e.resourceId;
      if (p.action === "removed") {
        // Only the four own levels: a padlock (`locked`) is not theirs to drop.
        await client.query(
          `DELETE FROM shares WHERE resource_type = $1 AND resource_id = $2 AND principal_type = 'user' AND principal_id = $3
              AND permission IN ('edit', 'view', 'readonly', 'denied')`,
          [p.e.resourceType, rid, p.e.userId],
        );
      }
      if (p.mark) {
        await client.query(
          `INSERT INTO access_group_raises (group_id, user_id, organization_id, resource_type, resource_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [input.groupId, p.e.userId, input.orgId, p.e.resourceType, rid, input.actorUserId],
        );
      }
      touched.push({ resourceType: p.e.resourceType, resourceId: rid });
    }
  }, db);
  // Re-check against the database as it stands now.
  const after = await loadAccessIndex(db, input.orgId);
  const cacheAfter = createResolverCache();
  const out = [];
  for (const p of plan) out.push({ ...p.e, action: p.action, before: p.before, after: await levelAt(after, cacheAfter, p.e) });
  // Sockets carry read-only at connect: reconnect what the change reached.
  const vaults = new Set<string>();
  for (const t of touched) {
    for (const d of await docsForResource(t.resourceType, t.resourceId, db)) {
      deps.disconnectDoc?.(d.vaultId, d.docId);
      vaults.add(d.vaultId);
    }
  }
  for (const v of vaults) deps.onAclChanged?.(v);
  return out;
}
