// SPDX-License-Identifier: Apache-2.0
//
// W3: claude.ai / ChatGPT OAuth connections. Tokens are stored as hashes
// (lazily) and an existing connection keeps working with no reconnect, before
// and after its first refresh; with vault keys, a pre-existing allow-listed
// grant upgrades while a key is held and then works with ZERO desktops online.
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { pendingKeyCache } from "../src/crypto/conversion.js";
import { allowMac } from "../src/crypto/token-wrap.js";
import { hashOAuthToken } from "../src/mcp/oauth-token-hash.js";
import { resetMcpBadTokens } from "../src/http/routes/mcp.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, markEncryptionRequested, seedVault } from "./helpers/seed.js";

const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const app = createApp(testAppDeps({ docWriter: createDocWriter(server) }));
const b64 = (b: Buffer) => b.toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CLIENT = "client-oauth-keys";

function api(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer) {
  return app.request(`/api${path}`, {
    method,
    headers: { ...authHeaders(user), ...(vk ? { "x-baalda-vk": b64(vk) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let rpcId = 0;
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.request("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    result?: { isError?: boolean; structuredContent?: any; content?: Array<{ text: string }> };
  };
  return {
    status: res.status,
    isError: body.result?.isError ?? res.status !== 200,
    data: body.result?.structuredContent,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

async function refresh(refreshToken: string) {
  const res = await app.request("/api/auth/mcp/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT }).toString(),
  });
  return { status: res.status, body: (await res.json()) as { access_token?: string; refresh_token?: string } };
}

function noDesktops() {
  vaultKeyCache.clear();
  pendingKeyCache.clear();
}

/** A connection made before this release: Better Auth stored it in plaintext. */
async function setup() {
  const owner = await signUp(`owner-${randomBytes(4).toString("hex")}@ok.test`);
  const org = await createOrg(owner, "OK", `ok-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const vaultId = await seedVault(org.id);
  // These tests exercise conversion: an owner opted the vault in.
  await markEncryptionRequested(vaultId, owner.userId);
  const docId = await seedNote(vaultId, null, "a.md", owner.userId);
  await pool.query(
    `INSERT INTO "oauthApplication" (id, name, "clientId", "redirectUrls", type) VALUES ($1, 'Claude', $1, 'https://x', 'public')`,
    [CLIENT],
  );
  const access = "AccessLegacyPlaintextTokenAbcdef";
  const refreshToken = "RefreshLegacyPlaintextTokenAbcde";
  await pool.query(
    `INSERT INTO "oauthAccessToken" (id, "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "clientId", "userId", scopes)
     VALUES ('g1', $1, $2, now() + interval '1 hour', now() + interval '7 days', $3, $4, 'openid offline_access')`,
    [access, refreshToken, CLIENT, owner.userId],
  );
  await pool.query("INSERT INTO mcp_oauth_vault (client_id, user_id, organization_id) VALUES ($1, $2, $3)", [
    CLIENT,
    owner.userId,
    org.id,
  ]);
  const vk = randomBytes(32);
  return { owner, orgId: org.id, vaultId, docId, access, refreshToken, vk, vkCheck: makeVkCheck(vk, vaultId) };
}

async function storedRow(id: string) {
  const { rows } = await pool.query<{ accessToken: string; refreshToken: string }>(
    `SELECT "accessToken", "refreshToken" FROM "oauthAccessToken" WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("OAuth connector tokens: hashed storage + vault keys", () => {
  beforeEach(async () => {
    await resetDb();
    resetMcpBadTokens();
    noDesktops();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  for (const flag of ["off", "on"]) {
    it(`an existing plaintext grant keeps working before and after its first refresh (flag ${flag})`, async () => {
      vi.stubEnv("BAALDA_VAULT_KEYS", flag);
      const s = await setup();

      // Before: works, and the row is hashed in place on use.
      const before = await tool(s.access, "read_note", { docId: s.docId });
      expect(before.isError, before.text).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(await storedRow("g1")).toEqual({
        accessToken: hashOAuthToken(s.access),
        refreshToken: hashOAuthToken(s.refreshToken),
      });
      expect((await tool(s.access, "read_note", { docId: s.docId })).isError).toBe(false);

      // First refresh: same response shape, new row stored only as hashes.
      const r1 = await refresh(s.refreshToken);
      expect(r1.status).toBe(200);
      const a2 = r1.body.access_token!;
      const rt2 = r1.body.refresh_token!;
      expect(a2).toMatch(/^[A-Za-z]{32}$/);
      const { rows } = await pool.query(`SELECT id FROM "oauthAccessToken" WHERE "accessToken" = $1`, [hashOAuthToken(a2)]);
      expect(rows).toHaveLength(1);
      expect(await storedRow(rows[0].id)).toEqual({ accessToken: hashOAuthToken(a2), refreshToken: hashOAuthToken(rt2) });
      const dump = JSON.stringify((await pool.query(`SELECT * FROM "oauthAccessToken"`)).rows);
      for (const t of [s.access, s.refreshToken, a2, rt2]) expect(dump).not.toContain(t);

      // After: the new token works, the old one still does (as today), and the
      // next refresh works too.
      expect((await tool(a2, "read_note", { docId: s.docId })).isError).toBe(false);
      expect((await tool(s.access, "read_note", { docId: s.docId })).isError).toBe(false);
      const r2 = await refresh(rt2);
      expect(r2.status).toBe(200);
      expect((await tool(r2.body.access_token!, "read_note", { docId: s.docId })).isError).toBe(false);
    });
  }

  it("a stored hash is never a credential (bearer, refresh, or the session probe)", async () => {
    const s = await setup();
    await tool(s.access, "read_note", { docId: s.docId });
    await new Promise((r) => setTimeout(r, 50));
    expect((await tool(hashOAuthToken(s.access), "read_note", { docId: s.docId })).status).toBe(401);
    expect((await refresh(hashOAuthToken(s.refreshToken))).status).toBe(401);
    expect((await refresh("NoSuchRefreshTokenAnywhereAbcdef")).status).toBe(401);
    const probe = await app.request("/api/auth/mcp/get-session", {
      headers: { authorization: `Bearer ${hashOAuthToken(s.access)}` },
    });
    expect(await probe.json()).toBeNull();
  });

  it("an allow-listed grant upgrades on refresh, then works in a keyed vault with zero desktops online", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    const s = await setup();
    // A member's desktop starts converting: pending check, allow-list the grant.
    expect(
      (await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk)).status,
    ).toBe(200);
    const cand = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json();
    expect(cand).toEqual([{ kind: "oauth_grant", id: "g1", hash: sha(s.refreshToken) }]);
    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, {
      entries: [{ kind: "oauth_grant", id: "g1", mac: b64(allowMac(s.vk, "g1", sha(s.refreshToken))) }],
    }, s.vk);
    const blocked = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    expect(blocked).toMatchObject({ ready: false, blockers: { oauthGrants: 1 } });

    // While the key is held: the old access token upgrades on use, and the
    // refresh gives the new pair its wraps (and covers the consumed row).
    expect((await tool(s.access, "read_note", { docId: s.docId })).isError).toBe(false);
    const r1 = await refresh(s.refreshToken);
    expect(r1.status).toBe(200);
    const ready = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    expect(ready).toMatchObject({ ready: true });

    // Convert, then no desktop anywhere.
    const init = await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/init`, {
      vkCheck: b64(s.vkCheck),
      generation: 1,
      sealedVkForSelf: b64(randomBytes(80)),
    }, s.vk);
    expect(init.status).toBe(201);
    noDesktops();

    const a2 = r1.body.access_token!;
    const upd = await tool(a2, "update_note", { docId: s.docId, content: "secret plan" });
    expect(upd.isError, upd.text).toBe(false);
    expect((await tool(a2, "read_note", { docId: s.docId })).data.content).toBe("secret plan");
    expect((await tool(s.access, "read_note", { docId: s.docId })).data.content).toBe("secret plan");
    // A refresh with no desktop online rewraps for the next pair.
    const r2 = await refresh(r1.body.refresh_token!);
    expect(r2.status).toBe(200);
    expect((await tool(r2.body.access_token!, "read_note", { docId: s.docId })).data.content).toBe("secret plan");
  });

  it("a new connection to a keyed vault is finished by the desktop, then works with zero desktops online", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    const s = await setup();
    await pool.query(`DELETE FROM "oauthAccessToken"`);
    await pool.query("DELETE FROM mcp_oauth_vault");
    const init = await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/init`, {
      vkCheck: b64(s.vkCheck),
      generation: 1,
      sealedVkForSelf: b64(randomBytes(80)),
    }, s.vk);
    expect(init.status).toBe(201);
    noDesktops();

    // The browser's Allow does not complete: it hands off to the desktop.
    const allow = await app.request("/oauth/consent", {
      method: "POST",
      headers: { authorization: `Bearer ${s.owner.token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        consent_code: "cc",
        client_id: CLIENT,
        organization_id: s.orgId,
        decision: "allow",
      }).toString(),
    });
    expect(allow.status).toBe(200);
    const html = await allow.text();
    expect(html).toContain("Open Baalda on your computer to finish connecting");
    const id = decodeURIComponent(/oauth-consent\?id=([^&"]+)/.exec(html)![1]);
    expect((await pool.query("SELECT 1 FROM mcp_oauth_vault")).rowCount).toBe(0);

    // Without the key (a forged session has none) or as someone else: refused.
    const other = await signUp(`other-${randomBytes(4).toString("hex")}@ok.test`);
    expect((await api(other, "POST", `/oauth/consents/${id}/complete`, {}, s.vk)).status).toBe(404);
    const noKey = await api(s.owner, "POST", `/oauth/consents/${id}/complete`, {});
    expect(noKey.status).toBe(409);
    expect((await api(s.owner, "POST", `/oauth/consents/${id}/complete`, {}, randomBytes(32))).status).toBe(409);
    expect(await (await api(s.owner, "GET", `/oauth/consents/${id}`)).json()).toMatchObject({
      app: "Claude",
      organizationId: s.orgId,
      vaultIds: [s.vaultId],
      approved: false,
    });

    // The desktop finishes it; the page's poll sees it.
    expect((await api(s.owner, "POST", `/oauth/consents/${id}/complete`, {}, s.vk)).status).toBe(200);
    const status = await app.request(`/oauth/consent/status?id=${encodeURIComponent(id)}`, { headers: authHeaders(s.owner) });
    expect(await status.json()).toEqual({ approved: true });

    // Re-submitting Allow now proceeds (binding written; Better Auth then
    // rejects our fake consent_code, which is fine for this test).
    await app.request("/oauth/consent", {
      method: "POST",
      headers: { authorization: `Bearer ${s.owner.token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_code: "cc", client_id: CLIENT, organization_id: s.orgId, decision: "allow" }).toString(),
    });
    expect((await pool.query("SELECT 1 FROM mcp_oauth_vault")).rowCount).toBe(1);

    // The code exchange: Better Auth writes the row, our hook wraps the key.
    const access = "FreshAccessTokenFromCodeExchange";
    const refreshToken = "FreshRefreshTokenFromCodeExchang";
    await pool.query(
      `INSERT INTO "oauthAccessToken" (id, "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "clientId", "userId", scopes)
       VALUES ('g2', $1, $2, now() + interval '1 hour', now() + interval '7 days', $3, $4, 'openid offline_access')`,
      [access, refreshToken, CLIENT, s.owner.userId],
    );
    const { rewrapOnIssue } = await import("../src/mcp/oauth-grant-keys.js");
    await rewrapOnIssue({ grantId: "g2", accessToken: access, refreshToken });
    expect((await pool.query("SELECT consumed_at IS NOT NULL AS c FROM oauth_consents WHERE id = $1", [id])).rows[0].c).toBe(true);

    noDesktops();
    expect((await tool(access, "update_note", { docId: s.docId, content: "hello" })).isError).toBe(false);
    const r = await refresh(refreshToken);
    expect(r.status).toBe(200);
    expect((await tool(r.body.access_token!, "read_note", { docId: s.docId })).data.content).toBe("hello");
  });

  it("a grant inserted into the database never gets a key", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    const s = await setup();
    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk);
    // No allow-list MAC (or a forged one): refresh and use store nothing.
    await pool.query(
      "INSERT INTO oauth_grant_allow (grant_id, vault_id, mac) VALUES ('g1', $1, $2)",
      [s.vaultId, randomBytes(32)],
    );
    await tool(s.access, "read_note", { docId: s.docId });
    expect((await refresh(s.refreshToken)).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM oauth_grant_keys")).rowCount).toBe(0);
  });
});
