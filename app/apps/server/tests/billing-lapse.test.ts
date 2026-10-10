import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { canCreateIn, canDeleteItem, canWriteBlob } from "../src/permissions/http-gates.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import {
  isAccountReadOnly,
  onMembershipTrimmed,
  recheckAccount,
  resetLapseMemory,
  setLapseNotifier,
} from "../src/billing/lapse.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

const mutable = config as unknown as { billingModel: "vault" | "team" };
const originalModel = mutable.billingModel;
const rec = recordingAppDeps();
const app = createApp(rec.deps);

function teamOn() {
  mutable.billingModel = "team";
  vi.stubEnv("POLAR_ACCESS_TOKEN", "test-token");
  vi.stubEnv("BAALDA_DEPLOYMENT", "cloud");
}

interface Fx {
  owner: TestUser;
  org: string;
  vault: string;
  account: string;
  note: string;
}

/** Owner + 2 more members (3 people > Free's 2) on one attached vault. */
async function fixture(sub: { status: string; periodEnd: string } | null): Promise<Fx> {
  const owner = await signUp(`owner-${randomUUID()}@test.dev`);
  const org = await seedOrg("Lapse", `lapse-${randomUUID()}`);
  await seedMember(org, owner.userId, "owner");
  for (const who of ["a", "b"]) await seedMember(org, await seedUser(`${who}-${randomUUID()}@test.dev`), "member");
  const account = `ba_${randomUUID()}`;
  await pool.query(
    `INSERT INTO billing_accounts (id, owner_user_id) VALUES ($1, $2)
     ON CONFLICT (owner_user_id) DO NOTHING`,
    [account, owner.userId],
  );
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM billing_accounts WHERE owner_user_id = $1`, [owner.userId]);
  const accountId = rows[0]!.id;
  await pool.query(
    `INSERT INTO billing_account_orgs (organization_id, billing_account_id) VALUES ($1, $2)
     ON CONFLICT (organization_id) DO UPDATE SET billing_account_id = EXCLUDED.billing_account_id`,
    [org, accountId],
  );
  if (sub) {
    await pool.query(
      `INSERT INTO subscriptions (organization_id, provider, provider_customer_id, provider_subscription_id,
          plan, status, current_period_end, cancel_at_period_end, billing_account_id, seats)
       VALUES ($1, 'polar', 'cus', $2, 'pro', $3, $4, false, $5, 3)`,
      [org, `sub_${randomUUID()}`, sub.status, sub.periodEnd, accountId],
    );
  }
  const vault = await seedVault(org);
  const note = await seedNote(vault, null, "mine.md", owner.userId);
  return { owner, org, vault, account: accountId, note };
}

const PAST = "2020-01-01";
const FUTURE = "2099-01-01";

beforeEach(async () => {
  await resetDb();
  resetLapseMemory();
  teamOn();
});
afterEach(() => {
  vi.unstubAllEnvs();
  mutable.billingModel = originalModel;
  setLapseNotifier(null);
});
afterAll(async () => {
  mutable.billingModel = originalModel;
  await pool.end();
});

describe("billing lapse read-only cap", () => {
  it("a lapsed account caps the owner's own note to view and refuses writes", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    expect(await isAccountReadOnly(pool, f.org)).toBe(true);
    expect(await effectivePermission(f.owner.userId, f.note, pool)).toBe("view");
    expect(await canCreateIn(f.owner.userId, f.vault, null, pool)).toBe(false);
    expect(
      await canWriteBlob(f.owner.userId, { vault_id: f.vault, doc_id: null } as never, pool),
    ).toBe(false);
    expect(
      await canDeleteItem(pool, { orgId: f.org, userId: f.owner.userId, kind: "note", id: f.note }),
    ).toEqual({ ok: false, code: "account_read_only" });
  });

  it("GET /locks returns the billing padlock and no lifts", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    const res = await app.fetch(
      new Request(`http://local/api/vaults/${f.vault}/locks`, { headers: authHeaders(f.owner) }),
    );
    expect(res.status).toBe(200);
    const { locks } = (await res.json()) as { locks: Array<Record<string, unknown>> };
    expect(locks).toContainEqual(
      expect.objectContaining({
        id: `billing:${f.org}`,
        resource_type: "vault",
        resource_id: f.org,
        permission: "locked",
        reason: "billing_lapsed",
      }),
    );
    expect(locks.some((l) => l.permission === "edit")).toBe(false);
  });

  it("past_due is not lapsed", async () => {
    const f = await fixture({ status: "past_due", periodEnd: PAST });
    expect(await isAccountReadOnly(pool, f.org)).toBe(false);
    expect(await effectivePermission(f.owner.userId, f.note, pool)).toBe("edit");
  });

  it("canceled but inside the paid period is not lapsed", async () => {
    const f = await fixture({ status: "canceled", periodEnd: FUTURE });
    expect(await isAccountReadOnly(pool, f.org)).toBe(false);
  });

  it("a Free account that never paid is not lapsed", async () => {
    const f = await fixture(null);
    expect(await isAccountReadOnly(pool, f.org)).toBe(false);
    expect(await effectivePermission(f.owner.userId, f.note, pool)).toBe("edit");
  });

  it("resuming clears the lapse and fans out onAclChanged", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    const fired = vi.fn();
    setLapseNotifier(fired);
    expect(await recheckAccount(f.account, pool)).toBe(true);
    expect(fired).toHaveBeenCalledWith(f.vault);
    fired.mockClear();
    await pool.query(
      `UPDATE subscriptions SET status = 'active', current_period_end = $2 WHERE billing_account_id = $1`,
      [f.account, FUTURE],
    );
    expect(await recheckAccount(f.account, pool)).toBe(false);
    expect(fired).toHaveBeenCalledWith(f.vault);
    expect(await effectivePermission(f.owner.userId, f.note, pool)).toBe("edit");
  });

  it("trimming to 2 members clears the lapse and fans out onAclChanged", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    const fired = vi.fn();
    setLapseNotifier(fired);
    await recheckAccount(f.account, pool);
    fired.mockClear();
    await pool.query(
      `DELETE FROM member WHERE id = (SELECT id FROM member WHERE "organizationId" = $1 AND role = 'member' LIMIT 1)`,
      [f.org],
    );
    await onMembershipTrimmed(pool, f.org);
    expect(fired).toHaveBeenCalledWith(f.vault);
    expect(await isAccountReadOnly(pool, f.org)).toBe(false);
    expect(await canCreateIn(f.owner.userId, f.vault, null, pool)).toBe(true);
  });
});

