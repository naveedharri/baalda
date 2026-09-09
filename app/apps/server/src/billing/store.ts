import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";

/**
 * The ONE write path for the `subscriptions` table.
 *
 * Five callers change a subscription row — the Polar webhook, vault deletion,
 * the cancel endpoint, transfer, and the reconcile pass in
 * `GET /api/billing/mine` — and before this file existed only the webhook could
 * write, so the other four had to improvise. `applySubscriptionState` gives
 * them all the same upsert, the same `event_ts` ordering guard and the same
 * tombstone bookkeeping, which is the only way "Polar and our DB always agree"
 * can hold: a provider snapshot and a webhook describing the same change can
 * arrive in either order and still converge on whichever the provider stamped
 * later.
 *
 * Two column groups, written by two statements on purpose:
 *
 *  1. **Provider state** (status, period end, cancel flag, price) is subject to
 *     the ordering guard — a stale redelivery must never overwrite newer state.
 *  2. **Our bookkeeping** (`org_name`, `owner_user_id`, `deleted_at`) is not.
 *     None of it comes from the provider, so provider event time says nothing
 *     about it, and a stale event that is otherwise a no-op should still be
 *     allowed to fill in an owner we were missing. That statement also bumps
 *     `updated_at`, which is what marks a row as freshly checked for the
 *     reconcile pass — otherwise a row whose guard suppressed the write would
 *     be re-reconciled on every single request.
 */

type Queryable = Pick<pg.Pool, "query">;

/** Statuses that mean "this vault is paid" (past_due is the grace period). */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "past_due"] as const;

