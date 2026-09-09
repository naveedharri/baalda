import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { getEntitlement } from "../src/billing/entitlements.js";
import { testAppDeps } from "./helpers/app.js";
import { makeFakeProvider, makeSnapshot } from "./helpers/billing-provider.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";

/**
 * Subscription LIFECYCLE — the half of billing that outlives a vault
 * (#109 orphaned subscriptions, #110 transfer, #111 the "mine" aggregate).
 *
 * `billing.test.ts` covers the steady state: config, entitlement reads,
 * checkout, the 402 caps, webhook signatures and ordering. This suite covers
 * what happens when the vault and the subscription stop agreeing about whether
 * they exist — a webhook for a vault we deleted, a delete that must not
 * proceed unless the provider confirms the cancel, and a subscription moving
 * between vaults.
 */

const fakeProvider = makeFakeProvider();
const app = createApp(testAppDeps({ billingProvider: fakeProvider }));

function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

/** Seed a subscription row the way a webhook would have written it. */
async function seedSubscription(
  orgId: string,
  status: string,
  extra: Partial<{
    customerId: string;
    subId: string;
    periodEnd: Date;
    cancelAtPeriodEnd: boolean;
    ownerUserId: string;
    deletedAt: Date;
    orgName: string;
    interval: string;
    amount: number;
    currency: string;
  }> = {},
) {
  await pool.query(
    `INSERT INTO subscriptions (organization_id, provider, provider_customer_id,
       provider_subscription_id, plan, status, current_period_end,
       cancel_at_period_end, deleted_at, org_name, owner_user_id,
       interval, amount, currency)
     VALUES ($1, 'polar', $2, $3, 'pro', $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (organization_id) DO UPDATE SET
       status = EXCLUDED.status,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end`,
    [
      orgId,
      extra.customerId ?? "cus_test",
      extra.subId ?? "sub_test",
      status,
      extra.periodEnd ?? new Date(Date.now() + 30 * 86400_000),
      extra.cancelAtPeriodEnd ?? false,
      extra.deletedAt ?? null,
      extra.orgName ?? null,
      extra.ownerUserId ?? null,
      extra.interval ?? "month",
      extra.amount ?? 1000,
      extra.currency ?? "usd",
    ],
  );
}

interface RawSub {
  organization_id: string;
  status: string;
  cancel_at_period_end: boolean;
  deleted_at: Date | null;
  org_name: string | null;
  owner_user_id: string | null;
  provider_subscription_id: string | null;
  interval: string | null;
  amount: number | null;
  currency: string | null;
}

async function readSub(orgId: string): Promise<RawSub | undefined> {
  const { rows } = await pool.query<RawSub>(
    `SELECT organization_id, status, cancel_at_period_end, deleted_at, org_name,
            owner_user_id, provider_subscription_id, interval, amount, currency
       FROM subscriptions WHERE organization_id = $1`,
    [orgId],
  );
  return rows[0];
}

