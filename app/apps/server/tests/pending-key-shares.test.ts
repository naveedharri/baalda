// SPDX-License-Identifier: Apache-2.0
//
// Conversion that does not wait on one computer: the claiming device seals the
// pending key to the other owners/admins, any of whom can then finish it; a
// replaced OAuth row and a never-viewed link no longer hold the vault.
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { conversionBlockers, pendingKeyCache } from "../src/crypto/conversion.js";
import { linkTokenHash } from "../src/crypto/link-keys.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedVault } from "./helpers/seed.js";

const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const app = createApp(testAppDeps({ docWriter: createDocWriter(server) }));
const b64 = (b: Buffer) => b.toString("base64");
const CLIENT = "client-pending-shares";

function api(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer) {
  return app.request(`/api${path}`, {
    method,
    headers: { ...authHeaders(user), "x-baalda-version": "0.1.102", ...(vk ? { "x-baalda-vk": b64(vk) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setup() {
  const tag = randomBytes(4).toString("hex");
  const owner = await signUp(`owner-${tag}@shares.test`);
  const admin = await signUp(`admin-${tag}@shares.test`);
  const plain = await signUp(`member-${tag}@shares.test`);
  const org = await createOrg(owner, "Shares", `shares-${tag}`);
  await seedMember(org.id, admin.userId, "admin");
  await seedMember(org.id, plain.userId, "member");
  for (const u of [owner, admin, plain]) {
    await pool.query("INSERT INTO user_keys (user_id, public_key) VALUES ($1, $2)", [u.userId, randomBytes(32)]);
  }
  const vaultId = await seedVault(org.id);
  const docId = await seedNote(vaultId, null, "a.md", owner.userId);
  const vk = randomBytes(32);
  const vkCheck = makeVkCheck(vk, vaultId);
  expect((await api(owner, "POST", `/vaults/${vaultId}/keys/pending`, { vkCheck: b64(vkCheck), generation: 1 }, vk)).status).toBe(200);
  return { owner, admin, plain, orgId: org.id, vaultId, docId, vk, vkCheck };
}

describe("pending key shares", () => {
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

  it("the claiming device shares with another admin, who finishes the conversion", async () => {
    const s = await setup();
    const targets = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/pending/shares`, undefined, s.vk)).json();
    expect(targets).toEqual([{ userId: s.admin.userId, publicKey: expect.any(String), shared: false }]);

    const sealed = randomBytes(80);
    const put = await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending/shares`, { userId: s.admin.userId, sealedVk: b64(sealed) }, s.vk);
    expect(put.status).toBe(200);
    const again = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/pending/shares`, undefined, s.vk)).json();
    expect(again[0].shared).toBe(true);

    // The admin's app sees it in keys/mine; the owner (who has none) does not.
    const mine = await (await api(s.admin, "GET", `/vaults/${s.vaultId}/keys/mine`)).json();
    expect(mine).toMatchObject({ keyed: false, pendingShare: b64(sealed) });
    expect((await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/mine`)).json()).pendingShare).toBeUndefined();

    // With the same key, the admin's device claims (idempotent) and converts.
    expect((await api(s.admin, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk)).status).toBe(200);
    const init = await api(s.admin, "POST", `/vaults/${s.vaultId}/keys/init`, {
      vkCheck: b64(s.vkCheck),
      generation: 1,
      sealedVkForSelf: b64(randomBytes(80)),
    }, s.vk);
    expect(init.status).toBe(201);
    expect((await pool.query("SELECT 1 FROM vault_pending_key_shares")).rowCount).toBe(0);
    // Keyed now: the share routes refuse.
    expect((await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/pending/shares`, undefined, s.vk)).status).toBe(409);
  });

  it("another admin takes over a claim its device stopped renewing 5 minutes ago, and finishes", async () => {
    const s = await setup();
    const vk2 = randomBytes(32);
    const check2 = makeVkCheck(vk2, s.vaultId);
    const claim2 = () => api(s.admin, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(check2), generation: 1 }, vk2);
    // Something the abandoned key made: an allow-list entry and a share.
    await pool.query("INSERT INTO oauth_grant_allow (grant_id, vault_id, mac) VALUES ('g-old', $1, $2)", [s.vaultId, randomBytes(32)]);
    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending/shares`, { userId: s.admin.userId, sealedVk: b64(randomBytes(80)) }, s.vk);

    // A live claim (renewed just now) is never taken.
    expect((await claim2()).status).toBe(409);
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk)).status).toBe(200);
    expect((await claim2()).status).toBe(409);

    await pool.query("UPDATE vault_pending_keys SET refreshed_at = now() - interval '6 minutes'");
    expect((await claim2()).status).toBe(200);
    const { rows } = await pool.query<{ vk_check: Buffer; created_by: string }>("SELECT vk_check, created_by FROM vault_pending_keys");
    expect(rows[0].vk_check.equals(check2)).toBe(true);
    expect(rows[0].created_by).toBe(s.admin.userId);
    expect((await pool.query("SELECT 1 FROM oauth_grant_allow")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM vault_pending_key_shares")).rowCount).toBe(0);

    // The old device, back now, is the one refused; the new claimer finishes.
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk)).status).toBe(409);
    const init = await api(s.admin, "POST", `/vaults/${s.vaultId}/keys/init`, {
      vkCheck: b64(check2),
      generation: 1,
      sealedVkForSelf: b64(randomBytes(80)),
    }, vk2);
    expect(init.status).toBe(201);
  });

  it("a plain member cannot take over an abandoned claim", async () => {
    const s = await setup();
    await pool.query("UPDATE vault_pending_keys SET refreshed_at = now() - interval '1 hour'");
    const vk2 = randomBytes(32);
    const res = await api(s.plain, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(makeVkCheck(vk2, s.vaultId)), generation: 1 }, vk2);
    expect(res.status).toBe(403);
    const { rows } = await pool.query<{ vk_check: Buffer }>("SELECT vk_check FROM vault_pending_keys");
    expect(rows[0].vk_check.equals(s.vkCheck)).toBe(true);
  });

  it("refuses without the pending key, for a plain member, and to a plain member", async () => {
    const s = await setup();
    const share = { userId: s.admin.userId, sealedVk: b64(randomBytes(80)) };
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending/shares`, share)).status).toBe(409);
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending/shares`, share, randomBytes(32))).status).toBe(409);
    expect((await api(s.plain, "POST", `/vaults/${s.vaultId}/keys/pending/shares`, share, s.vk)).status).toBe(403);
    expect((await api(s.plain, "GET", `/vaults/${s.vaultId}/keys/pending/shares`, undefined, s.vk)).status).toBe(403);
    const toMember = await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending/shares`, { userId: s.plain.userId, sealedVk: b64(randomBytes(80)) }, s.vk);
    expect(toMember.status).toBe(400);
    expect((await pool.query("SELECT 1 FROM vault_pending_key_shares")).rowCount).toBe(0);
  });

  it("an OAuth row replaced over an hour ago no longer holds the vault", async () => {
    const s = await setup();
    await pool.query(
      `INSERT INTO "oauthApplication" (id, name, "clientId", "redirectUrls", type) VALUES ($1, 'Claude', $1, 'https://x', 'public')`,
      [CLIENT],
    );
    await pool.query("INSERT INTO mcp_oauth_vault (client_id, user_id, organization_id) VALUES ($1, $2, $3)", [CLIENT, s.owner.userId, s.orgId]);
    const refreshToken = "RefreshTokenForPendingSharesTest1";
    await pool.query(
      `INSERT INTO "oauthAccessToken" (id, "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "clientId", "userId", scopes)
       VALUES ('old', 'AccessTokenForPendingSharesTest11', $1, now() - interval '2 hours', now() + interval '6 days', $2, $3, 'openid offline_access')`,
      [refreshToken, CLIENT, s.owner.userId],
    );
    expect((await conversionBlockers(s.vaultId, 1, pool)).oauthGrants).toBe(1);

    const res = await app.request("/api/auth/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await pool.query("SELECT grant_id FROM oauth_grant_consumed")).rows).toEqual([{ grant_id: "old" }]);
    // Within the hour the old row still counts (a retried refresh may use it).
    expect((await conversionBlockers(s.vaultId, 1, pool)).oauthGrants).toBe(2);
    await pool.query("UPDATE oauth_grant_consumed SET consumed_at = now() - interval '61 minutes'");
    expect((await conversionBlockers(s.vaultId, 1, pool)).oauthGrants).toBe(1);
  });

  it("a link never viewed does not hold the vault; a viewed one does", async () => {
    const s = await setup();
    const insert = async (viewed: boolean) => {
      const docId = await seedNote(s.vaultId, null, `${viewed ? "viewed" : "never"}.md`, s.owner.userId);
      const token = randomBytes(24).toString("base64url");
      return pool.query(
        `INSERT INTO public_links (id, doc_id, vault_id, org_id, token, token_hash, created_by, view_tracking_since, last_viewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
        [randomUUID(), docId, s.vaultId, s.orgId, token, linkTokenHash(token), s.owner.userId, viewed ? new Date() : null],
      );
    };
    await insert(false);
    expect((await conversionBlockers(s.vaultId, 1, pool)).links).toHaveLength(0);
    await insert(true);
    expect((await conversionBlockers(s.vaultId, 1, pool)).links).toHaveLength(1);
  });
});
