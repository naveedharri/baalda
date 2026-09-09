import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { config, billingEnabled } from "../../config.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import {
  WebhookSignatureError,
  type BillingInterval,
  type BillingProvider,
  type NormalizedBillingEvent,
  type SubscriptionSnapshot,
} from "../../billing/provider.js";
import {
  getEntitlement,
  normalizeIntervalForApi,
  seatCount,
  countOwnedUnsubscribedOrgs,
  type Entitlement,
} from "../../billing/entitlements.js";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_COLUMNS,
  applySubscriptionState,
  canManageSubscriptionRow,
  findByOrg,
  findByProviderSubscription,
  isActiveStatus,
  type SubscriptionRow,
  type SubscriptionState,
} from "../../billing/store.js";
import { successPageHtml } from "./billing-success.js";

/**
 * Subscription billing routes (frozen API contract).
 *
 *  GET  /api/billing/config               — public; advertises plans + limits.
 *  GET  /api/billing/mine                 — every vault I'm in + orphaned subs.
 *  GET  /api/billing/orgs/:orgId          — member: this vault's plan/seats.
 *  POST /api/billing/orgs/:orgId/checkout — owner/admin: hosted checkout URL.
 *  POST /api/billing/orgs/:orgId/portal   — owner/admin: manage/cancel URL.
 *  POST /api/billing/orgs/:orgId/cancel   — owner: stop at period end, or now.
 *  POST /api/billing/orgs/:orgId/transfer — owner: move a sub to another vault.
 *  POST /api/billing/webhook              — provider webhook (raw body, idempotent).
 *  GET  /api/billing/success              — checkout success landing page.
 *
 * When billing is disabled (no provider token), /config reports
 * `{ enabled: false }` and every other route 404s — self-host stays unlimited.
 *
 * A subscription can OUTLIVE its vault (#109/#111). Deleting a vault leaves a
 * **tombstone** row (`deleted_at` set) so the owner can still see, cancel or
 * transfer what they are paying for, and so a webhook that arrives afterwards
 * has somewhere to land instead of 500ing on a foreign key forever. Every
 * per-org route below therefore accepts the tombstone's recorded owner as well
 * as the live vault's members: `:orgId` may name a vault that no longer exists.
 */
export interface BillingDeps {
  provider: BillingProvider;
}

const PLANS = [
  { id: "pro-monthly", label: "Pro", amount: 1000, currency: "usd", interval: "month" },
  { id: "pro-yearly", label: "Pro", amount: 9700, currency: "usd", interval: "year" },
] as const;

/**
 * How stale an active row may get before `GET /mine` re-reads it from the
 * provider. Webhooks are the fast path; this is the backstop for the ones that
 * never arrive (a mis-signed endpoint, a delivery dropped during an outage —
 * 2026-09-08 was exactly that), so the two sides cannot stay diverged for
 * longer than one visit to the Billing tab.
 */
const RECONCILE_STALE_MINUTES = 10;
/** Cap the provider calls one request may make, so the tab can't hang on Polar. */
const RECONCILE_MAX_PER_REQUEST = 5;

/** Map a provider snapshot onto the shape `applySubscriptionState` persists. */
function stateFromSnapshot(
  orgId: string,
  snap: SubscriptionSnapshot,
  extra: Pick<SubscriptionState, "deletedAt" | "ownerUserId"> = {},
): SubscriptionState {
  return {
    organizationId: orgId,
    providerCustomerId: snap.providerCustomerId || null,
    providerSubscriptionId: snap.providerSubscriptionId || null,
    plan: "pro",
    status: snap.status,
    currentPeriodEnd: snap.currentPeriodEnd,
    cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
    eventTs: snap.modifiedAt,
    interval: snap.interval,
    amount: snap.amount,
    currency: snap.currency,
    ...extra,
  };
}

