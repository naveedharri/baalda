// SPDX-License-Identifier: Apache-2.0
//
// A verified key presented by a WRITE request warms the process key cache for
// background work, like a vault channel connection: a keyed vault edited only
// over HTTP/MCP (no desktop channel) still gets its index, links and idle
// versions. One-way: requests never read the cache. Read-only public-link views
// never warm it.
import { randomBytes } from "node:crypto";
import type { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { REQUEST_KEY_HOLD_MS, VaultKeyCache, vaultKeyCache } from "../src/crypto/key-cache.js";
import { pendingKeyCache } from "../src/crypto/conversion.js";
import { startCryptoBackfill, stopCryptoBackfill } from "../src/crypto/backfill.js";
import { createVersionCapture } from "../src/versions/capture.js";
import { openSearchRow } from "../src/index/sealed-index.js";
import { resetMcpBadTokens } from "../src/http/routes/mcp.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { CLIENT_VERSION_HEADER, VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { markEncryptionRequested, seedNote, seedVault } from "./helpers/seed.js";

const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const docWriter = createDocWriter(server);
const app = createApp(testAppDeps({ docWriter }));
const b64 = (b: Buffer) => b.toString("base64");

/** A vault-key capable desktop unless `old` (no version reported). */
function api(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer, old = false) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      ...authHeaders(user),
      ...(old ? {} : { [CLIENT_VERSION_HEADER]: VAULT_KEYS_MIN_DESKTOP }),
      ...(vk ? { "x-baalda-vk": b64(vk) } : {}),
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
  const body = (await res.json()) as { result?: { isError?: boolean; structuredContent?: any; content?: Array<{ text: string }> } };
  return { isError: body.result?.isError ?? false, data: body.result?.structuredContent, text: body.result?.content?.[0]?.text ?? "" };
}

function noDesktops() {
  vaultKeyCache.clear();
  pendingKeyCache.clear();
}

