import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import {
  canReadAttachment,
  canWriteAttachment,
  filterReadableBlobs,
} from "../../permissions/http-gates.js";
import { getSession } from "../session.js";
import { relAssetPath } from "../../render/note-html.js";
import { ByteBudget } from "../../blobs/admission.js";
import {
  BLOB_MIME_ENFORCE,
  MAX_BLOB_BYTES,
  MAX_INFLIGHT_UPLOAD_BYTES,
} from "../../blobs/config.js";
import {
  categoryForMime,
  hasMagicSignature,
  isAllowedMime,
  maxBytesForMime,
  mimeMatchesBytes,
  normalizeMime,
  sniffMime,
} from "../../blobs/formats.js";
import {
  BlobStoreError,
  createBlobStore,
  resolveStoreForRow,
  storageKeyForRow,
} from "../../blobs/store.js";

/**
 * Attachment blob routes (spec 02 §2/§5A). Routes only: where the bytes live is
 * `src/blobs/` — the store adapter, its Postgres provider, the format
 * allow-list and the upload admission budget.
 *
 * Authorization mirrors the registry routes: any member of the vault (the
 * note collection's owning organization) is edit-capable for its attachments
 * (owner/admin/member). Downloads require the same membership (view is enough —
 * membership *is* the view grant at the vault level).
 *
 *   POST /api/vaults/:vaultId/blobs   raw binary body → store (dedupe by sha256)
 *   GET  /api/vaults/:vaultId/blobs   list metadata
 *   GET  /api/blobs/:id               download bytes with the stored mime
 *   HEAD /api/blobs/:id               the same headers, no body
 */
export const blobRoutes = new Hono();

const uploadBudget = new ByteBudget(MAX_INFLIGHT_UPLOAD_BYTES);

/** Bytes handed to the magic-byte sniff. 64 KB, not 4, because the zip family
 *  (docx/xlsx/pptx/zip) is told apart by an entry name in the archive's
 *  directory rather than by its first four bytes. */
const SNIFF_BYTES = 64 * 1024;

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

/**
 * Is this a rel_path an attachment may be stored under?
 *
 * Same rules as `render/note-html.ts relAssetPath` (no scheme, no backslash, no
 * `..`, no empty segment — a Windows drive letter is caught as a scheme), plus
 * the requirement that it live under `attachments/`. That last part is what
 * makes the value safe to hand back to a client: the desktop writes a
 * server-supplied rel_path to disk through `ensure_attachment_rel`, so a path
 * outside `attachments/` is at best dead weight and at worst a write the
 * desktop is right to refuse. Until now `..` was simply stored.
 */
function safeAttachmentRelPath(raw: string | null): string | null {
  if (!raw) return null;
  const rel = relAssetPath(raw);
  if (rel === null) return null;
  const segments = rel.split("/");
  if (segments.length < 2 || segments[0] !== "attachments") return null;
  return rel;
}

