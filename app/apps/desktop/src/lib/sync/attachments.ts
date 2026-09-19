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
// limit: RENAMING a tree binary does not propagate ACROSS DEVICES (the bytes
// are unchanged, so the diff sees nothing to do and another device keeps the
// old name), and two paths holding identical bytes collapse to one blob. Stage
// B replaces the diff with a path-keyed one over `files.id`; the rename no-op
// is pinned by a test so that change is a visible one.
//
// What the hash-keyed diff CANNOT do at all is notice a deletion — a file that
// left this disk is, to it, content the server has and we don't, i.e. a
// download. That half is not the diff's to fix and lives in `binaryDeletes.ts`:
// it watches the disk, propagates the delete (and the local half of a rename,
// which moves the `files` row) and tells this mirror not to download a path
// whose window is still open (`deps.isDeletePending`).
//
// The rename is also where the two halves can FORK a file: a window the queue
// could not settle leaves the new path unregistered, and registering a path
// whose bytes are already a `files` row is how one file gets two doc_ids — with
// the blob, and so the ACL, bound to whichever came first. Two rails answer it
// here: nothing unregistered uploads while a window is unsettled
// (`deps.isRenamePending`), and a dedupe hit naming a row whose path is gone
// from this disk is adopted rather than duplicated (`reconcileDedupedRow`).
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
import { BATCH_MAX_FILES, runPool, useBulkPath } from "./pool";
import type { DocSyncState } from "./vaultScope";
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
  /**
   * The `files` row these bytes ARE (null for an `attachments/` drop).
   *
   * Recorded on download, which is the only way a teammate's binary gets a doc
   * id on this device: `ensureFileRow` runs on the UPLOAD path, so a file this
   * device merely received had no mapping at all — and an unmapped file is one
   * the vault channel's `hello` cannot announce, so the server could never name
   * it on `ready.revoked` and a revocation never reached it.
   */
  docId?: string | null;
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
 *
 * **Invariant: a download never lands on a path the disk already holds.** Sha
 * is identity, but the server keeps ONE ready row per content, not per path, so
 * editing a synced `Report.docx` in place leaves the server holding both the
 * old sha and the new one. Keyed on sha alone the superseded row reads as "a
 * file this device is missing", and writing it back destroys the edit — then
 * the next pass sees the old sha locally and pulls the new one, and the file
 * flip-flops between two versions forever. So a path the disk occupies is not
 * missing locally, whatever its bytes are: sha-only identity stays for paths
 * with NO local file (the genuine "this device doesn't have it" case), and a
 * disagreement at an occupied path is a conflict the uploader resolves the
 * other way (uploads run first in every pass), never an overwrite.
 *
 * Compared case-insensitively, like `samePath`/`planInbound` and the server's
 * `lower(path)` unique indexes — on macOS `Report.docx` and `report.docx` are
 * the same file on disk.
 */
export function diffAttachments(
  local: LocalAttachment[],
  server: ServerBlob[],
): AttachmentDiff {
  const localShas = new Set(local.map((a) => a.sha256));
  const localPaths = new Set(local.map((a) => a.relPath.toLowerCase()));
  const serverShas = new Set(server.map((b) => b.sha256));

  const toUpload = local.filter((a) => !serverShas.has(a.sha256));
  const toDownload = server.filter(
    (b) =>
      !!b.sha256 &&
      !!b.relPath &&
      isSafeBlobRelPath(b.relPath) &&
      !localShas.has(b.sha256) &&
      !localPaths.has(b.relPath.toLowerCase()),
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

/**
 * How many binaries move at once — uploads, downloads and the text drain alike.
 *
 * 6, `REGISTRY_CONCURRENCY`'s reasoning rather than `UPLOAD_CONCURRENCY`'s (in
 * `pool.ts`; not `{@link}`ed because this module imports neither): a unit here
 * is an HTTP request against one host,
 * not a WebSocket plus a resident `NoteBridge`, so the limit that binds is the
 * per-host connection pool, not heap. Before this every one of these loops was a
 * `for (…) await …` at width 1, and a 500-file vault paid ~2,000 strictly
 * sequential round trips (≈5 minutes of pure latency) before a byte was counted.
 *
 * Request count alone is the wrong budget for binaries, though — six 200 MB
 * videos at width 6 is 1.2 GB in flight — so {@link BYTES_IN_FLIGHT_BUDGET}
 * bounds the other axis.
 */
const BINARY_CONCURRENCY = 6;

/**
 * How many outstanding transfer bytes we allow across the whole mirror.
 *
 * 32 MiB, Syncthing's `pullerMaxPendingKiB` default — the most-cited precedent
 * for "how much should be in flight", and deliberately sized in BYTES: a
 * concurrency number alone cannot tell a thousand 4 KB PNGs from six 1 GB
 * videos, and only one of those two shapes threatens the heap and the link.
 *
 * A single transfer larger than the whole budget still runs (alone): the gate
 * never refuses work, it only makes it wait for room, and "wait for room that
 * can never exist" is a deadlock.
 */
const BYTES_IN_FLIGHT_BUDGET = 32 * 1024 * 1024;

/**
 * Parts of ONE multipart file in flight at once.
 *
 * 4, below {@link BINARY_CONCURRENCY} because these lanes compete with the other
 * files' lanes for the same connections and the same byte budget. A 1 GB video
 * was 64 sequential 16 MB PUTs — one TCP stream's throughput; four lanes is the
 * cheapest multiple of that without letting one file own the whole mirror.
 */
const MULTIPART_CONCURRENCY = 4;

/**
 * Bytes-in-flight backpressure: run `fn` once there is room for `bytes`.
 *
 * Deliberately tiny and local — this is a budget, not a scheduler. The claim is
 * clamped to the budget so an oversized transfer waits for an EMPTY pipe and
 * then runs alone rather than blocking forever, and every waiter is woken on
 * release (they re-check, and the ones that still do not fit queue again).
 */
class BytesInFlight {
  private used = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly budget: number) {}

  async run<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
    const claim = Math.max(0, Math.min(bytes || 0, this.budget));
    while (this.used > 0 && this.used + claim > this.budget) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.used += claim;
    try {
      return await fn();
    } finally {
      this.used -= claim;
      const woken = this.waiters;
      this.waiters = [];
      for (const resolve of woken) resolve();
    }
  }
}

