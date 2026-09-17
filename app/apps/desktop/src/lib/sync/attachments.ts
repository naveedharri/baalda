// Attachment sync (Phase 3 blob store, spec 02 §2/§5A). Diffs the vault's local
// `attachments/` files against the server's blob list BY CONTENT HASH (sha256)
// and moves the delta both ways: upload local-only files, download server-only
// files into `attachments/`. Attachments never enter the note/CRDT pipeline —
// this is a plain content-addressed file mirror.
//
// The diff is pure and unit-tested in isolation; the `AttachmentSync` class
// wires it to injected I/O (ApiClient + Tauri ipc) and debounces watcher-driven
// reconciles so a burst of file events collapses into one pass.
//
// ── How bytes actually move ────────────────────────────────────────────────
// An upload is `intent → PUT → complete`, the SAME three steps whichever store
// the server keeps blobs in: the intent answers with a URL (our own route with
// a `?t=` upload token, or an S3/R2 presign) and the client never branches on
// the provider. Two things fall out of that: dedupe becomes a JSON round trip
// that moves ZERO bytes (the legacy route only said `deduped: true` AFTER a new
// device re-uploaded every attachment in full), and quota/MIME/size are
// answered before anything is sent.
//
// AUTHORIZATION IS THE POINT OF THE `direct` FLAG. An upload URL carries its
// own credential and NEVER gets our bearer — S3 rejects a request presenting
// both a presign and an `Authorization` header, and our own route's `?t=` query
// IS the auth. A download is the mirror image: `direct: true` is a presign and
// must be fetched clean; `direct: false` is our own `/api/blobs/:id`, where the
// bearer is required. That one rule lives in `downloadOne` below.
//
// A server that predates all this answers 404 on the intent; the client falls
// back to the legacy `POST /api/vaults/:id/blobs` and remembers, so exactly one
// upload pays for the probe.

import { mimeForPath as mimeForFormat } from "../formats";
import type {
  BlobCompleteBody,
  BlobDownloadTarget,
  BlobIntent,
  BlobUploadPart,
} from "../api";

/** Local attachment metadata (from `ipc.listAttachments`). */
export interface LocalAttachment {
  relPath: string;
  sha256: string;
  size?: number;
}

/** Server attachment metadata (from `api.listVaultBlobs`). */
export interface ServerBlob {
  id: string;
  sha256: string;
  relPath: string | null;
  size?: number;
  mime?: string | null;
}

export interface AttachmentDiff {
  /** Present locally, absent on the server → upload. */
  toUpload: LocalAttachment[];
  /** Present on the server, absent locally → download. */
  toDownload: ServerBlob[];
}

/**
 * Whether a server-supplied `relPath` is a safe attachment target to write to
 * disk. The server stores the uploader's `x-rel-path` header verbatim, so a
 * malicious member could set it to `.context/index.sqlite` or a note path and
 * have every teammate's client overwrite that file. We accept ONLY paths under
 * `attachments/`, with no traversal or dotfile/ignored segments — attachments
 * are the only thing this sync channel is allowed to place.
 */
export function isSafeAttachmentRelPath(relPath: string): boolean {
  if (!relPath) return false;
  // Normalize separators; reject Windows-style just in case.
  const parts = relPath.split(/[\\/]/);
  if (parts[0] !== "attachments" || parts.length < 2) return false;
  return parts.every(
    (seg) => seg !== "" && seg !== "." && seg !== ".." && !seg.startsWith("."),
  );
}

/**
 * Pure content-hash diff. A file is "the same" iff its sha256 matches; rel_path
 * is not part of identity (dedupe is by content), so a rename with unchanged
 * bytes is a no-op. Server blobs without a sha or a rel_path — or with a
 * relPath outside `attachments/` (see {@link isSafeAttachmentRelPath}) — can't
 * be placed on disk, so they're skipped from the download set.
 */
export function diffAttachments(
  local: LocalAttachment[],
  server: ServerBlob[],
): AttachmentDiff {
  const localShas = new Set(local.map((a) => a.sha256));
  const serverShas = new Set(server.map((b) => b.sha256));

  const toUpload = local.filter((a) => !serverShas.has(a.sha256));
  const toDownload = server.filter(
    (b) =>
      !!b.sha256 &&
      !!b.relPath &&
      isSafeAttachmentRelPath(b.relPath) &&
      !localShas.has(b.sha256),
  );
  return { toUpload, toDownload };
}