function call(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { ...authHeaders(user), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("billing lapse: remaining content writes answer 402, management stays open", () => {
  it("PATCH rename of the owner's own note answers 402 account_read_only", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    const res = await call(f.owner, "PATCH", `/api/notes/${f.note}`, { relPath: "renamed.md" });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "account_read_only" });
    const { rows } = await pool.query(`SELECT rel_path FROM notes WHERE id = $1`, [f.note]);
    expect(rows[0].rel_path).toBe("mine.md");
  });

  it("blob text PUT answers 402 account_read_only", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    const blob = await seedBlob(f.vault, f.org, "attachments/pic.png");
    const res = await call(f.owner, "PUT", `/api/vaults/${f.vault}/blobs/${blob}/text`, {
      content: "hello",
      sha256: "a".repeat(64),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "account_read_only" });
  });

  it("note restore from Trash answers 402 account_read_only, even for the owner", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    await pool.query(`UPDATE notes SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [f.note, f.owner.userId]);
    const res = await call(f.owner, "POST", `/api/notes/${f.note}/restore`);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "account_read_only" });
    const { rows } = await pool.query(`SELECT deleted_at FROM notes WHERE id = $1`, [f.note]);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it("PUT team-access is management and still answers 200", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    const res = await call(f.owner, "PUT", `/api/orgs/${f.org}/team-access`, { mode: "readonly" });
    expect(res.status).toBe(200);
  });

  it("removing a member still works while lapsed", async () => {
    const f = await fixture({ status: "canceled", periodEnd: PAST });
    const { rows } = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM member WHERE "organizationId" = $1 AND role = 'member' LIMIT 1`,
      [f.org],
    );
    const res = await call(f.owner, "DELETE", `/api/orgs/${f.org}/members/${rows[0]!.userId}`);
    expect(res.ok).toBe(true);
    const left = await pool.query(`SELECT 1 FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [
      f.org,
      rows[0]!.userId,
    ]);
    expect(left.rowCount).toBe(0);
  });
});
