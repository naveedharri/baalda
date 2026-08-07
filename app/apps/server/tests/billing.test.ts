import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import { createApp } from "../src/http/app.js";
import { PolarBillingProvider } from "../src/billing/polar.js";
import {
  canAddMember,
  canCreateOrganization,
  countOwnedUnsubscribedOrgs,
  getEntitlement,
  seatCount,
} from "../src/billing/entitlements.js";
import type {
  BillingProvider,
  NormalizedBillingEvent,
} from "../src/billing/provider.js";
import { testAppDeps } from "./helpers/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp } from "./helpers/auth.js";

// The seat cap is a product decision that moves (3 → 10 when free vaults were
// opened up to real teams). These suites assert that it is ENFORCED, so they
// read the configured value rather than restating it — a test that has to be
// edited every time the number changes tests the number, not the rule.
const SEAT_CAP = config.freeMaxMembers;

/** Fill an org to exactly `SEAT_CAP` seats. The owner is seat 1; pending
 *  invitations occupy the rest (they count against the cap, which is the point
 *  — a free vault can't invite its way past the limit). */
async function fillSeatsToCap(orgId: string, inviterId: string, tag: string) {
  const values = Array.from({ length: SEAT_CAP - 1 }, (_, i) => {
    const n = i + 1;
    return `('${tag}-inv${n}', $1, '${tag}${n}@x.com', 'member', 'pending', now() + interval '1 day', $2)`;
  }).join(",\n");
  if (!values) return;
  await pool.query(
    `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
     VALUES ${values}`,
    [orgId, inviterId],
  );
}

const WEBHOOK_SECRET = "test-polar-webhook-secret";

// ── A controllable fake provider (no network). verifyAndNormalizeWebhook is
//    scripted per-test via `fakeProvider.nextEvent`. Real signature checking is
//    exercised separately with the actual PolarBillingProvider. ───────────────
interface FakeProvider extends BillingProvider {
  nextEvent: NormalizedBillingEvent | null;
  lastCheckout: unknown;
  canceled: string[];
}
function makeFakeProvider(): FakeProvider {
  return {
    nextEvent: null,
    lastCheckout: null,
    canceled: [],
    async createCheckout(args) {
      this.lastCheckout = args;
      return { url: `https://polar.test/checkout/${args.interval}` };
    },
    async getPortalUrl(args) {
      return { url: `https://polar.test/portal/${args.customerId}` };
    },
    async cancelSubscription(id) {
      this.canceled.push(id);
    },
    verifyAndNormalizeWebhook() {
      return this.nextEvent;
    },
  };
}

const fakeProvider = makeFakeProvider();
const app = createApp(testAppDeps({ billingProvider: fakeProvider }));
const realApp = createApp(testAppDeps({ billingProvider: new PolarBillingProvider() }));

