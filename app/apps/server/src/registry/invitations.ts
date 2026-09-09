import type pg from "pg";

/**
 * Read side of Better Auth's `invitation` table, shared by the public landing
 * page (`GET /invite/:id`), the preview/inbox API (`routes/invitations.ts`) and
 * the join-code path (`routes/orgs.ts`). Better Auth owns the writes.
 */

type Queryable = Pick<pg.Pool, "query">;

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  /** Raw Better Auth status: pending | accepted | rejected | canceled. */
  status: string;
  organizationId: string;
  organizationName: string;
  inviterId: string;
  inviterName: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export type InvitationState = "pending" | "accepted" | "rejected" | "canceled" | "expired";

/** A `pending` row past its expiry reads as `expired`; nothing else changes. */
export function invitationState(inv: Pick<InvitationRow, "status" | "expiresAt">): InvitationState {
  if (inv.status === "pending") {
    return inv.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
  }
  if (inv.status === "accepted" || inv.status === "rejected" || inv.status === "canceled") {
    return inv.status;
  }
  return "canceled";
}

const SELECT = `
  SELECT i.id, i.email, i.role, i.status, i."organizationId", o.name AS "organizationName",
         i."inviterId", u.name AS "inviterName", i."expiresAt", i."createdAt"
    FROM invitation i
    JOIN organization o ON o.id = i."organizationId"
    LEFT JOIN "user" u ON u.id = i."inviterId"`;

export async function loadInvitation(db: Queryable, id: string): Promise<InvitationRow | null> {
  const { rows } = await db.query<InvitationRow>(`${SELECT} WHERE i.id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Live (pending, unexpired) invitations addressed to an email, newest first.
 * Case-insensitive: Better Auth lowercases on create, but a user row's email
 * keeps the case it was typed with.
 */
export async function listPendingInvitationsFor(
  db: Queryable,
  email: string,
): Promise<InvitationRow[]> {
  const { rows } = await db.query<InvitationRow>(
    `${SELECT}
      WHERE lower(i.email) = lower($1) AND i.status = 'pending' AND i."expiresAt" > now()
      ORDER BY i."createdAt" DESC`,
    [email],
  );
  return rows;
}

/** JSON shape shared by the preview and inbox endpoints (and the desktop). */
export function invitationJson(inv: InvitationRow) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role ?? "member",
    status: invitationState(inv),
    organizationId: inv.organizationId,
    organizationName: inv.organizationName,
    inviterId: inv.inviterId,
    inviterName: inv.inviterName,
    expiresAt: inv.expiresAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
  };
}