/** Add a member row directly — Better Auth has no "make this user an admin". */
async function addMember(orgId: string, user: TestUser, role: string) {
  await pool.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, $4, now())`,
    [`m_${Math.random().toString(36).slice(2)}`, orgId, user.userId, role],
  );
}

/** Pretend this row was last written a while ago, so /mine reconciles it. */
async function backdate(orgId: string, minutes: number) {
  await pool.query(
    `UPDATE subscriptions SET updated_at = now() - ($2 || ' minutes')::interval
      WHERE organization_id = $1`,
    [orgId, String(minutes)],
  );
}

describe("subscription lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
    fakeProvider.reset();
    process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token"; // billing ON
  });
  afterEach(() => {
    delete process.env.POLAR_ACCESS_TOKEN;
  });
  afterAll(async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await pool.end();
  });

  // ── (a) a webhook for a vault we no longer have ───────────────────────────
  describe("webhook for a deleted vault", () => {
    it("records a tombstone and answers 200 instead of looping on a FK error", async () => {
      const ghostOrg = "org_ghost";
      const ghostUser = "user_ghost";
      fakeProvider.nextEvent = {
        eventId: "evt_ghost_1",
        occurredAt: new Date(Date.now() - 60_000),
        type: "subscription_active",
        organizationId: ghostOrg,
        userId: ghostUser,
        providerCustomerId: "cus_ghost",
        providerSubscriptionId: "sub_ghost",
        plan: "pro",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        cancelAtPeriodEnd: false,
        interval: "year",
        amount: 9700,
        currency: "usd",
      };

      const res = await req("POST", "/api/billing/webhook", { body: {} });
      expect(res.status).toBe(200);

      const row = await readSub(ghostOrg);
      expect(row).toBeDefined();
      expect(row?.deleted_at).not.toBeNull();
      // No `member` rows survive a vault delete, so checkout's metadata.user_id
      // is the only remaining answer to "whose subscription is this".
      expect(row?.owner_user_id).toBe(ghostUser);
      expect(row?.org_name).toBeNull();
      expect(row?.status).toBe("active");
      expect(row?.interval).toBe("year");
      expect(Number(row?.amount)).toBe(9700);
    });

    it("is idempotent on replay", async () => {
      fakeProvider.nextEvent = {
        eventId: "evt_ghost_replay",
        occurredAt: new Date(),
        type: "subscription_active",
        organizationId: "org_ghost",
        userId: "user_ghost",
        providerCustomerId: "cus_ghost",
        providerSubscriptionId: "sub_ghost",
        plan: "pro",
        status: "active",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        interval: "month",
        amount: 1000,
        currency: "usd",
      };
      expect((await req("POST", "/api/billing/webhook", { body: {} })).status).toBe(200);
      expect((await req("POST", "/api/billing/webhook", { body: {} })).status).toBe(200);

      const { rows } = await pool.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM billing_events",
      );
      expect(Number(rows[0].c)).toBe(1);
      const { rows: subs } = await pool.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM subscriptions",
      );
      expect(Number(subs[0].c)).toBe(1);
    });

    it("flips an existing tombstone to canceled on a later revoke", async () => {
      const base = {
        organizationId: "org_ghost",
        userId: "user_ghost",
        providerCustomerId: "cus_ghost",
        providerSubscriptionId: "sub_ghost",
        plan: "pro",
        interval: "month" as const,
        amount: 1000,
        currency: "usd",
      };
      fakeProvider.nextEvent = {
        ...base,
        eventId: "evt_ghost_active",
        occurredAt: new Date(Date.now() - 60_000),
        type: "subscription_active",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        cancelAtPeriodEnd: false,
      };
      await req("POST", "/api/billing/webhook", { body: {} });

      fakeProvider.nextEvent = {
        ...base,
        eventId: "evt_ghost_revoked",
        occurredAt: new Date(),
        type: "subscription_revoked",
        status: "canceled",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      };
      expect((await req("POST", "/api/billing/webhook", { body: {} })).status).toBe(200);

      const row = await readSub("org_ghost");
      expect(row?.status).toBe("canceled");
      // Still a tombstone — the second event must not resurrect the vault.
      expect(row?.deleted_at).not.toBeNull();
    });
  });

  // ── (b) webhooks follow the subscription, not the metadata ────────────────
  it("resolves a webhook by provider subscription id after a transfer", async () => {
    const owner = await signUp("xfer-wh@billing.com");
    const source = await createOrg(owner, "Source", "wh-source");
    const target = await createOrg(owner, "Target", "wh-target");
    await seedSubscription(source.id, "active", { subId: "sub_moved" });

    const moved = await req("POST", `/api/billing/orgs/${source.id}/transfer`, {
      token: owner.token,
      body: { targetOrgId: target.id },
    });
    expect(moved.status).toBe(200);

    // Polar's metadata still names the OLD vault (the PATCH is best-effort and
    // may not have landed); following it would walk the subscription back.
    fakeProvider.nextEvent = {
      eventId: "evt_after_xfer",
      occurredAt: new Date(),
      type: "subscription_updated",
      organizationId: source.id,
      userId: owner.userId,
      providerCustomerId: "cus_test",
      providerSubscriptionId: "sub_moved",
      plan: "pro",
      status: "past_due",
      currentPeriodEnd: new Date(Date.now() + 5 * 86400_000),
      cancelAtPeriodEnd: false,
      interval: "month",
      amount: 1000,
      currency: "usd",
    };
    expect((await req("POST", "/api/billing/webhook", { body: {} })).status).toBe(200);

    expect((await readSub(target.id))?.status).toBe("past_due");
    // And no second row was created for the vault it came from.
    expect(await readSub(source.id)).toBeUndefined();
  });

  // ── (c) deleting a vault ──────────────────────────────────────────────────
  describe("DELETE /api/orgs/:orgId", () => {
    it("cancels at period end and keeps the row as a tombstone", async () => {
      const owner = await signUp("d1@billing.com");
      const org = await createOrg(owner, "D1", "d1-org");
      await seedSubscription(org.id, "active", { subId: "sub_d1" });

      const res = await req("DELETE", `/api/orgs/${org.id}`, { token: owner.token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deleted: boolean;
        subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
      };
      expect(body.deleted).toBe(true);
      expect(body.subscription?.cancelAtPeriodEnd).toBe(true);
      // period_end, not revoke: the owner already paid for this month.
      expect(fakeProvider.canceled).toEqual([{ id: "sub_d1", mode: "period_end" }]);

      const row = await readSub(org.id);
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.cancel_at_period_end).toBe(true);
      expect(row?.owner_user_id).toBe(owner.userId);
      expect(row?.org_name).toBe("D1");
      const { rows: orgRows } = await pool.query("SELECT 1 FROM organization WHERE id = $1", [
        org.id,
      ]);
      expect(orgRows.length).toBe(0);
    });

    it("still asks the provider when our row already says the subscription is ending", async () => {
      // Our copy can be stale (an un-cancel made in the portal whose webhook
      // never arrived); the provider call is idempotent, so always make it.
      const owner = await signUp("d2@billing.com");
      const org = await createOrg(owner, "D2", "d2-org");
      await seedSubscription(org.id, "active", {
        subId: "sub_d2",
        cancelAtPeriodEnd: true,
      });

      const res = await req("DELETE", `/api/orgs/${org.id}`, { token: owner.token });
      expect(res.status).toBe(200);
      expect(fakeProvider.canceled).toEqual([{ id: "sub_d2", mode: "period_end" }]);
      const body = (await res.json()) as {
        subscription: { cancelAtPeriodEnd: boolean } | null;
      };
      expect(body.subscription?.cancelAtPeriodEnd).toBe(true);
      expect((await readSub(org.id))?.deleted_at).not.toBeNull();
    });

    it("aborts the whole delete with 502 when the provider refuses", async () => {
      const owner = await signUp("d3@billing.com");
      const org = await createOrg(owner, "D3", "d3-org");
      await seedSubscription(org.id, "active", { subId: "sub_d3" });
      fakeProvider.failCancel = new Error("polar is down");

      const res = await req("DELETE", `/api/orgs/${org.id}`, { token: owner.token });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("subscription_cancel_failed");
      expect(body.message).toContain("polar is down");

      // Nothing was deleted — a provider outage must not cost someone a vault
      // while Polar keeps charging for it.
      const { rows: orgRows } = await pool.query("SELECT 1 FROM organization WHERE id = $1", [
        org.id,
      ]);
      expect(orgRows.length).toBe(1);
      const row = await readSub(org.id);
      expect(row?.deleted_at).toBeNull();
      expect(row?.status).toBe("active");
    });

    it("deletes a free vault without touching the provider", async () => {
      const owner = await signUp("d4@billing.com");
      const org = await createOrg(owner, "D4", "d4-org");

      const res = await req("DELETE", `/api/orgs/${org.id}`, { token: owner.token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean; subscription: unknown };
      expect(body.deleted).toBe(true);
      expect(body.subscription).toBeNull();
      expect(fakeProvider.canceled).toEqual([]);
      expect(await readSub(org.id)).toBeUndefined();
    });
  });

  // ── (d) transfer ──────────────────────────────────────────────────────────
  describe("POST /api/billing/orgs/:orgId/transfer", () => {
    it("moves a live subscription between two vaults the caller owns", async () => {
      const owner = await signUp("t1@billing.com");
      const source = await createOrg(owner, "T1 Source", "t1-source");
      const target = await createOrg(owner, "T1 Target", "t1-target");
      await seedSubscription(source.id, "active", { subId: "sub_t1" });

      const res = await req("POST", `/api/billing/orgs/${source.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: target.id },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        transferred: boolean;
        orgId: string;
        billing: { plan: string; status: string; amount: number | null };
      };
      expect(body.transferred).toBe(true);
      expect(body.orgId).toBe(target.id);
      expect(body.billing.plan).toBe("pro");
      expect(body.billing.amount).toBe(1000);

      expect(await readSub(source.id)).toBeUndefined();
      const row = await readSub(target.id);
      expect(row?.status).toBe("active");
      expect(row?.deleted_at).toBeNull();
      expect(row?.org_name).toBe("T1 Target");
      expect(row?.owner_user_id).toBe(owner.userId);
      // Nothing was scheduled to lapse, so there was nothing to un-cancel.
      expect(fakeProvider.resumed).toEqual([]);
      expect(fakeProvider.metadataWrites).toEqual([
        { id: "sub_t1", orgId: target.id, userId: owner.userId },
      ]);
    });

    it("un-cancels and moves a tombstone left behind by a deleted vault", async () => {
      const owner = await signUp("t2@billing.com");
      const gone = await createOrg(owner, "T2 Gone", "t2-gone");
      await seedSubscription(gone.id, "active", { subId: "sub_t2" });
      expect((await req("DELETE", `/api/orgs/${gone.id}`, { token: owner.token })).status).toBe(
        200,
      );
      // The delete scheduled it to lapse; the transfer has to take that back.
      expect((await readSub(gone.id))?.cancel_at_period_end).toBe(true);

      const target = await createOrg(owner, "T2 Target", "t2-target");
      const res = await req("POST", `/api/billing/orgs/${gone.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: target.id },
      });
      expect(res.status).toBe(200);

      expect(fakeProvider.resumed).toEqual(["sub_t2"]);
      const row = await readSub(target.id);
      expect(row?.deleted_at).toBeNull();
      expect(row?.status).toBe("active");
      expect(row?.cancel_at_period_end).toBe(false);
      expect(await readSub(gone.id)).toBeUndefined();
      // The moved subscription is live Pro on the new vault.
      const ent = await getEntitlement(target.id);
      expect(ent.plan).toBe("pro");
      expect(ent.active).toBe(true);
    });

    it("refuses a target the caller does not own (403)", async () => {
      const owner = await signUp("t3a@billing.com");
      const other = await signUp("t3b@billing.com");
      const source = await createOrg(owner, "T3 Source", "t3-source");
      const target = await createOrg(other, "T3 Target", "t3-target");
      await seedSubscription(source.id, "active", { subId: "sub_t3" });

      const res = await req("POST", `/api/billing/orgs/${source.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: target.id },
      });
      expect(res.status).toBe(403);
      expect((await readSub(source.id))?.organization_id).toBe(source.id);
    });

    it("refuses a target that already pays (409 target_already_subscribed)", async () => {
      const owner = await signUp("t4@billing.com");
      const source = await createOrg(owner, "T4 Source", "t4-source");
      const target = await createOrg(owner, "T4 Target", "t4-target");
      await seedSubscription(source.id, "active", { subId: "sub_t4a" });
      await seedSubscription(target.id, "active", { subId: "sub_t4b" });

      const res = await req("POST", `/api/billing/orgs/${source.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: target.id },
      });
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toEqual({
        error: "target_already_subscribed",
      });
    });

    it("refuses a source that is not active (409 subscription_not_active)", async () => {
      const owner = await signUp("t5@billing.com");
      const source = await createOrg(owner, "T5 Source", "t5-source");
      const target = await createOrg(owner, "T5 Target", "t5-target");
      await seedSubscription(source.id, "canceled", { subId: "sub_t5" });

      const res = await req("POST", `/api/billing/orgs/${source.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: target.id },
      });
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toEqual({
        error: "subscription_not_active",
      });
    });

    it("refuses a transfer onto itself (400 same_vault)", async () => {
      const owner = await signUp("t6@billing.com");
      const org = await createOrg(owner, "T6", "t6-org");
      await seedSubscription(org.id, "active", { subId: "sub_t6" });

      const res = await req("POST", `/api/billing/orgs/${org.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: org.id },
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual({ error: "same_vault" });
    });

    it("replaces a stale canceled row on the target", async () => {
      const owner = await signUp("t7@billing.com");
      const source = await createOrg(owner, "T7 Source", "t7-source");
      const target = await createOrg(owner, "T7 Target", "t7-target");
      await seedSubscription(source.id, "active", { subId: "sub_t7_live" });
      await seedSubscription(target.id, "canceled", { subId: "sub_t7_dead" });

      const res = await req("POST", `/api/billing/orgs/${source.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: target.id },
      });
      expect(res.status).toBe(200);

      const row = await readSub(target.id);
      expect(row?.status).toBe("active");
      expect(row?.provider_subscription_id).toBe("sub_t7_live");
      const { rows } = await pool.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM subscriptions",
      );
      expect(Number(rows[0].c)).toBe(1);
    });

    it("404s with no subscription to move", async () => {
      const owner = await signUp("t8@billing.com");
      const source = await createOrg(owner, "T8 Source", "t8-source");
      const target = await createOrg(owner, "T8 Target", "t8-target");
      const res = await req("POST", `/api/billing/orgs/${source.id}/transfer`, {
        token: owner.token,
        body: { targetOrgId: target.id },
      });
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toEqual({ error: "no_subscription" });
    });
  });

  // ── (e) cancel ────────────────────────────────────────────────────────────
  describe("POST /api/billing/orgs/:orgId/cancel", () => {
    it("schedules a cancel at period end by default", async () => {
      const owner = await signUp("c1@billing.com");
      const org = await createOrg(owner, "C1", "c1-org");
      await seedSubscription(org.id, "active", { subId: "sub_c1" });

      const res = await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
        token: owner.token,
        body: {},
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { plan: string; cancelAtPeriodEnd: boolean };
      expect(fakeProvider.canceled).toEqual([{ id: "sub_c1", mode: "period_end" }]);
      expect(body.cancelAtPeriodEnd).toBe(true);
      // Access continues until the period runs out.
      expect(body.plan).toBe("pro");
      expect((await readSub(org.id))?.cancel_at_period_end).toBe(true);
    });

    it("revokes immediately for mode=now", async () => {
      const owner = await signUp("c2@billing.com");
      const org = await createOrg(owner, "C2", "c2-org");
      await seedSubscription(org.id, "active", { subId: "sub_c2" });

      const res = await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
        token: owner.token,
        body: { mode: "now" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { plan: string; status: string };
      expect(fakeProvider.canceled).toEqual([{ id: "sub_c2", mode: "now" }]);
      expect(body.status).toBe("canceled");
      expect(body.plan).toBe("free");
    });

    it("refuses an admin (403) — billing changes are the owner's", async () => {
      const owner = await signUp("c3a@billing.com");
      const admin = await signUp("c3b@billing.com");
      const org = await createOrg(owner, "C3", "c3-org");
      await addMember(org.id, admin, "admin");
      await seedSubscription(org.id, "active", { subId: "sub_c3" });

      const res = await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
        token: admin.token,
        body: {},
      });
      expect(res.status).toBe(403);
      expect(fakeProvider.canceled).toEqual([]);
    });

    it("lets the owner of a tombstone stop paying for a vault that is gone", async () => {
      const owner = await signUp("c4@billing.com");
      const org = await createOrg(owner, "C4", "c4-org");
      await seedSubscription(org.id, "active", { subId: "sub_c4" });
      await req("DELETE", `/api/orgs/${org.id}`, { token: owner.token });
      fakeProvider.reset();

      const res = await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
        token: owner.token,
        body: { mode: "now" },
      });
      expect(res.status).toBe(200);
      expect(fakeProvider.canceled).toEqual([{ id: "sub_c4", mode: "now" }]);
      const row = await readSub(org.id);
      expect(row?.status).toBe("canceled");
      // Still a tombstone; canceling does not un-delete the vault.
      expect(row?.deleted_at).not.toBeNull();
    });

    it("404s when there is nothing active to cancel", async () => {
      const owner = await signUp("c5@billing.com");
      const org = await createOrg(owner, "C5", "c5-org");
      const missing = await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
        token: owner.token,
        body: {},
      });
      expect(missing.status).toBe(404);

      await seedSubscription(org.id, "canceled", { subId: "sub_c5" });
      const inactive = await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
        token: owner.token,
        body: {},
      });
      expect(inactive.status).toBe(404);
    });

    it("reports a provider failure as 502 and changes nothing", async () => {
      const owner = await signUp("c6@billing.com");
      const org = await createOrg(owner, "C6", "c6-org");
      await seedSubscription(org.id, "active", { subId: "sub_c6" });
      fakeProvider.failCancel = new Error("polar refused");

      const res = await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
        token: owner.token,
        body: {},
      });
      expect(res.status).toBe(502);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "subscription_cancel_failed",
      });
      expect((await readSub(org.id))?.cancel_at_period_end).toBe(false);
    });
  });

  // ── one vault, one subscription ───────────────────────────────────────────
  //    The steady-state 409 lives in billing.test.ts beside the other checkout
  //    cases; these are the lifecycle angles — what the guard does once a
  //    subscription has been canceled, and what a tombstone must NOT block.
  describe("POST /api/billing/orgs/:orgId/checkout", () => {
    it("refuses a second checkout, then allows one after a real cancel", async () => {
      const owner = await signUp("k1@billing.com");
      const org = await createOrg(owner, "K1", "k1-org");
      await seedSubscription(org.id, "active", { subId: "sub_k1" });

      const dup = await req("POST", `/api/billing/orgs/${org.id}/checkout`, {
        token: owner.token,
        body: { interval: "month" },
      });
      expect(dup.status).toBe(409);
      expect((await dup.json()) as { error: string }).toEqual({ error: "already_subscribed" });
      // Refused before the provider was ever asked, so no checkout session
      // exists that someone could still go and pay for.
      expect(fakeProvider.lastCheckout).toBeNull();

      // Cancel for real, then the Upgrade button has to work again.
      expect(
        (
          await req("POST", `/api/billing/orgs/${org.id}/cancel`, {
            token: owner.token,
            body: { mode: "now" },
          })
        ).status,
      ).toBe(200);
      expect((await readSub(org.id))?.status).toBe("canceled");

      const again = await req("POST", `/api/billing/orgs/${org.id}/checkout`, {
        token: owner.token,
        body: { interval: "year" },
      });
      expect(again.status).toBe(200);
      expect((fakeProvider.lastCheckout as { orgId: string; interval: string }).orgId).toBe(
        org.id,
      );
    });

    it("still refuses during the past_due grace, when access has not lapsed", async () => {
      const owner = await signUp("k2@billing.com");
      const org = await createOrg(owner, "K2", "k2-org");
      await seedSubscription(org.id, "past_due", { subId: "sub_k2" });

      const res = await req("POST", `/api/billing/orgs/${org.id}/checkout`, {
        token: owner.token,
        body: { interval: "month" },
      });
      expect(res.status).toBe(409);
      expect(fakeProvider.lastCheckout).toBeNull();
    });

    it("does not let a deleted vault's tombstone block a new vault's checkout", async () => {
      const owner = await signUp("k3@billing.com");
      const gone = await createOrg(owner, "K3 Gone", "k3-gone");
      await seedSubscription(gone.id, "active", { subId: "sub_k3" });
      await req("DELETE", `/api/orgs/${gone.id}`, { token: owner.token });
      expect((await readSub(gone.id))?.deleted_at).not.toBeNull();

      // The guard is keyed to the vault being paid for, and a tombstone belongs
      // to a vault that no longer exists. Starting again on a fresh vault is
      // exactly the story #110 was written for.
      const fresh = await createOrg(owner, "K3 Fresh", "k3-fresh");
      const res = await req("POST", `/api/billing/orgs/${fresh.id}/checkout`, {
        token: owner.token,
        body: { interval: "month" },
      });
      expect(res.status).toBe(200);
    });
  });

  // ── (f) the aggregate the Billing tab renders ─────────────────────────────
  describe("GET /api/billing/mine", () => {
    it("lists every vault the caller is in, plus orphaned subscriptions", async () => {
      const owner = await signUp("m1@billing.com");
      const mate = await signUp("m1b@billing.com");
      const paid = await createOrg(owner, "Paid", "m1-paid");
      const free = await createOrg(owner, "Free", "m1-free");
      await addMember(paid.id, mate, "member");
      await seedSubscription(paid.id, "active", {
        subId: "sub_m1",
        interval: "year",
        amount: 9700,
      });
      // A vault this owner deleted while it was still being charged.
      const gone = await createOrg(owner, "Gone", "m1-gone");
      await seedSubscription(gone.id, "active", { subId: "sub_m1_gone" });
      await req("DELETE", `/api/orgs/${gone.id}`, { token: owner.token });

      const res = await req("GET", "/api/billing/mine", { token: owner.token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vaults: Array<{
          orgId: string;
          name: string;
          role: string;
          plan: string;
          status: string;
          interval: string | null;
          amount: number | null;
          seats: { members: number; pendingInvitations: number; limit: number | null };
          billingOwner: { userId: string; email: string } | null;
          canManage: boolean;
          canTransfer: boolean;
        }>;
        orphaned: Array<{ orgId: string; orgName: string | null; status: string }>;
        freeLimits: {
          vaultsPerUser: number;
          membersPerVault: number;
          freeVaultsUsed: number;
        };
      };

      expect(body.vaults.map((v) => v.orgId).sort()).toEqual([free.id, paid.id].sort());
      const paidCard = body.vaults.find((v) => v.orgId === paid.id)!;
      expect(paidCard.role).toBe("owner");
      expect(paidCard.plan).toBe("pro");
      expect(paidCard.status).toBe("active");
      expect(paidCard.interval).toBe("year");
      expect(paidCard.amount).toBe(9700);
      expect(paidCard.seats.members).toBe(2);
      expect(paidCard.seats.limit).toBeNull(); // paid ⇒ unlimited
      expect(paidCard.billingOwner?.userId).toBe(owner.userId);
      expect(paidCard.canManage).toBe(true);
      expect(paidCard.canTransfer).toBe(true);

      const freeCard = body.vaults.find((v) => v.orgId === free.id)!;
      expect(freeCard.plan).toBe("free");
      expect(freeCard.status).toBe("none");
      expect(freeCard.seats.limit).toBe(config.freeMaxMembers);
      expect(freeCard.canTransfer).toBe(false);

      expect(body.orphaned).toHaveLength(1);
      expect(body.orphaned[0]).toMatchObject({
        orgId: gone.id,
        orgName: "Gone",
        status: "active",
      });
      // Only the free vault counts toward the free-vault cap.
      expect(body.freeLimits.freeVaultsUsed).toBe(1);
      expect(body.freeLimits.vaultsPerUser).toBe(config.freeMaxVaults);
      expect(body.freeLimits.membersPerVault).toBe(config.freeMaxMembers);
    });

    it("shows a teammate their role and hides someone else's orphans", async () => {
      const owner = await signUp("m2a@billing.com");
      const mate = await signUp("m2b@billing.com");
      const org = await createOrg(owner, "Shared", "m2-shared");
      await addMember(org.id, mate, "member");
      const gone = await createOrg(owner, "Owner Gone", "m2-gone");
      await seedSubscription(gone.id, "active", { subId: "sub_m2" });
      await req("DELETE", `/api/orgs/${gone.id}`, { token: owner.token });

      const res = await req("GET", "/api/billing/mine", { token: mate.token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vaults: Array<{ orgId: string; role: string; canManage: boolean; canTransfer: boolean }>;
        orphaned: unknown[];
      };
      expect(body.vaults).toHaveLength(1);
      expect(body.vaults[0]).toMatchObject({
        orgId: org.id,
        role: "member",
        canManage: false,
        canTransfer: false,
      });
      // The tombstone belongs to the owner, not to this teammate.
      expect(body.orphaned).toEqual([]);
    });

    it("reconciles a stale active row against the provider", async () => {
      const owner = await signUp("m3@billing.com");
      const org = await createOrg(owner, "M3", "m3-org");
      await seedSubscription(org.id, "active", { subId: "sub_m3" });
      await backdate(org.id, 20);
      // What Polar actually holds: already scheduled to end, on the yearly plan.
      fakeProvider.snapshot = makeSnapshot({
        cancelAtPeriodEnd: true,
        interval: "year",
        amount: 9700,
      });

      const res = await req("GET", "/api/billing/mine", { token: owner.token });
      expect(res.status).toBe(200);
      expect(fakeProvider.fetched).toEqual(["sub_m3"]);

      const row = await readSub(org.id);
      expect(row?.cancel_at_period_end).toBe(true);
      expect(row?.interval).toBe("year");
      expect(Number(row?.amount)).toBe(9700);
      const card = ((await (
        await req("GET", "/api/billing/mine", { token: owner.token })
      ).json()) as { vaults: Array<{ cancelAtPeriodEnd: boolean }> }).vaults[0];
      expect(card.cancelAtPeriodEnd).toBe(true);
    });

    it("leaves a freshly-written row alone", async () => {
      const owner = await signUp("m4@billing.com");
      const org = await createOrg(owner, "M4", "m4-org");
      await seedSubscription(org.id, "active", { subId: "sub_m4" });

      const res = await req("GET", "/api/billing/mine", { token: owner.token });
      expect(res.status).toBe(200);
      // A webhook or a mutation wrote it moments ago; re-reading Polar on every
      // visit to the Billing tab would be a round trip for nothing.
      expect(fakeProvider.fetched).toEqual([]);
    });

    it("keeps the row when the provider has never heard of the subscription", async () => {
      const owner = await signUp("m5@billing.com");
      const org = await createOrg(owner, "M5", "m5-org");
      await seedSubscription(org.id, "active", { subId: "sub_m5" });
      await backdate(org.id, 20);
      fakeProvider.getResults.set("sub_m5", null); // 404 at Polar

      const res = await req("GET", "/api/billing/mine", { token: owner.token });
      expect(res.status).toBe(200);
      // Unknown is not "canceled" — we do not invent a status.
      expect((await readSub(org.id))?.status).toBe("active");
    });

    it("401s without a session and 404s when billing is off", async () => {
      expect((await req("GET", "/api/billing/mine")).status).toBe(401);
      const owner = await signUp("m6@billing.com");
      delete process.env.POLAR_ACCESS_TOKEN;
      expect((await req("GET", "/api/billing/mine", { token: owner.token })).status).toBe(404);
    });
  });

  // ── (g) a tombstone's owner keeps the read + portal routes ────────────────
  describe("tombstone access", () => {
    it("serves GET /orgs/:orgId and the portal to the owner of a deleted vault", async () => {
      const owner = await signUp("g1@billing.com");
      const other = await signUp("g2@billing.com");
      const org = await createOrg(owner, "G1", "g1-org");
      await seedSubscription(org.id, "active", { subId: "sub_g1" });
      await req("DELETE", `/api/orgs/${org.id}`, { token: owner.token });

      const status = await req("GET", `/api/billing/orgs/${org.id}`, { token: owner.token });
      expect(status.status).toBe(200);
      const body = (await status.json()) as {
        plan: string;
        cancelAtPeriodEnd: boolean;
        interval: string | null;
        seats: { members: number };
      };
      expect(body.plan).toBe("pro");
      expect(body.cancelAtPeriodEnd).toBe(true);
      expect(body.interval).toBe("month");
      expect(body.seats.members).toBe(0); // the members cascaded away with the org

      const portal = await req("POST", `/api/billing/orgs/${org.id}/portal`, {
        token: owner.token,
      });
      expect(portal.status).toBe(200);
      expect((await portal.json()) as { url: string }).toEqual({
        url: "https://polar.test/portal/cus_test",
      });

      // Nobody else gets in.
      expect(
        (await req("GET", `/api/billing/orgs/${org.id}`, { token: other.token })).status,
      ).toBe(403);
      expect(
        (await req("POST", `/api/billing/orgs/${org.id}/portal`, { token: other.token })).status,
      ).toBe(403);
    });
  });
});