/** 64 lowercase hex characters, or null. */
function normalizeSha(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

function shaEquals(a: string, b: string): boolean {
  // Not a secret, but constant-time costs nothing and keeps the habit.
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── upload ────────────────────────────────────────────────────────────────
blobRoutes.post(
  "/vaults/:vaultId/blobs",
  // The size cap has to be enforced BEFORE the body is buffered, otherwise it
  // protects nothing: `arrayBuffer()` on a 10 GB request kills the process long
  // before any post-read check could run. Hono's bodyLimit answers 413 straight
  // from the Content-Length when there is one (no body read at all), and for a
  // chunked/length-less request it reads incrementally and aborts the moment the
  // running total passes maxSize — so the limit is not spoofable by omitting or
  // lying about Content-Length.
  bodyLimit({
    maxSize: MAX_BLOB_BYTES,
    onError: (c) => c.json({ error: "Attachment too large" }, 413),
  }),
  async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const vaultId = c.req.param("vaultId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    // Uploading is a write. A Read-only vault has to refuse it too, or
    // "read-only" would let anyone keep adding bytes to the vault's blob store.
    if (!(await canWriteAttachment(session.userId, vaultId))) {
      return c.json({ error: "This vault is read-only for you" }, 403);
    }

    // ── validation, all of it before a single byte of body is read ──────────
    const filename = c.req.header("x-file-name") ?? c.req.query("filename") ?? null;
    const relPath = safeAttachmentRelPath(
      c.req.header("x-rel-path") ?? c.req.query("relPath") ?? filename,
    );
    if (!relPath) {
      return c.json(
        {
          error: "Attachment path must be a vault-relative path under attachments/",
          code: "invalid_rel_path",
        },
        400,
      );
    }

    const mime = normalizeMime(c.req.header("content-type")) || "application/octet-stream";
    if (!isAllowedMime(mime)) {
      if (BLOB_MIME_ENFORCE === "reject") {
        return c.json(
          { error: `Unsupported attachment type: ${mime}`, code: "unsupported_media_type" },
          415,
        );
      }
      console.warn(
        `[blobs] BLOB_MIME_ENFORCE=warn: storing ${relPath} with unlisted mime ${mime}`,
      );
    }

    const store = await createBlobStore();
    // The category ceiling, clamped to what this provider can actually hold.
    // On Postgres that clamp is the whole story (everything lands on
    // MAX_BLOB_BYTES, which bodyLimit has already enforced); the per-category
    // number starts to matter with a provider that streams.
    const sizeCap = Math.min(maxBytesForMime(mime), store.maxBytes(categoryForMime(mime)));

    // `x-sha256`: the client telling us what it is about to send. When the
    // content is already here, the upload is answered from the header alone and
    // ZERO bytes move — which is the whole point of sending it. (Claiming a
    // hash you do not have gets you metadata for a blob in a vault you can
    // already list, so there is nothing to gain by lying.) When it is new, the
    // header is verified against the real hash below.
    const claimedSha = normalizeSha(c.req.header("x-sha256"));
    if (claimedSha) {
      const hit = await findBlob(vaultId, claimedSha);
      if (hit) return c.json({ ...toMeta(hit), deduped: true }, 200);
    }

    // Admission control, after auth (so anonymous callers can never occupy the
    // budget) and before the body is materialized. Reserve the declared size,
    // clamped to the hard cap; an absent/garbage Content-Length reserves the
    // whole cap, which is the honest worst case for a body we can't size yet.
    const declared = Number(c.req.header("content-length"));
    const reserve =
      Number.isFinite(declared) && declared > 0
        ? Math.min(Math.trunc(declared), MAX_BLOB_BYTES)
        : MAX_BLOB_BYTES;
    if (!(await uploadBudget.acquire(reserve))) {
      return c.json({ error: "Too many uploads in flight — retry shortly" }, 503, {
        "Retry-After": "5",
      });
    }
    try {
      // `Buffer.from(ArrayBuffer)` is a VIEW over the already-allocated body, not
      // a copy — the previous `Buffer.from(new Uint8Array(ab))` duplicated the
      // whole payload (Hono also caches the parsed body, so both copies stayed
      // live for the rest of the request).
      const ab = await c.req.arrayBuffer();
      if (ab.byteLength === 0) {
        return c.json({ error: "empty body" }, 400);
      }
      // Belt-and-braces: bodyLimit already enforced this above.
      if (ab.byteLength > MAX_BLOB_BYTES) {
        return c.json({ error: "Attachment too large" }, 413);
      }
      if (ab.byteLength > sizeCap) {
        return c.json(
          {
            error: `Attachment too large for ${categoryForMime(mime)} (max ${sizeCap} bytes)`,
            code: "attachment_too_large",
          },
          413,
        );
      }
      const buf = Buffer.from(ab);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      if (claimedSha && !shaEquals(claimedSha, sha256)) {
        return c.json(
          { error: "x-sha256 does not match the uploaded bytes", code: "sha_mismatch" },
          400,
        );
      }

      // Do the bytes agree with the declared type? Only for formats that HAVE a
      // signature — text has none, and `application/octet-stream` declares
      // nothing to contradict. An unrecognisable prefix is not evidence of a
      // lie, so only a positive, contradicting identification is refused.
      if (hasMagicSignature(mime)) {
        const sniffed = await sniffMime(buf.subarray(0, SNIFF_BYTES));
        if (!mimeMatchesBytes(mime, sniffed)) {
          return c.json(
            {
              error: `Content-Type ${mime} does not match the uploaded bytes (${sniffed})`,
              code: "content_type_mismatch",
            },
            400,
          );
        }
      }

      // Dedupe per vault by content hash: return the existing row if present.
      // Doing this before the bytes are handed to the store means a re-upload of
      // known content never pays the encode/serialize cost at all.
      const existing = await findBlob(vaultId, sha256);
      if (existing) {
        return c.json({ ...toMeta(existing), deduped: true }, 200);
      }

      const id = randomUUID();
      // The row is created `pending` and the bytes are written into it through
      // the store, then it is flipped to `ready` — the flow PR 2b's
      // intent → PUT → complete needs, run here inside one transaction so a
      // half-written blob is never visible to a reader or to dedupe.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<BlobRow>(
          `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                              storage_provider, storage_key, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'pending', $10)
           ON CONFLICT (vault_id, sha256) DO NOTHING
           RETURNING id, sha256, size, mime, rel_path, filename`,
          [
            id,
            vaultId,
            org,
            sha256,
            buf.byteLength,
            mime,
            relPath,
            filename,
            store.provider,
            session.userId,
          ],
        );
        if (!inserted.rows[0]) {
          // Another request uploaded the same content between the dedupe read
          // and this insert. `blobs_vault_sha_idx` is what settles it; the loser
          // returns the winner's row rather than a 500.
          await client.query("ROLLBACK");
          const winner = await findBlob(vaultId, sha256);
          if (winner) return c.json({ ...toMeta(winner), deduped: true }, 200);
          return c.json({ error: "Upload conflicted — retry" }, 409);
        }
        await store.put(
          {
            key: id,
            blobId: id,
            vaultId,
            body: Readable.from(buf),
            size: buf.byteLength,
            mime,
            sha256,
            filename,
          },
          client,
        );
        await client.query("UPDATE blobs SET status = 'ready', updated_at = now() WHERE id = $1", [
          id,
        ]);
        await client.query("COMMIT");
        return c.json({ ...toMeta(inserted.rows[0]), deduped: false }, 201);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } finally {
      uploadBudget.release(reserve);
    }
  },
);

async function findBlob(vaultId: string, sha256: string): Promise<BlobRow | undefined> {
  const { rows } = await pool.query<BlobRow>(
    `SELECT id, sha256, size, mime, rel_path, filename
       FROM blobs WHERE vault_id = $1 AND sha256 = $2 AND status = 'ready'`,
    [vaultId, sha256],
  );
  return rows[0];
}

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

  // `status = 'ready'` only: a pending row is an upload in flight (or an
  // abandoned one), and listing it would tell the desktop's attachment diff a
  // file it cannot download already exists.
  const { rows } = await pool.query<BlobRow>(
    `SELECT id, sha256, size, mime, rel_path, filename
       FROM blobs WHERE vault_id = $1 AND status = 'ready' ORDER BY rel_path`,
    [vaultId],
  );
  // Private-by-default: a scoped member only sees blobs referenced by notes
  // they can read (owner/admin + Open vaults see all). Mirrors the download gate.
  const visible = await filterReadableBlobs(session.userId, vaultId, rows);
  return c.json({ blobs: visible.map(toMeta) });
});

