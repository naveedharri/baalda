// SPDX-License-Identifier: Apache-2.0
//
// W3: MCP tokens and public links in keyed vaults behave exactly as today and
// work with ZERO desktops online (no key in the process cache). Conversion of
// an existing vault waits until every active token/link has its own wrap.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { lockGateRows, pendingKeyCache } from "../src/crypto/conversion.js";
import { allowMac } from "../src/crypto/token-wrap.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import { resetMcpBadTokens } from "../src/http/routes/mcp.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedBlob, seedBlobText, seedNote, markEncryptionRequested, seedVault } from "./helpers/seed.js";
import { sealBlobTextRow } from "../src/index/sealed-index.js";

const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const app = createApp(testAppDeps({ docWriter: createDocWriter(server) }));
const b64 = (b: Buffer) => b.toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function api(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer | string) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      ...authHeaders(user),
      ...(vk ? { "x-baalda-vk": typeof vk === "string" ? vk : b64(vk) } : {}),
    },
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
  const body = (await res.json()) as {
    result?: { isError?: boolean; structuredContent?: any; content?: Array<{ text: string }> };
  };
  return { isError: body.result?.isError ?? false, data: body.result?.structuredContent, text: body.result?.content?.[0]?.text ?? "" };
}

/** Zero desktops online: nothing in either in-memory key cache. */
function noDesktops() {
  vaultKeyCache.clear();
  pendingKeyCache.clear();
}

