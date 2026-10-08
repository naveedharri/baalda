import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { makeFakeProvider, makeSnapshot } from "./helpers/billing-provider.js";
import { SubscriptionCancelingError } from "../src/billing/provider.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { ensureAccountForOrg, ensureAccountForUser } from "../src/billing/accounts.js";

/**
 * Account-level billing routes (team model): account read, usage, seats
 * preview/update, checkout, vault move, and the old per-vault routes'
 * team-mode answers. Run against a scratch DB only.
 */

const fakeProvider = makeFakeProvider();
const app = createApp(testAppDeps({ billingProvider: fakeProvider }));
const mutable = config as unknown as { billingModel: "vault" | "team" };
const originalModel = mutable.billingModel;

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

let n = 0;
async function vault(owner: TestUser): Promise<string> {
  // Billing off while seeding, so fixtures are not refused by the Free cap.
  const token = process.env.POLAR_ACCESS_TOKEN;
  process.env.POLAR_ACCESS_TOKEN = "";
  const org = await createOrg(owner, `Vault ${++n}`, `vault-${n}-${Date.now()}`).finally(() => {
    process.env.POLAR_ACCESS_TOKEN = token;
  });
  await ensureAccountForOrg(pool, org.id);
  return org.id;
}
async function addMember(orgId: string, user: TestUser) {
  await pool.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now())`,
    [`mem_${++n}`, orgId, user.userId],
  );
}
async function subscribe(accountId: string, orgId: string, seats: number) {
  const subId = `sub_acct_${++n}`;
  await pool.query(
    `INSERT INTO subscriptions (organization_id, billing_account_id, provider, provider_customer_id,
       provider_subscription_id, plan, status, current_period_end, cancel_at_period_end,
       interval, amount, currency, seats, list_amount)
     VALUES ($1, $2, 'polar', 'cus_acct', $3, 'team', 'active', now() + interval '30 days', false,
       'month', $4, 'usd', $5, $4)`,
    [orgId, accountId, subId, seats * 1000, seats],
  );
  return subId;
}

describe("account billing routes (team model)", () => {
  beforeEach(async () => {
    await resetDb();
    fakeProvider.reset();
    process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token";
    process.env.BAALDA_DEPLOYMENT = "cloud";
    mutable.billingModel = "team";
  });
  afterEach(() => {
    delete process.env.POLAR_ACCESS_TOKEN;
    delete process.env.BAALDA_DEPLOYMENT;
    mutable.billingModel = originalModel;
  });
  afterAll(async () => {
    mutable.billingModel = originalModel;
    await pool.end();
  });

  it("config advertises the team model; vault mode keeps today's shape", async () => {
    const team = await (await req("GET", "/api/billing/config")).json();
    expect(team.model).toBe("team");
    expect(team.free).toEqual({ people: 2, syncedVaults: 1 });
    expect(team.team.minSeats).toBe(3);
    expect(team.team.prices.map((p: { interval: string }) => p.interval)).toEqual(["month", "year"]);
    expect(team.plans).toHaveLength(1);
    expect(team.freeLimits).toMatchObject({ vaultsPerUser: 1, membersPerVault: 2 });

    mutable.billingModel = "vault";
    const old = await (await req("GET", "/api/billing/config")).json();
    expect(old.model).toBe("vault");
    expect(old.plans).toHaveLength(2);
    expect(old.freeLimits.vaultsPerUser).toBe(config.freeMaxVaults);
  });

  it("account read: owner sees people and price, a member only the plan", async () => {
    const owner = await signUp("acct-owner@b.com");
    const member = await signUp("acct-member@b.com");
    const org = await vault(owner);
    await addMember(org, member);
    const accountId = (await ensureAccountForUser(pool, owner.userId))!;
    await subscribe(accountId, org, 3);

    const mine = await (await req("GET", "/api/billing/account", { token: owner.token })).json();
    expect(mine).toMatchObject({
      id: accountId,
      plan: "team",
      status: "active",
      canManage: true,
      seats: { purchased: 3, used: 2, reserved: 0, pendingDecrease: null },
      price: { list: 3000, charged: 3000 },
      vaults: [{ orgId: org }],
    });
    expect(mine.people).toHaveLength(2);
    expect(mine.limits.people).toBe(3);

    const theirs = await (
      await req("GET", `/api/billing/account?orgId=${org}`, { token: member.token })
    ).json();
    expect(theirs).toMatchObject({ id: accountId, plan: "team", canManage: false, price: null, people: [] });

    const outsider = await signUp("acct-out@b.com");
    const res = await req("GET", `/api/billing/account?orgId=${org}`, { token: outsider.token });
    expect(res.status).toBe(403);
  });

  it("usage totals count distinct people across vaults", async () => {
    const owner = await signUp("usage-owner@b.com");
    const member = await signUp("usage-member@b.com");
    const a = await vault(owner);
    const b = await vault(owner);
    await addMember(a, member);
    await addMember(b, member);
    const body = await (await req("GET", "/api/billing/account/usage", { token: owner.token })).json();
    expect(body.vaults).toHaveLength(2);
    expect(body.vaults[0]).toMatchObject({ people: 2, notes: 0, storageBytes: 0, files: 0 });
    expect(body.totals).toMatchObject({ people: 2, vaults: 2, notes: 0 });
    expect(body.limits).toMatchObject({ people: 2, vaults: 1, assistant: false });
  });

  it("seat preview refuses below the floor", async () => {
    const owner = await signUp("prev@b.com");
    const org = await vault(owner);
    const accountId = (await ensureAccountForUser(pool, owner.userId))!;
    await subscribe(accountId, org, 3);
    const low = await req("GET", "/api/billing/account/seats/preview?seats=2", { token: owner.token });
    expect(low.status).toBe(400);
    expect((await low.json()).floor).toBe(3);
    const ok = await (
      await req("GET", "/api/billing/account/seats/preview?seats=5", { token: owner.token })
    ).json();
    expect(ok).toMatchObject({ newSeats: 5, newAmount: 5000, estimated: true, floor: 3 });
  });

  it("PATCH seats: increase invoices now, decrease waits for renewal; Free is 409", async () => {
    const owner = await signUp("seats@b.com");
    const org = await vault(owner);
    const accountId = (await ensureAccountForUser(pool, owner.userId))!;

    const free = await req("PATCH", "/api/billing/account/seats", { token: owner.token, body: { seats: 4 } });
    expect(free.status).toBe(409);
    expect((await free.json()).error).toBe("no_subscription");

    const subId = await subscribe(accountId, org, 3);
    fakeProvider.snapshot = makeSnapshot({ seats: 3, listAmount: 3000 });
    const up = await req("PATCH", "/api/billing/account/seats", { token: owner.token, body: { seats: 5 } });
    expect(up.status).toBe(200);
    expect(fakeProvider.seatUpdates.at(-1)).toEqual({ id: subId, seats: 5, proration: "invoice" });
    expect((await up.json()).seats.purchased).toBe(5);

    fakeProvider.snapshot = makeSnapshot({ seats: 5, listAmount: 5000 });
    const down = await req("PATCH", "/api/billing/account/seats", { token: owner.token, body: { seats: 4 } });
    expect(down.status).toBe(200);
    expect(fakeProvider.seatUpdates.at(-1)).toEqual({ id: subId, seats: 4, proration: "next_period" });
    const body = await down.json();
    expect(body.seats.purchased).toBe(5);
    expect(body.seats.pendingDecrease.to).toBe(4);

    const below = await req("PATCH", "/api/billing/account/seats", { token: owner.token, body: { seats: 2 } });
    expect(below.status).toBe(400);
  });

  it("checkout clamps seats to the floor and refuses when already subscribed", async () => {
    const owner = await signUp("co@b.com");
    const org = await vault(owner);
    const res = await req("POST", "/api/billing/account/checkout", {
      token: owner.token,
      body: { seats: 1, interval: "year" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).seats).toBe(3);
    expect(fakeProvider.lastCheckout).toMatchObject({ seats: 3, minSeats: 3, interval: "year", orgId: org });

    // The build that started the checkout is where the success page hands back.
    const dev = await req("POST", "/api/billing/account/checkout", {
      token: owner.token,
      body: { seats: 3, interval: "month", client: { channel: "dev", scheme: "baalda-dev" } },
    });
    expect(dev.status).toBe(200);
    expect(fakeProvider.lastCheckout).toMatchObject({
      successUrl: expect.stringMatching(/\?checkout_id=\{CHECKOUT_ID\}&app=baalda-dev$/),
      clientScheme: "baalda-dev",
    });

    const accountId = (await ensureAccountForUser(pool, owner.userId))!;
    await subscribe(accountId, org, 3);
    const again = await req("POST", "/api/billing/account/checkout", { token: owner.token, body: {} });
    expect(again.status).toBe(409);
  });

  it("reconcile: a paid checkout upgrades the account without any webhook", async () => {
    const owner = await signUp("rec@b.com");
    const org = await vault(owner);
    const accountId = (await ensureAccountForUser(pool, owner.userId))!;

    const co = await req("POST", "/api/billing/account/checkout", {
      token: owner.token,
      body: { seats: 3, interval: "month" },
    });
    expect(co.status).toBe(200);
    const { checkoutId } = (await co.json()) as { checkoutId: string };
    expect(checkoutId).toBe("chk_month");

    // Polar redirected before the payment settled: nothing to write yet.
    fakeProvider.checkouts.set(checkoutId, {
      status: "confirmed",
      orgId: org,
      accountId,
      userId: owner.userId,
      providerSubscriptionId: null,
      providerCustomerId: "cus_rec",
    });
    const pending = await req("POST", "/api/billing/account/reconcile", {
      token: owner.token,
      body: { checkoutId },
    });
    expect(pending.status).toBe(200);
    const pendingBody = await pending.json();
    expect(pendingBody.plan).toBe("free");
    expect(pendingBody.checkoutStatus).toBe("confirmed");

    // The payment lands; the next poll writes the subscription itself.
    fakeProvider.checkouts.set(checkoutId, {
      status: "succeeded",
      orgId: org,
      accountId,
      userId: owner.userId,
      providerSubscriptionId: "sub_rec",
      providerCustomerId: "cus_rec",
    });
    fakeProvider.snapshot = makeSnapshot({ seats: 3, listAmount: 3000, accountId });
    const paid = await req("POST", "/api/billing/account/reconcile", {
      token: owner.token,
      body: { checkoutId },
    });
    expect(paid.status).toBe(200);
    const paidBody = await paid.json();
    expect(paidBody.status).toBe("active");
    expect(paidBody.plan).toBe("team");
    const { rows } = await pool.query(
      `SELECT billing_account_id, seats FROM subscriptions WHERE provider_subscription_id = 'sub_rec'`,
    );
    expect(rows).toEqual([{ billing_account_id: accountId, seats: 3 }]);

    // Someone else's checkout id answers 404 and writes nothing.
    const other = await signUp("rec-other@b.com");
    await vault(other);
    const stranger = await req("POST", "/api/billing/account/reconcile", {
      token: other.token,
      body: { checkoutId },
    });
    expect(stranger.status).toBe(404);
    const unknown = await req("POST", "/api/billing/account/reconcile", {
      token: owner.token,
      body: { checkoutId: "chk_missing" },
    });
    expect(unknown.status).toBe(404);
    const bad = await req("POST", "/api/billing/account/reconcile", {
      token: owner.token,
      body: { checkoutId: "../x" },
    });
    expect(bad.status).toBe(400);
  });

  it("reconcile: a `confirmed` checkout with a subscription id is payable; open/expired/failed never write", async () => {
    const owner = await signUp("rec-conf@b.com");
    const org = await vault(owner);
    const accountId = (await ensureAccountForUser(pool, owner.userId))!;
    const base = {
      orgId: org,
      accountId,
      userId: owner.userId,
      providerSubscriptionId: "sub_conf",
      providerCustomerId: "cus_conf",
    };
    fakeProvider.snapshot = makeSnapshot({ seats: 3, listAmount: 3000, accountId });
    for (const status of ["open", "expired", "failed"] as const) {
      fakeProvider.checkouts.set("chk_conf", { ...base, status });
      const r = await req("POST", "/api/billing/account/reconcile", {
        token: owner.token,
        body: { checkoutId: "chk_conf" },
      });
      expect(r.status).toBe(200);
      expect((await r.json()).plan).toBe("free");
    }
    expect(fakeProvider.fetched).toEqual([]);

    // A canceled subscription behind a confirmed checkout is not written.
    fakeProvider.checkouts.set("chk_conf", { ...base, status: "confirmed" });
    fakeProvider.getResults.set("sub_conf", makeSnapshot({ status: "canceled", accountId }));
    const canceled = await req("POST", "/api/billing/account/reconcile", {
      token: owner.token,
      body: { checkoutId: "chk_conf" },
    });
    expect((await canceled.json()).plan).toBe("free");

    fakeProvider.getResults.delete("sub_conf");
    const res = await req("POST", "/api/billing/account/reconcile", {
      token: owner.token,
      body: { checkoutId: "chk_conf" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBe("team");
    expect(body.checkoutStatus).toBe("confirmed");

    // The success page's confirm takes the same path.
    await pool.query(`DELETE FROM subscriptions WHERE provider_subscription_id = 'sub_conf'`);
    const page = await req("GET", "/api/billing/success?checkout_id=chk_conf");
    expect(page.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT status FROM subscriptions WHERE provider_subscription_id = 'sub_conf'`,
    );
    expect(rows).toEqual([{ status: "active" }]);
  });

  it("old per-vault checkout and transfer answer 409 in team mode", async () => {
    const owner = await signUp("old@b.com");
    const org = await vault(owner);
    const co = await req("POST", `/api/billing/orgs/${org}/checkout`, { token: owner.token, body: {} });
    expect(co.status).toBe(409);
    expect((await co.json()).code).toBe("upgrade_in_new_app");
    const tr = await req("POST", `/api/billing/orgs/${org}/transfer`, {
      token: owner.token,
      body: { targetOrgId: "x" },
    });
    expect(tr.status).toBe(409);
    expect((await tr.json()).code).toBe("transfer_retired");

    mutable.billingModel = "vault";
    const vaultMode = await req("POST", `/api/billing/orgs/${org}/checkout`, {
      token: owner.token,
      body: { interval: "year" },
    });
    expect(vaultMode.status).toBe(200);
    expect(fakeProvider.lastCheckout).toMatchObject({ orgId: org, interval: "year" });
  });

  it("move: re-attaches a vault and its subscription; Free destination over its limit is 409", async () => {
    const a = await signUp("move-a@b.com");
    const b = await signUp("move-b@b.com");
    const org = await vault(a);
    // b co-owns the vault, so b may move it onto b's own account.
    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now())`,
      [`mem_${++n}`, org, b.userId],
    );
    const accountA = (await ensureAccountForUser(pool, a.userId))!;
    const accountB = (await ensureAccountForUser(pool, b.userId))!;
    const subId = await subscribe(accountA, org, 3);

    // b already has a synced vault on Free ⇒ no room.
    const bOwn = await vault(b);
    const full = await req("POST", `/api/billing/orgs/${org}/move`, {
      token: b.token,
      body: { toAccountId: accountB },
    });
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe("vault_limit_reached");

    await pool.query(`DELETE FROM billing_account_orgs WHERE organization_id = $1`, [bOwn]);
    const ok = await req("POST", `/api/billing/orgs/${org}/move`, {
      token: b.token,
      body: { toAccountId: accountB },
    });
    expect(ok.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT billing_account_id FROM billing_account_orgs WHERE organization_id = $1`,
      [org],
    );
    expect(rows[0].billing_account_id).toBe(accountB);
    const sub = await pool.query(`SELECT billing_account_id FROM subscriptions WHERE id = $1`, [subId]);
    expect(sub.rows[0].billing_account_id).toBe(accountB);
    expect(fakeProvider.accountMetadataWrites.at(-1)).toMatchObject({ id: subId, accountId: accountB });

    // Destination must be the caller's own account.
    const notMine = await req("POST", `/api/billing/orgs/${org}/move`, {
      token: b.token,
      body: { toAccountId: accountA },
    });
    expect(notMine.status).toBe(403);
  });
  it("cancel then resume: provider called, row flips cancel_at_period_end both ways", async () => {
    const a = await signUp("cr-a@b.com");
    const org = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    const subId = await subscribe(account, org, 3);

    const cancel = await req("POST", "/api/billing/account/cancel", { token: a.token, body: {} });
    expect(cancel.status).toBe(200);
    expect(fakeProvider.canceled.at(-1)).toEqual({ id: subId, mode: "period_end" });
    let row = await pool.query(`SELECT status, cancel_at_period_end FROM subscriptions WHERE provider_subscription_id = $1`, [subId]);
    expect(row.rows[0]).toMatchObject({ status: "active", cancel_at_period_end: true });

    const resume = await req("POST", "/api/billing/account/resume", { token: a.token });
    expect(resume.status).toBe(200);
    expect(fakeProvider.resumed).toContain(subId);
    row = await pool.query(`SELECT cancel_at_period_end FROM subscriptions WHERE provider_subscription_id = $1`, [subId]);
    expect(row.rows[0].cancel_at_period_end).toBe(false);

    fakeProvider.failResume = new Error("polar down");
    const failed = await req("POST", "/api/billing/account/resume", { token: a.token });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("subscription_resume_failed");
  });

  it("seats: a plan scheduled to cancel answers 409 subscription_canceling, before and after the provider", async () => {
    const a = await signUp("canceling-a@b.com");
    const org = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    const subId = await subscribe(account, org, 3);

    // A cancel the provider made that our row has not heard of yet.
    fakeProvider.failSeats = new SubscriptionCancelingError();
    const raced = await req("PATCH", "/api/billing/account/seats", { token: a.token, body: { seats: 4 } });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ error: "subscription_canceling" });
    fakeProvider.failSeats = null;

    expect((await req("POST", "/api/billing/account/cancel", { token: a.token, body: {} })).status).toBe(200);
    const summary = await (await req("GET", "/api/billing/account", { token: a.token })).json();
    expect(summary.cancelAtPeriodEnd).toBe(true);

    const before = fakeProvider.seatUpdates.length;
    const patch = await req("PATCH", "/api/billing/account/seats", { token: a.token, body: { seats: 4 } });
    expect(patch.status).toBe(409);
    expect(await patch.json()).toMatchObject({
      error: "subscription_canceling",
      message: "Resume your plan before changing seats.",
    });
    const preview = await req("GET", "/api/billing/account/seats/preview?seats=4", { token: a.token });
    expect(preview.status).toBe(409);
    expect(fakeProvider.seatUpdates.length).toBe(before);
    expect(subId).toBeTruthy();
  });

  it("GET account ?refresh=1 re-reads the live subscription from the provider; plain GET does not", async () => {
    const a = await signUp("refresh-a@b.com");
    const org = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    const subId = await subscribe(account, org, 3);
    fakeProvider.getResults.set(subId, {
      ...makeSnapshot(),
      providerSubscriptionId: subId,
      providerCustomerId: "cus_acct",
      status: "active",
      seats: 5,
      discountId: "disc_legacy",
      discountName: "Legacy price",
      discountBasisPoints: 10000,
      cancelAtPeriodEnd: true,
      modifiedAt: new Date(Date.now() + 60_000),
    });

    const plain = await req("GET", "/api/billing/account", { token: a.token });
    expect(plain.status).toBe(200);
    expect(fakeProvider.fetched).not.toContain(subId);
    expect((await plain.json()).cancelAtPeriodEnd).toBe(false);

    const fresh = await req("GET", "/api/billing/account?refresh=1", { token: a.token });
    expect(fresh.status).toBe(200);
    expect(fakeProvider.fetched.filter((id) => id === subId)).toHaveLength(1);
    const body = await fresh.json();
    expect(body.cancelAtPeriodEnd).toBe(true);
    expect(body.seats.purchased).toBe(5);
    const row = await pool.query(
      `SELECT seats, discount_id, cancel_at_period_end FROM subscriptions WHERE provider_subscription_id = $1`,
      [subId],
    );
    expect(row.rows[0]).toMatchObject({ seats: 5, discount_id: "disc_legacy", cancel_at_period_end: true });

    // Within 30 s a second refresh makes no provider call and still answers.
    fakeProvider.failGet = new Error("polar down");
    const again = await req("GET", "/api/billing/account?refresh=1", { token: a.token });
    expect(again.status).toBe(200);
    expect(fakeProvider.fetched.filter((id) => id === subId)).toHaveLength(1);
  });

  it("GET account ?refresh=1 answers the stored summary when the provider fails", async () => {
    const a = await signUp("refresh-fail@b.com");
    const org = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    await subscribe(account, org, 3);
    fakeProvider.failGet = new Error("polar down");
    const res = await req("GET", "/api/billing/account?refresh=1", { token: a.token });
    expect(res.status).toBe(200);
    expect((await res.json()).seats.purchased).toBe(3);
  });

  it("portal answers the provider URL for the account's customer", async () => {
    const a = await signUp("portal-a@b.com");
    const org = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    await subscribe(account, org, 3);
    const res = await req("POST", "/api/billing/account/portal", { token: a.token });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://polar.test/portal/cus_acct");
  });

  it("seats: a failed provider update is 502 seat_update_failed; re-sending the purchased count keeps seats", async () => {
    const a = await signUp("keep-a@b.com");
    const org = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    await subscribe(account, org, 5);
    fakeProvider.failSeats = new Error("polar down");
    const bad = await req("PATCH", "/api/billing/account/seats", { token: a.token, body: { seats: 6 } });
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toBe("seat_update_failed");
    fakeProvider.failSeats = null;
    const before = fakeProvider.seatUpdates.length;
    const keep = await req("PATCH", "/api/billing/account/seats", { token: a.token, body: { seats: 5 } });
    expect(keep.status).toBe(200);
    expect(fakeProvider.seatUpdates.length).toBe(before);
  });

  it("deleting a vault on a Team account never cancels or tombstones the account's subscription", async () => {
    const a = await signUp("del-a@b.com");
    const org = await vault(a);
    const other = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    await pool.query(
      `UPDATE billing_account_orgs SET billing_account_id = $1 WHERE organization_id = ANY($2)`,
      [account, [org, other]],
    );
    const subId = await subscribe(account, org, 3);
    const res = await req("DELETE", `/api/orgs/${org}`, { token: a.token });
    expect(res.status).toBe(200);
    expect(fakeProvider.canceled).toEqual([]);
    const row = await pool.query(
      `SELECT status, cancel_at_period_end, deleted_at, billing_account_id FROM subscriptions WHERE provider_subscription_id = $1`,
      [subId],
    );
    expect(row.rows[0]).toMatchObject({ status: "active", cancel_at_period_end: false, deleted_at: null, billing_account_id: account });
  });

  it("webhook subscription.canceled from the portal lands as cancel_at_period_end", async () => {
    const a = await signUp("wh-a@b.com");
    const org = await vault(a);
    const account = (await ensureAccountForUser(pool, a.userId))!;
    const subId = await subscribe(account, org, 3);
    fakeProvider.nextEvent = {
      eventId: "evt_cancel_1",
      occurredAt: new Date(),
      type: "subscription_canceled",
      organizationId: org,
      userId: a.userId,
      providerCustomerId: "cus_acct",
      providerSubscriptionId: subId,
      plan: "pro",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 20 * 86400_000),
      cancelAtPeriodEnd: true,
      interval: "month",
      amount: 3000,
      currency: "usd",
    };
    const res = await req("POST", "/api/billing/webhook", { body: {} });
    expect(res.status).toBe(200);
    const row = await pool.query(
      `SELECT status, cancel_at_period_end, billing_account_id FROM subscriptions WHERE provider_subscription_id = $1`,
      [subId],
    );
    expect(row.rows[0]).toMatchObject({ status: "active", cancel_at_period_end: true, billing_account_id: account });
  });
});
