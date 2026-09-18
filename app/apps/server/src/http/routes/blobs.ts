import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import {
  canEditDoc,
  canReadAttachment,
  canWriteBlob,
  filterReadableBlobs,
} from "../../permissions/http-gates.js";
import { getSession } from "../session.js";
import { relAssetPath } from "../../render/note-html.js";
import { config } from "../../config.js";
import { pgText } from "../../db/text.js";
import { embed } from "../../index/embedder.js";
import { ByteBudget } from "../../blobs/admission.js";
import {
  BLOB_MIME_ENFORCE,
  MAX_BLOB_BYTES,
  MAX_INFLIGHT_UPLOAD_BYTES,
} from "../../blobs/config.js";
import { objectKey } from "../../blobs/keys.js";
import { docsReferencing } from "../../blobs/refs.js";
import { storageLimitBytes } from "../../billing/entitlements.js";
import { verifyUploadToken } from "../../blobs/upload-token.js";
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
  type BlobStore,
  type CompletedPart,
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
 *   POST /api/vaults/:vaultId/blobs          raw binary body → store (legacy, dedupe by sha256)
 *   POST /api/vaults/:vaultId/blobs/intent   declare a file → dedupe answer or an upload URL
 *   PUT  /api/blobs/:id/data?t=              the bytes, for a provider with no object store
 *   POST /api/blobs/:id/parts                more presigned part URLs (multipart)
 *   POST /api/blobs/:id/complete             verify what landed and publish the blob
 *   GET  /api/vaults/:vaultId/blobs          list metadata
 *   GET  /api/blobs/:id                      download bytes with the stored mime
 *   GET  /api/blobs/:id/url                  a URL to fetch the bytes from
 *   HEAD /api/blobs/:id                      the same headers, no body
 *   PUT  /api/vaults/:vaultId/blobs/:blobId/text   the file's extracted plain text
 *   DELETE /api/blobs/:id                    remove an attachment (409 if referenced)
 *   GET  /api/vaults/:vaultId/storage        how much of the quota this vault uses
 *
 * THE INTENT FLOW, and why it is the same three steps for both providers:
 *
 *   intent → (deduped? done) → PUT the bytes → complete
 *
 * The legacy POST answers "do you already have this?" by sending the whole file
 * and reading `deduped: true` off the response, so every new device re-uploads
 * every attachment in full to learn that nothing was needed. `intent` answers it
 * with a JSON round trip and ZERO bytes, and checks ACL, rel_path, MIME, the
 * size cap and (PR 2c) quota BEFORE anything moves. The S3 provider returns a
 * presigned bucket URL and the Postgres provider returns a signed same-origin
 * `PUT /api/blobs/:id/data?t=`, in the same envelope, so the client has one code
 * path. The legacy POST keeps working unchanged, forever — shipped desktops use
 * it, and they feature-detect the new flow by a 404 on intent.
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
  /** The `files` doc these bytes are, or null for an `attachments/` drop. */
  doc_id?: string | null;
}

const BLOB_ROW_COLUMNS = "id, sha256, size, mime, rel_path, filename, doc_id";

