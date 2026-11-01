// SPDX-License-Identifier: Apache-2.0
// The launch safety net: recovery copies sealed to an offline key, the rescue
// grant, and switching it off.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { depositRecoveryCopy, purgeRecoveryCopies } from "../src/crypto/key-recovery.js";
import {
  generateRecoveryKeypair,
  openRecoveryCopy,
  recoveryKeyFingerprint,
  recoveryPublicFromPrivate,
  sealForRecovery,
} from "../src/crypto/recovery-seal.js";
import { VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp } from "./helpers/auth.js";
import { seedMember, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());
const b64 = (b: Buffer) => b.toString("base64");
const ADMIN = "a".repeat(40);

async function keyedVault() {
  const owner = await signUp("owner@recovery.test");
  const member = await signUp("member@recovery.test");
  const org = await createOrg(owner, "Recovery", `recovery-${Date.now()}`);
  await seedMember(org.id, member.userId, "member");
  const vaultId = await seedVault(org.id);
  const vk = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
    vaultId,
    makeVkCheck(vk, vaultId),
  ]);
  return { owner, member, orgId: org.id, vaultId, vk };
}

const admin = (path: string, init: RequestInit = {}, token = ADMIN) =>
  app.request(`/api/admin/key-recovery${path}`, {
    ...init,
    headers: { "x-baalda-recovery-admin": token, "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("key recovery safety net", () => {
  const pair = generateRecoveryKeypair();
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("KEY_RECOVERY_PUBLIC_KEY", b64(pair.publicKey));
    vi.stubEnv("KEY_RECOVERY_ADMIN_TOKEN", ADMIN);
    await resetDb();
    vaultKeyCache.clear();
    await purgeRecoveryCopies();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("seals to the public key; only the private key, vault and generation open it", () => {
    const vk = randomBytes(32);
    const sealed = sealForRecovery(vk, pair.publicKey, "v1", 1);
    expect(openRecoveryCopy(sealed, pair.privateKey, "v1", 1).equals(vk)).toBe(true);
    expect(recoveryPublicFromPrivate(pair.privateKey).equals(pair.publicKey)).toBe(true);
    expect(() => openRecoveryCopy(sealed, generateRecoveryKeypair().privateKey, "v1", 1)).toThrow();
    expect(() => openRecoveryCopy(sealed, pair.privateKey, "v2", 1)).toThrow();
    expect(() => openRecoveryCopy(sealed, pair.privateKey, "v1", 2)).toThrow();
    expect(sealed.includes(vk)).toBe(false);
  });

  it("a verified key deposits one copy that opens to the vault key", async () => {
    const s = await keyedVault();
    vaultKeyCache.holdForRequest(s.vaultId, s.vk, 1);
    expect(await depositRecoveryCopy(s.vaultId)).toBe(true);
    expect(await depositRecoveryCopy(s.vaultId)).toBe(false);
    const { rows } = await pool.query("SELECT generation, recovery_key_fp, sealed_vk FROM vault_key_recovery");
    expect(rows).toHaveLength(1);
    expect(rows[0].recovery_key_fp).toBe(recoveryKeyFingerprint(pair.publicKey));
    expect(openRecoveryCopy(rows[0].sealed_vk, pair.privateKey, s.vaultId, 1).equals(s.vk)).toBe(true);
  });

  it("a key that does not match vk_check is never deposited", async () => {
    const s = await keyedVault();
    vaultKeyCache.holdForRequest(s.vaultId, randomBytes(32), 1);
    expect(await depositRecoveryCopy(s.vaultId)).toBe(false);
    expect((await pool.query("SELECT 1 FROM vault_key_recovery")).rowCount).toBe(0);
  });

  it("off: no deposit, and purge deletes every copy", async () => {
    const s = await keyedVault();
    vaultKeyCache.holdForRequest(s.vaultId, s.vk, 1);
    await depositRecoveryCopy(s.vaultId);
    vi.stubEnv("KEY_RECOVERY_PUBLIC_KEY", "");
    expect(await purgeRecoveryCopies()).toBe(1);
    vaultKeyCache.clear();
    vaultKeyCache.holdForRequest(s.vaultId, s.vk, 1);
    expect(await depositRecoveryCopy(s.vaultId)).toBe(false);
    expect((await pool.query("SELECT 1 FROM vault_key_recovery")).rowCount).toBe(0);
  });

  it("admin routes are 404 without the token, with a wrong one, or with recovery off", async () => {
    const s = await keyedVault();
    expect((await app.request(`/api/admin/key-recovery/${s.vaultId}`)).status).toBe(404);
    expect((await admin(`/${s.vaultId}`, {}, "b".repeat(40))).status).toBe(404);
    expect((await admin(`/${s.vaultId}`)).status).toBe(200);
    vi.stubEnv("KEY_RECOVERY_PUBLIC_KEY", "");
    expect((await admin(`/${s.vaultId}`)).status).toBe(404);
    // A session is no admin token.
    vi.stubEnv("KEY_RECOVERY_PUBLIC_KEY", b64(pair.publicKey));
    expect(
      (await app.request(`/api/admin/key-recovery/${s.vaultId}`, { headers: authHeaders(s.owner) })).status,
    ).toBe(404);
  });

  it("rescue: the opened key grants a wrap to a member; a wrong key or a non-member is refused", async () => {
    const s = await keyedVault();
    vaultKeyCache.holdForRequest(s.vaultId, s.vk, 1);
    await depositRecoveryCopy(s.vaultId);
    const listing = (await (await admin(`/${s.vaultId}`)).json()) as {
      generation: number;
      copies: Array<{ sealedVk: string; generation: number }>;
      members: Array<{ userId: string }>;
    };
    expect(listing.generation).toBe(1);
    expect(listing.members.map((m) => m.userId).sort()).toEqual([s.owner.userId, s.member.userId].sort());
    const opened = openRecoveryCopy(Buffer.from(listing.copies[0]!.sealedVk, "base64"), pair.privateKey, s.vaultId, 1);
    const grant = (vk: Buffer, userId: string) =>
      admin(`/${s.vaultId}/grant`, {
        method: "POST",
        headers: { "x-baalda-vk": b64(vk), "x-baalda-version": VAULT_KEYS_MIN_DESKTOP },
        body: JSON.stringify({ userId, generation: 1, sealedVk: b64(randomBytes(80)) }),
      });
    expect((await grant(randomBytes(32), s.member.userId)).status).toBe(409);
    const outsider = await signUp("outsider@recovery.test");
    expect((await grant(opened, outsider.userId)).status).toBe(404);
    // An existing wrap moves to history, never deleted.
    await pool.query(
      "INSERT INTO vault_key_wraps (vault_id, user_id, generation, sealed_vk) VALUES ($1, $2, 1, $3)",
      [s.vaultId, s.member.userId, randomBytes(80)],
    );
    expect((await grant(opened, s.member.userId)).status).toBe(201);
    expect(
      (await pool.query("SELECT 1 FROM vault_key_wraps WHERE vault_id = $1 AND user_id = $2", [s.vaultId, s.member.userId]))
        .rowCount,
    ).toBe(1);
    expect(
      (await pool.query("SELECT 1 FROM vault_key_wrap_history WHERE vault_id = $1 AND user_id = $2", [s.vaultId, s.member.userId]))
        .rowCount,
    ).toBe(1);
    const audit = await pool.query("SELECT action FROM access_audit WHERE organization_id = $1 AND action = 'key_recovered'", [
      s.orgId,
    ]);
    expect(audit.rowCount).toBe(1);
  });
});