/**
 * Run the FIRST item alone, then the rest through {@link runPool}.
 *
 * The first item of every pass is a probe, and what it probes is the SERVER, not
 * the file: whether this server speaks the intent flow at all (404 ⇒ legacy for
 * the whole session), whether it takes extracted text (404 ⇒ stop offering),
 * whether the vault has storage left (402 ⇒ abandon the pass). Every one of
 * those answers is remembered, so learning it before the fan-out costs one round
 * trip instead of {@link BINARY_CONCURRENCY} of them — and, for the 402, means a
 * full vault still aborts after exactly one refusal the way it always has.
 *
 * `worker` owns its errors, exactly as `runPool` requires; anything it throws is
 * swallowed here for the same reason.
 */
async function runProbeFirst<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: { concurrency: number; shouldStop?: () => boolean },
): Promise<void> {
  if (items.length === 0) return;
  if (opts.shouldStop?.()) return;
  try {
    await worker(items[0], 0);
  } catch {
    /* the worker owns its own error reporting */
  }
  await runPool(items.slice(1), (item, i) => worker(item, i + 1), opts);
}

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
  /**
   * Is this path waiting out the delete queue's grace window
   * (`binaryDeletes.ts`)?
   *
   * Asked before every download, and the reason a delete sticks. A deleted file
   * is, to this diff, content the server has and we don't — so the debounced
   * pass (400ms, well inside the 2.5s window) would put it straight back before
   * the queue had even decided. Downloads only: an upload cannot resurrect a
   * file that is no longer on disk to read.
   */
  isDeletePending?: (relPath: string) => boolean;
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
  /**
   * Publish where every TREE binary stands, so a `.pdf` row in the sidebar can
   * carry the same dot a note's row does (`store.fileSyncState`).
   *
   * The WHOLE map every time, never a patch: a pass is the only thing that
   * knows the full local set, so replacing it is also how a file that was
   * deleted or renamed since the last pass loses its dot. Keyed by
   * vault-relative path, because identity here is the bytes and a `files` row
   * may have been refused — there is no docId to key by. Paths under the hidden
   * `attachments/` store are left out: they have no row to badge.
   *
   * The vocabulary is the notes' own {@link DocSyncState}, not a second one —
   * `queued` while a file waits for this pass, `syncing` while its bytes move,
   * `synced` once the server holds them, `error` only for a refusal retrying
   * cannot fix. One vocabulary is what makes the two dots mean the same thing.
   */
  onFileStates?: (states: Record<string, DocSyncState>) => void;
  /**
   * Publish the server's attachment-plan verdict for this vault. This is set
   * only from the explicit 402 contract response — never inferred from a Free
   * label, because Pro status may be stale locally and billing-disabled
   * self-hosts may sync attachments without a subscription.
   */
  onEntitlementBlocked?: (blocked: boolean) => void;
  /**
   * This pass is about to pull `count` files DOWN — a teammate's drop, or a
   * file whose access just came back.
   *
   * The counted half of the sidebar's dots: it feeds the same
   * {@link import("./progress").SyncProgressSink} a note backfill reports
   * through, so the header's "Syncing n/m" covers bytes as well as documents.
   * A 50 MB `.docx` arriving after a Private → Shared flip otherwise moved in
   * total silence — no row (the tree comes from the disk, and the file is not
   * on it yet) and no counter.
   *
   * Announced once per pass, before the first byte, so the denominator is whole
   * from the first frame rather than climbing one file at a time.
   */
  onDownloadsQueued?: (count: number) => void;
  /** One of those files landed, or failed. Exactly one call per file announced
   *  by {@link onDownloadsQueued} — including the ones a pass cut short never
   *  got to, or the counter would hang at `n/m` forever. */
  onDownloadSettled?: (outcome: "ok" | "failed") => void;

  // ---- Tree binaries: `files` rows + extracted text (PR3 Stage A) ---------

  /** Local `files.id` per vault-relative path (`ipc.listFileRows`). The id the
   *  server row is created under, so both sides name one identity. */
  localFileIds?: () => Promise<Map<string, string>>;
  /** The `files` id this vault already registered for a path, from
   *  `.context/config.json` — so a reconnect costs no round trip per binary. */
  knownFileId?: (relPath: string) => string | null;
  /** Create (or adopt) the server `files` row and answer with its id. */
  registerFile?: (input: { relPath: string; id: string }) => Promise<string | null>;
  /**
   * The same thing for N files in ONE request (`POST /vaults/:id/files/batch`).
   *
   * Used only above {@link BULK_THRESHOLD_DOCS} files and only to PRE-FILL the
   * ids `ensureFileRow` would otherwise mint one round trip at a time — every
   * decision after that (dedupe, adoption, authorship, the refusal memo) is
   * still made per file, by the same code, in the same order. Optional: a host
   * that does not provide it keeps today's per-file path at every size.
   */
  registerFiles?: (
    inputs: Array<{
      relPath: string;
      id: string;
      sha256: string;
      size: number;
      mime: string | null;
    }>,
  ) => Promise<
    Array<{
      relPath: string;
      id: string | null;
      status: "created" | "adopted" | "conflict" | "error";
      code: string | null;
      error: string | null;
    }>
  >;
  /** Remember a registered row for the next session. */
  rememberFileId?: (relPath: string, id: string, opts?: { authored?: boolean }) => void;
  /** Forget a mapping whose path is not this file's any more — the other half
   *  of an adoption, so `.context/config.json` never names two ids for one
   *  file (`registry.forgetFileId`). */
  forgetFileId?: (relPath: string) => void;
  /** `DELETE /api/files/:id` — used for exactly one thing here: dropping a row
   *  THIS device created for bytes the server already knows under another id.
   *  It deletes only blobs carrying that id, and a forked row carries none. */
  deleteFile?: (id: string) => Promise<void>;
  /**
   * Is the delete queue sitting on a window it could not settle
   * (`binaryDeletes.hasUnsettled`)?
   *
   * Asked before a NEW `files` row is minted, and it is the upload side of the
   * anti-fork rail. A rename the queue is still trying to pair looks from here
   * like a brand-new path: register it and the file exists twice, under two
   * doc_ids, with the ACL on whichever one the blob happened to bind to. Such a
   * file waits out the pass entirely (`deferForRename`) rather than uploading
   * bare, and the pass after the queue settles registers or adopts it.
   */
  isRenamePending?: () => boolean;
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
  /** A 402 contract response is stable for this session; do not poll it. */
  private attachmentSyncBlocked = false;
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
  /** relPath → the state the sidebar draws for it (see `deps.onFileStates`). */
  private fileStates = new Map<string, DocSyncState>();

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
  /** sha256 → the upload currently moving THOSE bytes. The claim that keeps
   *  same-content dedupe working now that the lanes race — see {@link uploadOne}. */
  private readonly uploadBySha = new Map<string, Promise<void>>();
  /** Every local binary path this pass saw, lowercased. What the rename
   *  adoption reads: a `files` row whose own path is NOT in here is a row this
   *  file left behind, not a second file holding the same bytes. Paths compare
   *  case-insensitively, exactly as they do everywhere else here. */
  private localPathKeys = new Set<string>();
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

  // ---- The sidebar's file dots (see `deps.onFileStates`) -----------------

  /** Hand the current map to the UI. One emission, whole map. */
  private publishFileStates(): void {
    this.deps.onFileStates?.(Object.fromEntries(this.fileStates));
  }

  /** Move ONE path. A no-op when the state is already what we'd publish, so a
   *  pass that changes nothing costs the sidebar no re-render. */
  private setFileState(relPath: string, state: DocSyncState): void {
    if (!this.deps.onFileStates) return;
    // The hidden root store has no sidebar row to badge.
    if (isUnderAttachments(relPath)) return;
    if (this.fileStates.get(relPath) === state) return;
    this.fileStates.set(relPath, state);
    this.publishFileStates();
  }

  /**
   * This path is gone for good — forget everything cached about it.
   *
   * Called when a revoked tree binary is removed from disk (the inbound plan's
   * binary pass). The next pass would rebuild most of this from the two listings
   * anyway, but not all: `fileIds` and `permanentSkips` are session caches keyed
   * by path, and a path that comes back later — access restored, or a file the
   * user drops at the same name — must not adopt a `files` id it no longer has
   * any claim to. The dot goes immediately rather than at the next pass, because
   * the row it belongs to has just left the sidebar.
   */
  forgetFile(relPath: string): void {
    this.fileIds.delete(relPath);
    this.registerRefused.delete(relPath);
    this.permanentSkips.delete(relPath);
    this.localIds?.delete(relPath);
    if (this.fileStates.delete(relPath)) this.publishFileStates();
  }

  /** Run one full reconcile pass now. Coalesces if one is already in flight. */
  async reconcile(): Promise<ReconcileResult> {
    if (!this.current()) return { uploaded: 0, downloaded: 0 };
    if (this.attachmentSyncBlocked) return { uploaded: 0, downloaded: 0 };
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

  /** Clear a plan refusal after billing refresh has confirmed an upgrade. */
  resetEntitlement(): void {
    const wasBlocked = this.attachmentSyncBlocked;
    this.attachmentSyncBlocked = false;
    if (wasBlocked) this.deps.onEntitlementBlocked?.(false);
  }

  private async pass(): Promise<ReconcileResult> {
    // Listing is the one step outside a per-file try/catch, and it is the step
    // that fails routinely: the local read is epoch-pinned (so Rust REJECTS it the
    // moment the vault changes) and the server read fails whenever we're offline.
    // Both mean "no pass this time", not an exception for the caller — which
    // matters because every call site is fire-and-forget.
    let local: LocalAttachment[];
    let server: ServerBlob[];
    const localListing = this.deps.listLocal();
    try {
      [local, server] = await Promise.all([localListing, this.deps.listServer()]);
    } catch (e) {
      if (errStatus(e) === 402 && errCode(e) === "attachment_sync_requires_pro") {
        let hasLocalAttachments = false;
        try {
          hasLocalAttachments = (await localListing).length > 0;
        } catch {
          // The plan verdict remains authoritative; only its announcement waits
          // for positive local evidence.
        }
        this.handleAttachmentSyncRequired(e, hasLocalAttachments);
        return { uploaded: 0, downloaded: 0 };
      }
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
    // Rebuilt per pass, never accumulated: an adoption decided against a disk
    // two passes old would move a row onto a path that has since changed again.
    this.localPathKeys = new Set(local.map((a) => a.relPath.toLowerCase()));
    const { toUpload, toDownload } = diffAttachments(local, server);

    // The downloads this pass will actually make, decided BEFORE anything is
    // reported: a file inside an open delete window is not a file this device is
    // missing, and it must not be counted or badged as one.
    const downloads: ServerBlob[] = [];
    for (const b of toDownload) {
      if (b.relPath && this.deps.isDeletePending?.(b.relPath)) {
        console.info(`[attachments] ${b.relPath} has a delete pending — not downloading it back`);
        continue;
      }
      downloads.push(b);
    }

    // Where every tree binary stands, rebuilt from the two listings rather than
    // accumulated across passes: a file deleted or renamed since the last one
    // must LOSE its dot, and this is the only place that knows the full local
    // set. A sha the server already holds is synced outright — most of a
    // vault's files on most passes, and the reason the column settles to quiet
    // dots without a single byte moving.
    if (this.deps.onFileStates) {
      const queued = new Set(toUpload.map((a) => a.relPath));
      this.fileStates = new Map<string, DocSyncState>();
      for (const a of local) {
        if (isUnderAttachments(a.relPath)) continue;
        this.fileStates.set(
          a.relPath,
          this.permanentSkips.has(a.sha256)
            ? "error"
            : queued.has(a.relPath)
              ? "queued"
              : "synced",
        );
      }
      // …plus the files this pass is about to PULL DOWN. They have no local row
      // yet — the sidebar's tree is the disk — but the roll-up credits a path to
      // its ancestors whether or not the file is there (`syncRollup.ts`), so the
      // folder a re-granted 50 MB `.docx` is arriving into reads as busy from the
      // first frame instead of settled until the file lands.
      for (const b of downloads) {
        if (!b.relPath || isUnderAttachments(b.relPath)) continue;
        this.fileStates.set(b.relPath, "queued");
      }
      this.publishFileStates();
    }

    // Above the threshold, mint every `files` row this pass needs in one
    // request per chunk. Purely a pre-fill: `ensureFileRow` below then finds
    // each id remembered and every later decision is unchanged. Never fatal —
    // anything it could not settle falls through to the per-file path.
    await this.preregisterFiles(toUpload);
    if (!this.current()) return { uploaded: 0, downloaded: 0 };

    let uploaded = 0;
    let downloaded = 0;
    // Abandoned for the whole pass, not the one file (see {@link AbortPass}):
    // the quota refusal is the vault's answer, so it becomes a flag the pool's
    // `shouldStop` reads and every lane stops picking up new work at its next
    // checkpoint. Downloads are skipped too, exactly as before.
    let aborted: string | null = null;
    const bytes = new BytesInFlight(BYTES_IN_FLIGHT_BUDGET);
    await runProbeFirst(
      toUpload,
      async (a) => {
        // A file the server has already refused for good (too large, wrong type)
        // is skipped without a round trip — see `permanentSkips`.
        if (this.permanentSkips.has(a.sha256)) return;
        // An unregistered path while the delete queue is still trying to settle a
        // window is very likely the arrival half of a rename it is about to pair.
        // The WHOLE file waits, not just its registration: uploading it now would
        // put its bytes on the server under no doc_id at all, and the next pass —
        // which subtracts by sha — would never queue it again to fix that.
        if (this.deferForRename(a)) {
          this.setFileState(a.relPath, "queued");
          return;
        }
        this.setFileState(a.relPath, "syncing");
        try {
          if (await bytes.run(a.size ?? 0, () => this.uploadOne(a))) {
            uploaded++;
            this.setFileState(a.relPath, "synced");
          } else {
            // The only `false` is a permanent refusal (413 too large, 415 wrong
            // type), which `uploadOne` has already recorded in `permanentSkips`.
            this.setFileState(a.relPath, "error");
          }
        } catch (e) {
          if (e instanceof AbortPass) {
            // Nothing else in this pass can succeed either. Downloads are skipped
            // too: the vault is full, and the next pass will find the same state.
            // This file is not broken — it is waiting, like every one behind it.
            this.setFileState(a.relPath, "queued");
            if (!aborted) console.warn("[attachments] pass aborted:", e.reason);
            aborted = e.reason;
            return;
          }
          // Transient (offline, a 5xx). It stays `syncing`: the next pass runs it
          // again, and `error` is reserved for a refusal retrying cannot fix.
          console.error("[attachments] upload failed", a.relPath, e);
        }
      },
      {
        concurrency: BINARY_CONCURRENCY,
        // Re-checked per file: a big vault is hundreds of awaits, and every one
        // of them is a chance for the user to switch vaults. Continuing would
        // upload the NEW vault's files into the OLD vault's blob store.
        shouldStop: () => aborted != null || !this.current(),
      },
    );
    if (aborted) return { uploaded, downloaded };
    // One announcement for the whole wave (see `deps.onDownloadsQueued`), and
    // then exactly one settle per file — including the tail a cut-short pass
    // never reaches, which is what keeps the header's counter from hanging.
    if (downloads.length > 0) this.deps.onDownloadsQueued?.(downloads.length);
    let settled = 0;
    await runProbeFirst(
      downloads,
      async (b) => {
        // Its bytes are moving now. The dot was already `queued` from the rebuild
        // above; this is the same queued → syncing → synced walk an upload makes.
        if (b.relPath) this.setFileState(b.relPath, "syncing");
        try {
          await bytes.run(b.size ?? 0, () => this.downloadOne(b));
          downloaded++;
          // Remember whose `files` row these bytes are. Not an optimisation: it is
          // what puts a teammate's binary into the map the `hello` announces, and
          // so what lets a later revocation of it be named and removed.
          if (b.relPath && b.docId && !isUnderAttachments(b.relPath)) {
            this.fileIds.set(b.relPath, b.docId);
            this.deps.rememberFileId?.(b.relPath, b.docId);
          }
          // It came FROM the server, so the server has it — and its row appears
          // in the sidebar on the watcher echo, before the next pass would say so.
          if (b.relPath) this.setFileState(b.relPath, "synced");
          settled++;
          this.deps.onDownloadSettled?.("ok");
        } catch (e) {
          console.error("[attachments] download failed", b.relPath, e);
          // The dot stays `syncing` — like a failed upload, `error` is reserved
          // for a refusal retrying cannot fix, and the next pass tries again.
          settled++;
          this.deps.onDownloadSettled?.("failed");
        }
      },
      { concurrency: BINARY_CONCURRENCY, shouldStop: () => !this.current() },
    );
    // A pass the vault switch cut short still owes the counter every file it
    // announced. Reported as failures rather than silently dropped: the work was
    // queued and did not happen.
    for (let i = settled; i < downloads.length; i++) this.deps.onDownloadSettled?.("failed");
    return { uploaded, downloaded };
  }

  // ---- Upload ------------------------------------------------------------

  /**
   * Move one local-only attachment to the server. Returns whether it counts as
   * uploaded (a dedupe does — the server has the bytes, which is the point).
   *
   * Throws {@link AbortPass} when the failure is the vault's, not the file's.
   *
   * Serialized BY CONTENT. The loop used to be serial, so two vault paths
   * holding identical bytes uploaded once and the second found the sha already
   * known; at {@link BINARY_CONCURRENCY} both lanes reach the intent together
   * and both PUT the bytes. Claiming the sha first (the same shape as
   * `drainText`'s `textDone` claim) puts the second lane behind the first, where
   * the server answers its intent `deduped` and it moves no bytes at all — which
   * is exactly the workload this pass optimises (a vault of near-duplicate
   * binaries). Distinct content never waits: the key is the sha.
   */
  private async uploadOne(a: LocalAttachment): Promise<boolean> {
    // `while`, not `if`: several lanes can be parked on one sha, and each must
    // re-check — the first to wake claims it, the rest queue behind that claim.
    while (this.uploadBySha.has(a.sha256)) {
      await this.uploadBySha.get(a.sha256);
      if (!this.current()) return false;
      // The lane ahead may have learned these bytes are refused for good.
      if (this.permanentSkips.has(a.sha256)) return false;
    }
    let release!: () => void;
    const claim = new Promise<void>((resolve) => (release = resolve));
    this.uploadBySha.set(a.sha256, claim);
    try {
      return await this.uploadOneClaimed(a);
    } finally {
      // Drop the claim BEFORE waking the waiters, so the first one out of the
      // loop sees a free sha and takes it.
      if (this.uploadBySha.get(a.sha256) === claim) this.uploadBySha.delete(a.sha256);
      release();
    }
  }

  /** {@link uploadOne}'s body, with this sha's claim already held. */
  private async uploadOneClaimed(a: LocalAttachment): Promise<boolean> {
    const mime = mimeForPath(a.relPath);
    // A tree binary is a `files` row FIRST: the id has to exist before the
    // bytes, because it is what the blob carries as `doc_id` and what the
    // permission resolver answers for. A failure here is not fatal — the bytes
    // still go, with the pre-Stage-A path heuristic deciding who may read them.
    const docId = await this.ensureFileRow(a);
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
        if (errCode(e) === "attachment_sync_requires_pro") {
          this.handleAttachmentSyncRequired(e);
          throw new AbortPass("attachment_sync_requires_pro");
        }
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
      // It also names the `files` row those bytes ALREADY belong to, and that
      // is the one moment this side can learn it: the blob listing is filtered
      // by what the caller may read (a file set to Private drops out of it
      // entirely), so a renamed file can reach here looking brand new while the
      // server has held it all along. Reconciled before anything else believes
      // our id.
      await this.reconcileDedupedRow(a, docId, intent.blob);
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
      const count = Math.max(1, Math.ceil(size / upload.partBytes));
      const numbers = Array.from({ length: count }, (_, i) => i + 1);
      // Keyed by part number, never appended in finish order: with lanes racing,
      // part 3 can answer before part 1, and S3 rejects a complete whose parts
      // are not in ascending order. The map is assembled here, the ORDER below.
      const etags = new Map<number, string>();
      let failure: unknown = null;
      await runPool(
        numbers,
        async (n) => {
          const range = {
            start: (n - 1) * upload.partBytes,
            end: Math.min(n * upload.partBytes, size),
          };
          try {
            // A part URL we were never given — or one whose presign died while
            // the earlier parts were in flight — is re-minted rather than
            // failing the whole file. `partsUrl` carries its own token, and
            // `freshPartUrl` is per part, so lanes never contend for one URL.
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
            etags.set(n, etag);
          } catch (e) {
            // `runPool` swallows what a worker throws, and a silently missing
            // part would be COMPLETED as a truncated file. So the first failure
            // is kept, stops the remaining lanes, and is re-thrown below —
            // exactly what the serial loop's throw used to do.
            failure ??= e;
          }
        },
        {
          concurrency: MULTIPART_CONCURRENCY,
          shouldStop: () => failure != null || !this.current(),
        },
      );
      if (failure) throw failure;
      if (!this.current()) throw new Error("vault changed mid-upload");
      if (etags.size !== count) throw new Error(`${a.relPath}: only ${etags.size}/${count} parts`);
      return numbers.map((n) => ({ partNumber: n, etag: etags.get(n) as string }));
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

  /**
   * Remember a plan refusal for this sync instance. Watcher bursts continue to
   * call `reconcile`, so memoizing it is what turns a stable 402 into one clear
   * local-only state instead of a retry loop and a stream of identical toasts.
   */
  private handleAttachmentSyncRequired(e: unknown, announce = true): boolean {
    if (errStatus(e) !== 402 || errCode(e) !== "attachment_sync_requires_pro") return false;
    if (!this.attachmentSyncBlocked) {
      this.attachmentSyncBlocked = true;
      this.fileStates.clear();
      this.publishFileStates();
      this.deps.onEntitlementBlocked?.(true);
      if (announce) {
        this.deps.notify?.(
          "Attachments stay on this device in free vaults. Upgrade this vault to Pro to sync them.",
          "neutral",
        );
      }
    }
    return true;
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
    // Last line of the "never overwrite an occupied path" invariant
    // ({@link diffAttachments}). The diff already subtracts every path this
    // pass's listing saw, so reaching here means the file appeared AFTER the
    // listing — a drop, or an in-place save racing the pass. Either way these
    // are not the bytes at that path, and a download is a conflict, never an
    // overwrite: it is refused, reported as a failed download, and the next
    // pass uploads the local file instead (uploads run first).
    if (this.localPathKeys.has(relPath.toLowerCase())) {
      throw new Error(`${relPath} is occupied on disk — refusing to overwrite it with a download`);
    }
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
   * Should this file sit out the pass because a rename may be in flight?
   *
   * Only ever an UNREGISTERED tree binary: a path this device already has an id
   * for is not the arrival half of anything, and an `attachments/` drop has no
   * row to fork. See `binaryDeletes.hasUnsettled` for what the queue is waiting
   * for, and why the answer cannot name a path.
   */
  private deferForRename(a: LocalAttachment): boolean {
    if (isUnderAttachments(a.relPath)) return false;
    if (!this.deps.isRenamePending?.()) return false;
    if (this.fileIds.get(a.relPath) ?? this.deps.knownFileId?.(a.relPath)) return false;
    console.info(`[attachments] ${a.relPath} — a delete window is unsettled; leaving it queued`);
    return true;
  }

  /**
   * Register every tree binary this pass is about to upload in ONE request per
   * {@link BATCH_MAX_FILES}, instead of one round trip per file inside
   * {@link AttachmentSync.ensureFileRow}.
   *
   * Deliberately a PRE-FILL and nothing more: it writes the ids it learns into
   * `fileIds` (and `.context/config.json` via `rememberFileId`), after which
   * `ensureFileRow` takes its `remembered` fast path and every decision that
   * follows — the dedupe/adoption repair, the authorship claim, the refusal
   * memo, the per-file upload — is the same code in the same order it has
   * always been. A file this skips (no local id yet, already remembered,
   * already refused, under `attachments/`, deferred by a pending rename) simply
   * reaches `ensureFileRow` exactly as before.
   *
   * Below the threshold it does not run at all, so a small vault's behaviour is
   * byte for byte what it was.
   *
   * Per-item outcomes mirror the single path's `catch` exactly:
   *  • `created`/`adopted` with an id ⇒ remember it (`authored`, because this is
   *    the upload side — it is the only authorship signal a binary has);
   *  • `path_folder_mismatch` ⇒ the server resolved a different parent than our
   *    path implies because its folder rows are mid-reconcile: per file, never
   *    fatal, retried next pass;
   *  • any other ANSWERED refusal ⇒ a decision, not a hiccup: remembered in
   *    `registerRefused` so we stop asking, and the bytes still upload without a
   *    doc_id;
   *  • no answer for an item ⇒ nothing is recorded, and `ensureFileRow` asks for
   *    that one file the old way.
   */
  private async preregisterFiles(toUpload: LocalAttachment[]): Promise<void> {
    type BatchRow = {
      relPath: string;
      id: string | null;
      status: "created" | "adopted" | "conflict" | "error";
      code: string | null;
      error: string | null;
    };
    if (!this.deps.registerFiles || !this.deps.registerFile) return;
    const candidates: Array<{
      relPath: string;
      id: string;
      sha256: string;
      size: number;
      mime: string | null;
    }> = [];
    for (const a of toUpload) {
      if (!this.current()) return;
      if (isUnderAttachments(a.relPath)) continue;
      if (this.permanentSkips.has(a.sha256)) continue;
      if (this.registerRefused.has(a.relPath)) continue;
      if (this.fileIds.get(a.relPath) ?? this.deps.knownFileId?.(a.relPath)) continue;
      // The arrival half of a rename the delete queue is still pairing must not
      // be registered as a new file — the same rail `uploadOne` rides.
      if (this.deferForRename(a)) continue;
      // No local `files` row yet (the extraction worker is seconds behind a
      // drop): the next pass registers it, exactly as the single path decides.
      const id = await this.localFileId(a.relPath);
      if (!id) continue;
      candidates.push({
        relPath: a.relPath,
        id,
        sha256: a.sha256,
        size: a.size ?? 0,
        mime: mimeForPath(a.relPath),
      });
    }
    if (!useBulkPath(candidates.length)) return;

    for (let i = 0; i < candidates.length; i += BATCH_MAX_FILES) {
      if (!this.current()) return;
      const chunk = candidates.slice(i, i + BATCH_MAX_FILES);
      let results: BatchRow[];
      try {
        results = await this.deps.registerFiles(chunk);
      } catch (e) {
        const status = errStatus(e);
        const code = errCode(e);
        // A plan limit stops the PRE-REGISTRATION and nothing else: the files
        // are not broken, the vault is full. The upload loop below then hits the
        // same limit and aborts the pass the way it always has.
        if (status === 402 || code === "vault_limit_reached") {
          console.warn(`[attachments] files/batch stopped — ${code ?? status}`);
          return;
        }
        // Same reading as one refused registration, applied to the request: an
        // ANSWER (4xx that is not the retryable 400) is a decision about these
        // files; anything else is a hiccup that must not cost them their doc_id.
        const permanent = status != null && status >= 400 && status < 500 && status !== 400;
        if (permanent) for (const c of chunk) this.registerRefused.add(c.relPath);
        console.warn(
          `[attachments] files/batch failed (${status ?? "?"} ${code ?? "?"})${
            permanent ? "; uploading without doc_ids" : "; retrying next pass"
          }`,
          e,
        );
        continue;
      }
      if (!this.current()) return;
      const byPath = new Map(results.map((r) => [r.relPath, r]));
      for (const c of chunk) {
        const res = byPath.get(c.relPath);
        if (!res) continue; // unanswered ⇒ the per-file path asks again
        if (res.id && (res.status === "created" || res.status === "adopted")) {
          this.fileIds.set(c.relPath, res.id);
          this.deps.rememberFileId?.(c.relPath, res.id, { authored: true });
          continue;
        }
        if (res.code === "path_folder_mismatch") continue; // retried next pass
        this.registerRefused.add(c.relPath);
        console.warn(
          `[attachments] ${c.relPath} — no files row (${res.code ?? res.error ?? "refused"}); uploading without a doc_id`,
        );
      }
    }
  }

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
  private async ensureFileRow(a: LocalAttachment): Promise<string | undefined> {
    const relPath = a.relPath;
    if (isUnderAttachments(relPath)) return undefined;
    if (!this.deps.registerFile) return undefined;
    const remembered = this.fileIds.get(relPath) ?? this.deps.knownFileId?.(relPath) ?? null;
    if (remembered) {
      this.fileIds.set(relPath, remembered);
      return remembered;
    }
    if (this.registerRefused.has(relPath)) return undefined;
    // ADOPT BEFORE CREATING is the rule, and the ONLY oracle for it is the
    // dedupe hit a page further down (`reconcileDedupedRow`). The blob listing
    // cannot answer here: it is the same listing the diff subtracts, so a path
    // whose bytes it shows is never queued for upload and never reaches this
    // method — while the path that DOES reach it is one whose blob the listing
    // hid (ACL-filtered, another user's row). So the row is adopted after the
    // intent, which dedupes on vault+sha whatever the caller may read.
    const localId = (await this.localFileId(relPath)) ?? null;
    if (!localId) return undefined;
    try {
      const id = await this.deps.registerFile({ relPath, id: localId });
      if (!id) return undefined;
      this.fileIds.set(relPath, id);
      // `authored`: this is the UPLOAD path, so these bytes are this user's.
      // It is the only authorship signal a binary has, and it decides whether a
      // later revocation leaves them a `.context/trash` copy or nothing.
      this.deps.rememberFileId?.(relPath, id, { authored: true });
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
   * Adopt the `files` row these exact bytes ALREADY are, instead of leaving a
   * second one behind.
   *
   * The rule is deliberately narrow: the deduped blob carries a `doc_id` that is
   * not ours, and the path that row remembers is neither ours nor present on
   * this disk. Gone from disk is what makes it a rename rather than a twin — two
   * different files holding identical bytes share one blob (the mirror's
   * long-standing sha identity), and moving the row onto the second one would
   * take the first file's ACL with it. Both on disk ⇒ leave both alone; that
   * pair keeps the known limitation it always had.
   *
   * By the time we get here `ensureFileRow` may already have created `ours` (or
   * `.context/config.json` may remember one from a previous session's fork), so
   * this is the repair as well as the guard: that row is dropped BEFORE the
   * move, because the server adopts by path first and would otherwise hand our
   * own fork straight back. Dropping it costs no bytes — `DELETE /api/files/:id`
   * removes only blobs carrying THAT id, and the bytes carry the other one.
   *
   * Only the intent flow reaches this. The legacy route reports nothing about a
   * dedupe, so a server that predates the intent route keeps the old behaviour.
   *
   * Never fatal. The bytes are on the server either way, and a repair that
   * failed is retried by the next pass.
   */
  private async reconcileDedupedRow(
    a: LocalAttachment,
    ours: string | undefined,
    blob: { docId?: string | null; relPath?: string | null } | undefined,
  ): Promise<void> {
    if (isUnderAttachments(a.relPath)) return;
    if (!this.deps.registerFile) return;
    const theirs = blob?.docId ?? null;
    if (!theirs || theirs === ours) return;
    if (!this.isStrandedRow(blob?.relPath ?? null, a.relPath)) return;
    if (ours) {
      if (!this.deps.deleteFile) return;
      try {
        await this.deps.deleteFile(ours);
      } catch (e) {
        console.warn(`[attachments] couldn't drop the duplicate files row for ${a.relPath}`, e);
        return;
      }
      this.fileIds.delete(a.relPath);
      this.deps.forgetFileId?.(a.relPath);
      console.info(
        `[attachments] ${a.relPath} was registered twice — dropped ${ours} for ${theirs}, which owns the bytes`,
      );
    }
    await this.adoptRow(a.relPath, theirs, blob?.relPath ?? null);
  }

  /** Is `rowPath` a path this file left behind — a row stranded by a rename
   *  rather than a second file that happens to hold the same bytes? */
  private isStrandedRow(rowPath: string | null | undefined, relPath: string): boolean {
    if (!rowPath || isUnderAttachments(rowPath)) return false;
    // No pass, no disk: never decide a rename against a listing we never made.
    if (this.localPathKeys.size === 0) return false;
    const rowKey = rowPath.toLowerCase();
    if (rowKey === relPath.toLowerCase()) return false;
    return !this.localPathKeys.has(rowKey);
  }

  /** Move an existing row onto our path and record it as ours. */
  private async adoptRow(
    relPath: string,
    docId: string,
    rowPath: string | null,
  ): Promise<string | undefined> {
    if (!this.deps.registerFile) return undefined;
    try {
      const id = (await this.deps.registerFile({ relPath, id: docId })) ?? docId;
      this.fileIds.set(relPath, id);
      // No `authored` claim: adoption says nothing about who put the bytes
      // there. The claim this device made when it first uploaded them is keyed
      // by doc_id and survives the rename on its own.
      this.deps.rememberFileId?.(relPath, id);
      if (rowPath) this.deps.forgetFileId?.(rowPath);
      console.info(
        `[attachments] ${rowPath ?? "?"} → ${relPath} (renamed on disk; adopted file ${id} by content)`,
      );
      return id;
    } catch (e) {
      // Same reading as a refused registration: an answer is a decision, no
      // answer is a hiccup. Either way the bytes still go — without a doc_id,
      // which is what they had a moment ago.
      console.warn(`[attachments] couldn't adopt ${docId} for ${relPath}`, e);
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
    await runProbeFirst(
      paths,
      async (relPath) => {
        let text: Awaited<ReturnType<typeof read>>;
        try {
          text = await read(relPath);
        } catch (e) {
          console.warn("[attachments] extracted text unavailable", relPath, e);
          return;
        }
        // `pending` is the worker still working; anything else with no words is
        // a file whose text is legitimately empty (a video, an unsupported type).
        if (!text || text.status !== "ok" || text.chars <= 0 || !text.sha256) return;
        const blobId = this.blobIdBySha.get(text.sha256);
        // Not uploaded yet — the byte mirror will name the blob, and its own
        // completion re-queues this path.
        if (!blobId) return;
        if (this.textDone.has(blobId)) return;
        const content = capText(text.text);
        // Claimed BEFORE the send, not after: text describes BYTES, and two
        // paths holding the same bytes are now in flight at the same time. The
        // claim is given back below for a failure worth retrying.
        this.textDone.add(blobId);
        try {
          await upload({
            blobId,
            docId: this.fileIds.get(relPath) ?? this.deps.knownFileId?.(relPath) ?? null,
            sha256: text.sha256,
            chars: content.length,
            content,
          });
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
            console.warn(`[attachments] ${relPath} text refused (${status}) — not retrying`);
            return;
          }
          this.textDone.delete(blobId);
          console.warn("[attachments] text upload failed", relPath, e);
        }
      },
      {
        concurrency: BINARY_CONCURRENCY,
        shouldStop: () => !this.current() || this.textSupported === false,
      },
    );
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
    // The dots belong to the vault this mirror was built for. A stopped mirror
    // has nothing to say about them — and the paths it was holding are about to
    // mean a different vault's files.
    if (this.fileStates.size > 0) {
      this.fileStates = new Map();
      this.publishFileStates();
    }
  }

  /** True while a debounced pass is still armed (teardown assertions/tests). */
  hasPendingReconcile(): boolean {
    return this.timer != null;
  }
}