function toMeta(row: BlobRow) {
  return {
    id: row.id,
    sha256: row.sha256,
    size: Number(row.size),
    mime: row.mime,
    relPath: row.rel_path,
    filename: row.filename,
    docId: row.doc_id ?? null,
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

/**
 * Where a blob's bytes belong, given what the client claimed.
 *
 * Two kinds of blob, and only one of them may name its own path. A TREE FILE
 * (`docId` naming a `files` row in this vault) takes the path the registry
 * already stores for that row — the server's own value, validated when the file
 * was registered (`resolveParentFolder`, so `rel_path` and `folder_id` agree)
 * and therefore not something a client can talk us into. An `attachments/` drop
 * has no registry row to ask, so its path is the caller's and goes through
 * {@link safeAttachmentRelPath}, which is what keeps a server-supplied path
 * something the desktop's `ensure_attachment_rel` will accept.
 *
 * That split is the whole reason binaries may now live anywhere in the tree
 * without loosening the anti-IDOR rule: `Team/q3.xlsx` is only ever accepted
 * because THIS server already knows a file by that path and that id.
 */
async function resolveBlobRelPath(
  vaultId: string,
  docId: string | null,
  claimed: string | null,
): Promise<{ relPath: string; docId: string | null } | null> {
  if (docId) {
    const { rows } = await pool.query<{ path: string }>(
      "SELECT path FROM files WHERE id = $1 AND vault_id = $2",
      [docId, vaultId],
    );
    if (rows[0]) return { relPath: rows[0].path, docId };
  }
  const rel = safeAttachmentRelPath(claimed);
  // An unresolvable docId is dropped rather than stored: a doc_id that names no
  // file would send every ACL check down a branch with nothing behind it.
  return rel === null ? null : { relPath: rel, docId: null };
}

/** A doc id, if it looks like one at all. Ids are TEXT server-side (Better Auth
 *  emits TEXT and clients supply their own), so the only real rule is a bound. */
function normalizeDocId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s.length > 0 && s.length <= 255 ? s : null;
}

/**
 * Adopt a doc_id onto a blob that has none.
 *
 * Only ever NULL → set. A blob is content-addressed per vault, so two tree
 * files with byte-identical contents share one row and only the first can own
 * it; letting the second overwrite `doc_id` would move the ACL of a file
 * someone can read onto whichever copy was uploaded last. First writer wins,
 * and the loser keeps the (weaker, path-based) attachment branch — the same
 * identical-bytes limitation the desktop's sha-keyed attachment diff already
 * has.
 */
async function adoptDocId(blobId: string, docId: string): Promise<void> {
  try {
    await pool.query(
      "UPDATE blobs SET doc_id = $2, updated_at = now() WHERE id = $1 AND doc_id IS NULL",
      [blobId, docId],
    );
  } catch (err) {
    // 23505 on `blobs_vault_sha_doc_idx` (migration 029): a concurrent upload
    // already claimed this content for the same doc. The other row is just as
    // good an answer — the bytes are identical by construction — so the caller
    // keeps the unclaimed row rather than getting a 500 for a race it won
    // nothing by losing.
    if ((err as { code?: string })?.code !== "23505") throw err;
    console.info(`[blobs] ${blobId} lost the adopt race for file ${docId}; leaving it unclaimed`);
  }
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
    // ── validation, all of it before a single byte of body is read ──────────
    const filename = c.req.header("x-file-name") ?? c.req.query("filename") ?? null;
    // `x-doc-id`: these bytes are a registered tree file, not an anonymous
    // drop. It decides both the path (the registry's, not the caller's) and
    // which ACL the write is judged against, so it is read before the gate.
    const claimedDoc = normalizeDocId(c.req.header("x-doc-id") ?? c.req.query("docId"));
    const located = await resolveBlobRelPath(
      vaultId,
      claimedDoc,
      c.req.header("x-rel-path") ?? c.req.query("relPath") ?? filename,
    );
    if (!located) {
      return c.json(
        {
          error: "Attachment path must be a vault-relative path under attachments/",
          code: "invalid_rel_path",
        },
        400,
      );
    }
    const { relPath, docId } = located;

    // Uploading is a write. A Read-only vault has to refuse it too, or
    // "read-only" would let anyone keep adding bytes to the vault's blob store;
    // for a tree file the gate is its own folder's (see `canWriteBlob`).
    if (!(await canWriteBlob(session.userId, { vault_id: vaultId, rel_path: relPath, doc_id: docId }))) {
      return c.json({ error: "This vault is read-only for you" }, 403);
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
      const hit = await findBlob(vaultId, claimedSha, docId);
      if (hit) return c.json({ ...toMeta(await claimDoc(hit, docId)), deduped: true }, 200);
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
      const existing = await findBlob(vaultId, sha256, docId);
      if (existing) {
        return c.json({ ...toMeta(await claimDoc(existing, docId)), deduped: true }, 200);
      }

      const id = randomUUID();
      // The object key follows the provider exactly as the intent route does
      // (`objectKey` for S3/R2, NULL for postgres whose key IS the row id):
      // `blobs_external_key_chk` refuses an external row with no key, so a
      // direct upload against an S3-backed server used to 500 here and only
      // the presign flow could ever store a byte.
      const storageKey = store.provider === "postgres" ? null : objectKey(vaultId, sha256);
      // The row is created `pending` and the bytes are written into it through
      // the store, then it is flipped to `ready` — the flow PR 2b's
      // intent → PUT → complete needs, run here inside one transaction so a
      // half-written blob is never visible to a reader or to dedupe.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<BlobRow>(
          `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                              storage_provider, storage_key, status, created_by, doc_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12, 'pending', $10, $11)
           ON CONFLICT DO NOTHING
           RETURNING ${BLOB_ROW_COLUMNS}`,
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
            docId,
            storageKey,
          ],
        );
        if (!inserted.rows[0]) {
          // Another request uploaded the same content between the dedupe read
          // and this insert. The per-doc unique index (migration 029) is what
          // settles it; the loser returns the winner's row rather than a 500.
          await client.query("ROLLBACK");
          const winner = await findBlob(vaultId, sha256, docId);
          if (winner) return c.json({ ...toMeta(await claimDoc(winner, docId)), deduped: true }, 200);
          return c.json({ error: "Upload conflicted — retry" }, 409);
        }
        await store.put(
          {
            key: storageKey ?? id,
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
        // After COMMIT: this row is the file's current content, so any older
        // ready row still claiming the same doc is a stale duplicate listing.
        await retireSupersededDocBlobs(docId, id);
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

/**
 * The ready row this upload may dedupe onto — content hash AND doc.
 *
 * `docId` is load-bearing, not a filter for tidiness. Keyed on `(vault, sha256)`
 * alone, two REGISTERED FILES holding identical bytes at different paths
 * collapsed into one row with one `rel_path` and one `doc_id`: the second file
 * never appeared in `GET /vaults/:id/blobs` (so a new device could not
 * materialize it), and deleting the FIRST file ran `deleteDocBlobs` over the
 * shared row and took the second one's bytes with it (migration 029).
 *
 * So a tree file matches only its OWN row, or an unclaimed one it can adopt
 * (`claimDoc`) — never another file's. An attachment (`docId` null) matches only
 * unclaimed rows, which keeps the zero-bytes-moved dedupe that makes a fresh
 * device settle a vault full of attachments cheaply. When both are on offer the
 * doc's own row wins, because adopting the unclaimed one would leave two rows
 * claiming the same content for the same doc.
 */
async function findBlob(
  vaultId: string,
  sha256: string,
  docId: string | null = null,
): Promise<BlobRow | undefined> {
  const { rows } = await pool.query<BlobRow>(
    `SELECT ${BLOB_ROW_COLUMNS}
       FROM blobs b
      WHERE b.vault_id = $1 AND b.sha256 = $2 AND b.status = 'ready'
        AND (
          b.doc_id IS NULL
          OR b.doc_id = $3
          -- A row bound to a file that NO LONGER EXISTS is not a claimant; it is
          -- bytes stranded on an id the resolver cannot answer for. claimDoc
          -- rebinds it rather than leaving it there.
          OR NOT EXISTS (SELECT 1 FROM files f WHERE f.id = b.doc_id)
        )
      ORDER BY (b.doc_id IS NOT DISTINCT FROM $3) DESC, (b.doc_id IS NULL) DESC,
               b.created_at ASC, b.id ASC
      LIMIT 1`,
    [vaultId, sha256, docId],
  );
  return rows[0];
}

/**
 * Retire any OTHER ready row still claiming this doc.
 *
 * A file's content changes: a new upload for the same `doc_id` carries a new
 * sha256, and migration 029's per-doc dedupe slot means it lands in a row of its
 * OWN rather than overwriting the old one. Left alone, `GET /vaults/:id/blobs`
 * would list the doc twice — two paths, two hashes — and the desktop's diff
 * would flap between them, re-downloading one over the other forever.
 *
 * Deleting the loser queues its object through migration 027's trigger, and the
 * drain re-checks for a live row on the key first, so a sibling that shares the
 * content keeps its bytes.
 */
async function retireSupersededDocBlobs(docId: string | null, keepBlobId: string): Promise<void> {
  if (!docId) return;
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM blobs WHERE doc_id = $1 AND id <> $2 AND status = 'ready'",
      [docId, keepBlobId],
    );
    if (rowCount) {
      console.info(`[blobs] retired ${rowCount} superseded row(s) for file ${docId}`);
    }
  } catch (err) {
    // Never fail an upload that has already landed over housekeeping — a stale
    // sibling is a duplicate listing, not lost content.
    console.warn(`[blobs] could not retire superseded rows for file ${docId}:`, err);
  }
}

/**
 * A dedupe hit that arrives WITH a doc_id, onto a row that has none, adopts it.
 *
 * This is the ordinary path for a file whose bytes a teammate already uploaded
 * as an attachment: the content is here, the registry now knows it as a tree
 * file, and without this the row would keep the weaker path-based ACL forever
 * because nobody ever sends those bytes again.
 *
 * One more case, and only one: the row already names a doc that NO LONGER
 * EXISTS. First-writer-wins is about two live files sharing bytes; a `files`
 * row that has been deleted is not a claimant, and leaving the binding there
 * strands the bytes on an id the resolver cannot answer for (`canReadAttachment`
 * then falls back to the path heuristic). A doc that is merely unreadable to
 * this caller is NOT gone — the check is existence, never permission, so a
 * Private file's blob keeps its owner's row.
 */
async function claimDoc(row: BlobRow, docId: string | null): Promise<BlobRow> {
  if (!docId || docId === row.doc_id) return row;
  if (!row.doc_id) {
    await adoptDocId(row.id, docId);
    return { ...row, doc_id: docId };
  }
  const { rows } = await pool.query("SELECT 1 FROM files WHERE id = $1", [row.doc_id]);
  if (rows.length > 0) return row;
  try {
    await pool.query(
      "UPDATE blobs SET doc_id = $2, updated_at = now() WHERE id = $1 AND doc_id = $3",
      [row.id, docId, row.doc_id],
    );
  } catch (err) {
    // 23505 on `blobs_vault_sha_doc_idx`: this doc already has a row for these
    // bytes, so the stranded one has nothing to offer it. Leave it — the pending
    // and orphan sweeps are what clear up rows nobody claims.
    if ((err as { code?: string })?.code !== "23505") throw err;
    return row;
  }
  console.info(`[blobs] ${row.id} was bound to the deleted file ${row.doc_id} — rebound to ${docId}`);
  return { ...row, doc_id: docId };
}

// ── intent → PUT → complete ───────────────────────────────────────────────

/** A pending or ready row, as the upload flow needs to see it. */
interface UploadRow {
  id: string;
  vault_id: string | null;
  org_id: string | null;
  sha256: string;
  size: string | number;
  mime: string | null;
  rel_path: string | null;
  filename: string | null;
  status: string;
  storage_provider: string | null;
  storage_key: string | null;
  doc_id: string | null;
}

const UPLOAD_ROW_COLUMNS =
  "id, vault_id, org_id, sha256, size, mime, rel_path, filename, status, storage_provider, storage_key, doc_id";

/**
 * Absolute origin for URLs this server hands a client.
 *
 * `BETTER_AUTH_URL` first, because that is what every other absolute URL here
 * is built from (`public-links.ts`, invitations, password reset) and it is the
 * address clients were told to use — the request's own `Host` may be an
 * internal load-balancer name. The request URL is the fallback for a
 * misconfigured `BETTER_AUTH_URL`, so a self-host that never set it still gets
 * a working upload URL instead of a relative one.
 */
function apiOrigin(c: Context): string {
  try {
    return new URL(config.betterAuthUrl).origin;
  } catch {
    /* fall through */
  }
  try {
    return new URL(c.req.url).origin;
  } catch {
    return "";
  }
}

/** What a vault is currently using, and what it is allowed. */
interface StorageUsage {
  usedBytes: number;
  pendingBytes: number;
  blobCount: number;
}

/**
 * Bytes this vault's blobs occupy.
 *
 * `pending` rows COUNT. They are an upload in flight or an abandoned one, and
 * both hold real bytes (the object is written before `complete` runs) — so
 * excluding them would let a client stay permanently over the limit by never
 * finishing. The pending sweep is what eventually frees an abandoned one.
 */
async function storageUsage(
  vaultId: string,
  excludeBlobId: string | null = null,
): Promise<StorageUsage> {
  const { rows } = await pool.query<{ used: string; pending: string; count: string }>(
    `SELECT coalesce(sum(size), 0)::bigint AS used,
            coalesce(sum(size) FILTER (WHERE status = 'pending'), 0)::bigint AS pending,
            count(*)::int AS count
       FROM blobs
      WHERE vault_id = $1
        AND status IN ('pending', 'ready')
        AND ($2::text IS NULL OR id <> $2)`,
    [vaultId, excludeBlobId],
  );
  return {
    usedBytes: Number(rows[0]?.used ?? 0),
    pendingBytes: Number(rows[0]?.pending ?? 0),
    blobCount: Number(rows[0]?.count ?? 0),
  };
}

/**
 * Storage quota. Answers the 402 body, or null when the upload fits.
 *
 * The ORDER this is called in is the load-bearing part: quota is the LAST gate,
 * after ACL and after the per-file caps, so a request that would be refused
 * anyway never costs a `sum()` over the vault's blobs. The limit lookup comes
 * before the sum for the same reason — an unlimited vault (self-host, or any
 * paid one) never runs the aggregate at all.
 *
 * `excludeBlobId` is for the defensive check at `complete`, where the blob's own
 * pending row is already inside the sum and would otherwise be counted twice.
 */
async function checkStorageQuota(
  vaultId: string,
  orgId: string,
  addedBytes: number,
  excludeBlobId: string | null = null,
): Promise<{ error: string; code: string; limitBytes: number; usedBytes: number } | null> {
  const limitBytes = await storageLimitBytes(orgId);
  if (limitBytes === null) return null;
  const { usedBytes } = await storageUsage(vaultId, excludeBlobId);
  if (usedBytes + addedBytes <= limitBytes) return null;
  return {
    error: `This vault has used its ${Math.round(limitBytes / (1024 * 1024))} MB of attachment storage`,
    code: "storage_limit_reached",
    limitBytes,
    usedBytes,
  };
}

/** A positive, integral byte count, or null. */
function normalizeSize(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Declare a file and get back either "already here" or somewhere to put it.
 *
 * Gate order is load-bearing and matches the legacy POST's: membership, then
 * WHERE this is going (the `docId`/rel_path resolution — which decides which
 * ACL applies, so it has to come first now that a tree file answers to its own
 * folder), then write access, then the rest of the shape (MIME), then the size
 * cap for that MIME on THIS provider, then quota. Each is cheaper than the one
 * after it, and all of them run before a byte moves.
 */
blobRoutes.post("/vaults/:vaultId/blobs/intent", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const vaultId = c.req.param("vaultId");
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Expected a JSON body", code: "invalid_body" }, 400);
  }

  const sha256 = normalizeSha(typeof body.sha256 === "string" ? body.sha256 : null);
  if (!sha256) {
    return c.json({ error: "sha256 must be 64 hex characters", code: "invalid_sha256" }, 400);
  }
  const size = normalizeSize(body.size);
  if (size === null) {
    return c.json({ error: "size must be a positive integer", code: "invalid_size" }, 400);
  }
  const filename = typeof body.filename === "string" ? body.filename : null;
  // `docId`: these bytes are a registered tree file. Same meaning as the legacy
  // POST's `x-doc-id` header — the path comes from the registry rather than the
  // request, and the write is gated on that file's folder.
  const claimedDoc = normalizeDocId(body.docId);
  const located = await resolveBlobRelPath(
    vaultId,
    claimedDoc,
    typeof body.relPath === "string" ? body.relPath : filename,
  );
  if (!located) {
    return c.json(
      {
        error: "Attachment path must be a vault-relative path under attachments/",
        code: "invalid_rel_path",
      },
      400,
    );
  }
  const { relPath, docId } = located;

  // Write access, now that we know WHAT is being written: a tree file answers
  // to its folder, an attachment to the vault posture (see `canWriteBlob`).
  if (!(await canWriteBlob(session.userId, { vault_id: vaultId, rel_path: relPath, doc_id: docId }))) {
    return c.json({ error: "This vault is read-only for you" }, 403);
  }

  const mime = normalizeMime(typeof body.mime === "string" ? body.mime : null) ||
    "application/octet-stream";
  if (!isAllowedMime(mime)) {
    if (BLOB_MIME_ENFORCE === "reject") {
      return c.json(
        { error: `Unsupported attachment type: ${mime}`, code: "unsupported_media_type" },
        415,
      );
    }
    console.warn(`[blobs] BLOB_MIME_ENFORCE=warn: intent for ${relPath} with unlisted mime ${mime}`);
  }

  const store = await createBlobStore();
  const sizeCap = Math.min(maxBytesForMime(mime), store.maxBytes(categoryForMime(mime)));
  if (size > sizeCap) {
    return c.json(
      {
        error: `Attachment too large for ${categoryForMime(mime)} (max ${sizeCap} bytes)`,
        code: "attachment_too_large",
      },
      413,
    );
  }

  // Already here → the answer is a blob id and NOT ONE BYTE of the file. This
  // is the case the whole flow exists for: a fresh device with a vault full of
  // attachments settles them all with one round trip each.
  const hit = await findBlob(vaultId, sha256, docId);
  if (hit) return c.json({ deduped: true, blob: toMeta(await claimDoc(hit, docId)) }, 200);

  const quota = await checkStorageQuota(vaultId, org, size);
  if (quota) return c.json(quota, 402);

  // An existing PENDING row for the same content is re-used rather than
  // conflicting: the per-doc unique index would refuse a second insert anyway, and
  // re-issuing the same blob id with a fresh presign is exactly what a client
  // retrying an interrupted upload needs. `updated_at` is bumped so the pending
  // sweep does not collect a row a client is actively working on.
  const existing = await pool.query<UploadRow>(
    `UPDATE blobs
        SET updated_at = now(),
            mime = $3,
            rel_path = $4,
            filename = $5,
            doc_id = coalesce(blobs.doc_id, $6)
      WHERE vault_id = $1 AND sha256 = $2 AND status = 'pending'
        AND (doc_id IS NULL OR doc_id = $6)
      RETURNING ${UPLOAD_ROW_COLUMNS}`,
    [vaultId, sha256, mime, relPath, filename, docId],
  );
  let row = existing.rows[0];

  if (!row) {
    const id = randomUUID();
    // Postgres has no object namespace (the bytes are the row's own column), so
    // its key IS the row id and `storage_key` stays NULL — which is what
    // migration 026's `blobs_external_key_chk` encodes.
    const storageKey = store.provider === "postgres" ? null : objectKey(vaultId, sha256);
    const inserted = await pool.query<UploadRow>(
      `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                          storage_provider, storage_key, status, created_by, doc_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING ${UPLOAD_ROW_COLUMNS}`,
      [id, vaultId, org, sha256, size, mime, relPath, filename, store.provider, storageKey,
        session.userId, docId],
    );
    row = inserted.rows[0];
    if (!row) {
      // Someone finished uploading this content between the dedupe read and the
      // insert. The winner's row is the answer, not a 409.
      const winner = await findBlob(vaultId, sha256, docId);
      if (winner) return c.json({ deduped: true, blob: toMeta(await claimDoc(winner, docId)) }, 200);
      return c.json({ error: "Upload conflicted — retry" }, 409);
    }
  }

  const origin = apiOrigin(c);
  const key = storageKeyForRow(row);
  const completeUrl = `${origin}/api/blobs/${encodeURIComponent(row.id)}/complete`;
  const presignInput = {
    key,
    blobId: row.id,
    vaultId,
    size,
    mime,
    sha256,
    origin,
    ...(typeof body.md5 === "string" ? { md5Base64: body.md5 } : {}),
  };

  try {
    // Over the provider's multipart threshold, a single PUT is a bad deal: no
    // resume, no parallelism, and one blip costs the whole transfer. AWS draws
    // the line at 100 MB and so do we.
    const threshold = store.multipartThresholdBytes;
    if (threshold !== null && size >= threshold) {
      const multi = await store.presignMultipart(presignInput);
      const { mintUploadToken } = await import("../../blobs/upload-token.js");
      const { UPLOAD_TOKEN_TTL_SECONDS } = await import("../../blobs/config.js");
      // The token is what `POST /api/blobs/:id/parts` authenticates: presigned
      // part URLs expire with everything else, and a long upload needs to ask
      // for more without re-running the whole intent gate.
      const token = await mintUploadToken(
        { blobId: row.id, vaultId, sha256, size, uploadId: multi.uploadId },
        UPLOAD_TOKEN_TTL_SECONDS,
      );
      return c.json(
        {
          blobId: row.id,
          upload: {
            kind: "multipart" as const,
            method: "PUT" as const,
            uploadId: multi.uploadId,
            partBytes: multi.partBytes,
            parts: multi.parts,
            headers: {},
            expiresAt: multi.expiresAt,
            direct: multi.direct,
            token,
            // Token already in the URL, the same way the single-PUT case works
            // — one fewer thing for a client to assemble by hand.
            partsUrl: `${origin}/api/blobs/${encodeURIComponent(row.id)}/parts?t=${encodeURIComponent(token)}`,
          },
          completeUrl,
        },
        200,
      );
    }

    const single = await store.presignUpload(presignInput);
    return c.json(
      {
        blobId: row.id,
        upload: {
          kind: "single" as const,
          method: single.method,
          url: single.url,
          headers: single.headers,
          expiresAt: single.expiresAt,
          direct: single.direct,
        },
        completeUrl,
      },
      200,
    );
  } catch (e) {
    return storeError(c, e);
  }
});

