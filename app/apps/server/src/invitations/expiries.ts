// SPDX-License-Identifier: Apache-2.0
//
// The Activity feed's "invitation expired unaccepted" rows (#268). The sweep
// (`sweep.ts`) records each notice once; this reads them back for one vault.
//
// A notice stays listed only while it is still true and still actionable:
//  · the invitation is still `pending` (Better Auth never flips an expired row,
//    so accepted/rejected/canceled means someone acted on it);
//  · the invitee has not joined some other way;
//  · no LATER invitation went to the same address in the same vault — a Resend
//    (or a fresh invite) answers the notice, whatever became of the new one.
// Owners and admins see every notice in the vault; anyone else only the
// invitations they sent themselves.

import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole, vaultOrg } from "../permissions/lookup.js";
import { INVITEE_NOT_A_MEMBER, NO_LATER_INVITATION } from "./sweep.js";

type Queryable = Pick<pg.Pool, "query">;

/** Matches the Activity feed's other server listings (30-day shrink window). */
export const EXPIRY_LISTING_DAYS = 30;
export const EXPIRY_LISTING_MAX = 200;

export interface InvitationExpiry {
  invitationId: string;
  organizationId: string;
  email: string;
  role: string;
  expiredAt: string;
  inviterId: string;
  inviterName: string | null;
}

export class InvitationListingError extends Error {
  constructor(
    readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

export async function listInvitationExpiries(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<{ items: InvitationExpiry[] }> {
  const orgId = await vaultOrg(vaultId, db);
  if (!orgId) throw new InvitationListingError(404, "Vault not found");
  const role = await orgRole(orgId, userId, db);
  if (!role) throw new InvitationListingError(403, "Not a member of this vault");
  const everyone = role === "owner" || role === "admin";
  const { rows } = await db.query<{
    id: string;
    email: string;
    role: string | null;
    expiresAt: Date;
    inviterId: string;
    inviterName: string | null;
  }>(
    `SELECT i.id, i.email, i.role, i."expiresAt", i."inviterId", u.name AS "inviterName"
       FROM invitation_notices n
       JOIN invitation i ON i.id = n.invitation_id
       LEFT JOIN "user" u ON u.id = i."inviterId"
      WHERE n.organization_id = $1
        AND n.expired_noticed_at IS NOT NULL
        AND i.status = 'pending'
        AND i."expiresAt" <= now()
        AND i."expiresAt" > now() - make_interval(days => $2::int)
        AND ($3::boolean OR i."inviterId" = $4)
        AND ${INVITEE_NOT_A_MEMBER}
        AND ${NO_LATER_INVITATION}
      ORDER BY i."expiresAt" DESC
      LIMIT $5`,
    [orgId, EXPIRY_LISTING_DAYS, everyone, userId, EXPIRY_LISTING_MAX],
  );
  return {
    items: rows.map((r) => ({
      invitationId: r.id,
      organizationId: orgId,
      email: r.email,
      role: r.role ?? "member",
      expiredAt: r.expiresAt.toISOString(),
      inviterId: r.inviterId,
      inviterName: r.inviterName,
    })),
  };
}

/**
 * Was an "expired unaccepted" notice recorded for this address in this vault?
 * Asked after a (re-)invite, so the feeds that list it refetch and drop it.
 */
export async function hasExpiryNotice(
  organizationId: string,
  email: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM invitation_notices n
       JOIN invitation i ON i.id = n.invitation_id
      WHERE n.organization_id = $1 AND n.expired_noticed_at IS NOT NULL
        AND lower(i.email) = lower($2)
      LIMIT 1`,
    [organizationId, email],
  );
  return rows.length > 0;
}