/** Is this row one we should still be treating as a live subscription? */
export function isActiveStatus(status: string): boolean {
  return (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** A `subscriptions` row exactly as stored. */
export interface SubscriptionRow {
  organization_id: string;
  provider: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  plan: string;
  status: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  event_ts: Date | null;
  /** Non-null ⇒ the vault (org) has been deleted; this row is a tombstone. */
  deleted_at: Date | null;
  org_name: string | null;
  owner_user_id: string | null;
  interval: string | null;
  amount: number | null;
  currency: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Every column of `subscriptions`, for SELECTs that hand back a whole row. */
export const SUBSCRIPTION_COLUMNS = `organization_id, provider, provider_customer_id,
       provider_subscription_id, plan, status, current_period_end,
       cancel_at_period_end, event_ts, deleted_at, org_name, owner_user_id,
       interval, amount, currency, created_at, updated_at`;

/** What a caller knows about a subscription and wants persisted. */
export interface SubscriptionState {
  organizationId: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  /** Our internal plan id (currently always "pro"). */
  plan: string;
  /** "active" | "past_due" | "canceled". */
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Provider event/modification time — the ordering guard compares on this. */
  eventTs: Date | null;
  interval: string | null;
  amount: number | null;
  currency: string | null;
  /**
   * Tombstone marker. A `Date` sets it, `null` clears it (transfer onto a live
   * vault), and leaving it `undefined` keeps whatever the row already had — a
   * webhook for a live vault must not silently un-delete a tombstone, and one
   * for a deleted vault must not have its marker cleared by the next event.
   */
  deletedAt?: Date | null;
  /**
   * Fallback owner, used only when the org has no `owner` member to derive one
   * from — i.e. when the org row is already gone. `metadata.user_id` off the
   * webhook, or the caller's own id for a delete/transfer.
   */
  ownerUserId?: string | null;
}

/**
 * Upsert one subscription row and return it as stored.
 *
 * Pass the `client` that owns the surrounding transaction when there is one:
 * the webhook's idempotency claim and this write MUST commit together, and
 * vault deletion's tombstone must land with the `DELETE FROM organization`.
 */
export async function applySubscriptionState(
  client: Queryable,
  state: SubscriptionState,
): Promise<SubscriptionRow | null> {
  await client.query(
    `INSERT INTO subscriptions (
       organization_id, provider, provider_customer_id, provider_subscription_id,
       plan, status, current_period_end, cancel_at_period_end, event_ts,
       interval, amount, currency, updated_at
     ) VALUES ($1, 'polar', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       -- COALESCE, not a bare overwrite: a snapshot that didn't carry the
       -- customer id must not erase the one the portal needs to open.
       provider_customer_id     = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
       provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
       plan                     = EXCLUDED.plan,
       status                   = EXCLUDED.status,
       current_period_end       = EXCLUDED.current_period_end,
       cancel_at_period_end     = EXCLUDED.cancel_at_period_end,
       event_ts                 = EXCLUDED.event_ts,
       interval                 = COALESCE(EXCLUDED.interval, subscriptions.interval),
       amount                   = COALESCE(EXCLUDED.amount, subscriptions.amount),
       currency                 = COALESCE(EXCLUDED.currency, subscriptions.currency),
       updated_at               = now()
     WHERE subscriptions.event_ts IS NULL
        OR EXCLUDED.event_ts >= subscriptions.event_ts`,
    [
      state.organizationId,
      state.providerCustomerId || null,
      state.providerSubscriptionId || null,
      state.plan,
      state.status,
      state.currentPeriodEnd,
      state.cancelAtPeriodEnd,
      state.eventTs,
      state.interval,
      state.amount,
      state.currency,
    ],
  );

  // Bookkeeping, outside the ordering guard (see the file header). `org_name`
  // is refreshed from the live org and otherwise kept — a tombstone has no org
  // to read a name from, and losing the snapshot would leave the owner staring
  // at an unnamed charge.
  const { rows } = await client.query<SubscriptionRow>(
    `UPDATE subscriptions SET
       org_name      = COALESCE((SELECT name FROM organization WHERE id = $1), org_name),
       owner_user_id = COALESCE(
                         owner_user_id,
                         (SELECT m."userId" FROM member m
                           WHERE m."organizationId" = $1 AND m.role = 'owner'
                           ORDER BY m."createdAt" LIMIT 1),
                         $2),
       deleted_at    = CASE WHEN $3 THEN $4::timestamptz ELSE deleted_at END,
       updated_at    = now()
     WHERE organization_id = $1
     RETURNING ${SUBSCRIPTION_COLUMNS}`,
    [
      state.organizationId,
      state.ownerUserId ?? null,
      state.deletedAt !== undefined,
      state.deletedAt ?? null,
    ],
  );
  return rows[0] ?? null;
}

/** Read one org's subscription row, or null. */
export async function findByOrg(
  client: Queryable,
  orgId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await client.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE organization_id = $1`,
    [orgId],
  );
  return rows[0] ?? null;
}

/**
 * Find the row that currently holds a given provider subscription.
 *
 * Webhooks resolve through this FIRST and only fall back to
 * `metadata.organization_id`. After a transfer Polar's metadata may still name
 * the vault the subscription came from (the metadata PATCH is best-effort), so
 * trusting metadata would walk a live subscription straight back onto a vault
 * that no longer holds it — and, if that vault had been deleted, resurrect its
 * tombstone as the paid one. There is no unique index on the column on purpose
 * (a canceled row for an old vault may legitimately linger holding the same
 * id), so the most recently written row wins.
 */
export async function findByProviderSubscription(
  client: Queryable,
  providerSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  if (!providerSubscriptionId) return null;
  const { rows } = await client.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE provider_subscription_id = $1
      ORDER BY updated_at DESC LIMIT 1`,
    [providerSubscriptionId],
  );
  return rows[0] ?? null;
}

/**
 * May this user cancel or transfer this subscription?
 *
 * While the vault lives, the answer is the vault's own authority: the `owner`
 * role and only that (an admin manages billing through the provider portal,
 * which can neither delete nor move anything of ours). Once the vault is gone
 * there are no `member` rows left to ask, so the tombstone's recorded
 * `owner_user_id` is the whole answer — which is exactly why migration 024
 * records it.
 */
export async function canManageSubscriptionRow(
  userId: string,
  row: SubscriptionRow,
  db: Queryable = defaultPool,
): Promise<boolean> {
  if (row.deleted_at) return row.owner_user_id === userId;
  return (await orgRole(row.organization_id, userId, db)) === "owner";
}
