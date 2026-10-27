import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { maybeDailyCheckpoint, resetCheckpointDeferrals } from "../src/versions/checkpoints.js";
import {
  checkpointSchedule,
  plainCheckpointDate,
  resetCheckpointScheduleCache,
} from "../src/versions/checkpoint-plan.js";
import { recordingAppDeps, type RecordingAppDeps } from "./helpers/app.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Checkpoint cadence by plan: a paid vault, or a deployment that does not
 * enforce billing, keeps daily automatic checkpoints and unlimited manual ones;
 * a Free vault with billing enforced takes no automatic checkpoints and one
 * manual checkpoint per rolling 7 days.
 */

// `billingModel` is read once at config load; flip it per test.
const mutable = config as unknown as { billingModel: "vault" | "team" };
const originalModel = mutable.billingModel;

let rec: RecordingAppDeps;
let app: ReturnType<typeof createApp>;
let n = 0;

function billingOn(model: "vault" | "team" = "team") {
  mutable.billingModel = model;
  vi.stubEnv("POLAR_ACCESS_TOKEN", "test-token");
  vi.stubEnv("BAALDA_DEPLOYMENT", "cloud");
}

function api(user: TestUser, path: string, init: RequestInit = {}) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${user.token}` };
  return app.fetch(new Request(`http://local${path}`, { ...init, headers }));
}

async function vaultFor(owner: TestUser): Promise<{ org: string; vault: string }> {
  const org = await seedOrg(`Ck${++n}`, `ck-${n}-${Date.now()}`);
  await seedMember(org, owner.userId, "owner");
  const vault = await seedVault(org);
  await seedVaultGrant(org, "edit");
  const note = await seedNote(vault, null, "a.md", owner.userId);
  rec.docWriter.store.set(note, "alpha");
  return { org, vault };
}

async function complimentaryTeam(ownerId: string, org: string) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO billing_accounts (id, owner_user_id, plan_override) VALUES ($1, $2, 'team') RETURNING id`,
    [`ba_ck_${++n}`, ownerId],
  );
  await pool.query(
    `INSERT INTO billing_account_orgs (organization_id, billing_account_id) VALUES ($1, $2)`,
    [org, rows[0]!.id],
  );
}

async function create(user: TestUser, vault: string) {
  return api(user, `/api/vaults/${vault}/checkpoints`, { method: "POST", body: "{}" });
}

async function schedule(user: TestUser, vault: string) {
  const res = await api(user, `/api/vaults/${vault}/checkpoints`);
  expect(res.status).toBe(200);
  return ((await res.json()) as {
    schedule: { auto: boolean; manualEveryDays: number | null; nextManualAt: string | null };
  }).schedule;
}

async function autoCount(vault: string): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    "SELECT count(*)::int AS c FROM vault_checkpoints WHERE vault_id = $1 AND kind = 'auto'",
    [vault],
  );
  return rows[0]!.c;
}

beforeEach(async () => {
  await resetDb();
  resetCheckpointScheduleCache();
  resetCheckpointDeferrals();
  rec = recordingAppDeps();
  app = createApp(rec.deps);
});
afterEach(() => {
  vi.unstubAllEnvs();
  mutable.billingModel = originalModel;
});
afterAll(async () => {
  mutable.billingModel = originalModel;
  await pool.end();
});

describe("checkpoint cadence by plan", () => {
  it("billing not enforced: daily automatic checkpoints and unlimited manual ones", async () => {
    vi.stubEnv("POLAR_ACCESS_TOKEN", "");
    const owner = await signUp("ck-off@t.com");
    const { vault } = await vaultFor(owner);

    expect(await maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter, deferMs: 0 })).not.toBeNull();
    expect(await autoCount(vault)).toBe(1);
    expect((await create(owner, vault)).status).toBe(201);
    expect((await create(owner, vault)).status).toBe(201);
    expect(await schedule(owner, vault)).toEqual({ auto: true, manualEveryDays: null, nextManualAt: null });
  });

  it("enforced, Team: the same as today", async () => {
    billingOn("team");
    const owner = await signUp("ck-team@t.com");
    const { org, vault } = await vaultFor(owner);
    await complimentaryTeam(owner.userId, org);

    expect(await maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter, deferMs: 0 })).not.toBeNull();
    expect((await create(owner, vault)).status).toBe(201);
    expect((await create(owner, vault)).status).toBe(201);
    expect(await schedule(owner, vault)).toEqual({ auto: true, manualEveryDays: null, nextManualAt: null });
  });

  it("enforced, legacy model with an active subscription: the same as today", async () => {
    billingOn("vault");
    const owner = await signUp("ck-pro@t.com");
    const { org, vault } = await vaultFor(owner);
    await pool.query(
      `INSERT INTO subscriptions (organization_id, provider, provider_customer_id, provider_subscription_id,
          plan, status, current_period_end, cancel_at_period_end)
       VALUES ($1, 'polar', 'cus', $2, 'pro', 'active', '2099-01-01', false)`,
      [org, `sub_ck_${++n}`],
    );
    expect((await checkpointSchedule(pool, vault)).auto).toBe(true);
    expect(await maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter, deferMs: 0 })).not.toBeNull();
  });

  it("enforced, Free: no automatic checkpoints, one manual checkpoint per 7 days", async () => {
    billingOn("team");
    const owner = await signUp("ck-free@t.com");
    const { vault } = await vaultFor(owner);

    expect(await maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter, deferMs: 0 })).toBeNull();
    expect(await autoCount(vault)).toBe(0);

    expect(await schedule(owner, vault)).toEqual({ auto: false, manualEveryDays: 7, nextManualAt: null });

    const first = await create(owner, vault);
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };

    const second = await create(owner, vault);
    expect(second.status).toBe(429);
    const refusal = (await second.json()) as { error: string; message: string; nextAt: string };
    expect(refusal.error).toBe("checkpoint_limit");
    const nextAt = new Date(refusal.nextAt);
    expect(nextAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(refusal.message).toBe(
      `This vault can make one checkpoint a week. The next one can be made on ${plainCheckpointDate(nextAt)}.`,
    );
    expect(refusal.message).not.toMatch(/free|team|plan|upgrade/i);
    expect((await schedule(owner, vault)).nextManualAt).toBe(refusal.nextAt);

    // Seven days later the window has rolled.
    await pool.query(
      "UPDATE vault_checkpoints SET created_at = now() - interval '7 days 1 minute' WHERE id = $1",
      [id],
    );
    expect((await schedule(owner, vault)).nextManualAt).toBeNull();
    expect((await create(owner, vault)).status).toBe(201);
  });

  it("caches the schedule so the activity path does not resolve the plan each time", async () => {
    billingOn("team");
    const owner = await signUp("ck-cache@t.com");
    const { org, vault } = await vaultFor(owner);
    expect((await checkpointSchedule(pool, vault)).auto).toBe(false);
    await complimentaryTeam(owner.userId, org);
    expect((await checkpointSchedule(pool, vault)).auto).toBe(false);
    expect((await checkpointSchedule(pool, vault, { fresh: true })).auto).toBe(true);
    expect((await checkpointSchedule(pool, vault)).auto).toBe(true);
  });

  it("formats the date plainly", () => {
    expect(plainCheckpointDate(new Date("2026-11-03T12:00:00Z"))).toBe("Tue 3 Nov");
  });
});
