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
} from "../../billing/provider.js";
import { getEntitlement, seatCount } from "../../billing/entitlements.js";
import { successPageHtml } from "./billing-success.js";

/**
 * Subscription billing routes (frozen API contract).
 *
 *  GET  /api/billing/config              — public; advertises plans + limits.
 *  GET  /api/billing/orgs/:orgId         — member: this vault's plan/seats.
 *  POST /api/billing/orgs/:orgId/checkout — owner/admin: hosted checkout URL.
 *  POST /api/billing/orgs/:orgId/portal   — owner/admin: manage/cancel URL.
 *  POST /api/billing/webhook             — provider webhook (raw body, idempotent).
 *  GET  /api/billing/success             — checkout success landing page.
 *
 * When billing is disabled (no provider token), /config reports
 * `{ enabled: false }` and every other route 404s — self-host stays unlimited.
 */
export interface BillingDeps {
  provider: BillingProvider;
}

const PLANS = [
  { id: "pro-monthly", label: "Pro", amount: 1000, currency: "usd", interval: "month" },
  { id: "pro-yearly", label: "Pro", amount: 9700, currency: "usd", interval: "year" },
] as const;

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

    // MUST read the raw body before any JSON parsing so the signature matches.
    const raw = await c.req.text();
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

      // Ordering guard: webhooks aren't delivery-ordered, so only apply when the
      // incoming event is at least as new as the row we hold (event_ts). A stale
      // redelivery is still recorded as processed (claim above) but must NOT
      // overwrite newer state — the WHERE turns it into a no-op on conflict.
      await client.query(
        `INSERT INTO subscriptions (
           organization_id, provider, provider_customer_id, provider_subscription_id,
           plan, status, current_period_end, cancel_at_period_end, event_ts, updated_at
         ) VALUES ($1, 'polar', $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (organization_id) DO UPDATE SET
           provider_customer_id     = EXCLUDED.provider_customer_id,
           provider_subscription_id = EXCLUDED.provider_subscription_id,
           plan                     = EXCLUDED.plan,
           status                   = EXCLUDED.status,
           current_period_end       = EXCLUDED.current_period_end,
           cancel_at_period_end     = EXCLUDED.cancel_at_period_end,
           event_ts                 = EXCLUDED.event_ts,
           updated_at               = now()
         WHERE subscriptions.event_ts IS NULL
            OR EXCLUDED.event_ts >= subscriptions.event_ts`,
        [
          event.organizationId,
          event.providerCustomerId,
          event.providerSubscriptionId,
          event.plan,
          event.status,
          event.currentPeriodEnd,
          event.cancelAtPeriodEnd,
          event.occurredAt,
        ],
      );

      await client.query("COMMIT");
      return c.body(null, 200);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // ── status for a vault (any member) ─────────────────────────────────────────
  billing.get("/billing/orgs/:orgId", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "Not a member of this vault" }, 403);

    const ent = await getEntitlement(orgId);
    const seats = await seatCount(orgId);
    return c.json({
      plan: ent.plan,
      status: ent.status,
      currentPeriodEnd: ent.currentPeriodEnd,
      cancelAtPeriodEnd: ent.cancelAtPeriodEnd,
      seats: {
        members: seats.members,
        pendingInvitations: seats.pendingInvitations,
        // Active subscription ⇒ unlimited (null); otherwise the free-tier cap.
        limit: ent.active ? null : config.freeMaxMembers,
      },
    });
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

  // ── customer portal (owner/admin) ──────────────────────────────────────────
  billing.post("/billing/orgs/:orgId/portal", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (role !== "owner" && role !== "admin") {
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

  return billing;
}
