import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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

/**
 * Max attachment upload size, and the admission budget that bounds how many
 * uploads may be in flight at once.
 *
 * Sizing rationale (this process runs with V8 capped at 512 MB inside a 1 GiB
 * container, see Dockerfile / railway.json): storing an N-byte blob costs
 * several multiples of N on the heap at peak, because node-postgres has no
 * binary parameter protocol — the bytes must be rendered into a text-encodable
 * form and then serialized into the outgoing wire buffer. With the base64
 * encoding used below that is roughly N (body) + 1.33N (base64) + 1.33N (pg's
 * write buffer) ≈ 3.7N. A 100 MB cap therefore put a SINGLE legal upload at
 * ~370 MB of a 512 MB heap, and two concurrent ones over the container.
 *
 * So: a cap that is generous for real attachments (images, PDFs, short clips)
 * but survivable at ~3.7x, plus a global byte budget so concurrency cannot
 * stack peaks. Both are env-overridable for operators who have sized their
 * container differently. Deliberately local to this file rather than added to
 * config.ts.
 */
const MAX_BLOB_BYTES = positiveEnvInt("MAX_BLOB_BYTES", 25 * 1024 * 1024); // 25 MB

/**
 * Total upload-body bytes admitted concurrently. Must be >= MAX_BLOB_BYTES or a
 * single max-size upload could never be admitted; the budget is what stops N
 * simultaneous uploads from summing past the heap. At the default 50 MB the
 * worst case is ~185 MB of peak heap for uploads.
 */
const MAX_INFLIGHT_UPLOAD_BYTES = Math.max(
  MAX_BLOB_BYTES,
  positiveEnvInt("MAX_INFLIGHT_UPLOAD_BYTES", 2 * MAX_BLOB_BYTES),
);

/** Requests allowed to WAIT for budget before we start shedding with 503. */
const MAX_UPLOAD_QUEUE = 16;

/** How long a queued upload waits for budget before giving up with 503. */
const UPLOAD_WAIT_MS = 30_000;

function positiveEnvInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/**
 * FIFO admission control over a byte budget.
 *
 * Peak memory on the upload path is proportional to the size of the bodies
 * being handled, and nothing else bounded it: the size cap limited one request
 * while any number of compliant requests could run at once. Callers reserve
 * their (declared, clamped) body size before touching the body and release it
 * when done.
 *
 * Exported so it can be unit-tested without a database or an HTTP server.
 */
export class ByteBudget {
  private inflight = 0;
  private readonly waiters: Array<{
    bytes: number;
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private readonly budget: number,
    private readonly maxQueue: number = MAX_UPLOAD_QUEUE,
    private readonly waitMs: number = UPLOAD_WAIT_MS,
  ) {}

  /** Bytes currently reserved. Test/observability helper. */
  get reserved(): number {
    return this.inflight;
  }

  /** Requests currently waiting for budget. Test/observability helper. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Reserve `bytes`. Resolves true once admitted, false if the queue is
   * saturated or the wait timed out (caller should shed the request).
   *
   * `inflight === 0` always admits, so a request larger than the whole budget
   * still makes progress instead of deadlocking. Admission is strictly FIFO —
   * a newcomer never jumps a queue — so a large upload can't be starved by a
   * stream of small ones.
   */
  acquire(bytes: number): Promise<boolean> {
    if (this.waiters.length === 0 && this.fits(bytes)) {
      this.inflight += bytes;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= this.maxQueue) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = {
        bytes,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, this.waitMs),
      };
      // Never hold the process open just for a queued upload.
      if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /** Give back a previous successful reservation. Always call from a `finally`. */
  release(bytes: number): void {
    this.inflight -= bytes;
    if (this.inflight < 0) this.inflight = 0;
    while (this.waiters.length > 0 && this.fits(this.waiters[0].bytes)) {
      const waiter = this.waiters.shift() as (typeof this.waiters)[number];
      clearTimeout(waiter.timer);
      this.inflight += waiter.bytes;
      waiter.resolve(true);
    }
  }

  private fits(bytes: number): boolean {
    return this.inflight === 0 || this.inflight + bytes <= this.budget;
  }
}

