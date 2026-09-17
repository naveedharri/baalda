// Binary sync (Phase 3 blob store, spec 02 §2/§5A). Diffs the vault's local
// binaries against the server's blob list BY CONTENT HASH (sha256) and moves
// the delta both ways: upload local-only files, download server-only files onto
// disk. Binaries never enter the note/CRDT pipeline — this is a plain
// content-addressed file mirror.
//
// ── Two homes, one mirror (PR3 Stage A) ────────────────────────────────────
// `attachments/` is the hidden, content-addressed store an editor drop writes
// to. A TREE binary is anything else the vault surfaces and the CRDT does not
// own — `Team/report.docx`, `Media/clip.mp4`. Both ride this mirror, and the
// difference is what happens either side of the bytes:
//
//   • a tree binary is REGISTERED as a server `files` row first, under the
//     local index's `files.id`, and its blob carries that id as `doc_id` — so
//     the permission resolver answers for the FILE (folder shares, org grants,
//     the sealed posture) instead of falling back to the blob store's path
//     heuristic. That ACL fix is the whole point of Stage A;
//   • a tree binary materializes through the TREE write guard
//     (`ipc.writeTreeBinary`), never through the `attachments/` one, which
//     stays exactly as strict as it was for server-supplied paths.
//
// Identity is still sha256 in both directions, which is Stage A's known
// limit: RENAMING a tree binary does not propagate (the bytes are unchanged, so
// the diff sees nothing to do and another device keeps the old name), and two
// paths holding identical bytes collapse to one blob. Stage B replaces the
// diff with a path-keyed one over `files.id`; the rename no-op is pinned by a
// test so that change is a visible one.
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

import { formatFor, isNoteExt, mimeForPath as mimeForFormat } from "../formats";
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

/** Does this vault-relative path live in the hidden `attachments/` store? */
export function isUnderAttachments(relPath: string): boolean {
  return relPath === "attachments" || relPath.startsWith("attachments/");
}

/**
 * Whether a server-supplied `relPath` is a safe TREE binary target — the
 * mirror of {@link isSafeAttachmentRelPath} for files that live in the tree.
 *
 * Same threat: the server stores the uploader's path verbatim, so this is what
 * a member could aim at every teammate's disk. Accepted is exactly what a user
 * could have dropped there themselves — no traversal, no dotfile or hidden
 * segment, and an extension the format registry surfaces as a non-note (so a
 * blob can never overwrite a `.md`, and never lands inside `.context/`).
 *
 * Rust re-decides all of it (`attachments.rs ensure_tree_binary_rel`) and is
 * the authority, including the denied build dirs this side does not enumerate;
 * this filter is what keeps the pass from queueing work Rust will refuse.
 */
export function isSafeTreeBinaryRelPath(relPath: string): boolean {
  if (!relPath) return false;
  const parts = relPath.split(/[\\/]/);
  if (parts.length === 0) return false;
  if (!parts.every((seg) => seg !== "" && seg !== "." && seg !== ".." && !seg.startsWith(".")))
    return false;
  if (isNoteExt(relPath)) return false;
  const format = formatFor(relPath);
  return !!format && format.surface && format.syncAs === "attachment";
}

/**
 * Can this server blob be placed on disk at the path the server names?
 *
 * Two guards, one per home, and never a relaxation of either: a path under
 * `attachments/` must satisfy {@link isSafeAttachmentRelPath}, anything else
 * must satisfy {@link isSafeTreeBinaryRelPath}.
 */
export function isSafeBlobRelPath(relPath: string): boolean {
  return isUnderAttachments(relPath)
    ? isSafeAttachmentRelPath(relPath)
    : isSafeTreeBinaryRelPath(relPath);
}

/**
 * Is a watcher event for this path the BINARY sync's business rather than the
 * note pipeline's?
 *
 * The routing rule `App.tsx` applies to every watcher batch. It used to be
 * "does the path start with `attachments/`", which was true of every binary
 * back when the only binaries lived there — a `.docx` dropped into a folder
 * fell through to the note path, where an unmapped file means "register it as a
 * note". The format registry answers it properly: the CRDT family is `syncAs:
 * "note"`, everything else the vault surfaces is a blob.
 */
