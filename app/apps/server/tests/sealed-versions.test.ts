// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { recordVersion } from "../src/versions/capture.js";
import { captureCheckpoint, maybeDailyCheckpoint, topUpCheckpoint } from "../src/versions/checkpoints.js";
import { revertVaultToCheckpoint } from "../src/versions/revert.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { KeyRequiredError } from "../src/crypto/transport.js";
import { VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { memoryDocWriter, testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, seedVault } from "./helpers/seed.js";

const SECRET_V1 = "first draft of the acquisition memo";
const SECRET_V2 = "second draft, numbers redacted";

async function allTextBytes(): Promise<Buffer> {
  const { rows } = await pool.query<{ c: string; e: Buffer | null }>("SELECT content AS c, content_enc AS e FROM note_texts");
  return Buffer.concat(rows.flatMap((r) => [Buffer.from(r.c ?? ""), r.e ?? Buffer.alloc(0)]));
}

describe("sealed versions and checkpoints (W3)", () => {
  const docWriter = memoryDocWriter();
  const app = createApp(testAppDeps({ docWriter }));
  let owner: TestUser;
  let vaultId: string;
  let docId: string;
  let vk: Buffer;
  let crypto: DocCrypto;

  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
    docWriter.store.clear();
    owner = await signUp("owner@ver.test");
    const org = await createOrg(owner, "Ver", `ver-${Date.now()}`);
    vaultId = await seedVault(org.id);
    vk = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(vk, vaultId)]);
    crypto = { vaultId, key: vk, generation: 1 };
    docId = await seedNote(vaultId, null, "memo.md", owner.userId);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  const hdr = (withKey: boolean) => ({
    ...authHeaders(owner),
    "x-baalda-version": VAULT_KEYS_MIN_DESKTOP,
    ...(withKey ? { "x-baalda-vk": vk.toString("base64") } : {}),
  });

  it("versions: sealed at rest; list without key, read/revert need the key", async () => {
    const v1 = await recordVersion({ vaultId, docId, content: SECRET_V1, cause: "idle", authorId: owner.userId, crypto });
    docWriter.store.set(docId, SECRET_V2);
    expect((await allTextBytes()).includes(Buffer.from("acquisition"))).toBe(false);

    const list = await app.request(`/api/notes/${docId}/versions`, { headers: hdr(false) });
    expect(list.status).toBe(200);
    expect((await list.json()).versions[0].size).toBe(Buffer.byteLength(SECRET_V1));

    expect((await app.request(`/api/notes/${docId}/versions/${v1}`, { headers: hdr(false) })).status).toBe(409);
    const read = await app.request(`/api/notes/${docId}/versions/${v1}`, { headers: hdr(true) });
    expect((await read.json()).content).toBe(SECRET_V1);

    const refused = await app.request(`/api/notes/${docId}/versions/${v1}/revert`, { method: "POST", headers: hdr(false) });
    expect(refused.status).toBe(409);
    expect(docWriter.store.get(docId)).toBe(SECRET_V2);

    const ok = await app.request(`/api/notes/${docId}/versions/${v1}/revert`, { method: "POST", headers: hdr(true) });
    expect(ok.status).toBe(200);
    expect(docWriter.store.get(docId)).toBe(SECRET_V1);
    // The pre-revert copy of V2 is sealed too.
    expect((await allTextBytes()).includes(Buffer.from("redacted"))).toBe(false);
  });

  it("key_required names the vault (note paths do not); a pre-vault-key build gets 426 instead", async () => {
    const v1 = await recordVersion({ vaultId, docId, content: SECRET_V1, cause: "idle", authorId: owner.userId, crypto });
    const old = { ...authHeaders(owner) }; // no version reported = a build before vault keys
    const routes: Array<[string, string]> = [
      ["GET", `/api/notes/${docId}/versions/${v1}`],
      ["POST", `/api/notes/${docId}/versions/${v1}/revert`],
      ["POST", `/api/notes/${docId}/public-link`],
      ["POST", `/api/mcp/tokens`],
    ];
    for (const [method, path] of routes) {
      const res = await app.request(path, { method, headers: hdr(false), body: method === "POST" ? "{}" : undefined });
      expect([path, res.status]).toEqual([path, 409]);
      expect(await res.json()).toMatchObject({ code: "key_required", vaultId });
      const legacy = await app.request(path, { method, headers: old, body: method === "POST" ? "{}" : undefined });
      expect([path, legacy.status]).toEqual([path, 426]);
      expect(await legacy.json()).toMatchObject({ code: "client_outdated" });
    }
    const { rows } = await pool.query("SELECT (SELECT count(*) FROM public_links)::int AS l, (SELECT count(*) FROM mcp_tokens)::int AS t");
    expect(rows[0]).toEqual({ l: 0, t: 0 });
    // With the key, the same note-scoped reads work.
    const read = await app.request(`/api/notes/${docId}/versions/${v1}`, { headers: hdr(true) });
    expect(read.status).toBe(200);
    expect((await read.json()).content).toBe(SECRET_V1);
    const list = await app.request(`/api/notes/${docId}/versions`, { headers: hdr(true) });
    expect(list.status).toBe(200);
    expect((await list.json()).versions).toHaveLength(1);
  });

  it("background version capture with no key held refuses and writes nothing", async () => {
    await expect(
      recordVersion({ vaultId, docId, content: SECRET_V1, cause: "idle", authorId: null }),
    ).rejects.toBeInstanceOf(KeyRequiredError);
    expect((await pool.query("SELECT 1 FROM note_versions")).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM note_texts")).rows).toHaveLength(0);
  });

  it("checkpoints: capture (sealed), revert restores the text; no key = deferred, nothing written", async () => {
    docWriter.store.set(docId, SECRET_V1);
    expect(await maybeDailyCheckpoint({ vaultId, docWriter, deferMs: 0 } as never)).toEqual({ deferred: true });
    expect((await pool.query("SELECT 1 FROM vault_checkpoints")).rows).toHaveLength(0);

    const cp = await captureCheckpoint({ db: pool, docWriter, vaultId, kind: "manual", createdBy: owner.userId, crypto });
    expect(cp.noteCount).toBe(1);
    expect((await allTextBytes()).includes(Buffer.from("acquisition"))).toBe(false);

    docWriter.store.set(docId, SECRET_V2);
    await expect(
      revertVaultToCheckpoint({ vaultId, checkpointId: cp.id, userId: owner.userId, docWriter }),
    ).rejects.toBeInstanceOf(KeyRequiredError);
    expect(docWriter.store.get(docId)).toBe(SECRET_V2);

    const out = await revertVaultToCheckpoint({ vaultId, checkpointId: cp.id, userId: owner.userId, docWriter, crypto });
    expect(out.acquired).toBe(true);
    expect(docWriter.store.get(docId)).toBe(SECRET_V1);
  });

  it("top-up with no key held adds nothing; with a held key it seals", async () => {
    const cp = await captureCheckpoint({ db: pool, docWriter, vaultId, kind: "manual", createdBy: null, crypto });
    expect(cp.structureOnly).toBe(1);
    docWriter.store.set(docId, SECRET_V1);
    expect(await topUpCheckpoint(pool, docWriter, vaultId, cp.id, [docId])).toEqual([]);
    const release = vaultKeyCache.acquire(vaultId, vk, 1);
    expect(await topUpCheckpoint(pool, docWriter, vaultId, cp.id, [docId])).toEqual([docId]);
    release();
    expect((await allTextBytes()).includes(Buffer.from("acquisition"))).toBe(false);
  });
});
