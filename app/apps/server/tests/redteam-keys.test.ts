// SPDX-License-Identifier: Apache-2.0
//
// W3 red team, round 2 (round 1 = adversary-db.test.ts, a database-writing
// operator). Here the attacker is an ordinary participant:
//   A. a MEMBER restricted from folder X who HOLDS the vault key;
//   B. a member who was REMOVED, replaying what they kept;
//   C. a holder of a public link or MCP token, without membership;
//   D. malformed key material on every transport;
//   E. spam against the new key endpoints.
// Each test performs the attack and asserts it fails. RESIDUAL = documented,
// accepted behaviour (not fixed here).
import { randomBytes } from "node:crypto";
import type { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { pendingKeyCache } from "../src/crypto/conversion.js";
import { decodeVk, splitSyncToken } from "../src/crypto/transport.js";
import { resetMcpBadTokens } from "../src/http/routes/mcp.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  markEncryptionRequested,
  seedBlob,
  seedDeny,
  seedFile,
  seedFolder,
  seedMember,
  seedNote,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const app = createApp(testAppDeps({ docWriter: createDocWriter(server) }));
const SECRET = "restricted-board-minutes";
const VERSION = "0.1.98";
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function updateWith(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

function api(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer | string) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      ...authHeaders(user),
      "content-type": "application/json",
      "x-baalda-version": VERSION,
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
  const raw = await res.text();
  let isError = true;
  try {
    isError = (JSON.parse(raw) as { result?: { isError?: boolean } }).result?.isError ?? true;
  } catch {
    /* non-JSON = error */
  }
  return { status: res.status, isError, raw };
}

/** Pull every page of a bootstrap session; the decompressed bytes, concatenated. */
async function drainBootstrap(user: TestUser, vaultId: string, sessionId: string, vk: Buffer) {
  const out: Buffer[] = [];
  let cursor = 0;
  for (let i = 0; i < 20; i++) {
    const res = await api(user, "GET", `/vaults/${vaultId}/bootstrap/${sessionId}?cursor=${cursor}`, undefined, vk);
    if (res.status !== 200) return { status: res.status, bytes: Buffer.concat(out) };
    out.push(gunzipSync(Buffer.from(await res.arrayBuffer())));
    const next = res.headers.get("X-Baalda-Cursor");
    if (next === null) break;
    cursor = Number(next);
  }
  return { status: 200, bytes: Buffer.concat(out) };
}

/**
 * A keyed, team-shared vault. Folder `X/` holds the secret note and a tree
 * file; `member` is denied X (No access) yet holds the vault key; `leaver`
 * has full access and is removed later by the tests that need it.
 */
async function world() {
  const tag = randomBytes(3).toString("hex");
  const owner = await signUp(`owner-${tag}@rt.test`);
  const member = await signUp(`member-${tag}@rt.test`);
  const leaver = await signUp(`leaver-${tag}@rt.test`);
  const org = await createOrg(owner, "RT", `rt-${Date.now()}-${tag}`);
  await seedMember(org.id, member.userId, "member");
  await seedMember(org.id, leaver.userId, "member");
  const vaultId = await seedVault(org.id);
  await seedVaultGrant(org.id, "edit");
  await markEncryptionRequested(vaultId, owner.userId);
  const x = await seedFolder(vaultId, null, "X", "X", owner.userId);
  const secretDoc = await seedNote(vaultId, x, "X/secret.md", owner.userId);
  const mine = await seedNote(vaultId, null, "mine.md", member.userId);
  const fileId = await seedFile(vaultId, x, "X/secret.pdf");
  const blobId = await seedBlob(vaultId, org.id, "X/secret.pdf", { docId: fileId, mime: "application/pdf" });
  await seedDeny(org.id, "folder", x, member.userId);

  const vk = randomBytes(32);
  const init = await api(owner, "POST", `/vaults/${vaultId}/keys/init`, {
    vkCheck: b64(makeVkCheck(vk, vaultId)),
    generation: 1,
    sealedVkForSelf: b64(randomBytes(80)),
  });
  expect(init.status).toBe(201);
  const push = await api(owner, "POST", `/vaults/${vaultId}/docs/batch`, {
    items: [{ docId: secretDoc, update: b64(updateWith(SECRET)) }],
  }, vk);
  expect(push.status).toBe(200);
  return { owner, member, leaver, orgId: org.id, vaultId, x, secretDoc, mine, fileId, blobId, vk };
}
type W = Awaited<ReturnType<typeof world>>;

async function removeMember(w: W, user: TestUser) {
  await pool.query(`DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [w.orgId, user.userId]);
}

const leaks = (s: string | Buffer) => Buffer.from(s).includes(Buffer.from(SECRET));

describe("red team round 2 (W3)", () => {
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

  // ── A. restricted member holding the key ─────────────────────────────────
  it("A1. bootstrap `only` naming a restricted doc returns nothing of it", async () => {
    const w = await world();
    const res = await api(w.member, "POST", `/vaults/${w.vaultId}/bootstrap`, { only: [w.secretDoc] }, w.vk);
    expect(res.status).toBe(200);
    const s = (await res.json()) as { sessionId: string };
    const page = await drainBootstrap(w.member, w.vaultId, s.sessionId, w.vk);
    expect(leaks(page.bytes)).toBe(false);
    expect(page.bytes.includes(Buffer.from("X/secret.md"))).toBe(false);
  });

  it("A2. a bootstrap session made BEFORE access was removed serves nothing restricted after", async () => {
    const w = await world();
    // Lift the deny, let the member plan a session that includes X/secret.md…
    await pool.query("DELETE FROM shares WHERE principal_id = $1", [w.member.userId]);
    const res = await api(w.member, "POST", `/vaults/${w.vaultId}/bootstrap`, {}, w.vk);
    const s = (await res.json()) as { sessionId: string; docs?: number };
    // …then take access away again and replay the planned session.
    await seedDeny(w.orgId, "folder", w.x, w.member.userId);
    const page = await drainBootstrap(w.member, w.vaultId, s.sessionId, w.vk);
    expect(leaks(page.bytes)).toBe(false);
  });

  it("A3. pushing into or reading back a restricted doc through docs/batch is refused", async () => {
    const w = await world();
    const res = await api(w.member, "POST", `/vaults/${w.vaultId}/docs/batch`, {
      items: [{ docId: w.secretDoc, update: b64(updateWith("overwrite")) }],
    }, w.vk);
    const text = await res.text();
    expect(leaks(text)).toBe(false);
    if (res.status === 200) {
      const body = JSON.parse(text) as { results?: Array<{ status?: string; ok?: boolean }> };
      expect(JSON.stringify(body)).not.toContain('"applied"');
    }
    // The note still holds only the owner's text.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [w.secretDoc]);
    expect(rows[0].n).toBe(1);
  });

  it("A4. search, graph, versions, trash, access-check, notes listing show nothing restricted", async () => {
    const w = await world();
    const probes = [
      `/vaults/${w.vaultId}/search?q=${SECRET}`,
      `/vaults/${w.vaultId}/graph`,
      `/notes/${w.secretDoc}/versions`,
      `/vaults/${w.vaultId}/trash`,
      `/notes?vaultId=${w.vaultId}`,
      `/files?vaultId=${w.vaultId}`,
    ];
    for (const p of probes) {
      const res = await api(w.member, "GET", p, undefined, w.vk);
      const text = await res.text();
      expect(leaks(text), p).toBe(false);
      expect(text.includes("secret.md"), p).toBe(false);
      expect(text.includes("secret.pdf"), p).toBe(false);
    }
    const check = await api(w.member, "POST", `/vaults/${w.vaultId}/access-check`, { docIds: [w.secretDoc] }, w.vk);
    expect(leaks(await check.text())).toBe(false);
  });

  it("A5. a restricted member cannot mint a public link on, or download, restricted content", async () => {
    const w = await world();
    const mint = await api(w.member, "POST", `/notes/${w.secretDoc}/public-link`, undefined, w.vk);
    expect([403, 404]).toContain(mint.status);
    const blob = await api(w.member, "GET", `/blobs/${w.blobId}`, undefined, w.vk);
    expect([403, 404]).toContain(blob.status);
    const url = await api(w.member, "GET", `/blobs/${w.blobId}/url`, undefined, w.vk);
    expect([403, 404]).toContain(url.status);
  });

  it("A6. a public link on the member's OWN note cannot fetch a restricted tree file it names", async () => {
    const w = await world();
    // The member writes the restricted file's path into a note they may edit…
    const push = await api(w.member, "POST", `/vaults/${w.vaultId}/docs/batch`, {
      items: [{ docId: w.mine, update: b64(updateWith("see ![](X/secret.pdf)")) }],
    }, w.vk);
    expect(push.status).toBe(200);
    // …publishes it, and asks the public page for the embed.
    const mint = await api(w.member, "POST", `/notes/${w.mine}/public-link`, undefined, w.vk);
    expect(mint.status).toBe(201);
    const { token } = (await mint.json()) as { token: string };
    const res = await app.request(`/p/${token}/a/X/secret.pdf`);
    expect(res.status).toBe(404);
  });

  it("A7. the member's MCP token cannot read or find restricted notes", async () => {
    const w = await world();
    const minted = await api(w.member, "POST", "/mcp/tokens", { name: "m" }, w.vk);
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    for (const [name, args] of [
      ["read_note", { docId: w.secretDoc }],
      ["read_note", { path: "X/secret.md" }],
      ["search_notes", { query: SECRET }],
      ["list_notes", {}],
      ["read_attachment_text", { blobId: w.blobId }],
    ] as const) {
      const r = await tool(token, name, args as Record<string, unknown>);
      expect(leaks(r.raw), name).toBe(false);
      expect(r.raw.includes("secret.md") && name !== "read_note", name).toBe(false);
    }
  });

  // ── B. removed member ─────────────────────────────────────────────────────
  it("B1. after removal: old session, MCP token, bootstrap session, token mints all fail", async () => {
    const w = await world();
    const minted = await api(w.leaver, "POST", "/mcp/tokens", { name: "l" }, w.vk);
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const boot = await api(w.leaver, "POST", `/vaults/${w.vaultId}/bootstrap`, {}, w.vk);
    const { sessionId } = (await boot.json()) as { sessionId: string };

    await removeMember(w, w.leaver);

    const r = await tool(token, "read_note", { docId: w.secretDoc });
    expect(r.isError).toBe(true);
    expect(leaks(r.raw)).toBe(false);
    const page = await drainBootstrap(w.leaver, w.vaultId, sessionId, w.vk);
    expect(page.status).not.toBe(200);
    expect(leaks(page.bytes)).toBe(false);
    for (const [m, p, body] of [
      ["POST", "/sync-token", { vaultId: w.vaultId, docId: w.secretDoc }],
      ["POST", "/vault-sync-token", { vaultId: w.vaultId }],
      ["GET", `/vaults/${w.vaultId}/keys/mine`, undefined],
      ["POST", `/vaults/${w.vaultId}/docs/batch`, { items: [{ docId: w.secretDoc, update: b64(updateWith("x")) }] }],
      ["GET", `/notes?vaultId=${w.vaultId}`, undefined],
    ] as const) {
      const res = await api(w.leaver, m, p, body, w.vk);
      expect(res.status, p).toBeGreaterThanOrEqual(400);
      expect(leaks(await res.text()), p).toBe(false);
    }
  });

  it("B2. a public link a removed member minted no longer serves a tree file they could read", async () => {
    const w = await world();
    const leaverNote = await seedNote(w.vaultId, null, "l.md", w.leaver.userId);
    await api(w.leaver, "POST", `/vaults/${w.vaultId}/docs/batch`, {
      items: [{ docId: leaverNote, update: b64(updateWith("![](X/secret.pdf)")) }],
    }, w.vk);
    const mint = await api(w.leaver, "POST", `/notes/${leaverNote}/public-link`, undefined, w.vk);
    expect(mint.status).toBe(201);
    const { token } = (await mint.json()) as { token: string };
    expect((await app.request(`/p/${token}/a/X/secret.pdf`)).status).toBe(200);
    await removeMember(w, w.leaver);
    expect((await app.request(`/p/${token}/a/X/secret.pdf`)).status).toBe(404);
    // RESIDUAL: the note page itself stays published (a link is a capability
    // on that note; an owner/admin revokes it from the note's share menu).
    expect((await app.request(`/p/${token}`)).status).toBe(200);
  });

  // ── C. token holders without membership ───────────────────────────────────
  it("C1. a public link token unlocks only its own note: no other note, version or unreferenced file", async () => {
    const w = await world();
    const mint = await api(w.owner, "POST", `/notes/${w.mine}/public-link`, undefined, w.vk);
    const { token } = (await mint.json()) as { token: string };
    for (const p of [
      `/p/${token}/a/X/secret.md`,
      `/p/${token}/a/X/secret.pdf`,
      `/p/${token}/a/..%2FX%2Fsecret.pdf`,
      `/p/${token}/a/X/../X/secret.pdf`,
      `/p/${token}x`,
    ]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(404);
      expect(leaks(await res.text()), p).toBe(false);
    }
    // The link token is no API credential.
    const res = await app.request(`/api/notes/${w.secretDoc}/versions`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect((await tool(token, "read_note", { docId: w.secretDoc })).status).toBe(401);
  });

  it("C2. an MCP token for vault A cannot touch vault B", async () => {
    const a = await world();
    const b = await world();
    const minted = await api(a.owner, "POST", "/mcp/tokens", { name: "a" }, a.vk);
    const { token } = (await minted.json()) as { token: string };
    for (const [name, args] of [
      ["read_note", { docId: b.secretDoc }],
      ["read_note", { docId: b.secretDoc, vaultId: b.vaultId }],
      ["list_notes", { vaultId: b.vaultId }],
      ["update_note", { docId: b.secretDoc, content: "pwned" }],
      ["search_notes", { query: SECRET, vaultId: b.orgId }],
    ] as const) {
      const r = await tool(token, name, args as Record<string, unknown>);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.raw.includes(b.secretDoc) && name === "list_notes").toBe(false);
    }
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [b.secretDoc]);
    expect(rows[0].n).toBe(1);
    // Vault A's own secret is readable (the token works) — and B's stays sealed.
    expect(leaks((await tool(token, "read_note", { docId: a.secretDoc })).raw)).toBe(true);
  });

  // ── D. malformed key material ─────────────────────────────────────────────
  it("D1. malformed / oversized / foreign X-Baalda-VK: a clean 409 or 431, never 500, never echoed", async () => {
    const w = await world();
    const other = randomBytes(32);
    const bad = [
      "",
      "not base64 !!",
      b64(randomBytes(31)),
      b64(randomBytes(33)),
      b64(randomBytes(64)),
      `${b64(w.vk)}\u0000`,
      "A".repeat(64 * 1024),
      b64(other), // another vault's (or a guessed) key
      b64(w.vk).replace(/.=$/, "A="), // the real key with one bit-group flipped
    ];
    const before = vaultKeyCache.has(w.vaultId);
    vaultKeyCache.clear();
    for (const h of bad) {
      let res: Response;
      try {
        res = await api(w.member, "POST", `/vaults/${w.vaultId}/docs/batch`, {
          items: [{ docId: w.mine, update: b64(updateWith("x")) }],
        }, h || undefined);
      } catch {
        continue; // the transport itself refused the header value
      }
      const text = await res.text();
      expect(res.status, h.slice(0, 20)).not.toBe(500);
      expect(res.status, `${h.slice(0, 20)} ${text.slice(0, 200)}`).not.toBe(200);
      if (h.length > 8) expect(text.includes(h.slice(0, 40))).toBe(false);
    }
    // A 1 MB header goes all the way through the app (in production Node's
    // 16 KB header cap answers 431 before it gets here): linear decode, 409.
    const t0 = Date.now();
    const huge = await api(w.member, "GET", `/vaults/${w.vaultId}/bootstrap/x`, undefined, "A".repeat(1024 * 1024));
    expect(huge.status).toBe(409);
    expect(Date.now() - t0).toBeLessThan(2000);
    // No refused key ever reached the background cache.
    expect(vaultKeyCache.has(w.vaultId)).toBe(false);
    expect(before).toBe(true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [w.mine]);
    expect(rows[0].n).toBe(0);
  });

  it("D2. sync token suffix tricks never yield a key and never split a non-JWT", () => {
    const vk = randomBytes(32);
    const jwt = "aaa.bbb.ccc";
    expect(splitSyncToken(`${jwt}.${b64(vk)}`).vk?.equals(vk)).toBe(true);
    expect(splitSyncToken(`${jwt}.garbage`)).toEqual({ jwt: `${jwt}.garbage`, vk: null });
    expect(splitSyncToken(`${jwt}.${b64(vk)}.${b64(vk)}`).vk).toBeNull();
    // Splits (the head has JWT shape), but the head is then no valid JWT: the
    // mint's signature check refuses it, so the extra key buys nothing.
    expect(splitSyncToken(`a.b.${b64(vk)}.${b64(vk)}`).jwt).toBe(`a.b.${b64(vk)}`);
    expect(splitSyncToken(`.${b64(vk)}`).vk).toBeNull();
    expect(splitSyncToken(`${b64(vk)}`).vk).toBeNull();
    expect(splitSyncToken(`${jwt}.${"A".repeat(1_000_000)}`).vk).toBeNull();
    expect(decodeVk("A".repeat(1_000_000))).toBeNull();
    expect(decodeVk(`${b64(vk)}\n`)).toBeNull();
  });

  it("D3. a correct key for vault B presented on vault A (or the old generation) is refused", async () => {
    const a = await world();
    const b = await world();
    for (const key of [b.vk, Buffer.alloc(32)]) {
      const res = await api(a.owner, "GET", `/vaults/${a.vaultId}/bootstrap/whatever`, undefined, key);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("key_required");
    }
  });

  // ── E. spam ────────────────────────────────────────────────────────────────
  it("E1. key requests and pending devices are bounded per user", async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) await api(w.member, "GET", `/vaults/${w.vaultId}/keys/mine`);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM vault_key_requests WHERE vault_id = $1", [w.vaultId]);
    expect(rows[0].n).toBe(1);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await api(w.member, "POST", "/me/devices", { deviceId: `dev-${i}`, publicKey: b64(randomBytes(32)) });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const { rows: d } = await pool.query(
      "SELECT count(*)::int AS n FROM user_device_keys WHERE user_id = $1",
      [w.member.userId],
    ).catch(() => ({ rows: [{ n: 0 }] }));
    expect(d[0].n).toBeLessThanOrEqual(5);
  });

  it("E2. request-encryption and allowlist are role-gated and bounded", async () => {
    const w = await world();
    expect((await api(w.member, "POST", `/vaults/${w.vaultId}/keys/request-encryption`)).status).toBe(403);
    const big = Array.from({ length: 2001 }, () => ({ kind: "mcp", id: "x", mac: b64(randomBytes(32)) }));
    const res = await api(w.owner, "POST", `/vaults/${w.vaultId}/keys/allowlist`, { entries: big }, w.vk);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
