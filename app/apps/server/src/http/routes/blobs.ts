import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { canReadAttachment, filterReadableBlobs } from "../../permissions/http-gates.js";
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

/** Max attachment upload size. Generous for real attachments (images, PDFs)
 *  while stopping a single member from OOM-crashing the shared HTTP+sync
 *  process with a multi-gigabyte body. */
const MAX_BLOB_BYTES = 100 * 1024 * 1024; // 100 MB

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

  // Reject oversized uploads before buffering the whole body into memory. A
  // truthful Content-Length is short-circuited here; the post-read guard below
  // catches a lying/absent one.
  const declaredLen = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BLOB_BYTES) {
    return c.json({ error: "Attachment too large" }, 413);
  }

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength === 0) {
    return c.json({ error: "empty body" }, 400);
  }
  if (body.byteLength > MAX_BLOB_BYTES) {
    return c.json({ error: "Attachment too large" }, 413);
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
  // Private-by-default: a scoped member only sees blobs referenced by notes
  // they can read (owner/admin + Open vaults see all). Mirrors the download gate.
  const visible = await filterReadableBlobs(session.userId, vaultId, rows);
  return c.json({ blobs: visible.map(toMeta) });
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
    rel_path: string | null;
    data: Buffer | null;
  }>("SELECT vault_id, org_id, mime, rel_path, data FROM blobs WHERE id = $1", [id]);
  const blob = rows[0];
  if (!blob || !blob.data) return c.json({ error: "Blob not found" }, 404);

  // Membership is necessary but not sufficient (via the blob's note collection,
  // or its org_id fallback for legacy rows without vault_id).
  const org = blob.vault_id ? await vaultOrg(blob.vault_id) : blob.org_id;
  if (!org || !(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }
  // Per-attachment ACL: a scoped member may only download a blob referenced by
  // a note they can read (owner/admin + Open vaults are allowed everything).
  // Legacy rows without a vault_id keep membership-only access (no note to gate on).
  if (blob.vault_id && !(await canReadAttachment(session.userId, blob.vault_id, blob.rel_path))) {
    return c.json({ error: "You do not have access to this attachment" }, 403);
  }

  // The stored MIME is attacker-controlled (taken verbatim from the uploader's
  // content-type). Serve every blob as a non-rendering download: `nosniff`
  // stops the browser MIME-sniffing it into an active document, and
  // `Content-Disposition: attachment` forces a download rather than inline
  // rendering — so a stored text/html blob can't execute as script in the API
  // origin. The desktop reads the raw bytes regardless of these headers.
  return c.body(blob.data, 200, {
    "Content-Type": blob.mime || "application/octet-stream",
    "Content-Length": String(blob.data.byteLength),
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "attachment",
  });
});
