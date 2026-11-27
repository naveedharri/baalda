// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { applyBulkAccess, type AccessChangeDeps, type AccessMode } from "../permissions/access-management.js";

/**
 * The access an owner/admin picked when inviting someone (`invitation_access`,
 * migration 046), applied once the invitee is a member.
 *
 * Runs AFTER the member row exists, so the m032 snapshot trigger has already
 * fired; `applyBulkAccess` on the whole vault for this one user then deletes
 * that snapshot, which is intended: the invite's access covers notes that
 * already existed too. The row is deleted once applied (the FK cascade would
 * also drop it with the invitation, but a consumed choice should not linger).
 *
 * The actor recorded on the share is the inviter while they still manage the
 * vault, else the vault's owner — the choice was authorised when the invite
 * was made, and `applyBulkAccess` requires a manager as actor.
 *
 * A level picked on the invite is the person's own vault-wide level, so the
 * groups that take every new member (`auto_join`, added by the m097 trigger
 * when the member row went in) are left again: an invite gives a level OR
 * groups, never both (400 `access_or_groups`), and a group's Can edit would
 * otherwise lift an invited Can view. The same rule as migration 101, whose
 * Everyone group holds only members without a vault level of their own.
 *
 * Best-effort: membership is already committed, so a failure is logged and the
 * member keeps the vault's join default.
 */
