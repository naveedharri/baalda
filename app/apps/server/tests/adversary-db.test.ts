// SPDX-License-Identifier: Apache-2.0
//
// W3 adversary suite: a malicious operator with full READ/WRITE access to the
// database but no vault key and no way to change server code. Each test keys a
// vault the normal way, performs the malicious DB write, drives the ordinary
// HTTP / MCP / public-link / persistence flows, and asserts the attack fails:
// no plaintext out, no key out, no re-key, no plaintext accepted into a sealed
// vault, no silent wrong content. Residuals are marked RESIDUAL.
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { pendingKeyCache } from "../src/crypto/conversion.js";
import { loadVkCheck } from "../src/crypto/transport.js";
import { hashToken } from "../src/mcp/tokens.js";
import { linkTokenHash } from "../src/crypto/link-keys.js";
import { resetMcpBadTokens } from "../src/http/routes/mcp.js";
import { compact, loadDocState } from "../src/yjs/persistence.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { markEncryptionRequested, seedNote, seedVault } from "./helpers/seed.js";

const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const app = createApp(testAppDeps({ docWriter: createDocWriter(server) }));
const SECRET = "board-minutes-do-not-leak";
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function updateWith(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}
function textOf(state: Uint8Array | null): string {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, state);
  const t = d.getText("content").toString();
  d.destroy();
  return t;
}

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
  const raw = await res.text();
  const body = JSON.parse(raw) as { result?: { isError?: boolean } };
  return { isError: body.result?.isError ?? true, raw };
}

/** Everything stored for the vault's content, plaintext or sealed, as one buffer. */
async function plaintextLeft(): Promise<boolean> {
  const { rows } = await pool.query<{ b: Buffer | null }>(
    `SELECT update AS b FROM doc_updates UNION ALL SELECT snapshot FROM doc_snapshots`,
  );
  return Buffer.concat(rows.map((r) => r.b).filter((b): b is Buffer => !!b)).includes(Buffer.from(SECRET));
}

