// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { searchNoteIndex } from "../src/index/indexer.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { KeyRequiredError } from "../src/crypto/transport.js";
import { VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

const app = createApp(testAppDeps());
const TEXT = "Quarterly revenue by region: north 4.2m, south 3.1m";

async function upload(token: string, vaultId: string, relPath: string) {
  const res = await app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "x-rel-path": relPath },
      body: randomBytes(16),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; sha256: string };
}

function putText(token: string, vaultId: string, blob: { id: string; sha256: string }, vk?: Buffer) {
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs/${blob.id}/text`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-baalda-version": VAULT_KEYS_MIN_DESKTOP,
        ...(vk ? { "x-baalda-vk": vk.toString("base64") } : {}),
      },
      body: JSON.stringify({ content: TEXT, sha256: blob.sha256, source: "client" }),
    }),
  );
}

describe("sealed blob_text (W3)", () => {
  let owner: TestUser;
  let org: string;
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    owner = await signUp(`owner+${randomUUID()}@bt.test`);
    org = await seedOrg("BT", `bt-${randomUUID().slice(0, 8)}`);
    await seedMember(org, owner.userId, "owner");
    await seedVaultGrant(org, "edit");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("keyed: needs the key, stores no plaintext, searches like an unkeyed copy", async () => {
    const plainVault = await seedVault(org, "Plain");
    const keyedVault = await seedVault(org, "Keyed");
    const plainBlob = await upload(owner.token, plainVault, "attachments/q3.xlsx");
    const keyedBlob = await upload(owner.token, keyedVault, "attachments/q3.xlsx");
    const vk = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [keyedVault, makeVkCheck(vk, keyedVault)]);

    expect((await putText(owner.token, plainVault, plainBlob)).status).toBe(204);
    const refused = await putText(owner.token, keyedVault, keyedBlob);
    expect(refused.status).toBe(409);
    expect((await pool.query("SELECT 1 FROM blob_text WHERE blob_id = $1", [keyedBlob.id])).rows).toHaveLength(0);
    expect((await putText(owner.token, keyedVault, keyedBlob, vk)).status).toBe(204);

    const { rows } = await pool.query("SELECT content, vector, search_tokens, search_enc FROM blob_text WHERE blob_id = $1", [keyedBlob.id]);
    expect(rows[0].content).toBe("");
    expect(rows[0].vector).toBeNull();
    expect(rows[0].search_tokens).toBeNull();
    expect(rows[0].search_enc.includes(Buffer.from("revenue"))).toBe(false);

    const crypto = { vaultId: keyedVault, key: vk, generation: 1 };
    for (const query of ["revenue north", "q3", "nothing here"]) {
      for (const keywordMode of ["app", "sql"] as const) {
        const a = await searchNoteIndex({ vaultId: plainVault, query, k: 5, readableDocIds: [], vaultWideReader: true, keywordMode });
        const b = await searchNoteIndex({ vaultId: keyedVault, query, k: 5, readableDocIds: [], vaultWideReader: true, keywordMode, crypto });
        expect(b.map((h) => [h.relPath, h.score.toFixed(10)])).toEqual(a.map((h) => [h.relPath, h.score.toFixed(10)]));
      }
    }
    await expect(
      searchNoteIndex({ vaultId: keyedVault, query: "revenue", k: 5, readableDocIds: [], vaultWideReader: true }),
    ).rejects.toBeInstanceOf(KeyRequiredError);
  });

  it("a keyed rewrite leaves an older plaintext row's columns untouched", async () => {
    const vaultId = await seedVault(org, "Later keyed");
    const blob = await upload(owner.token, vaultId, "attachments/a.pdf");
    expect((await putText(owner.token, vaultId, blob)).status).toBe(204);
    const before = (await pool.query("SELECT content, search_tokens FROM blob_text WHERE blob_id = $1", [blob.id])).rows[0];
    const vk = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(vk, vaultId)]);
    expect((await putText(owner.token, vaultId, blob, vk)).status).toBe(204);
    const after = (await pool.query("SELECT content, search_tokens, search_enc FROM blob_text WHERE blob_id = $1", [blob.id])).rows[0];
    expect(after.content).toBe(before.content);
    expect(after.search_tokens).toBe(before.search_tokens);
    expect(after.search_enc).not.toBeNull();
  });
});
