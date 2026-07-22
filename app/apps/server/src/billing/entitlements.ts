import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { config, billingEnabled } from "../config.js";

/**
 * Entitlement checks. These read ONLY our own tables (`subscriptions`, `member`,
 * `invitation`) — never the payment provider — so they're cheap and correct on
 * the request path. The `subscriptions` table is the single source of truth,
 * written only by webhook processing.
 *
 * Every gate returns "allowed" when billing is disabled (self-host = unlimited).
 */

type Queryable = Pick<pg.Pool, "query">;

/** A vault counts as paid (unlimited) while active or in the past_due grace. */
const ACTIVE_STATUSES = ["active", "past_due"] as const;

export interface Entitlement {
  plan: "free" | "pro";
  status: "none" | "active" | "past_due" | "canceled";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Provider customer id, when a subscription row exists (for the portal). */
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /** True when the org has an active (or past_due grace) subscription. */
  active: boolean;
}

interface SubRow {
  plan: string;
  status: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
}

/** Read the current entitlement for an org from OUR subscriptions table. */
export async function getEntitlement(
  orgId: string,
  db: Queryable = defaultPool,
): Promise<Entitlement> {
  const { rows } = await db.query<SubRow>(
    `SELECT plan, status, current_period_end, cancel_at_period_end,
            provider_customer_id, provider_subscription_id
       FROM subscriptions WHERE organization_id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row) {
    return {
      plan: "free",
      status: "none",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      providerCustomerId: null,
      providerSubscriptionId: null,
      active: false,
    };
  }
  const active = (ACTIVE_STATUSES as readonly string[]).includes(row.status);
  return {
    plan: active ? "pro" : "free",
    status: normalizeStatusForApi(row.status),
    currentPeriodEnd: row.current_period_end
      ? new Date(row.current_period_end).toISOString()
      : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    active,
  };
}

function normalizeStatusForApi(status: string): Entitlement["status"] {
  if (status === "active" || status === "past_due" || status === "canceled") {
    return status;
  }
  return "none";
}

/** Does the org have an active (unlimited-members) subscription right now? */
export async function orgHasActiveSubscription(
  orgId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM subscriptions WHERE organization_id = $1`,
    [orgId],
  );
  return rows[0] ? (ACTIVE_STATUSES as readonly string[]).includes(rows[0].status) : false;
}

/**
 * Number of vaults this user OWNS that do NOT have an active subscription.
 * Paid vaults never count toward the free-tier vault cap.
 */
export async function countOwnedUnsubscribedOrgs(
  userId: string,
  db: Queryable = defaultPool,
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::int AS count
       FROM member m
       LEFT JOIN subscriptions s ON s.organization_id = m."organizationId"
      WHERE m."userId" = $1
        AND m.role = 'owner'
        AND (s.status IS NULL OR s.status <> ALL($2::text[]))`,
    [userId, ACTIVE_STATUSES as unknown as string[]],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Members + pending (non-expired) invitations for an org. */
export async function seatCount(
  orgId: string,
  db: Queryable = defaultPool,
): Promise<{ members: number; pendingInvitations: number }> {
  const { rows: memberRows } = await db.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM member WHERE "organizationId" = $1`,
    [orgId],
  );
  const { rows: inviteRows } = await db.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM invitation
      WHERE "organizationId" = $1 AND status = 'pending' AND "expiresAt" > now()`,
    [orgId],
  );
  return {
    members: Number(memberRows[0]?.count ?? 0),
    pendingInvitations: Number(inviteRows[0]?.count ?? 0),
  };
}

/**
 * Can this user create another vault? Allowed when billing is off, or when
 * they own fewer than the cap in UNSUBSCRIBED vaults.
 */
export async function canCreateOrganization(
  userId: string,
  db: Queryable = defaultPool,
): Promise<{ allowed: boolean; limit: number }> {
  const limit = config.freeMaxVaults;
  if (!billingEnabled()) return { allowed: true, limit };
  const owned = await countOwnedUnsubscribedOrgs(userId, db);
  return { allowed: owned < limit, limit };
}

/**
 * Can a seat be added to this org (invitation or join-code redemption)? Allowed
 * when billing is off, when the org has an active subscription (unlimited), or
 * when members + pending invitations are below the cap.
 */
export async function canAddMember(
  orgId: string,
  db: Queryable = defaultPool,
): Promise<{ allowed: boolean; limit: number }> {
  const limit = config.freeMaxMembers;
  if (!billingEnabled()) return { allowed: true, limit };
  if (await orgHasActiveSubscription(orgId, db)) return { allowed: true, limit };
  const { members, pendingInvitations } = await seatCount(orgId, db);
  return { allowed: members + pendingInvitations < limit, limit };
}
