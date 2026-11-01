// SPDX-License-Identifier: Apache-2.0
//
// Keying a vault (keys/init) or registering a conversion (keys/pending) is for
// owners and admins (or the vault's creator). Whoever keys a vault is its only
// key holder until they share the key, so a plain member keying the team's
// vault would leave everyone else waiting for a key that never comes.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { pendingKeyCache } from "../src/crypto/conversion.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());
const b64 = (b: Buffer) => b.toString("base64");

function api(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer) {
  return app.request(`/api${path}`, {
    method,
    headers: { ...authHeaders(user), ...(vk ? { "x-baalda-vk": b64(vk) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setup() {
  const owner = await signUp(`owner-${randomBytes(4).toString("hex")}@gate.test`);
  const org = await createOrg(owner, "Gate", `gate-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const vaultId = await seedVault(org.id);
  const member = await signUp(`member-${randomBytes(4).toString("hex")}@gate.test`);
  await seedMember(org.id, member.userId, "member");
  const admin = await signUp(`admin-${randomBytes(4).toString("hex")}@gate.test`);
  await seedMember(org.id, admin.userId, "admin");
  return { owner, member, admin, orgId: org.id, vaultId };
}

const initBody = (vk: Buffer, vaultId: string) => ({
  vkCheck: b64(makeVkCheck(vk, vaultId)),
  generation: 1,
  sealedVkForSelf: b64(randomBytes(80)),
});

describe("keying a vault is for owners and admins", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("VAULT_KEY_CONVERSION", "on");
    await resetDb();
    vaultKeyCache.clear();
    pendingKeyCache.clear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("keys/pending: a plain member gets 403 and nothing is stored; an admin may", async () => {
    const s = await setup();
    const vk = randomBytes(32);
    const body = { vkCheck: b64(makeVkCheck(vk, s.vaultId)), generation: 1, deviceId: "d1" };
    const refused = await api(s.member, "POST", `/vaults/${s.vaultId}/keys/pending`, body, vk);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("keying_requires_admin");
    const { rows } = await pool.query("SELECT 1 FROM vault_pending_keys WHERE vault_id = $1", [s.vaultId]);
    expect(rows).toHaveLength(0);
    expect((await api(s.admin, "POST", `/vaults/${s.vaultId}/keys/pending`, body, vk)).status).toBe(200);
  });

  it("keys/init: a plain member gets 403 and the vault stays unkeyed; the owner may", async () => {
    const s = await setup();
    const vk = randomBytes(32);
    const refused = await api(s.member, "POST", `/vaults/${s.vaultId}/keys/init`, initBody(vk, s.vaultId), vk);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("keying_requires_admin");
    const { rows } = await pool.query("SELECT vk_check FROM vaults WHERE id = $1", [s.vaultId]);
    expect(rows[0].vk_check).toBeNull();
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/init`, initBody(vk, s.vaultId), vk)).status).toBe(201);
  });

  it("the person who created a vault may still key it after being made a plain member", async () => {
    const s = await setup();
    await pool.query("UPDATE vaults SET encryption_requested_at = now(), encryption_requested_by = $2 WHERE id = $1", [
      s.vaultId,
      s.member.userId,
    ]);
    const vk = randomBytes(32);
    expect((await api(s.member, "POST", `/vaults/${s.vaultId}/keys/init`, initBody(vk, s.vaultId), vk)).status).toBe(201);
  });
});