/** The `GET /api/billing/orgs/:orgId` body — shared with cancel and transfer. */
function orgBillingBody(
  ent: Entitlement,
  seats: { members: number; pendingInvitations: number },
) {
  return {
    plan: ent.plan,
    status: ent.status,
    currentPeriodEnd: ent.currentPeriodEnd,
    cancelAtPeriodEnd: ent.cancelAtPeriodEnd,
    interval: ent.interval,
    amount: ent.amount,
    currency: ent.currency,
    seats: {
      members: seats.members,
      pendingInvitations: seats.pendingInvitations,
      // Active subscription ⇒ unlimited (null); otherwise the free-tier cap.
      limit: ent.active ? null : config.freeMaxMembers,
    },
  };
}

/** Read the billing view for one org (works for a tombstone: seats come back 0). */
async function readOrgBilling(orgId: string) {
  const [ent, seats] = await Promise.all([getEntitlement(orgId), seatCount(orgId)]);
  return orgBillingBody(ent, seats);
}

/**
 * Does this user own the tombstone for `orgId`? The fallback authority for
 * every per-org route: the vault is gone, so `orgRole` has nothing to answer
 * with, but the person still being charged must not be locked out of the
 * subscription they are paying for.
 */
async function ownsTombstone(orgId: string, userId: string): Promise<boolean> {
  const row = await findByOrg(pool, orgId);
  return !!row && !!row.deleted_at && row.owner_user_id === userId;
}