const uploadBudget = new ByteBudget(MAX_INFLIGHT_UPLOAD_BYTES);

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
      const buf = Buffer.from(ab);

      const mime = c.req.header("content-type") || "application/octet-stream";
      const filename = c.req.header("x-file-name") ?? c.req.query("filename") ?? null;
      const relPath = c.req.header("x-rel-path") ?? c.req.query("relPath") ?? filename;
      const sha256 = createHash("sha256").update(buf).digest("hex");

      // Dedupe per vault by content hash: return the existing row if present.
      // Doing this before any encoding means a re-upload of known content never
      // pays the encode/serialize cost at all.
      const existing = await pool.query<BlobRow>(
        `SELECT id, sha256, size, mime, rel_path, filename
           FROM blobs WHERE vault_id = $1 AND sha256 = $2`,
        [vaultId, sha256],
      );
      if (existing.rows[0]) {
        return c.json({ ...toMeta(existing.rows[0]), deduped: true }, 200);
      }

      const id = randomUUID();
      // base64 + server-side `decode`, not a raw Buffer parameter. node-postgres
      // has no binary parameter protocol: handed a Buffer it renders it as a
      // `\x…` HEX string, i.e. 2 bytes of JS string per payload byte, and then
      // serializes that into the outgoing buffer — ~4N on top of the body.
      // base64 is 1.33 bytes per payload byte, so this cuts the dominant
      // allocation on the upload path by a third. Bytes stored are identical.
      const { rows } = await pool.query<BlobRow>(
        `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, data, rel_path, filename)
         VALUES ($1, $2, $3, $4, $5, $6, decode($7::text, 'base64'), $8, $9)
         RETURNING id, sha256, size, mime, rel_path, filename`,
        [
          id,
          vaultId,
          org,
          sha256,
          buf.byteLength,
          mime,
          buf.toString("base64"),
          relPath,
          filename,
        ],
      );
      return c.json({ ...toMeta(rows[0]), deduped: false }, 201);
    } finally {
      uploadBudget.release(reserve);
    }
  },
);

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
  // Metadata FIRST, deliberately without `data`. Selecting the bytes up front
  // meant every request — including the ones about to be rejected with 403 —
  // materialized the whole blob several times over (pg renders BYTEA as a hex
  // string twice the blob's size before decoding it to a Buffer). Now only a
  // caller who passes both gates can make the process allocate anything large.
  const { rows } = await pool.query<{
    vault_id: string | null;
    org_id: string | null;
    mime: string | null;
    rel_path: string | null;
  }>("SELECT vault_id, org_id, mime, rel_path FROM blobs WHERE id = $1", [id]);
  const blob = rows[0];
  if (!blob) return c.json({ error: "Blob not found" }, 404);

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

  // Authorized: now fetch the bytes.
  //
  // KNOWN LIMITATION (not fixed here, on purpose): this is still a single
  // whole-blob read, so peak heap is a few multiples of the blob size and there
  // is no streaming. node-postgres cannot stream a BYTEA column, so fixing it
  // properly means either large-object support or chunked reads
  // (`substring(data from $2 for $3)`), and the chunked route only performs if
  // the column is also switched to uncompressed storage (`ALTER TABLE blobs
  // ALTER COLUMN data SET STORAGE EXTERNAL`) — otherwise every chunk detoasts
  // the entire value. That is a restructuring of the pg access path with its own
  // correctness surface, so it is written up as a recommendation rather than
  // attempted. The lowered MAX_BLOB_BYTES bounds the damage meanwhile.
  const { rows: dataRows } = await pool.query<{ data: Buffer | null }>(
    "SELECT data FROM blobs WHERE id = $1",
    [id],
  );
  const data = dataRows[0]?.data;
  if (!data) return c.json({ error: "Blob not found" }, 404);

  // The stored MIME is attacker-controlled (taken verbatim from the uploader's
  // content-type). Serve every blob as a non-rendering download: `nosniff`
  // stops the browser MIME-sniffing it into an active document, and
  // `Content-Disposition: attachment` forces a download rather than inline
  // rendering — so a stored text/html blob can't execute as script in the API
  // origin. The desktop reads the raw bytes regardless of these headers.
  return c.body(data, 200, {
    "Content-Type": blob.mime || "application/octet-stream",
    "Content-Length": String(data.byteLength),
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "attachment",
  });
});