/** A vault keyed the normal way, with one note whose content is sealed. */
async function keyedVault() {
  const owner = await signUp(`owner-${randomBytes(4).toString("hex")}@adv.test`);
  const org = await createOrg(owner, "Adv", `adv-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const vaultId = await seedVault(org.id);
  await markEncryptionRequested(vaultId, owner.userId);
  const docId = await seedNote(vaultId, null, "a.md", owner.userId);
  const docB = await seedNote(vaultId, null, "b.md", owner.userId);
  const vk = randomBytes(32);
  const init = await api(owner, "POST", `/vaults/${vaultId}/keys/init`, {
    vkCheck: b64(makeVkCheck(vk, vaultId)),
    generation: 1,
    sealedVkForSelf: b64(randomBytes(80)),
  });
  expect(init.status).toBe(201);
  for (const [id, text] of [
    [docId, SECRET],
    [docB, "other note"],
  ] as const) {
    const push = await api(owner, "POST", `/vaults/${vaultId}/docs/batch`, { items: [{ docId: id, update: b64(updateWith(text)) }] }, vk);
    expect(push.status).toBe(200);
  }
  expect(await plaintextLeft()).toBe(false);
  return { owner, orgId: org.id, vaultId, docId, docB, vk, crypto: { vaultId, key: vk, generation: 1 } };
}
type K = Awaited<ReturnType<typeof keyedVault>>;

const newInit = (k: K) => {
  const evil = randomBytes(32);
  return api(k.owner, "POST", `/vaults/${k.vaultId}/keys/init`, {
    vkCheck: b64(makeVkCheck(evil, k.vaultId)),
    generation: 1,
    sealedVkForSelf: b64(randomBytes(80)),
  });
};
const newPending = (k: K) => {
  const evil = randomBytes(32);
  return api(k.owner, "POST", `/vaults/${k.vaultId}/keys/pending`, {
    vkCheck: b64(makeVkCheck(evil, k.vaultId)),
    generation: 1,
    deviceId: "dev-x",
  }, evil);
};
const pushPlain = (k: K, text: string, docId = k.docId) =>
  api(k.owner, "POST", `/vaults/${k.vaultId}/docs/batch`, { items: [{ docId, update: b64(updateWith(text)) }] });

describe("database attacker without a vault key (W3)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("VAULT_KEY_CONVERSION", "on");
    await resetDb();
    resetMcpBadTokens();
    vaultKeyCache.clear();
    pendingKeyCache.clear();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("1a. vk_check wiped: still keyed everywhere; no plaintext write, no re-key", async () => {
    const k = await keyedVault();
    await pool.query("UPDATE vaults SET vk_check = NULL WHERE id = $1", [k.vaultId]);
    expect(await loadVkCheck(k.vaultId, pool)).not.toBeNull();

    const push = await pushPlain(k, "plaintext after wipe");
    expect(push.status).toBe(409);
    expect((await push.json()).code).toBe("key_required");
    // Even the real key no longer verifies (nothing to verify against): refuse.
    expect((await api(k.owner, "POST", `/vaults/${k.vaultId}/docs/batch`, { items: [{ docId: k.docId, update: b64(updateWith("x")) }] }, k.vk)).status).toBe(409);
    expect((await pool.query("SELECT 1 FROM doc_updates WHERE update IS NOT NULL")).rowCount).toBe(0);

    const reinit = await newInit(k);
    expect(reinit.status).toBe(409);
    expect((await reinit.json()).code).toBe("key_material_exists");
    expect((await newPending(k)).status).toBe(409);
    expect((await pool.query("SELECT vk_check FROM vaults WHERE id = $1", [k.vaultId])).rows[0].vk_check).toBeNull();
  });

  it("1b. vk_check AND every key row wiped (sealed rows remain): keys/init and keys/pending refuse", async () => {
    const k = await keyedVault();
    await pool.query("UPDATE vaults SET vk_check = NULL, key_generation = NULL WHERE id = $1", [k.vaultId]);
    await pool.query("DELETE FROM vault_key_wraps WHERE vault_id = $1", [k.vaultId]);
    await pool.query("DELETE FROM vault_key_wrap_history WHERE vault_id = $1", [k.vaultId]);
    await pool.query("DELETE FROM vault_crypto_state WHERE vault_id = $1", [k.vaultId]);

    const reinit = await newInit(k);
    expect(reinit.status).toBe(409);
    expect((await reinit.json()).code).toBe("key_material_exists");
    const pending = await newPending(k);
    expect(pending.status).toBe(409);
    expect((await pending.json()).code).toBe("key_material_exists");
    expect((await pool.query("SELECT 1 FROM vault_pending_keys")).rowCount).toBe(0);
    // Sealed rows never read as an empty doc without the key.
    await expect(loadDocState(k.docId, pool)).rejects.toThrow();
  });

  it("1c. RESIDUAL: with every key row wiped too, a key-less client's plaintext push is accepted", async () => {
    // The per-request check only consults the cheap key rows; a sealed-row
    // probe needs a partial index (migration) to be cheap enough per request.
    // Desktops holding the key refuse this state (session.ts key-mismatch),
    // so only a client WITHOUT the key (e.g. an MCP token) can write here.
    const k = await keyedVault();
    await pool.query("UPDATE vaults SET vk_check = NULL, key_generation = NULL WHERE id = $1", [k.vaultId]);
    await pool.query("DELETE FROM vault_key_wraps WHERE vault_id = $1", [k.vaultId]);
    await pool.query("DELETE FROM vault_crypto_state WHERE vault_id = $1", [k.vaultId]);
    const fresh = await seedNote(k.vaultId, null, "fresh.md", k.owner.userId);
    const push = await pushPlain(k, "written after the wipe", fresh);
    expect(push.status).toBe(200);
    expect((await pool.query("SELECT 1 FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL", [fresh])).rowCount).toBe(1);
    // Old sealed content still never leaks.
    expect(await plaintextLeft()).toBe(false);
  });

  it("8. sealed rows swapped between docs fail to open (no silent wrong content)", async () => {
    const k = await keyedVault();
    const a = (await pool.query("SELECT id, update_enc FROM doc_updates WHERE doc_id = $1", [k.docId])).rows[0];
    const b = (await pool.query("SELECT id, update_enc FROM doc_updates WHERE doc_id = $1", [k.docB])).rows[0];
    await pool.query("UPDATE doc_updates SET update_enc = $2 WHERE id = $1", [a.id, b.update_enc]);
    await expect(loadDocState(k.docId, pool, k.crypto)).rejects.toThrow();
    // Another column / vault: a sealed update dropped in as a snapshot fails too.
    await pool.query(
      "INSERT INTO doc_snapshots (doc_id, snapshot, snapshot_enc, state_vector) VALUES ($1, NULL, $2, '\\x00')",
      [k.docB, a.update_enc],
    );
    await expect(loadDocState(k.docB, pool, k.crypto)).rejects.toThrow();
  });

  it("5. a token row inserted with a known secret gets no content; a garbage allow MAC is refused", async () => {
    const k = await keyedVault();
    const token = `mcp_${randomBytes(24).toString("base64url")}`;
    const tokenId = randomUUID();
    await pool.query(
      `INSERT INTO mcp_tokens (id, user_id, organization_id, name, token_hash, token_prefix)
       VALUES ($1, $2, $3, 'forged', $4, 'mcp_…')`,
      [tokenId, k.owner.userId, k.orgId, hashToken(token)],
    );
    const read = await tool(token, "read_note", { docId: k.docId });
    expect(read.isError).toBe(true);
    expect(read.raw).not.toContain(SECRET);

    // A desktop is online (key in the process cache) and the attacker
    // allow-lists the forged token with a MAC they had to guess.
    const release = vaultKeyCache.acquire(k.vaultId, Buffer.from(k.vk), 1);
    try {
      await pool.query("INSERT INTO mcp_token_allow (token_id, vault_id, mac) VALUES ($1, $2, $3)", [
        tokenId,
        k.vaultId,
        randomBytes(32),
      ]);
      const again = await tool(token, "read_note", { docId: k.docId });
      expect(again.isError).toBe(true);
      expect(again.raw).not.toContain(SECRET);
      expect((await pool.query("SELECT 1 FROM mcp_token_keys WHERE token_id = $1", [tokenId])).rowCount).toBe(0);
      // Writes are refused too (no plaintext lands in the sealed vault).
      expect((await tool(token, "append_note", { docId: k.docId, text: "evil" })).isError).toBe(true);
      expect((await tool(token, "create_note", { vaultId: k.vaultId, path: "evil.md", content: "evil" })).isError).toBe(true);
      expect((await pool.query("SELECT 1 FROM doc_updates WHERE update IS NOT NULL")).rowCount).toBe(0);
    } finally {
      release();
    }
  });

  it("7. a real token's wrap copied onto a forged token (or another vault) does not open", async () => {
    const k = await keyedVault();
    const minted = await api(k.owner, "POST", "/mcp/tokens", { name: "real" }, k.vk);
    expect(minted.status).toBe(201);
    const { id: realId } = (await minted.json()) as { id: string };
    const wrap = (await pool.query("SELECT vault_id, generation, wrapped_vk FROM mcp_token_keys WHERE token_id = $1", [realId])).rows[0];
    expect(wrap).toBeTruthy();

    const token = `mcp_${randomBytes(24).toString("base64url")}`;
    const tokenId = randomUUID();
    await pool.query(
      `INSERT INTO mcp_tokens (id, user_id, organization_id, name, token_hash, token_prefix)
       VALUES ($1, $2, $3, 'forged', $4, 'mcp_…')`,
      [tokenId, k.owner.userId, k.orgId, hashToken(token)],
    );
    await pool.query(
      "INSERT INTO mcp_token_keys (token_id, vault_id, generation, wrapped_vk) VALUES ($1, $2, $3, $4)",
      [tokenId, wrap.vault_id, wrap.generation, wrap.wrapped_vk],
    );
    const read = await tool(token, "read_note", { docId: k.docId });
    expect(read.isError).toBe(true);
    expect(read.raw).not.toContain(SECRET);
  });

  it("6. a public link row inserted with a known token (and a guessed allow MAC) shows nothing", async () => {
    const k = await keyedVault();
    const token = randomBytes(24).toString("base64url");
    const release = vaultKeyCache.acquire(k.vaultId, Buffer.from(k.vk), 1);
    try {
      await pool.query(
        `INSERT INTO public_links (id, doc_id, vault_id, org_id, token, token_hash, created_by, allow_mac)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), k.docId, k.vaultId, k.orgId, token, linkTokenHash(token), k.owner.userId, randomBytes(32)],
      );
      const res = await app.request(`/p/${token}`);
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain(SECRET);
      expect((await pool.query("SELECT wrapped_vk FROM public_links")).rows[0].wrapped_vk).toBeNull();
    } finally {
      release();
    }
  });

  it("10. a session row forged in the database reads and writes nothing without the key", async () => {
    const k = await keyedVault();
    const forgedToken = randomBytes(24).toString("base64url");
    await pool.query(
      `INSERT INTO session (id, token, "userId", "expiresAt", "updatedAt") VALUES ($1, $2, $3, now() + interval '1 day', now())`,
      [randomUUID(), forgedToken, k.owner.userId],
    );
    const forged: TestUser = { userId: k.owner.userId, email: k.owner.email, token: forgedToken };
    // The forged session itself is accepted (sessions are plaintext in the DB)...
    expect((await api(forged, "GET", `/vaults/${k.vaultId}/keys/mine`)).status).toBe(200);
    // ...but content needs the key: no read, no plaintext write.
    expect((await app.request(`/api/vaults/${k.vaultId}/bootstrap/x`, { headers: authHeaders(forged) })).status).toBe(409);
    const push = await pushPlain({ ...k, owner: forged }, "forged write");
    expect(push.status).toBe(409);
    const versions = await api(forged, "GET", `/notes/${k.docId}/versions`);
    expect(await versions.text()).not.toContain(SECRET);
    // And it can mint no MCP token without the key.
    expect((await api(forged, "POST", "/mcp/tokens", { name: "x" })).status).toBe(409);
    expect(await plaintextLeft()).toBe(false);
  });

  it("9. tampered backfill cursors / index queue delete nothing and write no plaintext", async () => {
    const k = await keyedVault();
    const before = (await pool.query("SELECT count(*)::int AS n FROM doc_updates")).rows[0].n;
    await pool.query(
      `UPDATE vault_crypto_state SET cursors = '{"completedAt":"2000-01-01T00:00:00Z","checkedAt":"2000-01-01T00:00:00Z","tables":{}}'::jsonb WHERE vault_id = $1`,
      [k.vaultId],
    );
    await pool.query("INSERT INTO index_pending (doc_id, vault_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [k.docId, k.vaultId]);
    const { backfillVault, catchUpIndex } = await import("../src/crypto/backfill.js");
    const release = vaultKeyCache.acquire(k.vaultId, Buffer.from(k.vk), 1);
    try {
      await backfillVault(k.vaultId, { db: pool, maxBatches: 5 });
      await catchUpIndex(k.vaultId, pool);
    } finally {
      release();
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM doc_updates")).rows[0].n).toBe(before);
    expect(await plaintextLeft()).toBe(false);
    const idx = await pool.query("SELECT content, search_enc FROM note_index WHERE doc_id = $1", [k.docId]);
    for (const r of idx.rows) expect(String(r.content ?? "")).not.toContain(SECRET);
    expect(textOf(await loadDocState(k.docId, pool, k.crypto))).toBe(SECRET);
  });

  it("11. RESIDUAL: a plaintext row inserted into a keyed doc is read as content; compaction does not launder it", async () => {
    const k = await keyedVault();
    await pool.query("INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)", [k.docId, Buffer.from(updateWith("INJECTED"))]);
    // Integrity gap (documented): the legacy plaintext region of a keyed doc
    // is not authenticated, so attacker text merges into the note.
    expect(textOf(await loadDocState(k.docId, pool, k.crypto))).toContain("INJECTED");
    // Keyed compaction refuses a log with plaintext left: nothing is folded
    // into a sealed snapshot and nothing is deleted.
    const rows = (await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [k.docId])).rows[0].n;
    await compact(k.docId, pool, k.crypto);
    expect((await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [k.docId])).rows[0].n).toBe(rows);
    expect((await pool.query("SELECT 1 FROM doc_snapshots WHERE doc_id = $1", [k.docId])).rowCount).toBe(0);

    // RESIDUAL: the backfill treats it as legacy plaintext and dual-writes a
    // sealed copy (plaintext kept), i.e. it launders the injected row.
    const { backfillVault } = await import("../src/crypto/backfill.js");
    const release = vaultKeyCache.acquire(k.vaultId, Buffer.from(k.vk), 1);
    try {
      await backfillVault(k.vaultId, { db: pool, maxBatches: 5 });
    } finally {
      release();
    }
    const injected = await pool.query<{ update: Buffer | null; update_enc: Buffer | null }>(
      "SELECT update, update_enc FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL",
      [k.docId],
    );
    expect(injected.rowCount).toBe(1);
    expect(injected.rows[0].update_enc).not.toBeNull();
  });
});