/**
 * The Content-Type an attachment uploads with.
 *
 * Delegates to the format registry (`lib/formats.ts`), which is the single
 * answer to "what IS this file?" — this used to be a second, drifting table
 * that knew `mov` as nothing and `ico` as the non-canonical
 * `image/x-icon`. Kept as an exported name because the sync layer and its
 * tests are written against it.
 */
export function mimeForPath(relPath: string): string {
  return mimeForFormat(relPath);
}

/** One byte range of a file: `[start, end)`, one multipart part. */
export interface AttachmentRange {
  start: number;
  end: number;
}

/** What a PUT answered, whether it went through Rust or the webview. */
export interface PutResult {
  status: number;
  etag?: string | null;
}

/**
 * Terminal for the whole pass, not just one file.
 *
 * The only member today is the storage quota: once the vault is full, every
 * remaining upload would fail the same way, and a hundred identical failures is
 * a hundred pointless round trips plus (without this) a hundred toasts.
 */
class AbortPass extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "AbortPass";
  }
}

/** The HTTP status a thrown API/transport error carries, when it carries one. */
function errStatus(e: unknown): number | null {
  if (!e || typeof e !== "object") return null;
  const s = (e as { status?: unknown }).status;
  return typeof s === "number" ? s : null;
}

/**
 * The server's machine-readable error code, read structurally rather than via
 * `instanceof`: this module is driven by injected deps in tests, and the shape
 * (`code`, or `error`/`code` inside `body`) is what both the real
 * `BlobTransportError` and a test's plain object have in common.
 */
function errCode(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const direct = (e as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const body = (e as { body?: unknown }).body;
  if (body && typeof body === "object") {
    const b = body as { code?: unknown; error?: unknown };
    if (typeof b.code === "string") return b.code;
    if (typeof b.error === "string") return b.error;
  }
  return null;
}

/**
 * Is this the invoke bridge saying the Rust command isn't there, rather than
 * the transfer failing?
 *
 * Only that answer justifies falling back to the webview — a real network
 * failure must NOT be retried through a path that has to load the whole file
 * into the JS heap first.
 */
function isMissingCommand(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /command .*not (found|allowed)|unknown command|not allowed by the scope/i.test(msg);
}

/**
 * Statuses that mean "this presigned URL is no longer good", as opposed to
 * "the upload failed". S3 answers 403 on an expired signature; our own route
 * answers 401 on a dead upload token. Either way the fix is a fresh URL, not a
 * failed file.
 */
const EXPIRED_PRESIGN: readonly number[] = [401, 403];

/** `attachments/a/b.png` → `b.png`. */
function baseName(relPath: string): string {
  const parts = relPath.split("/");
  return parts[parts.length - 1] ?? relPath;
}

/** Injected I/O so the sync loop is testable without Tauri or a live server. */
export interface AttachmentSyncDeps {
  /**
   * Is the vault this sync was built for still the open one? Every pass and
   * every debounced fire consults it, so a reconcile that spans a vault switch
   * stops instead of uploading the NEW vault's attachments into the OLD vault's
   * blob store (and downloading the old vault's into the new folder). Defaults
   * to always-current when omitted (unit tests).
   */
  isCurrent?: () => boolean;
  /** List local attachment files under `attachments/`. */
  listLocal: () => Promise<LocalAttachment[]>;
  /** Read a local attachment's bytes (vault-relative path). */
  readLocal: (relPath: string) => Promise<Uint8Array>;
  /** Atomically write bytes to a vault-relative path (creates dirs). */
  writeLocal: (relPath: string, bytes: Uint8Array) => Promise<void>;
  /** List the server's blobs for this vault. */
  listServer: () => Promise<ServerBlob[]>;
  /** LEGACY upload: POST the whole body in one shot. The fallback for a server
   *  with no intent route, and the reason that route stays forever. */
  uploadServer: (relPath: string, bytes: Uint8Array, mime: string) => Promise<void>;
  /** LEGACY download: GET `/api/blobs/:id` and hand back the bytes. */
  downloadServer: (id: string) => Promise<Uint8Array>;

  // ---- The intent → PUT → complete transport (all optional) ---------------
  // Every one of these is optional so a caller (or a test) can wire up as much
  // of the flow as it has; absent means "this server/host can't do that step",
  // and the legacy pair above is what runs instead.

  /** Announce an upload. Throws 404 on a server that predates the flow. */
  createIntent?: (input: {
    relPath: string;
    sha256: string;
    size: number;
    mime: string;
    filename: string;
  }) => Promise<BlobIntent>;
  /** POST the intent's `completeUrl` once every byte is in. Idempotent. */
  completeUpload?: (completeUrl: string, body: BlobCompleteBody) => Promise<void>;
  /** Re-mint presigned part URLs whose own presign expired mid-upload. */
  requestParts?: (
    partsUrl: string,
    partNumbers: number[],
  ) => Promise<{ parts: BlobUploadPart[] }>;
  /** Stream a file (or one range of it) to a URL from Rust — the fast path. */
  putFile?: (input: {
    relPath: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    range?: AttachmentRange;
  }) => Promise<PutResult>;
  /** PUT bytes from the webview — the fallback when Rust can't (tests). */
  putBytes?: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    bytes: Uint8Array;
  }) => Promise<PutResult>;
  /** Ask where a blob's bytes are right now (presign or our own route). */
  downloadUrl?: (blobId: string) => Promise<BlobDownloadTarget>;
  /** Stream a URL to disk from Rust, hash-verified and atomic. */
  fetchToFile?: (input: {
    url: string;
    relPath: string;
    headers: Record<string, string>;
    expectedSha256?: string | null;
  }) => Promise<{ status: number; bytes: number }>;
  /** GET bytes from a (possibly presigned) URL in the webview — fallback. */
  fetchBytes?: (url: string, headers: Record<string, string>) => Promise<Uint8Array>;
  /**
   * Headers proving who we are, for a download URL that is OUR OWN route.
   *
   * Never applied to a `direct` (presigned) URL — see the module header. Kept
   * as a dep rather than read from the api client so the rule is exercised by
   * the unit tests that assert a presign is fetched clean.
   */
  authHeaders?: () => Record<string, string>;
  /** Tell the user something terminal happened (a full vault). */
  notify?: (text: string, tone?: "error" | "neutral" | "success") => void;
}

