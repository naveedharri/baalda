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
    await db.query(`DELETE FROM invitation_access WHERE invitation_id = ANY($1::text[])`, [
      rows.map((r) => r.invitation_id),
    ]);
    return chosen.mode;
  } catch (err) {
    console.error("[invitations] applying invitation access failed:", (err as Error).message);
    return null;
  }
}