function req(
  target: typeof app,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return target.fetch(
    new Request(`http://local${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

/** Directly seed a subscription row (as the webhook would). */
async function seedSubscription(
  orgId: string,
  status: string,
  extra: Partial<{ customerId: string; subId: string; periodEnd: Date }> = {},
) {
  await pool.query(
    `INSERT INTO subscriptions (organization_id, provider, provider_customer_id,
       provider_subscription_id, plan, status, current_period_end, cancel_at_period_end)
     VALUES ($1, 'polar', $2, $3, 'pro', $4, $5, false)
     ON CONFLICT (organization_id) DO UPDATE SET status = EXCLUDED.status`,
    [
      orgId,
      extra.customerId ?? "cus_test",
      extra.subId ?? "sub_test",
      status,
      extra.periodEnd ?? new Date(Date.now() + 30 * 86400_000),
    ],
  );
}

describe("billing", () => {
  beforeEach(async () => {
    await resetDb();
    fakeProvider.nextEvent = null;
    fakeProvider.canceled = [];
    process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token"; // billing ON
  });
  afterEach(() => {
    delete process.env.POLAR_ACCESS_TOKEN;
  });
  afterAll(async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await pool.end();
  });

  // ── config gating ─────────────────────────────────────────────────────────
  describe("GET /api/billing/config", () => {
    it("reports enabled=false with no other fields when billing is off", async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      const res = await req(app, "GET", "/api/billing/config");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false });
    });

    it("reports plans + free limits when billing is on", async () => {
      const res = await req(app, "GET", "/api/billing/config");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        enabled: boolean;
        plans: Array<{ id: string; amount: number; interval: string }>;
        freeLimits: { vaultsPerUser: number; membersPerVault: number };
      };
      expect(body.enabled).toBe(true);
      expect(body.plans.map((p) => p.id)).toEqual(["pro-monthly", "pro-yearly"]);
      expect(body.plans.find((p) => p.id === "pro-monthly")!.amount).toBe(1000);
      expect(body.plans.find((p) => p.id === "pro-yearly")!.amount).toBe(9700);
      expect(body.freeLimits).toEqual({
        vaultsPerUser: config.freeMaxVaults,
        membersPerVault: SEAT_CAP,
      });
    });

    it("all other billing routes 404 when billing is off", async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      const user = await signUp("off@billing.com");
      const org = await createOrg(user, "Off", "off-billing");
      expect((await req(app, "GET", `/api/billing/orgs/${org.id}`, { token: user.token })).status).toBe(404);
      expect((await req(app, "POST", "/api/billing/webhook", { body: {} })).status).toBe(404);
      expect((await req(app, "GET", "/api/billing/success")).status).toBe(404);
    });

    it("enforces no free-tier limits when billing is off (self-host = unlimited)", async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      const user = await signUp("unlimited@billing.com");
      // Create more than FREE_MAX_VAULTS (3) owned vaults — none should be blocked.
      await createOrg(user, "U1", "unl-w1");
      await createOrg(user, "U2", "unl-w2");
      await createOrg(user, "U3", "unl-w3");
      const fourth = await createOrg(user, "U4", "unl-w4");
      expect(fourth.id).toBeTruthy();
      expect((await canCreateOrganization(user.userId)).allowed).toBe(true);

      // Pending invitations that would matter under a cap — still unblocked here.
      await pool.query(
        `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ('unl-inv1', $1, 'a@x.com', 'member', 'pending', now() + interval '1 day', $2),
                ('unl-inv2', $1, 'b@x.com', 'member', 'pending', now() + interval '1 day', $2),
                ('unl-inv3', $1, 'c@x.com', 'member', 'pending', now() + interval '1 day', $2)`,
        [fourth.id, user.userId],
      );
      expect((await canAddMember(fourth.id)).allowed).toBe(true);
    });
  });

  // ── entitlement counting rules ──────────────────────────────────────────────
  describe("entitlements", () => {
    it("countOwnedUnsubscribedOrgs excludes orgs with an active subscription", async () => {
      const user = await signUp("count@billing.com");
      const a = await createOrg(user, "A", "count-a");
      const b = await createOrg(user, "B", "count-b");
      await createOrg(user, "C", "count-c");
      expect(await countOwnedUnsubscribedOrgs(user.userId)).toBe(3);

      await seedSubscription(a.id, "active");
      expect(await countOwnedUnsubscribedOrgs(user.userId)).toBe(2);
      // past_due still counts as paid (grace) → excluded.
      await seedSubscription(b.id, "past_due");
      expect(await countOwnedUnsubscribedOrgs(user.userId)).toBe(1);
      // canceled counts as unsubscribed again.
      await seedSubscription(a.id, "canceled");
      expect(await countOwnedUnsubscribedOrgs(user.userId)).toBe(2);
    });

    it("canCreateOrganization blocks at the vault cap (unsubscribed only)", async () => {
      const user = await signUp("cap@billing.com");
      await createOrg(user, "W1", "cap-w1");
      await createOrg(user, "W2", "cap-w2");
      const third = await createOrg(user, "W3", "cap-w3");
      expect((await canCreateOrganization(user.userId)).allowed).toBe(false);
      // Upgrading one paid frees a slot.
      await seedSubscription(third.id, "active");
      expect((await canCreateOrganization(user.userId)).allowed).toBe(true);
    });

    it("seatCount / canAddMember count members + pending invitations", async () => {
      const owner = await signUp("seat@billing.com");
      const org = await createOrg(owner, "Seat", "seat-org");
      expect(await seatCount(org.id)).toEqual({ members: 1, pendingInvitations: 0 });

      await pool.query(
        `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ('inv1', $1, 'a@x.com', 'member', 'pending', now() + interval '1 day', $2),
                ('inv2', $1, 'b@x.com', 'member', 'pending', now() + interval '1 day', $2)`,
        [org.id, owner.userId],
      );
      expect(await seatCount(org.id)).toEqual({ members: 1, pendingInvitations: 2 });
      // Two pending invitations are two seats, but they only BLOCK once the
      // total reaches the cap — which is the counting rule this test is about.
      expect((await canAddMember(org.id)).allowed).toBe(SEAT_CAP > 3);

      // Fill the rest of the seats: pending invitations count, so the cap bites
      // without a single extra person actually joining.
      await fillSeatsToCap(org.id, owner.userId, "seat");
      expect((await canAddMember(org.id)).allowed).toBe(false);

      // An active subscription lifts the cap entirely.
      await seedSubscription(org.id, "active");
      expect((await canAddMember(org.id)).allowed).toBe(true);
    });

    it("expired invitations do not count toward the seat cap", async () => {
      const owner = await signUp("expinv@billing.com");
      const org = await createOrg(owner, "Exp", "exp-org");
      await pool.query(
        `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
         VALUES ('expired1', $1, 'old@x.com', 'member', 'pending', now() - interval '1 day', $2)`,
        [org.id, owner.userId],
      );
      expect((await seatCount(org.id)).pendingInvitations).toBe(0);
    });
  });

  // ── status endpoint ─────────────────────────────────────────────────────────
  describe("GET /api/billing/orgs/:orgId", () => {
    it("returns free/none for an unsubscribed vault with the seat cap", async () => {
      const owner = await signUp("st-free@billing.com");
      const org = await createOrg(owner, "F", "st-free");
      const res = await req(app, "GET", `/api/billing/orgs/${org.id}`, { token: owner.token });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        plan: "free",
        status: "none",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        seats: { members: 1, pendingInvitations: 0, limit: SEAT_CAP },
      });
    });

    it("returns pro/active with unlimited (null) seat limit when subscribed", async () => {
      const owner = await signUp("st-pro@billing.com");
      const org = await createOrg(owner, "P", "st-pro");
      await seedSubscription(org.id, "active");
      const res = await req(app, "GET", `/api/billing/orgs/${org.id}`, { token: owner.token });
      const body = (await res.json()) as { plan: string; status: string; seats: { limit: number | null } };
      expect(body.plan).toBe("pro");
      expect(body.status).toBe("active");
      expect(body.seats.limit).toBeNull();
    });

    it("rejects a non-member (403) and anon (401)", async () => {
      const owner = await signUp("st-owner@billing.com");
      const org = await createOrg(owner, "O", "st-owner");
      const stranger = await signUp("st-stranger@billing.com");
      expect((await req(app, "GET", `/api/billing/orgs/${org.id}`, { token: stranger.token })).status).toBe(403);
      expect((await req(app, "GET", `/api/billing/orgs/${org.id}`)).status).toBe(401);
    });
  });

  // ── checkout + portal ───────────────────────────────────────────────────────
  describe("checkout + portal", () => {
    it("owner gets a checkout URL; the interval is forwarded", async () => {
      const owner = await signUp("co@billing.com");
      const org = await createOrg(owner, "Co", "co-org");
      const res = await req(app, "POST", `/api/billing/orgs/${org.id}/checkout`, {
        token: owner.token,
        body: { interval: "year" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { url: string }).toEqual({ url: "https://polar.test/checkout/year" });
      expect((fakeProvider.lastCheckout as { interval: string }).interval).toBe("year");
    });

    it("a plain member cannot start checkout (403)", async () => {
      const owner = await signUp("co-owner@billing.com");
      const org = await createOrg(owner, "Co2", "co-org2");
      const member = await signUp("co-member@billing.com");
      await pool.query(
        `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
         VALUES ('m-co', $1, $2, 'member', now())`,
        [org.id, member.userId],
      );
      const res = await req(app, "POST", `/api/billing/orgs/${org.id}/checkout`, {
        token: member.token,
        body: { interval: "month" },
      });
      expect(res.status).toBe(403);
    });

    it("portal returns a URL when a customer exists, 400 otherwise", async () => {
      const owner = await signUp("po@billing.com");
      const org = await createOrg(owner, "Po", "po-org");
      expect((await req(app, "POST", `/api/billing/orgs/${org.id}/portal`, { token: owner.token })).status).toBe(400);
      await seedSubscription(org.id, "active", { customerId: "cus_po" });
      const res = await req(app, "POST", `/api/billing/orgs/${org.id}/portal`, { token: owner.token });
      expect(res.status).toBe(200);
      expect((await res.json()) as { url: string }).toEqual({ url: "https://polar.test/portal/cus_po" });
    });
  });

  // ── limit enforcement (402 + contract token) ───────────────────────────────
  describe("402 enforcement", () => {
    it("org create → 402 vault_limit_reached at the cap (via Better Auth)", async () => {
      const user = await signUp("oc@billing.com");
      await createOrg(user, "O1", "oc-1");
      await createOrg(user, "O2", "oc-2");
      await createOrg(user, "O3", "oc-3");
      const res = await req(app, "POST", "/api/auth/organization/create", {
        token: user.token,
        body: { name: "O4", slug: "oc-4" },
      });
      expect(res.status).toBe(402);
      const text = await res.text();
      expect(text).toContain("vault_limit_reached");
    });

    it("invite-member → 402 member_limit_reached at the cap (via Better Auth)", async () => {
      const owner = await signUp("im@billing.com");
      const org = await createOrg(owner, "Im", "im-org");
      await fillSeatsToCap(org.id, owner.userId, "im");
      const res = await req(app, "POST", "/api/auth/organization/invite-member", {
        token: owner.token,
        body: { email: "one-too-many@x.com", role: "member", organizationId: org.id },
      });
      expect(res.status).toBe(402);
      expect(await res.text()).toContain("member_limit_reached");
    });

    it("invite-member is allowed on the last free seat", async () => {
      // The cap must bite at cap+1, not cap — an off-by-one here would charge
      // people for a seat they were promised.
      const owner = await signUp("lastseat@billing.com");
      const org = await createOrg(owner, "Last", "last-seat-org");
      await fillSeatsToCap(org.id, owner.userId, "ls");
      await pool.query(`DELETE FROM invitation WHERE id = $1`, [`ls-inv${SEAT_CAP - 1}`]);
      const res = await req(app, "POST", "/api/auth/organization/invite-member", {
        token: owner.token,
        body: { email: "fits@x.com", role: "member", organizationId: org.id },
      });
      expect(res.status).toBe(200);
    });

    it("join-code redemption → 402 member_limit_reached at the cap", async () => {
      const owner = await signUp("jc@billing.com");
      const org = await createOrg(owner, "Jc", "jc-org");
      // Generate a join code.
      const codeRes = await req(app, "GET", "/api/orgs/join-code", { token: owner.token });
      const { code } = (await codeRes.json()) as { code: string };
      // Fill to the cap with the owner + pending invitations, so this stays a
      // test about the cap rather than a loop of sign-ups.
      await fillSeatsToCap(org.id, owner.userId, "jc");
      const late = await signUp("jc-late@billing.com");
      const res = await req(app, "POST", "/api/orgs/join", { token: late.token, body: { code } });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string; limit: number };
      expect(body.error).toBe("member_limit_reached");
      expect(body.limit).toBe(SEAT_CAP);
    });

    it("join-code redemption succeeds while a free seat remains", async () => {
      const owner = await signUp("jcok@billing.com");
      const org = await createOrg(owner, "JcOk", "jc-ok-org");
      const codeRes = await req(app, "GET", "/api/orgs/join-code", { token: owner.token });
      const { code } = (await codeRes.json()) as { code: string };
      await fillSeatsToCap(org.id, owner.userId, "jco");
      await pool.query(`DELETE FROM invitation WHERE id = $1`, [`jco-inv${SEAT_CAP - 1}`]);
      const joiner = await signUp("jcok-joiner@billing.com");
      const res = await req(app, "POST", "/api/orgs/join", { token: joiner.token, body: { code } });
      expect(res.status).toBe(200);
    });

    it("a paid vault has no member cap on join-code redemption", async () => {
      const owner = await signUp("jcp@billing.com");
      const org = await createOrg(owner, "JcPaid", "jcp-org");
      await seedSubscription(org.id, "active");
      const codeRes = await req(app, "GET", "/api/orgs/join-code", { token: owner.token });
      const { code } = (await codeRes.json()) as { code: string };
      // Add several members past the free cap — all allowed.
      for (let i = 0; i < 5; i++) {
        const j = await signUp(`jcp${i}@billing.com`);
        const res = await req(app, "POST", "/api/orgs/join", { token: j.token, body: { code } });
        expect(res.status).toBe(200);
      }
    });
  });

  // ── webhook ─────────────────────────────────────────────────────────────────
  describe("POST /api/billing/webhook", () => {
    it("rejects a bad signature with 403 (real provider)", async () => {
      const res = await req(realApp, "POST", "/api/billing/webhook", {
        headers: {
          "content-type": "application/json",
          "webhook-id": "msg_1",
          "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
          "webhook-signature": "v1,not-a-real-signature",
        },
        body: { type: "subscription.active", data: {} },
      });
      expect(res.status).toBe(403);
    });

    it("accepts a correctly-signed but irrelevant event with 202 (real provider)", async () => {
      // A valid signature over an event type we don't parse → SDK throws
      // internally → provider returns null → route answers 202.
      const payload = JSON.stringify({ type: "product.created", data: { id: "prod_x" } });
      const { headers } = signWebhook(payload);
      const res = await req(realApp, "POST", "/api/billing/webhook", {
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.parse(payload),
      });
      expect(res.status).toBe(202);
    });

    it("upserts a subscription and is idempotent on replay (fake provider)", async () => {
      const owner = await signUp("wh@billing.com");
      const org = await createOrg(owner, "Wh", "wh-org");

      fakeProvider.nextEvent = {
        eventId: "evt_active_1",
        occurredAt: new Date(),
        type: "subscription_active",
        organizationId: org.id,
        providerCustomerId: "cus_wh",
        providerSubscriptionId: "sub_wh",
        plan: "pro",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        cancelAtPeriodEnd: false,
      };

      const first = await req(app, "POST", "/api/billing/webhook", { body: { any: "thing" } });
      expect(first.status).toBe(200);
      expect((await getEntitlement(org.id)).status).toBe("active");
      expect((await getEntitlement(org.id)).plan).toBe("pro");

      // Replay the SAME event id → ignored, no duplicate processing.
      const replay = await req(app, "POST", "/api/billing/webhook", { body: { any: "thing" } });
      expect(replay.status).toBe(200);
      const { rows } = await pool.query<{ c: string }>(
        "SELECT count(*)::int AS c FROM billing_events",
      );
      expect(Number(rows[0].c)).toBe(1);
    });

    it("transitions active → canceled on a revoke event (fake provider)", async () => {
      const owner = await signUp("wh2@billing.com");
      const org = await createOrg(owner, "Wh2", "wh2-org");

      fakeProvider.nextEvent = {
        eventId: "evt_active_2",
        occurredAt: new Date(Date.now() - 60_000),
        type: "subscription_active",
        organizationId: org.id,
        providerCustomerId: "cus_wh2",
        providerSubscriptionId: "sub_wh2",
        plan: "pro",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        cancelAtPeriodEnd: false,
      };
      await req(app, "POST", "/api/billing/webhook", { body: {} });
      expect((await getEntitlement(org.id)).active).toBe(true);

      fakeProvider.nextEvent = {
        eventId: "evt_revoked_2",
        occurredAt: new Date(),
        type: "subscription_revoked",
        organizationId: org.id,
        providerCustomerId: "cus_wh2",
        providerSubscriptionId: "sub_wh2",
        plan: "pro",
        status: "canceled",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      };
      await req(app, "POST", "/api/billing/webhook", { body: {} });
      const ent = await getEntitlement(org.id);
      expect(ent.status).toBe("canceled");
      expect(ent.plan).toBe("free");
      expect(ent.active).toBe(false);
    });

    it("a stale out-of-order event does not overwrite newer state (fake provider)", async () => {
      const owner = await signUp("wh3@billing.com");
      const org = await createOrg(owner, "Wh3", "wh3-org");

      const t0 = new Date(Date.now() - 120_000); // earlier "active"
      const t1 = new Date(Date.now() - 60_000); // later "revoked"

      // Newer event lands first: subscription revoked at t1.
      fakeProvider.nextEvent = {
        eventId: "evt_revoked_3",
        occurredAt: t1,
        type: "subscription_revoked",
        organizationId: org.id,
        providerCustomerId: "cus_wh3",
        providerSubscriptionId: "sub_wh3",
        plan: "pro",
        status: "canceled",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      };
      await req(app, "POST", "/api/billing/webhook", { body: {} });
      expect((await getEntitlement(org.id)).active).toBe(false);

      // A delayed redelivery of the EARLIER active event (t0 < t1, new id):
      // idempotency lets it through, but the ordering guard must drop the write
      // so the canceled org does NOT silently regain Pro.
      fakeProvider.nextEvent = {
        eventId: "evt_active_3_stale",
        occurredAt: t0,
        type: "subscription_active",
        organizationId: org.id,
        providerCustomerId: "cus_wh3",
        providerSubscriptionId: "sub_wh3",
        plan: "pro",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        cancelAtPeriodEnd: false,
      };
      const res = await req(app, "POST", "/api/billing/webhook", { body: {} });
      expect(res.status).toBe(200); // acknowledged (recorded as processed)
      const ent = await getEntitlement(org.id);
      expect(ent.active).toBe(false); // still canceled — stale event ignored
      expect(ent.plan).toBe("free");
    });
  });

  // ── org delete cancels the subscription (best-effort) ───────────────────────
  it("DELETE /api/orgs/:orgId cancels the provider subscription", async () => {
    const owner = await signUp("del@billing.com");
    const org = await createOrg(owner, "Del", "del-org");
    await seedSubscription(org.id, "active", { subId: "sub_del" });
    const res = await req(app, "DELETE", `/api/orgs/${org.id}`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(fakeProvider.canceled).toContain("sub_del");
    // FK cascade removed the subscriptions row.
    const { rows } = await pool.query("SELECT 1 FROM subscriptions WHERE organization_id = $1", [org.id]);
    expect(rows.length).toBe(0);
  });
});

/** Build valid Standard-Webhooks headers for a payload (mirrors validateEvent). */
function signWebhook(payload: string): { headers: Record<string, string> } {
  const base64Secret = Buffer.from(WEBHOOK_SECRET, "utf-8").toString("base64");
  const wh = new Webhook(base64Secret);
  const msgId = "msg_" + Math.random().toString(36).slice(2);
  const timestamp = new Date();
  const signature = wh.sign(msgId, timestamp, payload);
  return {
    headers: {
      "webhook-id": msgId,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": signature,
    },
  };
}