/** Read a blob row for the upload flow, by id. */
async function uploadRow(id: string): Promise<UploadRow | undefined> {
  const { rows } = await pool.query<UploadRow>(
    `SELECT ${UPLOAD_ROW_COLUMNS} FROM blobs WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * The bytes, for a provider whose upload URL points back here.
 *
 * NO SESSION: the `?t=` upload token IS the authorization, and it was minted by
 * an `intent` that ran every gate. See `blobs/upload-token.ts` for why that is
 * the right trade — in short, the token binds blob id, vault, sha256 and size,
 * so it can only write the exact content it was issued for, and the transport
 * is then free to be a raw stream from another process with no cookie jar.
 */
blobRoutes.put(
  "/blobs/:id/data",
  // Same reasoning as the legacy POST: the cap has to be enforced before the
  // body is read. This route only ever serves a provider that buffers (Postgres
  // today), so MAX_BLOB_BYTES — not MAX_BLOB_BYTES_DIRECT — is the right bound;
  // anything bigger is on a provider whose intent handed out a direct URL.
  bodyLimit({
    maxSize: MAX_BLOB_BYTES,
    onError: (c) => c.json({ error: "Attachment too large", code: "attachment_too_large" }, 413),
  }),
  async (c) => {
    const unauthorized = () =>
      c.json({ error: "Invalid or expired upload token", code: "invalid_upload_token" }, 401);

    const raw = c.req.query("t");
    if (!raw) return unauthorized();
    let claims;
    try {
      claims = await verifyUploadToken(raw);
    } catch {
      return unauthorized();
    }
    // A token for another blob is not a token for this one, whatever it says.
    if (claims.blobId !== c.req.param("id")) return unauthorized();

    const row = await uploadRow(claims.blobId);
    if (!row) return c.json({ error: "Blob not found" }, 404);
    if (row.vault_id !== claims.vaultId || !shaEquals(row.sha256, claims.sha256)) {
      return unauthorized();
    }
    if (row.status === "ready") {
      return c.json({ error: "This blob already has its bytes", code: "already_uploaded" }, 409);
    }

    const declared = claims.size;
    if (declared > MAX_BLOB_BYTES) {
      return c.json({ error: "Attachment too large", code: "attachment_too_large" }, 413);
    }
    if (!(await uploadBudget.acquire(declared))) {
      return c.json({ error: "Too many uploads in flight — retry shortly" }, 503, {
        "Retry-After": "5",
      });
    }
    try {
      const webBody = c.req.raw.body;
      if (!webBody) return c.json({ error: "empty body" }, 400);

      // Hash, count and sniff AS THE BYTES GO PAST, rather than buffering the
      // request and then walking it again. The store still decides what it does
      // with the stream (the Postgres provider collects it, because pg cannot
      // stream a parameter in), but nothing on this side holds a second copy.
      const hash = createHash("sha256");
      const head: Buffer[] = [];
      let headBytes = 0;
      let received = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          received += buf.byteLength;
          if (received > declared) {
            cb(new Error("size_mismatch"));
            return;
          }
          hash.update(buf);
          if (headBytes < SNIFF_BYTES) {
            const take = buf.subarray(0, SNIFF_BYTES - headBytes);
            head.push(take);
            headBytes += take.byteLength;
          }
          cb(null, buf);
        },
      });

      const store = await resolveStoreForRow(row);
      const key = storageKeyForRow(row);
      try {
        await store.put({
          key,
          blobId: row.id,
          vaultId: row.vault_id ?? "",
          body: Readable.fromWeb(webBody as never).pipe(meter),
          size: declared,
          mime: row.mime ?? "application/octet-stream",
          sha256: row.sha256,
          filename: row.filename,
          relPath: row.rel_path,
        });
      } catch (e) {
        if ((e as Error)?.message === "size_mismatch") {
          await store.delete(key).catch(() => {});
          return c.json(
            { error: "More bytes arrived than the upload declared", code: "size_mismatch" },
            400,
          );
        }
        return storeError(c, e);
      }

      // Verification. The row stays `pending` on a failure and only the bytes
      // are dropped, so the client may retry with the SAME token and blob id
      // rather than re-running intent; the sweep collects it if it never does.
      if (received !== declared) {
        await store.delete(key).catch(() => {});
        return c.json(
          { error: `Expected ${declared} bytes, received ${received}`, code: "size_mismatch" },
          400,
        );
      }
      const actual = hash.digest("hex");
      if (!shaEquals(actual, row.sha256)) {
        await store.delete(key).catch(() => {});
        return c.json(
          { error: "The bytes do not hash to the declared sha256", code: "sha_mismatch" },
          400,
        );
      }
      const mime = row.mime ?? "application/octet-stream";
      if (hasMagicSignature(mime)) {
        const sniffed = await sniffMime(Buffer.concat(head));
        if (!mimeMatchesBytes(mime, sniffed)) {
          await store.delete(key).catch(() => {});
          return c.json(
            {
              error: `Content-Type ${mime} does not match the uploaded bytes (${sniffed})`,
              code: "content_type_mismatch",
            },
            400,
          );
        }
      }
      // 204 and not the metadata: `complete` is what publishes the blob, and a
      // client that treated a 2xx here as "done" would have a blob nobody can
      // list. One meaning per step.
      return c.body(null, 204);
    } finally {
      uploadBudget.release(declared);
    }
  },
);

/**
 * More presigned part URLs for an upload already in flight.
 *
 * Authorized by the same upload token as the data PUT — a long multipart
 * transfer outlives its first batch of presigns, and re-running `intent` would
 * start a second multipart upload rather than continuing this one.
 */
blobRoutes.post("/blobs/:id/parts", async (c) => {
  const unauthorized = () =>
    c.json({ error: "Invalid or expired upload token", code: "invalid_upload_token" }, 401);

  const raw = c.req.query("t");
  if (!raw) return unauthorized();
  let claims;
  try {
    claims = await verifyUploadToken(raw);
  } catch {
    return unauthorized();
  }
  if (claims.blobId !== c.req.param("id") || !claims.uploadId) return unauthorized();

  const row = await uploadRow(claims.blobId);
  if (!row) return c.json({ error: "Blob not found" }, 404);
  if (row.status === "ready") {
    return c.json({ error: "This blob already has its bytes", code: "already_uploaded" }, 409);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    /* an empty body is legal — see the default below */
  }
  const requested = Array.isArray(body.partNumbers) ? body.partNumbers : [];
  const partNumbers = requested
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10_000);
  if (partNumbers.length === 0) {
    return c.json({ error: "partNumbers must be a non-empty array", code: "invalid_parts" }, 400);
  }

  try {
    const store = await resolveStoreForRow(row);
    const presigned = await store.presignParts(
      storageKeyForRow(row),
      claims.uploadId,
      partNumbers,
    );
    return c.json(presigned, 200);
  } catch (e) {
    return storeError(c, e);
  }
});

/**
 * Verify what landed and publish the blob.
 *
 * Session-gated again (the token's job ended with the bytes), because this is
 * the step that makes the blob visible to every other member of the vault.
 * Everything it checks is something the server can see WITHOUT the bytes having
 * passed through it: the object's real size, and the first 64 KB of it.
 *
 * What it does NOT do is re-hash the object. On a direct upload that would mean
 * streaming the whole file back out of the bucket to check a number the
 * authenticated uploader supplied about bytes only they ever held — see the
 * integrity note in `blobs/s3-store.ts`. Size and magic bytes are what actually
 * protect the store; the sha is the content ADDRESS.
 */
blobRoutes.post("/blobs/:id/complete", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const row = await uploadRow(c.req.param("id"));
  if (!row) return c.json({ error: "Blob not found" }, 404);

  const org = row.vault_id ? await vaultOrg(row.vault_id) : row.org_id;
  if (!org || !(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }
  if (row.vault_id && !(await canWriteBlob(session.userId, row))) {
    return c.json({ error: "This vault is read-only for you" }, 403);
  }

  // Idempotent: a client that retries `complete` (or two devices that finished
  // the same content) get the same metadata, not an error.
  if (row.status === "ready") return c.json(toMeta(row), 200);

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    /* no body is the single-PUT case */
  }

  const expected = Number(row.size);
  let store: BlobStore;
  let key: string;
  try {
    store = await resolveStoreForRow(row);
    key = storageKeyForRow(row);
  } catch (e) {
    return storeError(c, e);
  }

  /** Mismatch ⇒ the bytes are wrong, so neither they nor the row may survive:
   *  a pending row holds the dedupe slot, and leaving it would make the NEXT
   *  upload of this content adopt a blob that failed verification. */
  const reject = async (error: string, code: string) => {
    await store.delete(key).catch(() => {});
    await pool.query("DELETE FROM blobs WHERE id = $1 AND status = 'pending'", [row.id]);
    return c.json({ error, code }, 400);
  };

  // A client MAY restate the hash it uploaded. Disagreeing with the row means
  // the two sides are talking about different content — the bytes at this key
  // are not the bytes this blob id addresses — so it is rejected exactly like a
  // size or type mismatch, object and row together.
  const claimedSha = normalizeSha(typeof body.sha256 === "string" ? body.sha256 : null);
  if (claimedSha && !shaEquals(claimedSha, row.sha256)) {
    return reject(
      "sha256 does not match the blob this upload was opened for",
      "checksum_mismatch",
    );
  }

  try {
    const uploadId = typeof body.uploadId === "string" ? body.uploadId : null;
    if (uploadId) {
      const parts: CompletedPart[] = (Array.isArray(body.parts) ? body.parts : [])
        .map((p) => p as { partNumber?: unknown; etag?: unknown })
        .filter((p) => Number.isInteger(Number(p.partNumber)) && typeof p.etag === "string")
        .map((p) => ({ partNumber: Number(p.partNumber), etag: p.etag as string }));
      if (parts.length === 0) {
        return c.json(
          { error: "A multipart complete needs its parts", code: "invalid_parts" },
          400,
        );
      }
      await store.completeMultipart(key, uploadId, parts);
    }

    const head = await store.head(key);
    // No object at all: the bytes never arrived (or a multipart was never
    // completed). 409, not 404 — the BLOB exists, the upload is unfinished, and
    // the client's move is to send the bytes, not to start over.
    if (!head) {
      return c.json(
        { error: "No bytes have been uploaded for this blob yet", code: "upload_incomplete" },
        409,
      );
    }
    if (head.size !== expected) {
      return reject(`Expected ${expected} bytes, the object holds ${head.size}`, "size_mismatch");
    }

    const mime = row.mime ?? "application/octet-stream";
    if (hasMagicSignature(mime)) {
      // 64 KB, not 4: the zip family (docx/xlsx/pptx/zip) is told apart by an
      // entry name inside the archive rather than by its first four bytes.
      const peeked = await store.peek(key, SNIFF_BYTES);
      const sniffed = peeked ? await sniffMime(peeked) : null;
      if (!mimeMatchesBytes(mime, sniffed)) {
        return reject(
          `Content-Type ${mime} does not match the uploaded bytes (${sniffed})`,
          "content_type_mismatch",
        );
      }
    }

    // Quota again, defensively. `intent` already checked it, but the object
    // has been sitting in the store since then and OTHER uploads may have
    // landed in between; this is the last moment the bytes can be refused
    // before they become a listed attachment. The blob's own pending row is
    // excluded from the sum — it is already in there, and counting the same
    // bytes twice would refuse an upload that fits.
    if (row.vault_id) {
      const quota = await checkStorageQuota(row.vault_id, org, head.size, row.id);
      if (quota) {
        // Same disposal as a failed verification: the object goes, and the
        // pending row goes with it so it stops holding the dedupe slot.
        await store.delete(key).catch(() => {});
        await pool.query("DELETE FROM blobs WHERE id = $1 AND status = 'pending'", [row.id]);
        return c.json(quota, 402);
      }
    }

    const { rows } = await pool.query<BlobRow>(
      `UPDATE blobs SET status = 'ready', size = $2, updated_at = now()
        WHERE id = $1
        RETURNING ${BLOB_ROW_COLUMNS}`,
      [row.id, head.size],
    );
    await retireSupersededDocBlobs(rows[0]?.doc_id ?? row.doc_id, row.id);
    return c.json(toMeta(rows[0]), 200);
  } catch (e) {
    return storeError(c, e);
  }
});

// ── extracted text ────────────────────────────────────────────────────────

/** Biggest extracted body we store per blob. A 200-page docx is ~300 KB of
 *  text; past a megabyte the marginal ranking value is nil and the cost is a
 *  TOASTed row every search has to scan. The desktop truncates to match. */
const MAX_BLOB_TEXT_BYTES = 1024 * 1024;

/**
 * The plain text inside a file, as its own client extracted it.
 *
 * WHY THE CLIENT AND NOT THE SERVER. With a presigned direct upload the bytes
 * never touch this process at all, and the ones that do arrive in a container
 * sized for JSON and Yjs updates, not for running mammoth or a spreadsheet
 * parser over a 25 MB workbook. The desktop already has the file on disk, has
 * Rust and the parsers, and does the same work to render it — so it sends the
 * words and the server stores them.
 *
 * WHAT THIS TEXT IS FOR, and the trust that follows: ranking and nothing else.
 * It is never served back as the file's content (the bytes are), it is never an
 * authorization input, and a member who can upload could already write any
 * words they liked into a note. So a wrong or mischievous extraction buys
 * exactly one thing — bad search results for a file the caller could write
 * anyway. What IS checked is that the caller may write this blob, and that they
 * are describing the content the row addresses (`sha256`).
 *
 *   204 stored · 401 no session · 403 no write access · 404 unknown/not ready
 *   409 `sha_mismatch` · 413 `text_too_large`
 *
 * Idempotent: the same call twice is one row, rewritten.
 */
blobRoutes.put("/vaults/:vaultId/blobs/:blobId/text", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const vaultId = c.req.param("vaultId");
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }

  const row = await uploadRow(c.req.param("blobId"));
  // One 404 for "no such blob", "not this vault's blob" and "not ready": all
  // three mean the same thing to a client, and telling them apart would let a
  // member of one vault probe another's blob ids.
  if (!row || row.vault_id !== vaultId || row.status !== "ready") {
    return c.json({ error: "Blob not found" }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Expected a JSON body", code: "invalid_body" }, 400);
  }

  const content = typeof body.content === "string" ? body.content : null;
  if (content === null) {
    return c.json({ error: "content must be a string", code: "invalid_content" }, 400);
  }
  const sha256 = normalizeSha(typeof body.sha256 === "string" ? body.sha256 : null);
  if (!sha256) {
    return c.json({ error: "sha256 must be 64 hex characters", code: "invalid_sha256" }, 400);
  }

  // A `docId` here does the same job it does at intent: a file whose bytes were
  // already in the vault (a dedupe hit, a teammate's earlier upload) gets its
  // doc identity — and with it its real ACL — from whichever call learns it
  // first. The gate below then judges the ADOPTED id, never the claimed one.
  const claimedDoc = normalizeDocId(body.docId);
  if (claimedDoc && !row.doc_id) {
    const located = await resolveBlobRelPath(vaultId, claimedDoc, row.rel_path);
    if (located?.docId) {
      await adoptDocId(row.id, located.docId);
      row.doc_id = located.docId;
    }
  }

  // Write access, and for a tree file `edit` on the file itself: this text is
  // what the vault's search says the file contains, so writing it is a write to
  // that doc, not merely to the vault's blob store.
  if (!(await canWriteBlob(session.userId, row))) {
    return c.json({ error: "This vault is read-only for you" }, 403);
  }
  if (row.doc_id && !(await canEditDoc(session.userId, row.doc_id))) {
    return c.json({ error: "This file is read-only for you" }, 403);
  }

  // The hash is what ties the text to the bytes. Disagreeing means the client
  // extracted a DIFFERENT version of this file (an edit that has not been
  // uploaded yet, or a stale queue entry), and storing it would make search
  // describe content the vault does not hold.
  if (!shaEquals(sha256, row.sha256)) {
    return c.json(
      { error: "sha256 does not match the bytes this blob holds", code: "sha_mismatch" },
      409,
    );
  }

  // Measured in BYTES, not characters: the cap protects a Postgres row and a
  // request body, and one emoji is four of the former per one of the latter.
  if (Buffer.byteLength(content, "utf8") > MAX_BLOB_TEXT_BYTES) {
    return c.json(
      {
        error: `Extracted text must be at most ${MAX_BLOB_TEXT_BYTES} bytes`,
        code: "text_too_large",
      },
      413,
    );
  }

  // `pgText` for the same reason every other derived copy uses it: Postgres
  // `text` cannot hold U+0000, and text pulled out of a binary container is
  // exactly where a stray NUL comes from.
  const stored = pgText(content);
  const chars = Number.isInteger(body.chars) && (body.chars as number) >= 0
    ? (body.chars as number)
    : stored.length;
  const source = typeof body.source === "string" && body.source ? body.source : "client";

  await pool.query(
    `INSERT INTO blob_text (blob_id, vault_id, doc_id, chars, content, vector, source, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
     ON CONFLICT (blob_id) DO UPDATE
       SET vault_id = EXCLUDED.vault_id,
           doc_id = EXCLUDED.doc_id,
           chars = EXCLUDED.chars,
           content = EXCLUDED.content,
           vector = EXCLUDED.vector,
           source = EXCLUDED.source,
           updated_at = now()`,
    [row.id, vaultId, row.doc_id, chars, stored, JSON.stringify(embed(stored)), source],
  );

  return c.body(null, 204);
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

  // `status = 'ready'` only: a pending row is an upload in flight (or an
  // abandoned one), and listing it would tell the desktop's attachment diff a
  // file it cannot download already exists.
  const { rows } = await pool.query<BlobRow & { rel_path: string | null }>(
    `SELECT ${BLOB_ROW_COLUMNS}
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
  filename: string | null;
  size: string | number | null;
  status: string;
  storage_provider: string | null;
  storage_key: string | null;
  doc_id: string | null;
}

/** `bytes=<start>-<end?>`. Multi-range and suffix ranges are ignored (the whole
 *  object is served), which is what every store here can actually honour. */
function parseRange(header: string | undefined): { start: number; end?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d+)?$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? undefined : Number(m[2]);
  if (!Number.isFinite(start) || (end !== undefined && (!Number.isFinite(end) || end < start))) {
    return null;
  }
  return end === undefined ? { start } : { start, end };
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
    `SELECT id, vault_id, org_id, mime, rel_path, filename, size, status,
            storage_provider, storage_key, doc_id
       FROM blobs WHERE id = $1`,
    [id],
  );
  const blob = rows[0];
  if (!blob) return { deny: c.json({ error: "Blob not found" }, 404) };
  // A `pending` row is an upload in flight or an abandoned one: it has a
  // (vault, sha256) slot but no publishable bytes. The list route already hides
  // them, and a download has to agree or a client could fetch half a file.
  if (blob.status !== "ready") return { deny: c.json({ error: "Blob not found" }, 404) };

  // Membership is necessary but not sufficient (via the blob's note collection,
  // or its org_id fallback for legacy rows without vault_id).
  const org = blob.vault_id ? await vaultOrg(blob.vault_id) : blob.org_id;
  if (!org || !(await orgRole(org, session.userId))) {
    return { deny: c.json({ error: "Not a member of this vault" }, 403) };
  }
  // Per-attachment ACL: a scoped member may only download a blob referenced by
  // a note they can read (owner/admin + Open vaults are allowed everything).
  // Legacy rows without a vault_id keep membership-only access (no note to gate on).
  if (
    blob.vault_id &&
    !(await canReadAttachment(session.userId, blob.vault_id, blob.rel_path, blob.doc_id))
  ) {
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

/**
 * What the provider must pin onto the response — for S3 that means baking
 * `response-content-type` / `response-content-disposition` into the SIGNATURE,
 * so an object whose uploader set its metadata to `text/html` still comes back
 * as a download of the type the ROW says it is.
 */
function getOptionsFor(row: DownloadRow) {
  return {
    mime: row.mime || "application/octet-stream",
    filename: row.filename,
    disposition: "attachment" as const,
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
    const range = parseRange(c.req.header("range"));
    const result = await store.get(storageKeyForRow(blob), {
      ...getOptionsFor(blob),
      ...(range ? { range } : {}),
    });
    // s3 without `S3_PROXY_DOWNLOADS`: 302 to a short-lived presigned GET. This
    // is the BROWSER-context path (a public link, a webview `<img>`); the
    // desktop asks `GET /api/blobs/:id/url` instead, because reqwest forwards
    // `Authorization` across a redirect and S3 refuses a presign that arrives
    // with one.
    if (result.kind === "redirect") {
      return c.redirect(result.url, 302);
    }
    const headers = downloadHeaders(blob, result.size, result.acceptRanges);
    if (result.range) {
      return c.body(Readable.toWeb(result.body) as ReadableStream, 206, {
        ...headers,
        "Content-Range": `bytes ${result.range.start}-${result.range.end}/${result.totalSize}`,
      });
    }
    return c.body(Readable.toWeb(result.body) as ReadableStream, 200, headers);
  } catch (e) {
    return storeError(c, e);
  }
});

/**
 * Where to fetch the bytes from, as JSON.
 *
 * The desktop's transport uses this rather than following `GET /api/blobs/:id`'s
 * 302, for one concrete reason: reqwest does not strip `Authorization` when it
 * follows a redirect, and S3 rejects a request that carries both a presigned
 * signature and an `Authorization` header. A URL in a JSON body is fetched with
 * a clean client and no such collision.
 *
 * Same ACL as the download it replaces. The Postgres provider answers with a
 * same-origin URL to that very route and no expiry — there is nothing to
 * presign, and the client's bearer is what authorizes it.
 */
blobRoutes.get("/blobs/:id/url", async (c) => {
  const gate = await authorizeDownload(c);
  if ("deny" in gate) return gate.deny;
  const blob = gate.row;

  try {
    const store = await resolveStoreForRow(blob);
    if (store.provider === "postgres") {
      return c.json({
        url: `${apiOrigin(c)}/api/blobs/${encodeURIComponent(blob.id)}`,
        expiresAt: null,
        direct: false,
      });
    }
    const result = await store.get(storageKeyForRow(blob), getOptionsFor(blob));
    if (result.kind !== "redirect") {
      // `S3_PROXY_DOWNLOADS=1` — the bucket is deliberately not reachable by
      // clients, so the only URL worth handing out is this server's own.
      result.body.destroy();
      return c.json({
        url: `${apiOrigin(c)}/api/blobs/${encodeURIComponent(blob.id)}`,
        expiresAt: null,
        direct: false,
      });
    }
    return c.json({ url: result.url, expiresAt: result.expiresAt, direct: true });
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

// ── delete ────────────────────────────────────────────────────────────────

/**
 * Remove an attachment.
 *
 * There was no way to do this at all before: a blob could be uploaded and
 * never unmade, so a mistaken 25 MB drop stayed in the vault (and in every
 * teammate's sync) forever.
 *
 * A HARD delete, not a soft one. `blobs` has no tombstone and needs none — the
 * desktop's attachment diff is by content hash, so a row that is gone is simply
 * content the server does not have, and the object behind it is disposed of by
 * migration 027's `AFTER DELETE` trigger through the deletion queue. Nothing
 * here knows or cares whether the bytes were in Postgres or a bucket.
 *
 * The 409 is the interesting part. An attachment a note still embeds is not
 * garbage, and deleting it would leave a broken image in someone's document, so
 * the default answer is a refusal that NAMES the notes (`referencedBy`) — the
 * caller can then open them, or say `?force=1` and mean it.
 */
blobRoutes.delete("/blobs/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const row = await uploadRow(c.req.param("id"));
  if (!row) return c.json({ error: "Blob not found" }, 404);

  const org = row.vault_id ? await vaultOrg(row.vault_id) : row.org_id;
  if (!org || !(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }
  // Deleting is a write, and the same gate that decides who may ADD an
  // attachment decides who may take one away — a Read-only vault refuses both.
  if (row.vault_id && !(await canWriteBlob(session.userId, row))) {
    return c.json({ error: "This vault is read-only for you" }, 403);
  }

  const force = ["1", "true", "yes"].includes((c.req.query("force") ?? "").toLowerCase());
  if (!force && row.vault_id) {
    const referencedBy = await docsReferencing(row.vault_id, row.rel_path);
    if (referencedBy.length > 0) {
      return c.json(
        {
          error: "This attachment is still used by a note",
          code: "blob_referenced",
          referencedBy,
        },
        409,
      );
    }
  }

  await pool.query("DELETE FROM blobs WHERE id = $1", [row.id]);
  await purgeBlobText(row.id);

  return c.body(null, 204);
});

/**
 * Every blob that IS the tree file `docId`, gone.
 *
 * The file half of the delete above, exported because `DELETE /api/files/:id`
 * owns the row and this file owns the bytes — a registry route reaching into
 * `blobs` itself would be the second place that has to remember migration
 * 027's disposal queue and 028's text cache.
 *
 * No `blob_refs` check here, unlike the route: a doc-backed blob is the FILE,
 * and a note embed points at `attachments/…` (which never carries a `doc_id`),
 * so there is nothing for a reference to protect. Deleting the file IS the
 * decision. Answers how many rows went, for the caller's log line.
 */
export async function deleteDocBlobs(docId: string, vaultId: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    "DELETE FROM blobs WHERE doc_id = $1 AND vault_id = $2 RETURNING id",
    [docId, vaultId],
  );
  for (const row of rows) await purgeBlobText(row.id);
  return rows.length;
}

/**
 * Drop the extracted-text cache for a blob.
 *
 * Migration 028's FK does this on its own (`blob_id REFERENCES blobs ON DELETE
 * CASCADE`, and `vault_id` cascades from `vaults`), so this is belt and braces
 * rather than the mechanism — it is here because a derived cache has to die
 * with the row it describes, and the one place that is easy to get wrong is a
 * delete path somebody adds later that writes around the FK. The `to_regclass`
 * guard stays for the same reason it went in: this runs on a deployment that
 * may not have applied 028 yet (the routes ship before the migration lands).
 */
async function purgeBlobText(blobId: string): Promise<void> {
  try {
    const { rows } = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.blob_text') IS NOT NULL AS present",
    );
    if (!rows[0]?.present) return;
    await pool.query("DELETE FROM blob_text WHERE blob_id = $1", [blobId]);
  } catch (err) {
    // Never fatal: the blob row is already gone, and a stale cache row is a
    // bug to fix, not a reason to answer 500 for a delete that succeeded.
    console.warn(`[blobs] could not purge blob_text for ${blobId}:`, err);
  }
}

// ── quota ─────────────────────────────────────────────────────────────────

/**
 * How much attachment storage this vault uses, and how much it is allowed.
 *
 * Member-gated rather than write-gated: this is the number a client shows
 * BEFORE offering an upload, and someone who can only read the vault still
 * needs to understand why a teammate's upload was refused. It names no
 * individual blob, so it tells a scoped member nothing the per-blob ACL hides.
 *
 * `limitBytes: null` means unlimited — self-host with billing off, or any vault
 * with an active subscription — and is deliberately not `Infinity` or a huge
 * number, so a client renders "unlimited" instead of a meaningless bar.
 */
blobRoutes.get("/vaults/:vaultId/storage", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const vaultId = c.req.param("vaultId");
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this vault" }, 403);
  }

  const usage = await storageUsage(vaultId);
  const limitBytes = await storageLimitBytes(org);
  return c.json({ ...usage, limitBytes });
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