// ── download ────────────────────────────────────────────────────────────────
interface DownloadRow {
  id: string;
  vault_id: string | null;
  org_id: string | null;
  mime: string | null;
  rel_path: string | null;
  size: string | number | null;
  storage_provider: string | null;
  storage_key: string | null;
}

/**
 * Metadata + both gates, deliberately without the bytes. Selecting the data up
 * front meant every request — including the ones about to be rejected with 403 —
 * materialized the whole blob several times over (pg renders BYTEA as a hex
 * string twice the blob's size before decoding it to a Buffer). Only a caller
 * who passes both gates makes the process allocate anything large.
 *
 * Returns either the row or the response to send instead.
 */
async function authorizeDownload(
  c: Context,
): Promise<{ row: DownloadRow } | { deny: Response }> {
  const session = await getSession(c);
  if (!session) return { deny: c.json({ error: "Authentication required" }, 401) };

  const id = c.req.param("id");
  const { rows } = await pool.query<DownloadRow>(
    `SELECT id, vault_id, org_id, mime, rel_path, size, storage_provider, storage_key
       FROM blobs WHERE id = $1`,
    [id],
  );
  const blob = rows[0];
  if (!blob) return { deny: c.json({ error: "Blob not found" }, 404) };

  // Membership is necessary but not sufficient (via the blob's note collection,
  // or its org_id fallback for legacy rows without vault_id).
  const org = blob.vault_id ? await vaultOrg(blob.vault_id) : blob.org_id;
  if (!org || !(await orgRole(org, session.userId))) {
    return { deny: c.json({ error: "Not a member of this vault" }, 403) };
  }
  // Per-attachment ACL: a scoped member may only download a blob referenced by
  // a note they can read (owner/admin + Open vaults are allowed everything).
  // Legacy rows without a vault_id keep membership-only access (no note to gate on).
  if (blob.vault_id && !(await canReadAttachment(session.userId, blob.vault_id, blob.rel_path))) {
    return { deny: c.json({ error: "You do not have access to this attachment" }, 403) };
  }
  return { row: blob };
}