export function routesToAttachmentSync(path: string): boolean {
  if (isUnderAttachments(path)) return true;
  return formatFor(path)?.syncAs === "attachment";
}

/**
 * Pure content-hash diff. A file is "the same" iff its sha256 matches; rel_path
 * is not part of identity (dedupe is by content), so a rename with unchanged
 * bytes is a no-op — see the module header for why that is Stage A's known
 * limit rather than a decision. Server blobs without a sha or a rel_path — or
 * with a relPath neither guard accepts (see {@link isSafeBlobRelPath}) — can't
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
    (b) => !!b.sha256 && !!b.relPath && isSafeBlobRelPath(b.relPath) && !localShas.has(b.sha256),
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

/** How long a `files-indexed` burst collects before the text pass runs. */
const TEXT_DEBOUNCE_MS = 800;

/**
 * The server rejects extracted text over 1 MB (413). Characters are not bytes,
 * so this cap is the cheap half: slice at a million characters — never inside a
 * surrogate pair, which would send a lone half and land as U+FFFD — and let the
 * server's own 413 handle text that is still over the byte cap after it (marked
 * permanent for that blob, never retried).
 */
const MAX_TEXT_CHARS = 1_000_000;

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  let end = MAX_TEXT_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // don't split a surrogate pair
  return text.slice(0, end);
}

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
  /** List the vault's local binaries — `attachments/` AND the tree binaries
   *  (`ipc.listBinaries`). */
  listLocal: () => Promise<LocalAttachment[]>;
  /** Read a local attachment's bytes (vault-relative path). */
  readLocal: (relPath: string) => Promise<Uint8Array>;
  /** Atomically write bytes to a path under `attachments/` (creates dirs). */
  writeLocal: (relPath: string, bytes: Uint8Array) => Promise<void>;
  /** The same for a TREE binary, through the tree write guard. Absent means
   *  this host cannot materialize outside `attachments/` (unit tests), and
   *  those downloads are skipped rather than forced through the wrong guard. */
  writeTreeLocal?: (relPath: string, bytes: Uint8Array) => Promise<void>;
  /** Claim the watcher echo for a path THIS device just wrote, exactly as the
   *  registry does for a materialized note (`registry.markMaterialized`). */
  markMaterialized?: (relPath: string) => void;
  /** List the server's blobs for this vault. */
  listServer: () => Promise<ServerBlob[]>;
  /** LEGACY upload: POST the whole body in one shot. The fallback for a server
   *  with no intent route, and the reason that route stays forever. `docId` is
   *  the `files` row a tree binary belongs to — sent as `x-doc-id`. */
  uploadServer: (
    relPath: string,
    bytes: Uint8Array,
    mime: string,
    docId?: string | null,
  ) => Promise<void>;
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
    /** The `files` row these bytes belong to (tree binaries only). */
    docId?: string | null;
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
  /** Stream a URL to disk from Rust, hash-verified and atomic. `tree` picks
   *  the write guard Rust applies — never inferred there, always stated here. */
  fetchToFile?: (input: {
    url: string;
    relPath: string;
    headers: Record<string, string>;
    expectedSha256?: string | null;
    tree: boolean;
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

  // ---- Tree binaries: `files` rows + extracted text (PR3 Stage A) ---------

  /** Local `files.id` per vault-relative path (`ipc.listFileRows`). The id the
   *  server row is created under, so both sides name one identity. */
  localFileIds?: () => Promise<Map<string, string>>;
  /** The `files` id this vault already registered for a path, from
   *  `.context/config.json` — so a reconnect costs no round trip per binary. */
  knownFileId?: (relPath: string) => string | null;
  /** Create (or adopt) the server `files` row and answer with its id. */
  registerFile?: (input: { relPath: string; id: string }) => Promise<string | null>;
  /** Remember a registered row for the next session. */
  rememberFileId?: (relPath: string, id: string) => void;
  /** The extracted text the INDEX holds for a path (`ipc.getFileText`). */
  fileText?: (
    relPath: string,
  ) => Promise<{ sha256: string; status: string; chars: number; text: string } | null>;
  /** Hand that text to the server as ranking fuel for team search. */
  uploadText?: (input: {
    blobId: string;
    docId?: string | null;
    sha256: string;
    chars: number;
    content: string;
  }) => Promise<void>;
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

  // ---- Tree binaries -----------------------------------------------------

  /** relPath → server `files` id, for the paths registered this session. */
  private readonly fileIds = new Map<string, string>();
  /** The local index's path → `files.id` map, read once per pass. */
  private localIds: Map<string, string> | null = null;
  /**
   * Tree binaries the server has REFUSED a `files` row for in a way retrying
   * cannot fix — no write access, the frozen root, or a path another identity
   * already holds. Their bytes still upload (without a `doc_id`, i.e. with the
   * blob store's old path heuristic for ACL); what stops is asking again every
   * pass.
   */
  private readonly registerRefused = new Set<string>();
  /** sha256 → the blob the server holds for it. Rebuilt from each listing and
   *  extended by each upload, so the text pass can name a blob by content. */
  private readonly blobIdBySha = new Map<string, string>();
  /** Does this server accept extracted text? `false` after one 404 (see
   *  `api.uploadBlobText`) — the whole session then stops offering it. */
  private textSupported: boolean | null = null;
  /** Blobs whose text this session has already sent (or permanently failed to
   *  send). Keyed by blob id: text describes BYTES, so one send per blob. */
  private readonly textDone = new Set<string>();
  /** Paths waiting for a text pass, and its own debounce — deliberately
   *  separate from the byte mirror's, so extraction never delays an upload. */
  private pendingText = new Set<string>();
  private textTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: AttachmentSyncDeps,
    private readonly debounceMs = 400,
    // Wrapped, not passed by reference: these are stored as fields and called as
    // `this.setTimeoutImpl(...)`, and WebKit refuses a bare `setTimeout` whose
    // receiver is not the Window ("Can only call Window.setTimeout on instances
    // of Window"). Node and jsdom do not enforce it, so only the real app broke.
    private readonly setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) =>
      setTimeout(fn, ms),
    private readonly clearTimeoutImpl: (t: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t),
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
    // Re-read per pass: a file dropped a second ago has no `files` row yet, and
    // the next pass is when it does.
    this.localIds = null;
    // What the server holds, by content — the text pass names a blob this way,
    // and a file that was uploaded by ANOTHER device (so never passes through
    // `uploadOne` here) is only ever knowable from the listing.
    for (const b of server) if (b.sha256) this.blobIdBySha.set(b.sha256, b.id);
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
    // A tree binary is a `files` row FIRST: the id has to exist before the
    // bytes, because it is what the blob carries as `doc_id` and what the
    // permission resolver answers for. A failure here is not fatal — the bytes
    // still go, with the pre-Stage-A path heuristic deciding who may read them.
    const docId = await this.ensureFileRow(a.relPath);
    // Read lazily and at most once: the deduped path must move NO bytes and
    // must not even open the file, which is what makes a second device's first
    // sync a few JSON round trips instead of re-uploading the whole store.
    let cached: Uint8Array | null = null;
    const loadBytes = async (): Promise<Uint8Array> => {
      if (!cached) cached = await this.deps.readLocal(a.relPath);
      return cached;
    };

    if (!this.deps.createIntent || this.intentSupported === false) {
      await this.deps.uploadServer(a.relPath, await loadBytes(), mime, docId);
      // The legacy route answers with the blob, but through a dep that reports
      // nothing — so the text for this path waits for the next listing to name
      // its blob, which is exactly what the pass already does.
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
        docId,
      });
      this.intentSupported = true;
    } catch (e) {
      const status = errStatus(e);
      if (status === 404) {
        // A server from before this flow. Remembered, so the NEXT file skips
        // the probe entirely rather than paying a 404 each time.
        this.intentSupported = false;
        await this.deps.uploadServer(a.relPath, await loadBytes(), mime, docId);
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

    if ("deduped" in intent && intent.deduped) {
      // Zero bytes moved — but the server now names the blob these bytes are,
      // which is all the text pass needs.
      if (intent.blob?.id) this.noteBlob(a.sha256, intent.blob.id, a.relPath);
      return true;
    }
    if (!("upload" in intent)) throw new Error("intent answered with no upload target");
    const { upload, completeUrl } = intent;
    this.noteBlob(a.sha256, intent.blobId, a.relPath);

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
    const tree = !isUnderAttachments(relPath);
    // A tree binary needs a host that can write outside `attachments/`. Without
    // one (a unit test, an older host) it is left alone rather than pushed
    // through the attachment guard, which would refuse it anyway.
    if (tree && !this.deps.writeTreeLocal && !this.deps.fetchToFile) {
      throw new Error(`no tree-binary write transport for ${relPath}`);
    }
    // Claim the watcher echo BEFORE the write, the way the registry does for a
    // materialized note: the file lands ~150ms before the event, and an echo
    // read as an external edit is how our own placeholder came to be treated as
    // somebody's change (#93).
    this.deps.markMaterialized?.(relPath);
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
            tree,
          });
          return;
        } catch (e) {
          if (!isMissingCommand(e)) throw e;
          this.rustTransport = false;
          console.warn("[attachments] Rust transport unavailable — using the webview", e);
        }
      }
      if (this.deps.fetchBytes) {
        await this.writeOne(relPath, await this.deps.fetchBytes(target.url, headers), tree);
        return;
      }
    }

    // Legacy: the server proxies the bytes on `/api/blobs/:id`.
    await this.writeOne(relPath, await this.deps.downloadServer(b.id), tree);
  }

  /** Write downloaded bytes through the guard that matches their home. */
  private async writeOne(relPath: string, bytes: Uint8Array, tree: boolean): Promise<void> {
    if (!tree) {
      await this.deps.writeLocal(relPath, bytes);
      return;
    }
    const write = this.deps.writeTreeLocal;
    if (!write) throw new Error(`no tree-binary write transport for ${relPath}`);
    await write(relPath, bytes);
  }

  // ---- `files` rows ------------------------------------------------------

  /**
   * The server `files` id for a tree binary, registering one if this device has
   * not already.
   *
   * `undefined` for anything under `attachments/` (those blobs stay
   * path-addressed and keep the old ACL heuristic), for a host with no registry
   * dep, for a path the local index has no `files` row for yet (the extraction
   * worker is seconds behind a drop — the next pass registers it), and for a
   * refusal. In every one of those cases the bytes still upload; only the
   * doc_id is missing.
   */
  private async ensureFileRow(relPath: string): Promise<string | undefined> {
    if (isUnderAttachments(relPath)) return undefined;
    if (!this.deps.registerFile) return undefined;
    const remembered = this.fileIds.get(relPath) ?? this.deps.knownFileId?.(relPath) ?? null;
    if (remembered) {
      this.fileIds.set(relPath, remembered);
      return remembered;
    }
    if (this.registerRefused.has(relPath)) return undefined;
    const localId = (await this.localFileId(relPath)) ?? null;
    if (!localId) return undefined;
    try {
      const id = await this.deps.registerFile({ relPath, id: localId });
      if (!id) return undefined;
      this.fileIds.set(relPath, id);
      this.deps.rememberFileId?.(relPath, id);
      return id;
    } catch (e) {
      const status = errStatus(e);
      const code = errCode(e);
      // Three outcomes, and which one this is decides whether we ever ask again:
      //  • 400 `path_folder_mismatch` — the server resolved a different parent
      //    than our path implies, because its folder rows are mid-reconcile.
      //    Per file, never fatal, retried next pass: the registry pull that
      //    fixes it is already queued;
      //  • any other ANSWER (403 no write access, the frozen root, a path
      //    another identity already holds) is a decision, not a hiccup —
      //    asking again every pass is a guaranteed refusal every pass;
      //  • no status, or a 5xx — we never reached a decision. Offline, a
      //    restarting server. Those must not cost the file its doc_id forever.
      const permanent = status != null && status >= 400 && status < 500 && status !== 400;
      if (permanent) this.registerRefused.add(relPath);
      console.warn(
        `[attachments] ${relPath} — no files row (${status ?? "?"} ${code ?? "?"})${
          permanent ? "; uploading without a doc_id" : "; retrying next pass"
        }`,
        e,
      );
      return undefined;
    }
  }

  /**
   * The LOCAL index's `files.id` for a path.
   *
   * One listing per PASS, not per file: a vault where 300 binaries need
   * registering would otherwise cross the IPC bridge 300 times for a map that
   * does not change while the pass runs.
   */
  private async localFileId(relPath: string): Promise<string | undefined> {
    if (!this.deps.localFileIds) return undefined;
    if (!this.localIds) {
      try {
        this.localIds = await this.deps.localFileIds();
      } catch (e) {
        console.warn("[attachments] local file ids unavailable", e);
        this.localIds = new Map();
      }
    }
    return this.localIds.get(relPath);
  }

  // ---- Extracted text ----------------------------------------------------

  /** Remember which blob holds these bytes, and offer its text. */
  private noteBlob(sha256: string, blobId: string, relPath: string): void {
    if (sha256 && blobId) this.blobIdBySha.set(sha256, blobId);
    // A file the index extracted BEFORE it was ever uploaded gets no second
    // `files-indexed` event, so the upload is the other trigger.
    this.scheduleText([relPath]);
  }

  /**
   * `files-indexed` arrived: these paths now have extracted text in the index,
   * and the server can have it as search fuel.
   *
   * Debounced and entirely off the byte mirror's path — a 200-file drop emits
   * a handful of coalesced batches from Rust, and none of them may delay an
   * upload.
   */
  handleFilesIndexed(paths: string[]): void {
    this.scheduleText(paths);
  }

  private scheduleText(paths: string[]): void {
    if (!this.deps.uploadText || !this.deps.fileText) return;
    if (this.textSupported === false) return;
    if (!this.current()) return;
    for (const p of paths) this.pendingText.add(p);
    if (this.pendingText.size === 0) return;
    if (this.textTimer) this.clearTimeoutImpl(this.textTimer);
    this.textTimer = this.setTimeoutImpl(() => {
      this.textTimer = null;
      void this.drainText().catch((e) => console.warn("[attachments] text pass failed", e));
    }, TEXT_DEBOUNCE_MS);
  }

  /** Send the extracted text for every queued path whose blob we can name. */
  private async drainText(): Promise<void> {
    const paths = [...this.pendingText];
    this.pendingText = new Set();
    const upload = this.deps.uploadText;
    const read = this.deps.fileText;
    if (!upload || !read) return;
    for (const relPath of paths) {
      if (!this.current()) return;
      if (this.textSupported === false) return;
      let text: Awaited<ReturnType<typeof read>>;
      try {
        text = await read(relPath);
      } catch (e) {
        console.warn("[attachments] extracted text unavailable", relPath, e);
        continue;
      }
      // `pending` is the worker still working; anything else with no words is
      // a file whose text is legitimately empty (a video, an unsupported type).
      if (!text || text.status !== "ok" || text.chars <= 0 || !text.sha256) continue;
      const blobId = this.blobIdBySha.get(text.sha256);
      // Not uploaded yet — the byte mirror will name the blob, and its own
      // completion re-queues this path.
      if (!blobId) continue;
      if (this.textDone.has(blobId)) continue;
      const content = capText(text.text);
      try {
        await upload({
          blobId,
          docId: this.fileIds.get(relPath) ?? this.deps.knownFileId?.(relPath) ?? null,
          sha256: text.sha256,
          chars: content.length,
          content,
        });
        this.textDone.add(blobId);
      } catch (e) {
        const status = errStatus(e);
        if (status === 404) {
          // The route is absent, or the blob is. Neither is worth another file.
          this.textSupported = false;
          this.pendingText.clear();
          console.warn("[attachments] server takes no extracted text — stopping for this session");
          return;
        }
        if (status === 413 || status === 409) {
          // 413: our char cap still overflowed the server's byte cap (multibyte
          // text). 409: the blob's bytes moved under us, and the new bytes get
          // their own extraction. Both are permanent for THIS blob.
          this.textDone.add(blobId);
          console.warn(`[attachments] ${relPath} text refused (${status}) — not retrying`);
          continue;
        }
        console.warn("[attachments] text upload failed", relPath, e);
      }
    }
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
    // The text pass holds the same captured vaultId and must die with it.
    if (this.textTimer) {
      this.clearTimeoutImpl(this.textTimer);
      this.textTimer = null;
    }
    this.pendingText.clear();
  }

  /** True while a debounced pass is still armed (teardown assertions/tests). */
  hasPendingReconcile(): boolean {
    return this.timer != null;
  }
}
