// Attachment sync (Phase 3 blob store, spec 02 §2/§5A). Diffs the vault's local
// `attachments/` files against the server's blob list BY CONTENT HASH (sha256)
// and moves the delta both ways: upload local-only files, download server-only
// files into `attachments/`. Attachments never enter the note/CRDT pipeline —
// this is a plain content-addressed file mirror.
//
// The diff is pure and unit-tested in isolation; the `AttachmentSync` class
// wires it to injected I/O (ApiClient + Tauri ipc) and debounces watcher-driven
// reconciles so a burst of file events collapses into one pass.

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

/** Guess a content-type from a file extension (upload hint; MVP table). */
export function mimeForPath(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
    tiff: "image/tiff",
    tif: "image/tiff",
    jfif: "image/jpeg",
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    zip: "application/zip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    wav: "audio/wav",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Injected I/O so the sync loop is testable without Tauri or a live server. */
export interface AttachmentSyncDeps {
  /** List local attachment files under `attachments/`. */
  listLocal: () => Promise<LocalAttachment[]>;
  /** Read a local attachment's bytes (vault-relative path). */
  readLocal: (relPath: string) => Promise<Uint8Array>;
  /** Atomically write bytes to a vault-relative path (creates dirs). */
  writeLocal: (relPath: string, bytes: Uint8Array) => Promise<void>;
  /** List the server's blobs for this vault. */
  listServer: () => Promise<ServerBlob[]>;
  /** Upload bytes as an attachment. */
  uploadServer: (relPath: string, bytes: Uint8Array, mime: string) => Promise<void>;
  /** Download a blob's bytes by id. */
  downloadServer: (id: string) => Promise<Uint8Array>;
}

export interface ReconcileResult {
  uploaded: number;
  downloaded: number;
}

export class AttachmentSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;

  constructor(
    private readonly deps: AttachmentSyncDeps,
    private readonly debounceMs = 400,
    private readonly setTimeoutImpl: typeof setTimeout = setTimeout,
    private readonly clearTimeoutImpl: typeof clearTimeout = clearTimeout,
  ) {}

  /** Run one full reconcile pass now. Coalesces if one is already in flight. */
  async reconcile(): Promise<ReconcileResult> {
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
      } while (this.rerun);
    } finally {
      this.running = false;
    }
    return result;
  }

  private async pass(): Promise<ReconcileResult> {
    const [local, server] = await Promise.all([
      this.deps.listLocal(),
      this.deps.listServer(),
    ]);
    const { toUpload, toDownload } = diffAttachments(local, server);

    for (const a of toUpload) {
      try {
        const bytes = await this.deps.readLocal(a.relPath);
        await this.deps.uploadServer(a.relPath, bytes, mimeForPath(a.relPath));
      } catch (e) {
        console.error("[attachments] upload failed", a.relPath, e);
      }
    }
    for (const b of toDownload) {
      try {
        const bytes = await this.deps.downloadServer(b.id);
        await this.deps.writeLocal(b.relPath as string, bytes);
      } catch (e) {
        console.error("[attachments] download failed", b.relPath, e);
      }
    }
    return { uploaded: toUpload.length, downloaded: toDownload.length };
  }

  /** Debounced reconcile — collapses a burst of watcher events into one pass. */
  scheduleReconcile(): void {
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this.reconcile();
    }, this.debounceMs);
  }
}