async function setup() {
  const owner = await signUp(`owner-${randomBytes(4).toString("hex")}@hold.test`);
  const org = await createOrg(owner, "Hold", `hold-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const vaultId = await seedVault(org.id);
  await markEncryptionRequested(vaultId, owner.userId);
  const docId = await seedNote(vaultId, null, "plan.md", owner.userId);
  const vk = randomBytes(32);
  return { owner, vaultId, docId, vk, vkCheck: makeVkCheck(vk, vaultId) };
}
type S = Awaited<ReturnType<typeof setup>>;

const init = (s: S, vk?: Buffer) =>
  api(
    s.owner,
    "POST",
    `/vaults/${s.vaultId}/keys/init`,
    { vkCheck: b64(s.vkCheck), generation: 1, sealedVkForSelf: b64(randomBytes(80)) },
    vk,
  );

async function until(cond: () => Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("VaultKeyCache.holdForRequest", () => {
  it("keeps the key for the hold, extends on use, then expires", () => {
    let t = 1_000;
    const cache = new VaultKeyCache({ now: () => t, graceMs: 60_000 });
    const key = randomBytes(32);
    const heard: string[] = [];
    cache.onAcquire((v) => heard.push(v));
    cache.holdForRequest("v", key, 1, 900_000);
    expect(cache.has("v")).toBe(true);
    t += 600_000;
    cache.holdForRequest("v", key, 1, 900_000); // a later write extends it
    t += 600_000;
    expect(cache.has("v")).toBe(true);
    t += 300_001;
    expect(cache.has("v")).toBe(false);
    expect(REQUEST_KEY_HOLD_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("a channel release never cuts a request hold short, and a hold outlives the grace", () => {
    let t = 0;
    const cache = new VaultKeyCache({ now: () => t, graceMs: 60_000 });
    const key = randomBytes(32);
    const release = cache.acquire("v", key, 1);
    cache.holdForRequest("v", key, 1, 900_000);
    release();
    t = 120_000; // past the channel grace, inside the request hold
    expect(cache.has("v")).toBe(true);
    t = 900_001;
    expect(cache.has("v")).toBe(false);
  });

  it("ignores a key that disagrees with the cached one for its generation", () => {
    const cache = new VaultKeyCache();
    const key = randomBytes(32);
    cache.acquire("v", key, 1);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    cache.holdForRequest("v", randomBytes(32), 1);
    err.mockRestore();
    const got = cache.get("v")!;
    expect(got.key.equals(key)).toBe(true);
  });
});

describe("request keys warm the cache (no vault channel)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    resetMcpBadTokens();
    noDesktops();
  });
  afterEach(() => {
    stopCryptoBackfill();
    noDesktops();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("MCP-only edits: searchable, links present, idle version captured", async () => {
    const s = await setup();
    expect((await init(s)).status).toBe(201);
    const minted = await api(s.owner, "POST", "/mcp/tokens", { name: "Agent" }, s.vk);
    const { token } = (await minted.json()) as { token: string };
    noDesktops(); // zero desktops online from here on

    const upd = await tool(token, "update_note", { docId: s.docId, content: "narwhal budget, see [[Roadmap]]" });
    expect(upd.isError, upd.text).toBe(false);
    expect(vaultKeyCache.has(s.vaultId)).toBe(true);

    const c = { vaultId: s.vaultId, key: s.vk, generation: 1 };
    const { rows } = await pool.query("SELECT search_enc FROM note_index WHERE doc_id = $1", [s.docId]);
    expect(openSearchRow(c, s.docId, rows[0].search_enc).body).toContain("narwhal");
    const links = await pool.query("SELECT to_title FROM note_links WHERE from_doc = $1", [s.docId]);
    expect(links.rows).toEqual([{ to_title: "Roadmap" }]);
    const found = await tool(token, "search_notes", { vaultId: s.vaultId, query: "narwhal" });
    expect(JSON.stringify(found.data)).toContain(s.docId);

    // The idle capture fires later, from the cache (the MCP call is long gone).
    const capture = createVersionCapture({ docWriter, idleMs: 60_000 });
    try {
      capture.touch(s.vaultId, s.docId, s.owner.userId);
      await capture.flush(s.docId);
      await capture.settled();
    } finally {
      capture.stop();
    }
    const v = await pool.query(
      `SELECT t.content, t.content_enc FROM note_versions v
         JOIN note_texts t ON t.doc_id = v.doc_id AND t.sha256 = v.sha256 WHERE v.doc_id = $1`,
      [s.docId],
    );
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].content_enc).not.toBeNull();
  });

  it("X-Baalda-VK warms the cache only once verified", async () => {
    const s = await setup();
    expect((await init(s)).status).toBe(201);
    noDesktops();
    const wrong = await api(s.owner, "GET", `/vaults/${s.vaultId}/search?q=x`, undefined, randomBytes(32));
    expect(wrong.status).toBe(409);
    expect(vaultKeyCache.has(s.vaultId)).toBe(false);
    // An old build (no version) with a wrong key is told to update instead.
    const old = await api(s.owner, "GET", `/vaults/${s.vaultId}/search?q=x`, undefined, randomBytes(32), true);
    expect(old.status).toBe(426);
    expect(vaultKeyCache.has(s.vaultId)).toBe(false);
    const right = await api(s.owner, "GET", `/vaults/${s.vaultId}/search?q=x`, undefined, s.vk);
    expect(right.status).toBe(200);
    expect(vaultKeyCache.has(s.vaultId)).toBe(true);
  });

  it("keys/init with the key drains notes deferred around the conversion", async () => {
    const s = await setup();
    startCryptoBackfill();
    // Deferred while the key lived only in the pending cache.
    await pool.query("INSERT INTO index_pending (doc_id, vault_id) VALUES ($1, $2)", [s.docId, s.vaultId]);
    expect((await init(s, s.vk)).status).toBe(201);
    expect(vaultKeyCache.has(s.vaultId)).toBe(true);
    await until(async () => (await pool.query("SELECT 1 FROM index_pending WHERE vault_id = $1", [s.vaultId])).rowCount === 0);
    const { rows } = await pool.query("SELECT search_enc IS NOT NULL AS sealed FROM note_index WHERE doc_id = $1", [s.docId]);
    expect(rows).toEqual([{ sealed: true }]);
  });

  it("a read-only public-link view does not keep the vault keyed", async () => {
    const s = await setup();
    expect((await init(s)).status).toBe(201);
    const res = await api(s.owner, "POST", `/notes/${s.docId}/public-link`, undefined, s.vk);
    const { token } = (await res.json()) as { token: string };
    noDesktops();
    expect((await app.request(`/p/${token}`)).status).toBe(200);
    expect(vaultKeyCache.has(s.vaultId)).toBe(false);
  });
});
