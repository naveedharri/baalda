// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { appendUpdate, compact, loadDocState, sealVerifyHooks } from "../src/yjs/persistence.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());
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
async function allStoredBytes(): Promise<Buffer> {
  const { rows } = await pool.query<{ b: Buffer | null }>(
    `SELECT COALESCE(update_enc, update) AS b FROM doc_updates
     UNION ALL SELECT COALESCE(snapshot_enc, snapshot) FROM doc_snapshots`,
  );
  return Buffer.concat(rows.map((r) => r.b).filter((b): b is Buffer => !!b));
}

async function setup(keyed: boolean) {
  const owner = await signUp(`owner-${keyed}@sealed.test`);
  const org = await createOrg(owner, "Sealed", `sealed-${keyed}-${Date.now()}`);
  const vaultId = await seedVault(org.id);
  const vk = randomBytes(32);
  if (keyed) {
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      vaultId,
      makeVkCheck(vk, vaultId),
    ]);
  }
  const docId = await seedNote(vaultId, null, "n.md", owner.userId);
  const crypto: DocCrypto = { vaultId, key: vk, generation: 1 };
  return { owner, vaultId, vk, docId, crypto };
}

function post(user: TestUser, path: string, body: unknown, vk?: Buffer) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { ...authHeaders(user), "content-type": "application/json", ...(vk ? { "x-baalda-vk": b64(vk) } : {}) },
    body: JSON.stringify(body),
  });
}

describe("sealed sync paths (W3)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sealVerifyHooks.open = sealVerifyHooksOriginal;
  });
  afterAll(async () => {
    await pool.end();
  });
  const sealVerifyHooksOriginal = sealVerifyHooks.open;

  it("docs/batch: keyed needs the key (409, nothing written); with it, stored bytes are sealed", async () => {
    const s = await setup(true);
    const item = { docId: s.docId, update: b64(updateWith(SECRET)) };
    const refused = await post(s.owner, `/vaults/${s.vaultId}/docs/batch`, { items: [item] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "key_required" });
    expect((await pool.query("SELECT 1 FROM doc_updates")).rows).toHaveLength(0);

    const ok = await post(s.owner, `/vaults/${s.vaultId}/docs/batch`, { items: [item] }, s.vk);
    expect(ok.status).toBe(200);
    expect((await ok.json()).results[0].status).toBe("applied");
    expect((await allStoredBytes()).includes(Buffer.from(SECRET))).toBe(false);
    expect(textOf(await loadDocState(s.docId, pool, s.crypto))).toBe(SECRET);
  });

  it("docs/batch: unkeyed vault unchanged (plaintext, no key needed)", async () => {
    const s = await setup(false);
    const ok = await post(s.owner, `/vaults/${s.vaultId}/docs/batch`, {
      items: [{ docId: s.docId, update: b64(updateWith("plain")) }],
    });
    expect(ok.status).toBe(200);
    const { rows } = await pool.query("SELECT update, update_enc FROM doc_updates");
    expect(rows[0].update_enc).toBeNull();
    expect(textOf(await loadDocState(s.docId))).toBe("plain");
  });

  it("notes/batch with state: keyed without key refuses BEFORE registering anything", async () => {
    const s = await setup(true);
    const items = [{ docId: "11111111-2222-4333-8444-555555555555", relPath: "new.md", state: b64(updateWith(SECRET)) }];
    const refused = await post(s.owner, `/vaults/${s.vaultId}/notes/batch`, { items });
    expect(refused.status).toBe(409);
    expect((await pool.query("SELECT 1 FROM notes WHERE rel_path = 'new.md'")).rows).toHaveLength(0);

    const ok = await post(s.owner, `/vaults/${s.vaultId}/notes/batch`, { items }, s.vk);
    expect(ok.status).toBe(200);
    expect((await allStoredBytes()).includes(Buffer.from(SECRET))).toBe(false);
  });

  it("bootstrap page: keyed without key is 409 key_required", async () => {
    const s = await setup(true);
    const res = await app.request(`/api/vaults/${s.vaultId}/bootstrap/whatever`, { headers: authHeaders(s.owner) });
    expect(res.status).toBe(409);
  });

  it("compaction verifies the sealed snapshot before replacing anything", async () => {
    const s = await setup(true);
    await appendUpdate(s.docId, updateWith(SECRET), pool, 1000, s.crypto);
    await appendUpdate(s.docId, updateWith("more"), pool, 1000, s.crypto);
    const before = (await pool.query("SELECT id, update_enc FROM doc_updates ORDER BY id")).rows;

    // A seal that does not decrypt back to the same bytes: nothing may change.
    sealVerifyHooks.open = () => Buffer.from("not the same");
    await compact(s.docId, pool, s.crypto);
    expect((await pool.query("SELECT id, update_enc FROM doc_updates ORDER BY id")).rows).toEqual(before);
    expect((await pool.query("SELECT 1 FROM doc_snapshots")).rows).toHaveLength(0);

    // A good seal compacts, and the content is intact.
    sealVerifyHooks.open = sealVerifyHooksOriginal;
    await compact(s.docId, pool, s.crypto);
    expect((await pool.query("SELECT 1 FROM doc_updates")).rows).toHaveLength(0);
    const text = textOf(await loadDocState(s.docId, pool, s.crypto));
    expect(text).toContain(SECRET);
    expect(text).toContain("more");
  });

  it("keyed compaction never deletes legacy plaintext rows", async () => {
    const s = await setup(false);
    await appendUpdate(s.docId, updateWith("legacy"), pool, 1000); // written before keying
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      s.vaultId,
      makeVkCheck(s.vk, s.vaultId),
    ]);
    await appendUpdate(s.docId, updateWith("sealed"), pool, 1000, s.crypto);
    await compact(s.docId, pool, s.crypto);
    const { rows } = await pool.query("SELECT update, update_enc FROM doc_updates ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[0].update).not.toBeNull();
    const text = textOf(await loadDocState(s.docId, pool, s.crypto));
    expect(text).toContain("legacy");
    expect(text).toContain("sealed");
  });
});
