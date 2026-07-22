import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";

/**
 * Attachment blob store (spec 02 §2/§5A). BYTEA storage for the MVP; the
 * `storage_url` column is reserved for an S3/R2 upgrade in production.
 *
 * Authorization mirrors the registry routes: any member of the vault (the
 * note collection's owning organization) is edit-capable for its attachments
 * (owner/admin/member). Downloads require the same membership (view is enough —
 * membership *is* the view grant at the vault level).
 *
 *   POST /api/vaults/:vaultId/blobs   raw binary body → store (dedupe by sha256)
 *   GET  /api/vaults/:vaultId/blobs   list metadata
 *   GET  /api/blobs/:id               download bytes with the stored mime
 */
export const blobRoutes = new Hono();

interface BlobRow {
  id: string;
  sha256: string;
  size: string | number;
  mime: string | null;
  rel_path: string | null;
  filename: string | null;
}

function toMeta(row: BlobRow) {
  return {
    id: row.id,
    sha256: row.sha256,
    size: Number(row.size),
    mime: row.mime,
    relPath: row.rel_path,
    filename: row.filename,
  };
}

// ── upload ────────────────────────────────────────────────────────────────
blobRoutes.post("/vaults/:vaultId/blobs", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const vaultId = c.req.param("vaultId");
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength === 0) {
    return c.json({ error: "empty body" }, 400);
  }
  const buf = Buffer.from(body);

  const mime = c.req.header("content-type") || "application/octet-stream";
  const filename = c.req.header("x-file-name") ?? c.req.query("filename") ?? null;
  const relPath = c.req.header("x-rel-path") ?? c.req.query("relPath") ?? filename;
  const sha256 = createHash("sha256").update(buf).digest("hex");

  // Dedupe per vault by content hash: return the existing row if present.
  const existing = await pool.query<BlobRow>(
    `SELECT id, sha256, size, mime, rel_path, filename
       FROM blobs WHERE vault_id = $1 AND sha256 = $2`,
    [vaultId, sha256],
  );
  if (existing.rows[0]) {
    return c.json({ ...toMeta(existing.rows[0]), deduped: true }, 200);
  }

  const id = randomUUID();
  const { rows } = await pool.query<BlobRow>(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, data, rel_path, filename)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, sha256, size, mime, rel_path, filename`,
    [id, vaultId, org, sha256, buf.byteLength, mime, buf, relPath, filename],
  );
  return c.json({ ...toMeta(rows[0]), deduped: false }, 201);
});

// ── list ──────────────────────────────────────────────────────────────────
blobRoutes.get("/vaults/:vaultId/blobs", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const vaultId = c.req.param("vaultId");
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }

  const { rows } = await pool.query<BlobRow>(
    `SELECT id, sha256, size, mime, rel_path, filename
       FROM blobs WHERE vault_id = $1 ORDER BY rel_path`,
    [vaultId],
  );
  return c.json({ blobs: rows.map(toMeta) });
});

// ── download ────────────────────────────────────────────────────────────────
blobRoutes.get("/blobs/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  const { rows } = await pool.query<{
    vault_id: string | null;
    org_id: string | null;
    mime: string | null;
    data: Buffer | null;
  }>("SELECT vault_id, org_id, mime, data FROM blobs WHERE id = $1", [id]);
  const blob = rows[0];
  if (!blob || !blob.data) return c.json({ error: "Blob not found" }, 404);

  // View requires vault membership (via the blob's note collection, or its
  // org_id fallback for legacy rows without vault_id).
  const org = blob.vault_id ? await vaultOrg(blob.vault_id) : blob.org_id;
  if (!org || !(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }

  return c.body(blob.data, 200, {
    "Content-Type": blob.mime || "application/octet-stream",
    "Content-Length": String(blob.data.byteLength),
  });
});