export function createBillingRoutes(deps: BillingDeps): Hono {
  const billing = new Hono();

  // ── public config ─────────────────────────────────────────────────────────
  billing.get("/billing/config", (c) => {
    if (!billingEnabled()) return c.json({ enabled: false });
    return c.json({
      enabled: true,
      plans: PLANS,
      freeLimits: {
        // Legacy wire field names (desktop parses by exact name); do not rename.
        vaultsPerUser: config.freeMaxVaults,
        membersPerVault: config.freeMaxMembers,
      },
    });
  });

  // ── success landing page (checkout success_url) ─────────────────────────────
  billing.get("/billing/success", (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    return c.html(successPageHtml);
  });

  // ── webhook (raw body, signature-verified, idempotent) ─────────────────────
  // Registered before the gate below only conceptually; the gate short-circuits
  // disabled billing for ALL non-config routes including this one.
  billing.post("/billing/webhook", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);

    // This route is unauthenticated (signature is checked below), so bound the
    // body BEFORE buffering it — a Polar event is a few KB; 256 KB is ample.
    // Without this an attacker who knows the path could OOM the shared process
    // with a huge payload before the signature check ever runs.
    const MAX_WEBHOOK_BYTES = 256 * 1024;
    const declaredLen = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > MAX_WEBHOOK_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    // MUST read the raw body before any JSON parsing so the signature matches.
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });

    let event: NormalizedBillingEvent | null;
    try {
      event = deps.provider.verifyAndNormalizeWebhook(raw, headers);
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        return c.json({ error: "invalid signature" }, 403);
      }
      throw err;
    }

    // Valid signature, but an event we don't act on.
    if (!event) return c.body(null, 202);

    // The idempotency claim and the entitlement write MUST commit together: if
    // they were separate autocommit statements, a claim that landed before a
    // failed upsert would make Polar's retry short-circuit as "already
    // processed" and the org would never be upgraded. One transaction — a
    // failed upsert rolls back the claim so the retry re-processes cleanly.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Idempotency: first writer wins; a replay claims nothing and is a no-op.
      const claim = await client.query(
        `INSERT INTO billing_events (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [event.eventId],
      );
      if (claim.rowCount === 0) {
        await client.query("COMMIT");
        return c.body(null, 200); // already processed
      }

      // Which row does this subscription belong to? The provider subscription
      // id wins over `metadata.organization_id`: after a transfer Polar's
      // metadata can still name the vault the subscription came FROM, and
      // following it would move a live subscription back onto a vault that no
      // longer holds it.
      const existing = await findByProviderSubscription(
        client,
        event.providerSubscriptionId,
      );
      const orgId = existing?.organization_id ?? event.organizationId;

      // No row yet and no such org ⇒ the vault was deleted and this event is
      // about a subscription that outlived it. Record a tombstone and answer
      // 200. Before migration 024 this hit the FK, rolled back the idempotency
      // claim with it and 500'd, so Polar retried the same event forever (#109).
      let deletedAt: Date | null | undefined;
      if (!existing) {
        const { rowCount } = await client.query(
          "SELECT 1 FROM organization WHERE id = $1",
          [orgId],
        );
        if (rowCount === 0) {
          deletedAt = new Date();
          console.warn(
            `billing webhook for deleted vault ${orgId}: recorded as tombstone`,
          );
        }
      }

      // Ordering guard (inside applySubscriptionState): webhooks aren't
      // delivery-ordered, so provider state only applies when the incoming
      // event is at least as new as the row we hold. A stale redelivery is
      // still recorded as processed by the claim above but must NOT overwrite
      // newer state.
      await applySubscriptionState(client, {
        organizationId: orgId,
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        plan: event.plan,
        status: event.status,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        eventTs: event.occurredAt,
        interval: event.interval,
        amount: event.amount,
        currency: event.currency,
        deletedAt,
        // With the org gone there are no `member` rows to derive an owner from,
        // so checkout's `metadata.user_id` is the only remaining answer.
        ownerUserId: event.userId,
      });

      await client.query("COMMIT");
      return c.body(null, 200);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // ── every vault I'm in, plus subscriptions whose vault is gone ─────────────
  billing.get("/billing/mine", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const userId = session.userId;

    const { rows: memberships } = await pool.query<{
      org_id: string;
      name: string;
      role: string;
    }>(
      `SELECT o.id AS org_id, o.name AS name, m.role AS role
         FROM member m
         JOIN organization o ON o.id = m."organizationId"
        WHERE m."userId" = $1
        ORDER BY o.name ASC`,
      [userId],
    );

    // Reconcile before assembling, so what we return is what Polar says. Only
    // rows this user can actually act on, only ones that claim to be live, and
    // only after they have gone stale — a fresh row was just written by a
    // webhook or a mutation and re-reading it would be a wasted round trip.
    const manageableOrgIds = memberships
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => m.org_id);
    const { rows: stale } = await pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE (organization_id = ANY($1::text[])
               OR (owner_user_id = $2 AND deleted_at IS NOT NULL))
          AND status = ANY($3::text[])
          AND provider_subscription_id IS NOT NULL
          AND updated_at < now() - ($4 || ' minutes')::interval
        ORDER BY updated_at ASC
        LIMIT ${RECONCILE_MAX_PER_REQUEST}`,
      [
        manageableOrgIds,
        userId,
        ACTIVE_SUBSCRIPTION_STATUSES as unknown as string[],
        String(RECONCILE_STALE_MINUTES),
      ],
    );
    // Best-effort and never fatal: a provider outage must still render the tab.
    await Promise.allSettled(
      stale.map(async (row) => {
        const subId = row.provider_subscription_id;
        if (!subId) return;
        try {
          const snap = await deps.provider.getSubscription(subId);
          if (!snap) {
            // Unknown at Polar. Not "canceled" — our row points at something
            // that isn't there, which is a data question for a human.
            console.warn(
              `billing reconcile: provider does not know subscription ${subId} (vault ${row.organization_id})`,
            );
            return;
          }
          await applySubscriptionState(pool, stateFromSnapshot(row.organization_id, snap));
        } catch (err) {
          console.warn(
            `billing reconcile failed for vault ${row.organization_id}:`,
            (err as Error).message,
          );
        }
      }),
    );

    const orgIds = memberships.map((m) => m.org_id);
    const subsByOrg = new Map<string, SubscriptionRow>();
    const memberCounts = new Map<string, number>();
    const inviteCounts = new Map<string, number>();
    const owners = new Map<string, { userId: string; name: string; email: string }>();
    if (orgIds.length) {
      const [subs, members, invites, ownerRows] = await Promise.all([
        pool.query<SubscriptionRow>(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
            WHERE organization_id = ANY($1::text[])`,
          [orgIds],
        ),
        pool.query<{ org_id: string; c: number }>(
          `SELECT "organizationId" AS org_id, count(*)::int AS c FROM member
            WHERE "organizationId" = ANY($1::text[]) GROUP BY 1`,
          [orgIds],
        ),
        pool.query<{ org_id: string; c: number }>(
          `SELECT "organizationId" AS org_id, count(*)::int AS c FROM invitation
            WHERE "organizationId" = ANY($1::text[])
              AND status = 'pending' AND "expiresAt" > now()
            GROUP BY 1`,
          [orgIds],
        ),
        pool.query<{ org_id: string; user_id: string; name: string; email: string }>(
          `SELECT m."organizationId" AS org_id, u.id AS user_id, u.name AS name, u.email AS email
             FROM member m JOIN "user" u ON u.id = m."userId"
            WHERE m."organizationId" = ANY($1::text[]) AND m.role = 'owner'
            ORDER BY m."createdAt" ASC`,
          [orgIds],
        ),
      ]);
      for (const r of subs.rows) subsByOrg.set(r.organization_id, r);
      for (const r of members.rows) memberCounts.set(r.org_id, Number(r.c));
      for (const r of invites.rows) inviteCounts.set(r.org_id, Number(r.c));
      // First owner by join time wins — the vault's creator, who pays for it.
      for (const r of ownerRows.rows) {
        if (!owners.has(r.org_id)) {
          owners.set(r.org_id, { userId: r.user_id, name: r.name, email: r.email });
        }
      }
    }

    const vaults = memberships.map((m) => {
      const row = subsByOrg.get(m.org_id);
      const active = !!row && isActiveStatus(row.status);
      const role = (m.role === "owner" || m.role === "admin" ? m.role : "member") as
        | "owner"
        | "admin"
        | "member";
      return {
        orgId: m.org_id,
        name: m.name,
        role,
        plan: (active ? "pro" : "free") as "free" | "pro",
        status: apiStatus(row?.status),
        currentPeriodEnd: row?.current_period_end
          ? new Date(row.current_period_end).toISOString()
          : null,
        cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
        interval: normalizeIntervalForApi(row?.interval ?? null),
        amount: row?.amount === undefined || row.amount === null ? null : Number(row.amount),
        currency: row?.currency ?? null,
        seats: {
          members: memberCounts.get(m.org_id) ?? 0,
          pendingInvitations: inviteCounts.get(m.org_id) ?? 0,
          limit: active ? null : config.freeMaxMembers,
        },
        billingOwner: owners.get(m.org_id) ?? null,
        // Upgrade / Manage — the same owner-or-admin gate as checkout/portal.
        canManage: role === "owner" || role === "admin",
        // Moving money is the owner's alone, and only while there is something
        // live to move.
        canTransfer: role === "owner" && active,
      };
    });

    // Tombstones this user owns that are STILL being charged. A canceled
    // tombstone is history and deliberately not listed — there is nothing left
    // to act on and it would only clutter the tab.
    const { rows: orphanRows } = await pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE owner_user_id = $1
          AND deleted_at IS NOT NULL
          AND status = ANY($2::text[])
        ORDER BY deleted_at DESC`,
      [userId, ACTIVE_SUBSCRIPTION_STATUSES as unknown as string[]],
    );
    const orphaned = orphanRows.map((row) => ({
      orgId: row.organization_id,
      orgName: row.org_name,
      deletedAt: new Date(row.deleted_at as Date).toISOString(),
      status: row.status as "active" | "past_due",
      currentPeriodEnd: row.current_period_end
        ? new Date(row.current_period_end).toISOString()
        : null,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      interval: normalizeIntervalForApi(row.interval),
      amount: row.amount === null ? null : Number(row.amount),
      currency: row.currency,
    }));

    return c.json({
      vaults,
      orphaned,
      freeLimits: {
        // Frozen wire field names, as in /config.
        vaultsPerUser: config.freeMaxVaults,
        membersPerVault: config.freeMaxMembers,
        freeVaultsUsed: await countOwnedUnsubscribedOrgs(userId),
      },
    });
  });

  // ── status for a vault (any member, or a tombstone's owner) ────────────────
  billing.get("/billing/orgs/:orgId", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role && !(await ownsTombstone(orgId, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }

    return c.json(await readOrgBilling(orgId));
  });

  // ── create checkout (owner/admin) ──────────────────────────────────────────
  billing.post("/billing/orgs/:orgId/checkout", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only vault owner/admin can start checkout" }, 403);
    }

    // One vault, one subscription — always. `subscriptions` is keyed by
    // organization_id, so a second checkout would charge the card again and
    // then have nowhere to land: whichever subscription lost the upsert would
    // be invisible to us while Polar kept billing for it (the #109 shape of
    // problem, arrived at from the other direction). Refuse before the provider
    // is ever asked, so no checkout session exists to be paid for. Changing
    // plan or payment method goes through the portal; canceling goes through
    // /cancel.
    const existing = await findByOrg(pool, orgId);
    if (existing && isActiveStatus(existing.status)) {
      return c.json({ error: "already_subscribed" }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as { interval?: unknown };
    const interval: BillingInterval = body.interval === "year" ? "year" : "month";

    const successUrl = `${config.betterAuthUrl}/api/billing/success`;
    try {
      const { url } = await deps.provider.createCheckout({
        orgId,
        userId: session.userId,
        email: session.email,
        interval,
        successUrl,
      });
      return c.json({ url });
    } catch (err) {
      return c.json({ error: (err as Error).message || "checkout failed" }, 502);
    }
  });

  // ── customer portal (owner/admin, or a tombstone's owner) ─────────────────
  billing.post("/billing/orgs/:orgId/portal", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    const allowed =
      role === "owner" ||
      role === "admin" ||
      (await ownsTombstone(orgId, session.userId));
    if (!allowed) {
      return c.json({ error: "Only vault owner/admin can manage billing" }, 403);
    }

    const ent = await getEntitlement(orgId);
    if (!ent.providerCustomerId) {
      return c.json({ error: "No billing customer for this vault" }, 400);
    }
    try {
      const { url } = await deps.provider.getPortalUrl({
        customerId: ent.providerCustomerId,
      });
      return c.json({ url });
    } catch (err) {
      return c.json({ error: (err as Error).message || "portal failed" }, 502);
    }
  });

  // ── cancel (owner only; admins use the provider portal) ───────────────────
  // `period_end` keeps the paid period the owner already bought; `now` revokes
  // outright, which is the only way to stop paying for a vault that is gone.
  billing.post("/billing/orgs/:orgId/cancel", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const row = await findByOrg(pool, orgId);
    if (!row) return c.json({ error: "no_subscription" }, 404);
    if (!(await canManageSubscriptionRow(session.userId, row))) {
      return c.json({ error: "Only the vault owner can cancel the subscription" }, 403);
    }
    if (!isActiveStatus(row.status) || !row.provider_subscription_id) {
      return c.json({ error: "no_subscription" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    const mode: "period_end" | "now" = body.mode === "now" ? "now" : "period_end";

    let snap: SubscriptionSnapshot;
    try {
      snap = await deps.provider.cancelSubscription(row.provider_subscription_id, mode);
    } catch (err) {
      return c.json(
        {
          error: "subscription_cancel_failed",
          message: (err as Error).message || "provider cancel failed",
        },
        502,
      );
    }
    // The provider's answer IS the state — write it now rather than waiting on
    // a webhook that may be delayed or dropped.
    await applySubscriptionState(pool, stateFromSnapshot(orgId, snap));
    return c.json(await readOrgBilling(orgId));
  });

  // ── transfer a subscription to another vault I own (#110) ──────────────────
  // `:orgId` is the SOURCE and may be a tombstone: "delete the vault, make a
  // new one, move the subscription across" is the story this exists for, and
  // the subscription is only reachable through its tombstone by then.
  billing.post("/billing/orgs/:orgId/transfer", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const sourceOrgId = c.req.param("orgId");
    const body = (await c.req.json().catch(() => ({}))) as { targetOrgId?: unknown };
    const targetOrgId = typeof body.targetOrgId === "string" ? body.targetOrgId : "";
    if (!targetOrgId) return c.json({ error: "targetOrgId required" }, 400);

    const source = await findByOrg(pool, sourceOrgId);
    if (!source || !source.provider_subscription_id) {
      return c.json({ error: "no_subscription" }, 404);
    }
    if (!(await canManageSubscriptionRow(session.userId, source))) {
      return c.json({ error: "Only the vault owner can transfer the subscription" }, 403);
    }
    if (!isActiveStatus(source.status)) {
      return c.json({ error: "subscription_not_active" }, 409);
    }
    // Checked before the target lookup: when source === target and the source
    // is a tombstone, the target "org" doesn't exist either, and a 404 would
    // hide the actual mistake.
    if (targetOrgId === sourceOrgId) {
      return c.json({ error: "same_vault" }, 400);
    }

    const { rows: targetOrgRows } = await pool.query<{ name: string }>(
      "SELECT name FROM organization WHERE id = $1",
      [targetOrgId],
    );
    const targetName = targetOrgRows[0]?.name;
    if (targetName === undefined) return c.json({ error: "unknown_vault" }, 404);
    if ((await orgRole(targetOrgId, session.userId)) !== "owner") {
      return c.json({ error: "Only the target vault's owner can receive a subscription" }, 403);
    }
    const targetRow = await findByOrg(pool, targetOrgId);
    if (targetRow && isActiveStatus(targetRow.status)) {
      return c.json({ error: "target_already_subscribed" }, 409);
    }

    // Provider first, so a refusal changes nothing on our side. Un-cancel when
    // the subscription was scheduled to lapse (which is exactly what deleting
    // the source vault did to it) — otherwise the transfer would hand over a
    // subscription that quietly dies at the end of the month.
    let snap: SubscriptionSnapshot | null = null;
    if (source.cancel_at_period_end) {
      try {
        snap = await deps.provider.resumeSubscription(source.provider_subscription_id);
      } catch (err) {
        return c.json(
          {
            error: "subscription_resume_failed",
            message: (err as Error).message || "provider resume failed",
          },
          502,
        );
      }
    }
    // Best-effort: keep Polar's metadata honest for anyone reading it there.
    // Our row decides ownership, and webhooks resolve by provider subscription
    // id before they consult metadata, so a failure here costs us nothing.
    try {
      await deps.provider.setSubscriptionOrg(
        source.provider_subscription_id,
        targetOrgId,
        session.userId,
      );
    } catch (err) {
      console.error(
        `billing transfer: could not re-point provider metadata for ${source.provider_subscription_id}:`,
        (err as Error).message,
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A stale (canceled / none) row on the target would collide with the
      // primary key; it holds nothing worth keeping.
      if (targetRow) {
        await client.query("DELETE FROM subscriptions WHERE organization_id = $1", [
          targetOrgId,
        ]);
      }
      await client.query(
        `UPDATE subscriptions SET
           organization_id = $2,
           deleted_at      = NULL,
           org_name        = $3,
           owner_user_id   = $4,
           updated_at      = now()
         WHERE organization_id = $1`,
        [sourceOrgId, targetOrgId, targetName, session.userId],
      );
      if (snap) {
        await applySubscriptionState(
          client,
          stateFromSnapshot(targetOrgId, snap, { deletedAt: null }),
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return c.json({
      transferred: true,
      orgId: targetOrgId,
      billing: await readOrgBilling(targetOrgId),
    });
  });

  return billing;
}

/** Row status → the four values the wire contract allows. */
function apiStatus(status: string | undefined): "none" | "active" | "past_due" | "canceled" {
  if (status === "active" || status === "past_due" || status === "canceled") return status;
  return "none";
}
