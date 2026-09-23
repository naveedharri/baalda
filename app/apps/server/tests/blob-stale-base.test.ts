import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Optimistic concurrency for a registered file's bytes (`baseSha`).
 *
 * The server keeps ONE version per doc, so two devices holding different bytes
 * for one file used to take turns retiring each other's upload forever. A
 * client that names the version its edit started from is refused with 409
 * `stale_base` (and the current version) once the doc has moved on; a client
 * that names none keeps the old behavior.
 */
const app = createApp(testAppDeps());

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const png = (tail: number) => Buffer.from([...PNG_HEAD, 0x49, 0x48, 0x44, tail]);
const V1 = png(1);
const V2 = png(2);
const V3 = png(3);
const shaOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Intent {
  blobId?: string;
  deduped?: boolean;
  upload?: { url: string; headers: Record<string, string> };
  code?: string;
  current?: { id: string; sha256: string; docId: string | null; relPath: string | null };
}

const DOC = "file-report";
const PATH = "report.png";

async function setup(slug: string) {
  const owner = await signUp(`owner@${slug}.com`);
  const org = await seedOrg("Acme", slug);
  await seedMember(org, owner.userId, "owner");
  const vault = await seedVault(org);
  await seedVaultGrant(org, "edit");
  const reg = await app.fetch(
    new Request("http://local/api/files", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ vaultId: vault, docId: DOC, path: PATH }),
    }),
  );
  expect(reg.status).toBeLessThan(300);
  return { owner, vault };
}

function intent(user: TestUser, vaultId: string, bytes: Buffer, baseSha?: Buffer) {
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs/intent`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sha256: shaOf(bytes),
        size: bytes.byteLength,
        mime: "image/png",
        relPath: PATH,
        docId: DOC,
        ...(baseSha ? { baseSha: shaOf(baseSha) } : {}),
      }),
    }),
  );
}

/** intent → PUT → complete, asserting it went through. */
async function uploadVia(user: TestUser, vaultId: string, bytes: Buffer, baseSha?: Buffer) {
  const res = await intent(user, vaultId, bytes, baseSha);
  expect(res.status).toBe(200);
  const plan = (await res.json()) as Intent;
  expect(plan.deduped).toBeFalsy();
  const put = await app.fetch(
    new Request(plan.upload!.url.replace(/^https?:\/\/[^/]+/, "http://local"), {
      method: "PUT",
      headers: plan.upload!.headers,
      body: bytes,
    }),
  );
  expect(put.status).toBe(204);
  const done = await app.fetch(
    new Request(`http://local/api/blobs/${plan.blobId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(done.status).toBe(200);
}

function legacyPost(
  user: TestUser,
  vaultId: string,
  bytes: Buffer,
  base?: { via: "query" | "header"; sha: Buffer },
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${user.token}`,
    "content-type": "image/png",
    "x-rel-path": PATH,
    "x-doc-id": DOC,
  };
  let url = `http://local/api/vaults/${vaultId}/blobs`;
  if (base?.via === "header") headers["x-base-sha256"] = shaOf(base.sha);
  if (base?.via === "query") url += `?baseSha=${shaOf(base.sha)}`;
  return app.fetch(new Request(url, { method: "POST", headers, body: bytes }));
}

async function readyShas(vaultId: string): Promise<string[]> {
  const { rows } = await pool.query<{ sha256: string }>(
    "SELECT sha256 FROM blobs WHERE vault_id = $1 AND doc_id = $2 AND status = 'ready'",
    [vaultId, DOC],
  );
  return rows.map((r) => r.sha256);
}

afterAll(async () => {
  await pool.end();
});

describe("baseSha: stale-base refusal for registered files", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("intent: a fresh base goes through; a stale base is refused with the current version", async () => {
    const { owner, vault } = await setup("stale-intent");
    await uploadVia(owner, vault, V1);
    // Device B edited V1 → V2 and says so: accepted, V1 retired.
    await uploadVia(owner, vault, V2, V1);
    expect(await readyShas(vault)).toEqual([shaOf(V2)]);

    // Device A never saw V2 and edits its V1 → V3. Refused, and told what won.
    const res = await intent(owner, vault, V3, V1);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Intent;
    expect(body.code).toBe("stale_base");
    expect(body.current?.sha256).toBe(shaOf(V2));
    expect(body.current?.docId).toBe(DOC);
    // Nothing was retired or reserved by the refusal.
    expect(await readyShas(vault)).toEqual([shaOf(V2)]);
    const pending = await pool.query("SELECT 1 FROM blobs WHERE status = 'pending'");
    expect(pending.rowCount).toBe(0);
  });

  it("intent: bytes equal to the current version dedupe even with a stale base", async () => {
    const { owner, vault } = await setup("stale-dedupe");
    await uploadVia(owner, vault, V1);
    await uploadVia(owner, vault, V2, V1);
    const res = await intent(owner, vault, V2, V1);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Intent).deduped).toBe(true);
  });

  it("intent: no baseSha (an older client) keeps the old last-writer-wins behavior", async () => {
    const { owner, vault } = await setup("stale-legacy-client");
    await uploadVia(owner, vault, V1);
    await uploadVia(owner, vault, V2, V1);
    await uploadVia(owner, vault, V3);
    expect(await readyShas(vault)).toEqual([shaOf(V3)]);
  });

  it("intent: a base on a doc with no ready row yet is not a conflict", async () => {
    const { owner, vault } = await setup("stale-first");
    await uploadVia(owner, vault, V1, V2);
    expect(await readyShas(vault)).toEqual([shaOf(V1)]);
  });

  it.each(["query", "header"] as const)(
    "legacy POST honours a stale base sent via %s, and ignores its absence",
    async (via) => {
      const { owner, vault } = await setup(`stale-post-${via}`);
      expect((await legacyPost(owner, vault, V1)).status).toBe(201);
      expect((await legacyPost(owner, vault, V2, { via, sha: V1 })).status).toBe(201);
      expect(await readyShas(vault)).toEqual([shaOf(V2)]);

      const stale = await legacyPost(owner, vault, V3, { via, sha: V1 });
      expect(stale.status).toBe(409);
      const body = (await stale.json()) as Intent;
      expect(body.code).toBe("stale_base");
      expect(body.current?.sha256).toBe(shaOf(V2));
      expect(await readyShas(vault)).toEqual([shaOf(V2)]);

      // No base: unchanged, the upload lands.
      expect((await legacyPost(owner, vault, V3)).status).toBe(201);
      expect(await readyShas(vault)).toEqual([shaOf(V3)]);
    },
  );
});
