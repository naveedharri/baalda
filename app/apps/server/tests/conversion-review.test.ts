// SPDX-License-Identifier: Apache-2.0
//
// W3 residual: the owner's review at conversion. Owners/admins see what each
// allow-list candidate is (name, creator, created/last used); an unchecked one
// is excluded: never allow-listed, never holds the vault pending, and needs
// reconnecting after conversion. Nothing is revoked.
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
import { createMcpToken } from "../src/mcp/tokens.js";
import { resetMcpBadTokens } from "../src/http/routes/mcp.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { markEncryptionRequested, seedMember, seedNote, seedVault } from "./helpers/seed.js";

const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const app = createApp(testAppDeps({ docWriter: createDocWriter(server) }));
const b64 = (b: Buffer) => b.toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

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
  const body = (await res.json()) as { result?: { isError?: boolean; structuredContent?: any } };
  return { isError: body.result?.isError ?? false, data: body.result?.structuredContent };
}

async function setup() {
  const owner = await signUp(`owner-${randomBytes(4).toString("hex")}@cr.test`);
  const org = await createOrg(owner, "CR", `cr-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const vaultId = await seedVault(org.id);
  await markEncryptionRequested(vaultId, owner.userId);
  const docId = await seedNote(vaultId, null, "a.md", owner.userId);
  const vk = randomBytes(32);
  const vkCheck = makeVkCheck(vk, vaultId);
  const member = await signUp(`member-${randomBytes(4).toString("hex")}@cr.test`);
  await seedMember(org.id, member.userId, "member");
  // Pending: the converting owner device registered the future check.
  const pending = await api(owner, "POST", `/vaults/${vaultId}/keys/pending`, { vkCheck: b64(vkCheck), generation: 1, deviceId: "d1" }, vk);
  expect(pending.status).toBe(200);
  return { owner, member, orgId: org.id, vaultId, docId, vk, vkCheck };
}

describe("conversion review (owner unchecks connections)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    resetMcpBadTokens();
    vaultKeyCache.clear();
    pendingKeyCache.clear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("owners get name, creator and last use; plain members get only the bare contract", async () => {
    const s = await setup();
    const { token, row } = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "Claude Desktop");
    await pool.query("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]);

    const owned = (await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json()) as any[];
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      kind: "mcp_token",
      id: row.id,
      hash: sha(token),
      label: "Claude Desktop",
      allowed: false,
      excluded: false,
    });
    expect(typeof owned[0].createdBy).toBe("string");
    expect(owned[0].createdBy.length).toBeGreaterThan(0);
    expect(Date.parse(owned[0].createdAt)).not.toBeNaN();
    expect(Date.parse(owned[0].lastUsedAt)).not.toBeNaN();
    // Never a secret beyond the hash the contract already carries.
    expect(JSON.stringify(owned)).not.toContain(token);

    const bare = (await (await api(s.member, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json()) as any[];
    expect(bare).toEqual([{ kind: "mcp_token", id: row.id, hash: sha(token) }]);
  });

  it("an unchecked, recently used token no longer holds the vault pending, and needs reconnecting after", async () => {
    const s = await setup();
    const kept = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "kept");
    const dropped = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "dropped");
    await pool.query("UPDATE mcp_tokens SET last_used_at = now()");
    expect((await tool(dropped.token, "update_note", { docId: s.docId, content: "before" })).isError).toBe(false);

    const ready0 = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    expect(ready0).toMatchObject({ ready: false, blockers: { tokens: 2 } });

    // A plain member cannot exclude anything.
    const refused = await api(s.member, "POST", `/vaults/${s.vaultId}/keys/allowlist`, {
      excluded: [{ kind: "mcp_token", id: dropped.row.id }],
    }, s.vk);
    expect(refused.status).toBe(403);
    expect((await pool.query("SELECT 1 FROM vault_conversion_exclusions")).rowCount).toBe(0);

    // The owner keeps one and unchecks the other (an outsider id is rejected).
    const posted = await (
      await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, {
        entries: [{ kind: "mcp_token", id: kept.row.id, mac: b64(allowMac(s.vk, kept.row.id, sha(kept.token))) }],
        excluded: [{ kind: "mcp_token", id: dropped.row.id }, { kind: "mcp_token", id: "not-ours" }],
      }, s.vk)
    ).json();
    expect(posted).toEqual({ accepted: 1, rejected: ["not-ours"], excluded: 1 });

    // Nothing was revoked: the unchecked token still works while the vault is pending.
    expect((await tool(dropped.token, "read_note", { docId: s.docId })).data.content).toBe("before");
    expect((await pool.query("SELECT 1 FROM mcp_tokens WHERE id = $1", [dropped.row.id])).rowCount).toBe(1);
    // That call upgraded nothing for it (never allow-listed).
    expect((await pool.query("SELECT 1 FROM mcp_token_keys WHERE token_id = $1", [dropped.row.id])).rowCount).toBe(0);

    // The kept one upgrades on its next use; the gate now waits for nothing else.
    expect((await tool(kept.token, "list_vaults")).isError).toBe(false);
    const ready1 = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    expect(ready1).toMatchObject({ ready: true, blockers: { tokens: 0 } });

    const init = await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/init`, {
      vkCheck: b64(s.vkCheck),
      generation: 1,
      sealedVkForSelf: b64(randomBytes(80)),
    });
    expect(init.status).toBe(201);

    vaultKeyCache.clear();
    pendingKeyCache.clear();
    expect((await tool(kept.token, "read_note", { docId: s.docId })).data.content).toBe("before");
    // The unchecked one cannot reach the keyed content: it needs reconnecting.
    expect((await tool(dropped.token, "read_note", { docId: s.docId })).isError).toBe(true);
  });

  it("re-checking an excluded connection in a later review allow-lists it again", async () => {
    const s = await setup();
    const t = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "t");
    await pool.query("UPDATE mcp_tokens SET last_used_at = now()");
    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, { excluded: [{ kind: "mcp_token", id: t.row.id }] }, s.vk);
    let cand = (await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json()) as any[];
    expect(cand[0]).toMatchObject({ allowed: false, excluded: true });

    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, {
      entries: [{ kind: "mcp_token", id: t.row.id, mac: b64(allowMac(s.vk, t.row.id, sha(t.token))) }],
    }, s.vk);
    cand = (await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json()) as any[];
    expect(cand[0]).toMatchObject({ allowed: true, excluded: false });
    // Back to waiting for its wrap, as any allow-listed token does.
    const ready = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    expect(ready).toMatchObject({ ready: false, blockers: { tokens: 1 } });
  });

  it("an excluded public link stops holding the gate too, and keeps working while pending", async () => {
    const s = await setup();
    const minted = await api(s.owner, "POST", `/notes/${s.docId}/public-link`, undefined, s.vk);
    const { token } = (await minted.json()) as { token: string };
    expect((await app.request(`/p/${token}`)).status).toBe(200);
    const cand = (await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json()) as any[];
    const link = cand.find((c) => c.kind === "public_link");
    expect(link).toMatchObject({ label: "a.md" });
    const before = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    // A fresh link minted while pending may already carry its wrap: only assert the exclusion's effect.
    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, { excluded: [{ kind: "public_link", id: link.id }] }, s.vk);
    const after = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    expect(after.blockers.links).toBe(0);
    expect(after.blockers.links).toBeLessThanOrEqual(before.blockers.links);
    expect((await app.request(`/p/${token}`)).status).toBe(200);
  });
});
