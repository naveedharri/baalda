import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { config } from "../src/config.js";

/**
 * Per-vault attachment storage quota.
 *
 * The accounting remains available to members, while uploads on a
 * billing-enabled server first require a Pro vault. A self-hosted server must
 * never meet a quota, and a Pro vault is unlimited.
 */
const app = createApp(testAppDeps());

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const LIMIT_BYTES = config.freeMaxStorageMb * 1024 * 1024;

let owner: TestUser;
let orgId = "";
let vaultId = "";

/** Occupy `bytes` of the vault's quota with a `ready` row. The `size` column is
 *  what the sum reads; no real bytes are needed to test an accounting rule. */
async function occupy(bytes: number, status: "ready" | "pending" = "ready"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data)
     VALUES ($1, $2, $3, $4, $5, 'image/png', $6, 'x.png', 'postgres', $7,
             CASE WHEN $7 = 'ready' THEN decode('000102','hex') ELSE NULL END)`,
    [id, vaultId, orgId, randomUUID().replace(/-/g, "") + "f".repeat(32), bytes,
      `attachments/${id}.png`, status],
  );
  return id;
}

function intent(user: TestUser, body: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs/intent`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const newUpload = () => ({
  sha256: createHash("sha256").update(randomUUID()).digest("hex"),
  size: PNG.byteLength,
  mime: "image/png",
  relPath: `attachments/${randomUUID()}.png`,
});

const storage = (user: TestUser) =>
  app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/storage`, {
      headers: { authorization: `Bearer ${user.token}` },
    }),
  );

afterAll(async () => {
  await pool.end();
});

describe("storage quota", () => {
  beforeEach(async () => {
    await resetDb();
    owner = await signUp(`owner-${randomUUID().slice(0, 8)}@quota.com`);
    orgId = await seedOrg("Quota Co", `quota-${randomUUID().slice(0, 8)}`);
    await seedMember(orgId, owner.userId, "owner");
    vaultId = await seedVault(orgId);
    await seedVaultGrant(orgId, "edit");
  });

  afterEach(() => {
    delete process.env.POLAR_ACCESS_TOKEN;
  });

  it("requires Pro before evaluating storage for an unsubscribed vault", async () => {
    process.env.POLAR_ACCESS_TOKEN = "test-token";
    await occupy(LIMIT_BYTES);

    const res = await intent(owner, newUpload());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "attachment_sync_requires_pro" });
  });

  it("counts pending rows in reported storage", async () => {
    process.env.POLAR_ACCESS_TOKEN = "test-token";
    await occupy(LIMIT_BYTES, "pending");
    const body = (await (await storage(owner)).json()) as {
      usedBytes: number;
      pendingBytes: number;
    };
    expect(body.usedBytes).toBe(LIMIT_BYTES);
    expect(body.pendingBytes).toBe(LIMIT_BYTES);
  });

  it("never 402s with billing off, however full the vault is", async () => {
    await occupy(LIMIT_BYTES * 4);
    const res = await intent(owner, newUpload());
    expect(res.status).toBe(200);
  });

  it("never 402s for a vault with an active subscription", async () => {
    process.env.POLAR_ACCESS_TOKEN = "test-token";
    await occupy(LIMIT_BYTES * 4);
    await pool.query(
      `INSERT INTO subscriptions (organization_id, plan, status) VALUES ($1, 'pro', 'active')`,
      [orgId],
    );
    expect((await intent(owner, newUpload())).status).toBe(200);
  });

  it("does not let legacy account flags bypass the Pro requirement", async () => {
    process.env.POLAR_ACCESS_TOKEN = "test-token";
    await pool.query(
      `INSERT INTO account_entitlements (user_id, free_vault_limit, attachment_sync)
       VALUES ($1, 3, true)`,
      [owner.userId],
    );
    const res = await intent(owner, newUpload());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "attachment_sync_requires_pro" });
  });

  describe("GET /api/vaults/:vaultId/storage", () => {
    it("reports usage and a null limit when nothing caps the vault", async () => {
      await occupy(1000);
      await occupy(500, "pending");
      const body = (await (await storage(owner)).json()) as Record<string, unknown>;
      expect(body).toEqual({
        usedBytes: 1500,
        pendingBytes: 500,
        blobCount: 2,
        // Unlimited is `null`, not a huge number, so a client renders
        // "unlimited" rather than a meaningless bar.
        limitBytes: null,
      });
    });

    it("reports the free-tier limit when billing is on", async () => {
      process.env.POLAR_ACCESS_TOKEN = "test-token";
      const body = (await (await storage(owner)).json()) as { limitBytes: number };
      expect(body.limitBytes).toBe(LIMIT_BYTES);
    });

    it("is member-gated, not write-gated", async () => {
      const reader = await signUp(`reader-${randomUUID().slice(0, 8)}@quota.com`);
      expect((await storage(reader)).status).toBe(403);
      await seedMember(orgId, reader.userId, "member");
      expect((await storage(reader)).status).toBe(200);
    });
  });
});