async function setup() {
  const owner = await signUp(`owner-${randomBytes(4).toString("hex")}@mk.test`);
  const org = await createOrg(owner, "MK", `mk-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const vaultId = await seedVault(org.id);
  // These tests exercise conversion: an owner opted the vault in.
  await markEncryptionRequested(vaultId, owner.userId);
  const docId = await seedNote(vaultId, null, "a.md", owner.userId);
  const vk = randomBytes(32);
  const vkCheck = makeVkCheck(vk, vaultId);
  return { owner, orgId: org.id, vaultId, docId, vk, vkCheck };
}
type S = Awaited<ReturnType<typeof setup>>;

const init = (s: S, check = s.vkCheck) =>
  api(s.owner, "POST", `/vaults/${s.vaultId}/keys/init`, {
    vkCheck: b64(check),
    generation: 1,
    sealedVkForSelf: b64(randomBytes(80)),
  });

async function sealedRows(docId: string) {
  const { rows } = await pool.query<{ plain: string; sealed: string }>(
    `SELECT count(*) FILTER (WHERE update IS NOT NULL) AS plain,
            count(*) FILTER (WHERE update_enc IS NOT NULL) AS sealed
       FROM doc_updates WHERE doc_id = $1`,
    [docId],
  );
  return { plain: Number(rows[0].plain), sealed: Number(rows[0].sealed) };
}

async function mintLink(s: S, vk?: Buffer) {
  const res = await api(s.owner, "POST", `/notes/${s.docId}/public-link`, undefined, vk);
  return { status: res.status, body: (await res.json()) as { token?: string; url?: string; code?: string } };
}

const view = (token: string) => app.request(`/p/${token}`);

describe("MCP tokens and public links with vault keys", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    resetMcpBadTokens();
    noDesktops();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("a token minted with the key works in a keyed vault with zero desktops online", async () => {
    const s = await setup();
    expect((await init(s)).status).toBe(201);

    // Minting without the key is refused and mints nothing.
    const refused = await api(s.owner, "POST", "/mcp/tokens", { name: "x" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("key_required");
    expect((await pool.query("SELECT 1 FROM mcp_tokens")).rowCount).toBe(0);

    const minted = await api(s.owner, "POST", "/mcp/tokens", { name: "Claude" }, s.vk);
    expect(minted.status).toBe(201);
    const { token, id } = (await minted.json()) as { token: string; id: string };
    noDesktops();

    const upd = await tool(token, "update_note", { docId: s.docId, content: "secret plan" });
    expect(upd.isError).toBe(false);
    expect(await sealedRows(s.docId)).toEqual({ plain: 0, sealed: 1 });
    const read = await tool(token, "read_note", { docId: s.docId });
    expect(read.isError).toBe(false);
    expect(read.data.content).toBe("secret plan");
    const app2 = await tool(token, "append_note", { docId: s.docId, text: " v2" });
    expect(app2.isError).toBe(false);
    expect((await tool(token, "read_note", { docId: s.docId })).data.content).toBe("secret plan v2");

    // Search finds the MCP write (indexed with the call's key, sealed) and a
    // sealed file text reads back — still with no desktop online.
    const { rows: idx } = await pool.query("SELECT search_enc IS NOT NULL AS sealed FROM note_index WHERE doc_id = $1", [s.docId]);
    expect(idx).toEqual([{ sealed: true }]);
    const found = await tool(token, "search_notes", { vaultId: s.vaultId, query: "secret plan" });
    expect(found.isError, found.text).toBe(false);
    expect(JSON.stringify(found.data)).toContain(s.docId);
    const blobId = await seedBlob(s.vaultId, s.orgId, "docs/q.txt", { mime: "text/plain" });
    await seedBlobText(blobId, s.vaultId, null, "");
    const crypto = { vaultId: s.vaultId, key: s.vk, generation: 1 };
    await pool.query("UPDATE blob_text SET search_enc = $2 WHERE blob_id = $1", [
      blobId,
      sealBlobTextRow(crypto, blobId, { body: "quarterly numbers", vector: [], tokens: "quarterly numbers" }),
    ]);
    // The note embeds the file, which is what lets a scoped reader see it.
    expect((await tool(token, "append_note", { docId: s.docId, text: "\n![[docs/q.txt]]" })).isError).toBe(false);
    const text = await tool(token, "read_attachment_text", { vaultId: s.vaultId, blobId });
    expect(text.isError, text.text).toBe(false);
    expect(text.data.text).toBe("quarterly numbers");

    // Only the hash and the wrap are stored; neither is the key or the token.
    const { rows } = await pool.query<{ wrapped_vk: Buffer }>("SELECT wrapped_vk FROM mcp_token_keys WHERE token_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].wrapped_vk.includes(s.vk)).toBe(false);
    expect(vaultKeyCache.has(s.vaultId)).toBe(false);
  });

  it("a token row inserted without the key never gets one; an edit on the unreadable note writes nothing", async () => {
    const s = await setup();
    expect((await init(s)).status).toBe(201);
    const good = (await (await api(s.owner, "POST", "/mcp/tokens", { name: "ok" }, s.vk)).json()).token as string;
    expect((await tool(good, "update_note", { docId: s.docId, content: "keep me" })).isError).toBe(false);

    // A token an admin inserts straight into the DB, with a forged allow row —
    // even while a member's key is held in memory.
    const { token: forged, row } = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "db");
    await pool.query("INSERT INTO mcp_token_allow (token_id, vault_id, mac) VALUES ($1, $2, $3)", [row.id, s.vaultId, randomBytes(32)]);
    const release = vaultKeyCache.acquire(s.vaultId, s.vk, 1);
    try {
      const before = await sealedRows(s.docId);
      const read = await tool(forged, "read_note", { docId: s.docId });
      expect(read.isError).toBe(true);
      expect(read.data.code).toBe("key_required");
      for (const [name, args] of [
        ["update_note", { docId: s.docId, content: "overwritten" }],
        ["append_note", { docId: s.docId, text: "x" }],
        ["edit_note", { docId: s.docId, edits: [{ type: "replace", find: "keep", replace: "lose" }] }],
        ["create_note", { vaultId: s.vaultId, relPath: "b.md", content: "x" }],
      ] as const) {
        const r = await tool(forged, name, args as Record<string, unknown>);
        expect(r.isError, name).toBe(true);
        expect(r.data.code, name).toBe("key_required");
      }
      expect(await sealedRows(s.docId)).toEqual(before);
      expect((await pool.query("SELECT 1 FROM notes WHERE rel_path = 'b.md'")).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM mcp_token_keys WHERE token_id = $1", [row.id])).rowCount).toBe(0);
    } finally {
      release();
    }
    expect((await tool(good, "read_note", { docId: s.docId })).data.content).toBe("keep me");
  });

  it("a pre-existing token is allow-listed, upgraded while pending, and works after conversion with no cache", async () => {
    const s = await setup();
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });
    }
    // Today: an unkeyed vault with an active token and content.
    const { token, row } = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "old");
    expect((await tool(token, "update_note", { docId: s.docId, content: "before" })).isError).toBe(false);
    await pool.query("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]);

    // Pending: the vault stays plaintext and MCP is unchanged.
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 })).status).toBe(409);
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1, deviceId: "d1" }, s.vk)).status).toBe(200);
    // Idempotent for identical bytes; another check is refused.
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk)).status).toBe(200);
    expect((await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(makeVkCheck(s.vk, s.vaultId)), generation: 1 }, s.vk)).status).toBe(409);
    expect((await tool(token, "read_note", { docId: s.docId })).data.content).toBe("before");

    const ready0 = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`)).json();
    expect(ready0).toMatchObject({ pending: true, ready: false, blockers: { tokens: 1 } });
    const blocked = await init(s);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).code).toBe("conversion_not_ready");

    // The desktop vouches for the token with a MAC under VK.
    expect((await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`)).status).toBe(409);
    const cand = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json();
    expect(cand).toEqual([{ kind: "mcp_token", id: row.id, hash: sha(token) }]);
    const entry = cand[0] as { id: string; hash: string };
    const posted = await (
      await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, {
        entries: [
          { kind: "mcp_token", id: entry.id, mac: b64(allowMac(s.vk, entry.id, entry.hash)) },
          { kind: "mcp_token", id: entry.id + "x", mac: b64(randomBytes(32)) },
        ],
      }, s.vk)
    ).json();
    expect(posted).toEqual({ accepted: 1, rejected: [entry.id + "x"] });

    // Next call upgrades (the pending key is warm from the desktop's requests).
    expect((await tool(token, "list_vaults")).isError).toBe(false);
    expect((await pool.query("SELECT 1 FROM mcp_token_keys WHERE token_id = $1", [row.id])).rowCount).toBe(1);
    const ready1 = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`)).json();
    expect(ready1).toMatchObject({ ready: true });

    // Init must use the pending check bytes.
    const other = await init(s, makeVkCheck(s.vk, s.vaultId));
    expect(other.status).toBe(409);
    expect((await other.json()).code).toBe("pending_mismatch");
    expect((await init(s)).status).toBe(201);
    expect((await pool.query("SELECT 1 FROM vault_pending_keys")).rowCount).toBe(0);

    noDesktops();
    expect((await tool(token, "read_note", { docId: s.docId })).data.content).toBe("before");
    expect((await tool(token, "update_note", { docId: s.docId, content: "after" })).isError).toBe(false);
    expect((await sealedRows(s.docId)).sealed).toBe(1);
    expect((await tool(token, "read_note", { docId: s.docId })).data.content).toBe("after");

    const all = logged.join("\n");
    for (const secret of [token, b64(s.vk), s.vk.toString("base64url"), s.vk.toString("hex")]) {
      expect(all.includes(secret)).toBe(false);
    }
  });

  it("the init gate's rows are locked in its transaction: a token use waits for the init to commit", async () => {
    const s = await setup();
    const { row } = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "racer");
    const initTx = await pool.connect();
    const other = await pool.connect();
    try {
      await initTx.query("BEGIN");
      await initTx.query("SELECT vk_check FROM vaults WHERE id = $1 FOR UPDATE", [s.vaultId]);
      await lockGateRows(initTx, s.vaultId);
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '200ms'");
      await expect(
        other.query("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]),
      ).rejects.toMatchObject({ code: "55P03" });
      await other.query("ROLLBACK");
    } finally {
      await initTx.query("ROLLBACK");
      initTx.release();
      other.release();
    }
    // Once the token has been used, the gate (now in-transaction) refuses.
    await pool.query("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
    const res = await init(s);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("conversion_not_ready");
    expect((await pool.query("SELECT vk_check FROM vaults WHERE id = $1", [s.vaultId])).rows[0].vk_check).toBeNull();
  });

  it("an idle (30+ days) token does not hold up conversion; a fresh vault converts at once", async () => {
    const s = await setup();
    const { row } = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "idle");
    await pool.query("UPDATE mcp_tokens SET last_used_at = now() - interval '31 days' WHERE id = $1", [row.id]);
    const r = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`)).json();
    expect(r).toMatchObject({ keyed: false, pending: false, ready: true });
    expect((await init(s)).status).toBe(201);
  });

  it("a public link in a keyed vault works with zero desktops; members re-read the URL with the key", async () => {
    const s = await setup();
    expect((await init(s)).status).toBe(201);
    const t = (await (await api(s.owner, "POST", "/mcp/tokens", { name: "w" }, s.vk)).json()).token as string;
    expect((await tool(t, "update_note", { docId: s.docId, content: "hello public" })).isError).toBe(false);

    expect((await mintLink(s)).status).toBe(409);
    const minted = await mintLink(s, s.vk);
    expect(minted.status).toBe(201);
    const token = minted.body.token as string;
    const { rows } = await pool.query("SELECT token, token_hash FROM public_links WHERE doc_id = $1", [s.docId]);
    expect(rows[0]).toEqual({ token: null, token_hash: sha(token) });

    noDesktops();
    const page = await view(token);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("hello public");

    expect((await api(s.owner, "GET", `/notes/${s.docId}/public-link`)).status).toBe(409);
    const again = await (await api(s.owner, "GET", `/notes/${s.docId}/public-link`, undefined, s.vk)).json();
    expect(again.link.token).toBe(token);
    expect((await mintLink(s, s.vk)).body.token).toBe(token);
  });

  it("an existing link is allow-listed, upgraded on view while pending, and keeps working after conversion", async () => {
    const s = await setup();
    const { token: mcp } = await createMcpToken({ userId: s.owner.userId, organizationId: s.orgId }, "m");
    expect((await tool(mcp, "update_note", { docId: s.docId, content: "old link text" })).isError).toBe(false);
    const link = (await mintLink(s)).body.token as string;
    expect((await view(link)).status).toBe(200);

    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk);
    const r0 = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`)).json();
    expect(r0.blockers.links).toBe(1);

    const cand = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json();
    const list = cand as Array<{ kind: string; id: string; hash: string }>;
    expect(list.find((x) => x.kind === "public_link")?.hash).toBe(sha(link));
    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, {
      entries: list.map((x) => ({ kind: x.kind, id: x.id, mac: b64(allowMac(s.vk, x.id, x.hash)) })),
    }, s.vk);
    // Views and calls upgrade them (the pending key is warm).
    expect((await view(link)).status).toBe(200);
    await tool(mcp, "list_vaults");
    const r1 = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`)).json();
    expect(r1).toMatchObject({ ready: true });
    expect((await init(s)).status).toBe(201);

    noDesktops();
    expect((await tool(mcp, "update_note", { docId: s.docId, content: "sealed now" })).isError).toBe(false);
    expect((await sealedRows(s.docId)).sealed).toBe(1);
    const page = await view(link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("sealed now");
  });

  it("an un-upgraded link in a keyed vault is a miss, never an empty page", async () => {
    const s = await setup();
    const link = (await mintLink(s)).body.token as string;
    expect((await init(s)).status).toBe(201); // never viewed: does not block
    const t = (await (await api(s.owner, "POST", "/mcp/tokens", { name: "w" }, s.vk)).json()).token as string;
    expect((await tool(t, "update_note", { docId: s.docId, content: "x" })).isError).toBe(false);
    noDesktops();
    expect((await view(link)).status).toBe(404);
  });

  it("the MAC is HMAC-SHA256(VK, utf8(id) || utf8(hash)) with no separator", () => {
    const vk = randomBytes(32);
    const want = createHmac("sha256", vk).update(Buffer.from("tok-1" + sha("x"), "utf8")).digest();
    expect(allowMac(vk, "tok-1", sha("x")).equals(want)).toBe(true);
  });

  it("an active OAuth grant is a candidate and keeps the vault pending until slice 2", async () => {
    const s = await setup();
    await pool.query(
      `INSERT INTO "oauthApplication" (id, name, "clientId", "redirectUrls", type) VALUES ('app1', 'Claude', 'client1', 'https://x', 'public')`,
    );
    await pool.query(
      `INSERT INTO "oauthAccessToken" (id, "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "clientId", "userId", scopes)
       VALUES ('g1', 'acc', 'ref-secret', now() + interval '1 hour', now() + interval '30 days', 'client1', $1, 'openid')`,
      [s.owner.userId],
    );
    await pool.query(
      "INSERT INTO mcp_oauth_vault (client_id, user_id, organization_id) VALUES ('client1', $1, $2)",
      [s.owner.userId, s.orgId],
    );
    await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck: b64(s.vkCheck), generation: 1 }, s.vk);
    const cand = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/allowlist-candidates`, undefined, s.vk)).json();
    expect(cand).toEqual([{ kind: "oauth_grant", id: "g1", hash: sha("ref-secret") }]);
    const posted = await (
      await api(s.owner, "POST", `/vaults/${s.vaultId}/keys/allowlist`, {
        entries: [{ kind: "oauth_grant", id: "g1", mac: b64(allowMac(s.vk, "g1", sha("ref-secret"))) }],
      }, s.vk)
    ).json();
    expect(posted.accepted).toBe(1);
    const ready = await (await api(s.owner, "GET", `/vaults/${s.vaultId}/keys/conversion-ready`, undefined, s.vk)).json();
    expect(ready).toMatchObject({ ready: false, blockers: { oauthGrants: 1 } });
    expect((await init(s)).status).toBe(409);
  });

  it("the conversion routes are not there with the flag off", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    const s = await setup();
    for (const p of ["pending", "allowlist-candidates", "allowlist", "conversion-ready"]) {
      const method = p === "pending" || p === "allowlist" ? "POST" : "GET";
      const body = method === "POST" ? {} : undefined;
      expect((await api(s.owner, method, `/vaults/${s.vaultId}/keys/${p}`, body, s.vk)).status, p).toBe(404);
    }
  });

  it("unkeyed vaults are exactly today, flag on or off", async () => {
    for (const flag of ["on", "off"]) {
      vi.stubEnv("BAALDA_VAULT_KEYS", flag);
      await resetDb();
      const s = await setup();
      const minted = await api(s.owner, "POST", "/mcp/tokens", { name: "plain" });
      expect(minted.status, flag).toBe(201);
      const token = (await minted.json()).token as string;
      expect((await tool(token, "update_note", { docId: s.docId, content: "plain" })).isError).toBe(false);
      expect(await sealedRows(s.docId)).toEqual({ plain: 1, sealed: 0 });
      expect((await tool(token, "read_note", { docId: s.docId })).data.content).toBe("plain");
      const link = await mintLink(s);
      expect(link.status, flag).toBe(201);
      const { rows } = await pool.query("SELECT token FROM public_links WHERE doc_id = $1", [s.docId]);
      expect(rows[0].token).toBe(link.body.token);
      expect(await (await view(link.body.token as string)).text()).toContain("plain");
      expect((await pool.query("SELECT 1 FROM mcp_token_keys")).rowCount).toBe(0);
    }
  });
});
