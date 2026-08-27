import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, seedVault } from "./helpers/seed.js";

/**
 * Response compression on the JSON API. The registry listings are why it exists:
 * `GET /api/notes` for a several-hundred-note vault is a few hundred KB of very
 * repetitive JSON, on the critical path of every client start-up and every
 * `registry` broadcast.
 *
 * Blob DOWNLOAD is excluded by PATH rather than left to the content-type filter,
 * because an attachment's stored mime is whatever the uploader sent — a
 * text/markdown attachment would otherwise get re-encoded on a route whose only
 * job is handing back exact bytes. The tests below pin both halves.
 */

const app = createApp(testAppDeps());

async function get(user: TestUser, path: string, acceptEncoding?: string): Promise<Response> {
  const headers: Record<string, string> = { ...authHeaders(user) };
  if (acceptEncoding) headers["accept-encoding"] = acceptEncoding;
  return app.fetch(new Request(`http://local${path}`, { headers }));
}

/** Read a gzipped Response body as text (a hand-built Response is not
 *  transparently decoded the way a network fetch would be). */
async function gunzipText(res: Response): Promise<string> {
  return gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
}

describe("HTTP response compression", () => {
  let owner: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@compress.test");
    const org = (await createOrg(owner, "Compress Co", "compress-co")).id;
    vault = await seedVault(org);
    // Enough rows that the payload is worth compressing at all.
    for (let i = 0; i < 40; i++) {
      await seedNote(vault, null, `Note-${String(i).padStart(3, "0")}.md`, owner.userId);
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it("gzips GET /api/notes when the client accepts it", async () => {
    const res = await get(owner, `/api/notes?vaultId=${vault}`, "gzip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");

    // And the bytes are real gzip carrying the same JSON.
    const body = JSON.parse(await gunzipText(res)) as { notes: unknown[] };
    expect(body.notes.length).toBe(40);
  });

  it("leaves the response uncompressed when the client doesn't accept it", async () => {
    const res = await get(owner, `/api/notes?vaultId=${vault}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = (await res.json()) as { notes: unknown[] };
    expect(body.notes.length).toBe(40);
  });

  it("compresses the other registry listings too", async () => {
    for (const path of [`/api/folders?vaultId=${vault}`, "/api/vaults"]) {
      const res = await get(owner, path, "gzip");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
    }
  });

  it("never touches a blob download, even one with a compressible mime", async () => {
    // text/markdown matches hono's compressible-type regex, so ONLY the path
    // exclusion can keep this response verbatim.
    const id = randomUUID();
    const bytes = Buffer.from("# attachment\n".repeat(200), "utf8");
    await pool.query(
      `INSERT INTO blobs (id, vault_id, sha256, size, mime, data, rel_path, filename)
       VALUES ($1, $2, $3, $4, 'text/markdown', $5, 'attachments/a.md', 'a.md')`,
      [id, vault, "sha-compress-test", bytes.length, bytes],
    );

    const res = await get(owner, `/api/blobs/${id}`, "gzip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    // Byte-for-byte what was stored.
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("still compresses the blob LIST route (JSON, not bytes)", async () => {
    const res = await get(owner, `/api/vaults/${vault}/blobs`, "gzip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("leaves /health alone (outside /api)", async () => {
    const res = await app.fetch(
      new Request("http://local/health", { headers: { "accept-encoding": "gzip" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});
