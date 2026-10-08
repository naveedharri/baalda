import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import {
  checkInviteSeat,
  checkJoinSeat,
  planEnforced,
  resolveAccountPlan,
  seatLimitMessage,
  seatRefusalBody,
} from "../src/billing/plan.js";
import { canAddMember, canCreateOrganization, canSyncAttachments, storageLimitBytes } from "../src/billing/entitlements.js";
import { createResolverCache } from "../src/permissions/resolver.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedOrg, seedUser } from "./helpers/seed.js";

// `billingModel` is read once at config load; flip it per test.
const mutable = config as unknown as { billingModel: "vault" | "team" };
const originalModel = mutable.billingModel;

function setModel(model: "vault" | "team") {
  mutable.billingModel = model;
}
function billingOn() {
  vi.stubEnv("POLAR_ACCESS_TOKEN", "test-token");
  vi.stubEnv("BAALDA_DEPLOYMENT", "cloud");
}

let n = 0;
async function account(ownerId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = `ba_test_${++n}`;
  await pool.query(
    `INSERT INTO billing_accounts (id, owner_user_id, free_people_limit, free_synced_vaults, plan_override, complimentary_until)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (owner_user_id) DO UPDATE SET free_people_limit = EXCLUDED.free_people_limit,
       free_synced_vaults = EXCLUDED.free_synced_vaults, plan_override = EXCLUDED.plan_override,
       complimentary_until = EXCLUDED.complimentary_until`,
    [id, ownerId, extra.people ?? null, extra.vaults ?? null, extra.override ?? null, extra.until ?? null],
  );
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM billing_accounts WHERE owner_user_id = $1`, [ownerId]);
  return rows[0]!.id;
}
async function vaultOn(accountId: string, ownerId: string): Promise<string> {
  const org = await seedOrg(`o${++n}`, `o${n}-${Date.now()}`);
  await seedMember(org, ownerId, "owner");
  await pool.query(
    `INSERT INTO billing_account_orgs (organization_id, billing_account_id) VALUES ($1, $2)
     ON CONFLICT (organization_id) DO UPDATE SET billing_account_id = EXCLUDED.billing_account_id`,
    [org, accountId],
  );
  return org;
}
async function invite(org: string, inviterId: string, email: string) {
  await pool.query(
    `INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
     VALUES ($1, $2, $3, 'member', 'pending', now() + interval '1 day', $4)`,
    [`inv${++n}`, org, email, inviterId],
  );
}
async function subscribe(org: string, accountId: string | null, status: string, seats: number | null, periodEnd = "2099-01-01") {
  await pool.query(
    `INSERT INTO subscriptions (organization_id, provider, provider_customer_id, provider_subscription_id,
        plan, status, current_period_end, cancel_at_period_end, billing_account_id, seats)
     VALUES ($1, 'polar', 'cus', $2, 'pro', $3, $4, false, $5, $6)`,
    [org, `sub_${++n}`, status, periodEnd, accountId, seats],
  );
}

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setModel(originalModel);
});
afterAll(async () => {
  setModel(originalModel);
});

describe("planEnforced", () => {
  it("is off for self-host and when billing is disabled", () => {
    vi.stubEnv("BAALDA_DEPLOYMENT", "self-hosted");
    vi.stubEnv("POLAR_ACCESS_TOKEN", "t");
    expect(planEnforced()).toBe(false);
    vi.stubEnv("BAALDA_DEPLOYMENT", "cloud");
    vi.stubEnv("POLAR_ACCESS_TOKEN", "");
    expect(planEnforced()).toBe(false);
    vi.stubEnv("POLAR_ACCESS_TOKEN", "t");
    expect(planEnforced()).toBe(true);
  });
});

describe("team model, billing not enforced", () => {
  it("returns no limits and every feature", async () => {
    setModel("team");
    vi.stubEnv("BAALDA_DEPLOYMENT", "self-hosted");
    const owner = await seedUser("selfhost@x.com");
    const acct = await account(owner);
    const org = await vaultOn(acct, owner);
    const plan = await resolveAccountPlan(pool, { orgId: org });
    expect(plan.limits).toEqual({ people: null, vaults: null, storageBytes: null, notesPerVault: null, assistant: true, fileSync: true });
    expect(await checkInviteSeat(pool, org, "a@x.com")).toBeNull();
    expect(await canSyncAttachments(org)).toBe(true);
  });
});

describe("vault model keeps today's answers", () => {
  it("per-org member cap and file sync unchanged", async () => {
    setModel("vault");
    billingOn();
    const owner = await seedUser("legacy@x.com");
    const org = await seedOrg("L", `l-${Date.now()}`);
    await seedMember(org, owner, "owner");
    expect((await canAddMember(org)).limit).toBe(config.freeMaxMembers);
    expect(await canSyncAttachments(org)).toBe(false);
    expect(await storageLimitBytes(org)).toBe(config.freeMaxStorageMb * 1024 * 1024);
    const plan = await resolveAccountPlan(pool, { orgId: org });
    expect(plan.accountId).toBeNull();
    expect(plan.limits.people).toBe(config.freeMaxMembers);
  });
});

describe("team model, enforced", () => {
  beforeEach(() => {
    setModel("team");
    billingOn();
  });

  it("counts people across every vault on the account", async () => {
    const owner = await seedUser("own@x.com");
    const friend = await seedUser("friend@x.com");
    const acct = await account(owner);
    const a = await vaultOn(acct, owner);
    const b = await vaultOn(acct, owner);
    await seedMember(b, friend, "member");
    const plan = await resolveAccountPlan(pool, { orgId: a });
    expect(plan.plan).toBe("free");
    expect(plan.seatsUsed).toBe(2);
    expect(plan.vaultsAttached).toBe(2);
    expect(plan.limits.people).toBe(2);
    expect(plan.limits.assistant).toBe(false);
    expect(plan.limits.fileSync).toBe(false);
    expect(plan.limits.notesPerVault).toBe(config.abuseMaxNotes);
    expect(plan.limits.storageBytes).toBe(config.abuseMaxStorageMb * 1024 * 1024);
    // Vault a is at the account cap even though only the owner is in it.
    expect(await checkInviteSeat(pool, a, "new@x.com")).toEqual({ code: "member_limit_reached", limit: 2, scope: "account" });
    // The friend is already on the account: adding them to vault a takes no seat.
    expect(await checkInviteSeat(pool, a, "friend@x.com")).toBeNull();
    expect(await checkJoinSeat(pool, a, { userId: friend })).toBeNull();
    // A Free account with 2 vaults already exceeds the 1-vault cap.
    expect((await canCreateOrganization(owner)).allowed).toBe(false);
  });

  it("honours grandfathered limits", async () => {
    const owner = await seedUser("gf@x.com");
    const acct = await account(owner, { people: 5, vaults: 3 });
    const a = await vaultOn(acct, owner);
    await vaultOn(acct, owner);
    const plan = await resolveAccountPlan(pool, { accountId: acct });
    expect(plan.limits.people).toBe(5);
    expect(plan.limits.vaults).toBe(3);
    expect((await canCreateOrganization(owner)).allowed).toBe(true);
    expect(await checkInviteSeat(pool, a, "x@x.com")).toBeNull();
  });

  it("complimentary override gives Team until it ends", async () => {
    const owner = await seedUser("comp@x.com");
    const acct = await account(owner, { override: "team", until: "2099-01-01" });
    const org = await vaultOn(acct, owner);
    const plan = await resolveAccountPlan(pool, { userId: owner });
    expect(plan.plan).toBe("team");
    expect(plan.limits.assistant).toBe(true);
    expect(plan.limits.fileSync).toBe(true);
    expect(plan.limits.people).toBeNull();
    await pool.query(`UPDATE billing_accounts SET complimentary_until = now() - interval '1 day' WHERE id = $1`, [acct]);
    expect((await resolveAccountPlan(pool, { orgId: org })).plan).toBe("free");
  });

  it("seats gate: pending invites reserve, acceptance is hard, members take no seat", async () => {
    const owner = await seedUser("team@x.com");
    const m1 = await seedUser("m1@x.com");
    const acct = await account(owner);
    const org = await vaultOn(acct, owner);
    await subscribe(org, acct, "active", 3);
    await seedMember(org, m1, "member");
    let plan = await resolveAccountPlan(pool, { orgId: org });
    expect(plan.plan).toBe("team");
    expect(plan.seatsPurchased).toBe(3);
    expect(plan.seatsUsed).toBe(2);
    // One seat left: an invite takes it.
    expect(await checkInviteSeat(pool, org, "p1@x.com")).toBeNull();
    await invite(org, owner, "p1@x.com");
    plan = await resolveAccountPlan(pool, { orgId: org });
    expect(plan.seatsReserved).toBe(1);
    // Soft gate: the reservation blocks another invite.
    expect(await checkInviteSeat(pool, org, "p2@x.com")).toEqual({
      code: "seat_limit_reached", seats: 3, used: 2, pending: 1, message: seatLimitMessage(3),
    });
    // Re-inviting the reserved address takes no new seat.
    expect(await checkInviteSeat(pool, org, "p1@x.com")).toBeNull();
    // Hard gate at acceptance ignores reservations: p1 joins (2 + 1 <= 3).
    const p1 = await seedUser("p1@x.com");
    expect(await checkJoinSeat(pool, org, { userId: p1, email: "p1@x.com" })).toBeNull();
    await seedMember(org, p1, "member");
    // Full: a stranger cannot join, an existing member can.
    const stranger = await seedUser("s@x.com");
    expect((await checkJoinSeat(pool, org, { userId: stranger }))?.code).toBe("seat_limit_reached");
    expect(await checkJoinSeat(pool, org, { userId: m1 })).toBeNull();
    expect(seatLimitMessage(3)).toBe(
      "All 3 seats are in use. The vault owner can add seats in Baalda (update the app if you don't see Billing).",
    );
  });

  it("lapse is computed for a former subscriber over the Free limits", async () => {
    const owner = await seedUser("lapse@x.com");
    const acct = await account(owner);
    const org = await vaultOn(acct, owner);
    await vaultOn(acct, owner);
    await subscribe(org, acct, "canceled", 3, "2000-01-01");
    const plan = await resolveAccountPlan(pool, { orgId: org });
    expect(plan.plan).toBe("free");
    expect(plan.lapsed).toBe(true);
    // A canceled sub still inside its paid period is Team, not lapsed.
    await pool.query(`UPDATE subscriptions SET current_period_end = '2099-01-01' WHERE organization_id = $1`, [org]);
    const live = await resolveAccountPlan(pool, { orgId: org });
    expect(live.plan).toBe("team");
    expect(live.lapsed).toBe(false);
  });

  it("a lapsed account refuses invites and joins as read-only, not as a people limit", async () => {
    const owner = await seedUser("lapse-inv@x.com");
    const acct = await account(owner);
    const org = await vaultOn(acct, owner);
    await vaultOn(acct, owner);
    await subscribe(org, acct, "canceled", 3, "2000-01-01");
    expect(await checkInviteSeat(pool, org, "new@x.com")).toEqual({ code: "account_read_only" });
    const stranger = await seedUser("lapse-s@x.com");
    const refused = await checkJoinSeat(pool, org, { userId: stranger });
    expect(refused).toEqual({ code: "account_read_only" });
    expect(seatRefusalBody(refused!)).toMatchObject({ error: "account_read_only", code: "account_read_only" });
  });

  it("memoises per request through ResolverCache.planFor", async () => {
    const owner = await seedUser("memo@x.com");
    const acct = await account(owner);
    const org = await vaultOn(acct, owner);
    const cache = createResolverCache();
    const spy = vi.spyOn(pool, "query");
    const first = await cache.planFor(pool, org);
    const calls = spy.mock.calls.length;
    const second = await cache.planFor(pool, org);
    expect(second).toBe(first);
    expect(spy.mock.calls.length).toBe(calls);
    spy.mockRestore();
  });
});