/**
 * The stored MIME is attacker-controlled (taken verbatim from the uploader's
 * content-type). Serve every blob as a non-rendering download: `nosniff` stops
 * the browser MIME-sniffing it into an active document, and
 * `Content-Disposition: attachment` forces a download rather than inline
 * rendering — so a stored text/html blob can't execute as script in the API
 * origin. The desktop reads the raw bytes regardless of these headers.
 */
function downloadHeaders(row: DownloadRow, size: number, acceptRanges: boolean) {
  return {
    "Content-Type": row.mime || "application/octet-stream",
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "attachment",
    "Accept-Ranges": acceptRanges ? "bytes" : "none",
  };
}

blobRoutes.get("/blobs/:id", async (c) => {
  const gate = await authorizeDownload(c);
  if ("deny" in gate) return gate.deny;
  const blob = gate.row;

  // Authorized: now fetch the bytes, through the provider recorded on the ROW.
  // The "no bytes stored" case is decided here and not before, because until
  // the provider is known there is no such thing as a missing body — a NULL
  // `data` column on an S3 row is normal, not a 404.
  try {
    const store = await resolveStoreForRow(blob);
    const result = await store.get(storageKeyForRow(blob));
    if (result.kind === "redirect") {
      return c.redirect(result.url, 302);
    }
    return c.body(
      Readable.toWeb(result.body) as ReadableStream,
      200,
      downloadHeaders(blob, result.size, result.acceptRanges),
    );
  } catch (e) {
    return storeError(c, e);
  }
});

// HEAD is the same gates and the same headers with no body. Nearly free on the
// Postgres provider (`octet_length` instead of the value) and the natural way
// for a client to ask "is this still there, and how big".
blobRoutes.on("HEAD", "/blobs/:id", async (c) => {
  const gate = await authorizeDownload(c);
  if ("deny" in gate) return gate.deny;
  const blob = gate.row;

  try {
    const store = await resolveStoreForRow(blob);
    const head = await store.head(storageKeyForRow(blob));
    if (!head) return c.body(null, 404);
    return c.body(null, 200, downloadHeaders(blob, head.size, false));
  } catch (e) {
    return storeError(c, e);
  }
});

/**
 * Map a store failure to a status. `storage_unavailable` is 503 and never 404:
 * a 404 tells the desktop's attachment diff the blob is gone, and it answers
 * that by re-uploading every byte.
 */
function storeError(c: Context, e: unknown) {
  if (e instanceof BlobStoreError) {
    if (e.code === "not_found") return c.json({ error: "Blob not found" }, 404);
    return c.json(
      { error: "Attachment storage is unavailable", code: "storage_unavailable" },
      503,
    );
  }
  throw e;
}