export async function applyInvitationAccess(
  input: { invitationIds: readonly string[]; organizationId: string; userId: string },
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<AccessMode | null> {
  if (input.invitationIds.length === 0) return null;
  try {
    const { rows } = await db.query<{ invitation_id: string; mode: AccessMode; inviter_id: string }>(
      `SELECT ia.invitation_id, ia.mode, i."inviterId" AS inviter_id
         FROM invitation_access ia JOIN invitation i ON i.id = ia.invitation_id
        WHERE ia.invitation_id = ANY($1::text[]) AND i."organizationId" = $2
        ORDER BY i."createdAt" DESC`,
      [[...input.invitationIds], input.organizationId],
    );
    const chosen = rows[0];
    if (!chosen) return null;
    const { rows: managers } = await db.query<{ user_id: string }>(
      `SELECT "userId" AS user_id FROM member
        WHERE "organizationId" = $1 AND role IN ('owner', 'admin')
        ORDER BY ("userId" = $2) DESC, (role = 'owner') DESC, "createdAt" ASC
        LIMIT 1`,
      [input.organizationId, chosen.inviter_id],
    );
    const actor = managers[0]?.user_id;
    if (!actor) {
      console.error(`[invitations] no manager left to apply invitation access in ${input.organizationId}`);
      return null;
    }
    await applyBulkAccess(
      {
        organizationId: input.organizationId,
        actorUserId: actor,
        resources: [{ resourceType: "vault", resourceId: input.organizationId }],
        audience: { type: "users", userIds: [input.userId] },
        mode: chosen.mode,
      },
      deps,
      db,
    );
    await db.query(
      `DELETE FROM access_group_members gm USING access_groups g
        WHERE g.id = gm.group_id AND g.auto_join
          AND gm.organization_id = $1 AND gm.user_id = $2`,
      [input.organizationId, input.userId],
    );
    await db.query(`DELETE FROM invitation_access WHERE invitation_id = ANY($1::text[])`, [
      rows.map((r) => r.invitation_id),
    ]);
    return chosen.mode;
  } catch (err) {
    console.error("[invitations] applying invitation access failed:", (err as Error).message);
    return null;
  }
}

/**
 * Whether the inviter chose anything for these invitations: a level, groups,
 * or "Only what's shared" on purpose. Read BEFORE the choices are applied
 * (applying consumes their rows).
 */
export async function invitationHadChoice(invitationIds: readonly string[], db: pg.Pool = defaultPool): Promise<boolean> {
  if (invitationIds.length === 0) return true;
  const { rows } = await db.query<{ any: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM invitation_access WHERE invitation_id = ANY($1::text[]))
         OR EXISTS (SELECT 1 FROM invitation_groups WHERE invitation_id = ANY($1::text[]))
         OR EXISTS (SELECT 1 FROM invitation_no_level WHERE invitation_id = ANY($1::text[])) AS any`,
    [[...invitationIds]],
  );
  return rows[0]?.any ?? true;
}

/**
 * An invite that chose nothing (sent by an app made before 2026-11-27) gives
 * the vault's old team level, as it did before the conversion: a plain member
 * with no vault level of their own and in no group that takes new members gets
 * `new_member_level` as their own level. Best-effort.
 */
export async function applyNewMemberDefault(
  input: { organizationId: string; userId: string },
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<void> {
  try {
    const { rows } = await db.query<{ level: string | null; role: string | null; own: boolean; grouped: boolean }>(
      `SELECT (SELECT new_member_level FROM organization_access_settings WHERE organization_id = $1) AS level,
              (SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2) AS role,
              EXISTS (SELECT 1 FROM shares WHERE resource_type = 'vault' AND resource_id = $1
                        AND principal_type = 'user' AND principal_id = $2) AS own,
              EXISTS (SELECT 1 FROM access_group_members gm JOIN access_groups g ON g.id = gm.group_id
                        WHERE g.auto_join AND gm.organization_id = $1 AND gm.user_id = $2) AS grouped`,
      [input.organizationId, input.userId],
    );
    const r = rows[0];
    if (!r || r.role !== "member" || r.own || r.grouped) return;
    if (r.level !== "edit" && r.level !== "view") return;
    await applyMemberLevel(
      { organizationId: input.organizationId, userId: input.userId, mode: r.level === "edit" ? "open" : "readonly" },
      deps,
      db,
    );
  } catch (err) {
    console.error("[invitations] applying the vault's default level failed:", (err as Error).message);
  }
}

/**
 * Admins START at Can edit everything (decided 2026-11-23), however they were
 * invited. Today's desktop sends that level on an admin invite; an older one,
 * Better Auth's own invite route or the API may send nothing, and an admin
 * would then join a vault on Only what's shared seeing nothing at all (the
 * 2026-11-28 five-app test). So an admin who joins with no vault level of
 * their own gets it here, the same row a promotion writes. A level the invite
 * did choose is kept as it is. Best-effort.
 */
export async function applyAdminStart(
  input: { organizationId: string; userId: string },
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<void> {
  try {
    const { rows } = await db.query<{ role: string | null; own: boolean }>(
      `SELECT (SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2) AS role,
              EXISTS (SELECT 1 FROM shares WHERE resource_type = 'vault' AND resource_id = $1
                        AND principal_type = 'user' AND principal_id = $2) AS own`,
      [input.organizationId, input.userId],
    );
    const r = rows[0];
    if (!r || r.role !== "admin" || r.own) return;
    await applyMemberLevel({ organizationId: input.organizationId, userId: input.userId, mode: "open" }, deps, db);
  } catch (err) {
    console.error("[invitations] giving a new admin Can edit everything failed:", (err as Error).message);
  }
}

/**
 * Give a member who just joined their own vault-wide level (the join code's
 * level). Same as an invite's level, applied by the vault's owner, and like an
 * invite's level they leave the groups that take every new member.
 */
export async function applyMemberLevel(
  input: { organizationId: string; userId: string; mode: AccessMode },
  deps: AccessChangeDeps = {},
  db: pg.Pool = defaultPool,
): Promise<void> {
  try {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT "userId" AS user_id FROM member
        WHERE "organizationId" = $1 AND role IN ('owner', 'admin')
        ORDER BY (role = 'owner') DESC, "createdAt" ASC LIMIT 1`,
      [input.organizationId],
    );
    const actor = rows[0]?.user_id;
    if (!actor) return;
    await applyBulkAccess(
      {
        organizationId: input.organizationId,
        actorUserId: actor,
        resources: [{ resourceType: "vault", resourceId: input.organizationId }],
        audience: { type: "users", userIds: [input.userId] },
        mode: input.mode,
      },
      deps,
      db,
    );
    await db.query(
      `DELETE FROM access_group_members gm USING access_groups g
        WHERE g.id = gm.group_id AND g.auto_join
          AND gm.organization_id = $1 AND gm.user_id = $2`,
      [input.organizationId, input.userId],
    );
  } catch (err) {
    console.error("[join-code] applying the join code level failed:", (err as Error).message);
  }
}