export interface ReconcileResult {
  uploaded: number;
  downloaded: number;
}

export class AttachmentSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;
  /**
   * Does this server speak the intent flow? `null` = not asked, `false` = it
   * answered 404 and every later upload goes straight to the legacy route.
   * Mirrors (and is seeded by) the api client's own per-server tri-state; kept
   * here too so ONE file pays for the probe even when the deps are hand-wired.
   */
  private intentSupported: boolean | null = null;
  /** Same, for `GET /api/blobs/:id/url`. */
  private downloadUrlSupported: boolean | null = null;
  /**
   * Is the Rust streaming transport available? Flipped once, permanently, when
   * the invoke bridge says the command isn't there — never on a transfer
   * failure, which would push a 500 MB file through the JS heap for nothing.
   */
  private rustTransport = true;
  /**
   * Files the server has PERMANENTLY refused (413 too large, 415 wrong type),
   * keyed by content hash because that is what identity means here. Retrying
   * them every pass is a guaranteed failure per pass, forever. Keyed by sha rather
   * than path so a rename does not resurrect the attempt.
   */
  private readonly permanentSkips = new Set<string>();
  /** The storage-full toast is raised at most once per sync instance. */
  private storageLimitNotified = false;

  constructor(
    private readonly deps: AttachmentSyncDeps,
    private readonly debounceMs = 400,
    private readonly setTimeoutImpl: typeof setTimeout = setTimeout,
    private readonly clearTimeoutImpl: typeof clearTimeout = clearTimeout,
  ) {}

  /** Is the vault this sync belongs to still the open one? */
  private current(): boolean {
    return this.deps.isCurrent?.() ?? true;
  }

  /** Run one full reconcile pass now. Coalesces if one is already in flight. */
  async reconcile(): Promise<ReconcileResult> {
    if (!this.current()) return { uploaded: 0, downloaded: 0 };
    if (this.running) {
      // Ensure the in-flight pass runs again to pick up whatever changed.
      this.rerun = true;
      return { uploaded: 0, downloaded: 0 };
    }
    this.running = true;
    let result: ReconcileResult = { uploaded: 0, downloaded: 0 };
    try {
      do {
        this.rerun = false;
        result = await this.pass();
      } while (this.rerun && this.current());
    } finally {
      this.running = false;
    }
    return result;
  }

  private async pass(): Promise<ReconcileResult> {
    // Listing is the one step outside a per-file try/catch, and it is the step
    // that fails routinely: the local read is epoch-pinned (so Rust REJECTS it the
    // moment the vault changes) and the server read fails whenever we're offline.
    // Both mean "no pass this time", not an exception for the caller — which
    // matters because every call site is fire-and-forget.
    let local: LocalAttachment[];
    let server: ServerBlob[];
    try {
      [local, server] = await Promise.all([this.deps.listLocal(), this.deps.listServer()]);
    } catch (e) {
      console.warn("[attachments] listing failed — skipping this pass", e);
      return { uploaded: 0, downloaded: 0 };
    }
    if (!this.current()) return { uploaded: 0, downloaded: 0 };
    const { toUpload, toDownload } = diffAttachments(local, server);

    let uploaded = 0;
    let downloaded = 0;
    for (const a of toUpload) {
      // Re-checked per file: a big vault is hundreds of awaits, and every one of
      // them is a chance for the user to switch vaults. Continuing would upload
      // the NEW vault's files into the OLD vault's blob store.
      if (!this.current()) break;
      // A file the server has already refused for good (too large, wrong type)
      // is skipped without a round trip — see `permanentSkips`.
      if (this.permanentSkips.has(a.sha256)) continue;
      try {
        if (await this.uploadOne(a)) uploaded++;
      } catch (e) {
        if (e instanceof AbortPass) {
          // Nothing else in this pass can succeed either. Downloads are skipped
          // too: the vault is full, and the next pass will find the same state.
          console.warn("[attachments] pass aborted:", e.reason);
          return { uploaded, downloaded };
        }
        console.error("[attachments] upload failed", a.relPath, e);
      }
    }
    for (const b of toDownload) {
      if (!this.current()) break;
      try {
        await this.downloadOne(b);
        downloaded++;
      } catch (e) {
        console.error("[attachments] download failed", b.relPath, e);
      }
    }
    return { uploaded, downloaded };
  }

  // ---- Upload ------------------------------------------------------------

  /**
   * Move one local-only attachment to the server. Returns whether it counts as
   * uploaded (a dedupe does — the server has the bytes, which is the point).
   *
   * Throws {@link AbortPass} when the failure is the vault's, not the file's.
   */
  private async uploadOne(a: LocalAttachment): Promise<boolean> {
    const mime = mimeForPath(a.relPath);
    // Read lazily and at most once: the deduped path must move NO bytes and
    // must not even open the file, which is what makes a second device's first
    // sync a few JSON round trips instead of re-uploading the whole store.
    let cached: Uint8Array | null = null;
    const loadBytes = async (): Promise<Uint8Array> => {
      if (!cached) cached = await this.deps.readLocal(a.relPath);
      return cached;
    };

    if (!this.deps.createIntent || this.intentSupported === false) {
      await this.deps.uploadServer(a.relPath, await loadBytes(), mime);
      return true;
    }

    let intent: BlobIntent;
    try {
      intent = await this.deps.createIntent({
        relPath: a.relPath,
        sha256: a.sha256,
        size: a.size ?? (await loadBytes()).byteLength,
        mime,
        filename: baseName(a.relPath),
      });
      this.intentSupported = true;
    } catch (e) {
      const status = errStatus(e);
      if (status === 404) {
        // A server from before this flow. Remembered, so the NEXT file skips
        // the probe entirely rather than paying a 404 each time.
        this.intentSupported = false;
        await this.deps.uploadServer(a.relPath, await loadBytes(), mime);
        return true;
      }
      if (status === 402) {
        this.notifyStorageLimit();
        throw new AbortPass(errCode(e) ?? "storage_limit_reached");
      }
      if (status === 413 || status === 415) {
        // Permanent for these bytes: the file is over the cap or of a type the
        // server refuses. Retrying it every pass is a guaranteed failure every
        // pass — mark it and move on.
        this.permanentSkips.add(a.sha256);
        console.warn(
          `[attachments] ${a.relPath} refused permanently (${status} ${errCode(e) ?? "?"}) — skipping`,
        );
        return false;
      }
      throw e;
    }

    if ("deduped" in intent && intent.deduped) return true; // zero bytes moved
    if (!("upload" in intent)) throw new Error("intent answered with no upload target");
    const { upload, completeUrl } = intent;

    if (upload.kind === "single") {
      const put = () =>
        this.putOnce(a, {
          url: upload.url,
          method: upload.method ?? "PUT",
          headers: upload.headers ?? {},
          loadBytes,
        });
      await put();
      await this.completeUpload(completeUrl, () => ({}), put);
      return true;
    }

    // Multipart: part n is `[(n-1)*partBytes, n*partBytes)`, 1-based like S3.
    const size = a.size ?? (await loadBytes()).byteLength;
    const known = new Map(upload.parts.map((p) => [p.partNumber, p.url]));
    let parts: Array<{ partNumber: number; etag: string }> = [];
    const runParts = async () => {
      const out: Array<{ partNumber: number; etag: string }> = [];
      const count = Math.max(1, Math.ceil(size / upload.partBytes));
      for (let n = 1; n <= count; n++) {
        if (!this.current()) throw new Error("vault changed mid-upload");
        const range = {
          start: (n - 1) * upload.partBytes,
          end: Math.min(n * upload.partBytes, size),
        };
        // A part URL we were never given — or one whose presign died while the
        // earlier parts were in flight — is re-minted rather than failing the
        // whole file. `partsUrl` carries its own token.
        let url = known.get(n) ?? (await this.freshPartUrl(upload.partsUrl, n, known));
        let res = await this.putOnce(a, {
          url,
          method: upload.method ?? "PUT",
          headers: upload.headers ?? {},
          range,
          loadBytes,
          tolerate: EXPIRED_PRESIGN,
        });
        if (EXPIRED_PRESIGN.includes(res.status)) {
          url = await this.freshPartUrl(upload.partsUrl, n, known);
          res = await this.putOnce(a, {
            url,
            method: upload.method ?? "PUT",
            headers: upload.headers ?? {},
            range,
            loadBytes,
          });
        }
        const etag = res.etag;
        if (!etag) throw new Error(`part ${n} of ${a.relPath} came back without an ETag`);
        out.push({ partNumber: n, etag });
      }
      return out;
    };
    parts = await runParts();
    await this.completeUpload(
      completeUrl,
      () => ({ uploadId: upload.uploadId, parts }),
      async () => {
        parts = await runParts();
      },
    );
    return true;
  }

  /**
   * One PUT, through Rust when it is there and the webview when it is not.
   *
   * No `Authorization` is ever added here: `headers` came from the intent and
   * is the complete set the presign signed (see the module header).
   */
  private async putOnce(
    a: LocalAttachment,
    t: {
      url: string;
      method: string;
      headers: Record<string, string>;
      range?: AttachmentRange;
      loadBytes: () => Promise<Uint8Array>;
      /** Statuses to hand back instead of throwing (an expired presign). */
      tolerate?: readonly number[];
    },
  ): Promise<PutResult> {
    let res: PutResult | null = null;
    if (this.deps.putFile && this.rustTransport) {
      try {
        res = await this.deps.putFile({
          relPath: a.relPath,
          url: t.url,
          method: t.method,
          headers: t.headers,
          range: t.range,
        });
      } catch (e) {
        if (!isMissingCommand(e) || !this.deps.putBytes) throw e;
        // Only "the command isn't there" earns the fallback, and only once.
        this.rustTransport = false;
        console.warn("[attachments] Rust transport unavailable — using the webview", e);
      }
    }
    if (!res) {
      if (!this.deps.putBytes) throw new Error("no attachment upload transport available");
      const bytes = await t.loadBytes();
      res = await this.deps.putBytes({
        url: t.url,
        method: t.method,
        headers: t.headers,
        bytes: t.range ? bytes.subarray(t.range.start, t.range.end) : bytes,
      });
    }
    const ok = res.status >= 200 && res.status < 300;
    if (!ok && !(t.tolerate ?? []).includes(res.status)) {
      throw Object.assign(new Error(`upload PUT failed: HTTP ${res.status}`), {
        status: res.status,
      });
    }
    return res;
  }

  /** Fresh presigned URL for one part, remembered for a retry of the same part. */
  private async freshPartUrl(
    partsUrl: string,
    partNumber: number,
    known: Map<number, string>,
  ): Promise<string> {
    if (!this.deps.requestParts) throw new Error(`no URL for part ${partNumber}`);
    const { parts } = await this.deps.requestParts(partsUrl, [partNumber]);
    for (const p of parts) known.set(p.partNumber, p.url);
    const url = known.get(partNumber);
    if (!url) throw new Error(`server returned no URL for part ${partNumber}`);
    return url;
  }

  /**
   * Finish the upload. `upload_incomplete` means the server cannot see every
   * byte yet — the PUT is what to retry, not the complete.
   */
  private async completeUpload(
    completeUrl: string,
    body: () => BlobCompleteBody,
    retryPut: () => Promise<unknown>,
  ): Promise<void> {
    const complete = this.deps.completeUpload;
    if (!complete) throw new Error("no way to complete an upload");
    try {
      await complete(completeUrl, body());
    } catch (e) {
      if (errCode(e) !== "upload_incomplete") throw e;
      await retryPut();
      await complete(completeUrl, body());
    }
  }

  /** One toast per sync instance — a full vault is one fact, not one per file. */
  private notifyStorageLimit(): void {
    if (this.storageLimitNotified) return;
    this.storageLimitNotified = true;
    this.deps.notify?.(
      "This vault is out of attachment storage — new files won't sync until you free space or upgrade.",
      "error",
    );
  }

  // ---- Download ----------------------------------------------------------

  /**
   * Bring one server-only attachment down.
   *
   * The URL is asked for rather than followed from a 302, because reqwest
   * forwards `Authorization` across a redirect and a presigned S3 URL rejects a
   * request that carries one. `direct` then decides the headers, and that is the
   * whole rule: presign ⇒ nothing, our own route ⇒ the bearer.
   */
  private async downloadOne(b: ServerBlob): Promise<void> {
    const relPath = b.relPath as string;
    let target: BlobDownloadTarget | null = null;
    if (this.deps.downloadUrl && this.downloadUrlSupported !== false) {
      try {
        target = await this.deps.downloadUrl(b.id);
        this.downloadUrlSupported = true;
      } catch (e) {
        if (errStatus(e) !== 404) throw e;
        // A server that predates the presigned download: legacy from here on.
        this.downloadUrlSupported = false;
      }
    }

    if (target) {
      const headers = target.direct ? {} : (this.deps.authHeaders?.() ?? {});
      if (this.deps.fetchToFile && this.rustTransport) {
        try {
          await this.deps.fetchToFile({
            url: target.url,
            relPath,
            headers,
            expectedSha256: b.sha256,
          });
          return;
        } catch (e) {
          if (!isMissingCommand(e)) throw e;
          this.rustTransport = false;
          console.warn("[attachments] Rust transport unavailable — using the webview", e);
        }
      }
      if (this.deps.fetchBytes) {
        await this.deps.writeLocal(relPath, await this.deps.fetchBytes(target.url, headers));
        return;
      }
    }

    // Legacy: the server proxies the bytes on `/api/blobs/:id`.
    await this.deps.writeLocal(relPath, await this.deps.downloadServer(b.id));
  }

  /** Debounced reconcile — collapses a burst of watcher events into one pass. */
  scheduleReconcile(): void {
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      if (!this.current()) return;
      void this.reconcile().catch((e) =>
        console.warn("[attachments] debounced reconcile failed", e),
      );
    }, this.debounceMs);
  }

  /**
   * Drop the pending debounced pass. MUST be called when the vault this sync
   * belongs to stops being current: dereferencing the instance is not enough —
   * a live `setTimeout` keeps it (and its captured vaultId) alive and would fire
   * a reconcile against the vault the user just left.
   */
  stop(): void {
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  /** True while a debounced pass is still armed (teardown assertions/tests). */
  hasPendingReconcile(): boolean {
    return this.timer != null;
  }
}
