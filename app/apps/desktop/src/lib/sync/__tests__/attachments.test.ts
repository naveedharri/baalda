import { describe, expect, it, vi } from "vitest";
import {
  AttachmentSync,
  diffAttachments,
  isSafeAttachmentRelPath,
  mimeForPath,
  type AttachmentSyncDeps,
  type LocalAttachment,
  type ServerBlob,
} from "../attachments";

describe("diffAttachments (content-hash diff)", () => {
  it("uploads local-only and downloads server-only, by sha256", () => {
    const local: LocalAttachment[] = [
      { relPath: "attachments/a.png", sha256: "aaa" }, // only local → upload
      { relPath: "attachments/shared.png", sha256: "sss" }, // both → skip
    ];
    const server: ServerBlob[] = [
      { id: "1", relPath: "attachments/shared.png", sha256: "sss" }, // both → skip
      { id: "2", relPath: "attachments/b.pdf", sha256: "bbb" }, // only server → download
    ];
    const { toUpload, toDownload } = diffAttachments(local, server);
    expect(toUpload.map((a) => a.relPath)).toEqual(["attachments/a.png"]);
    expect(toDownload.map((b) => b.id)).toEqual(["2"]);
  });

  it("treats identical content at different paths as already synced (dedupe)", () => {
    const local: LocalAttachment[] = [{ relPath: "attachments/renamed.png", sha256: "xyz" }];
    const server: ServerBlob[] = [{ id: "1", relPath: "attachments/original.png", sha256: "xyz" }];
    const { toUpload, toDownload } = diffAttachments(local, server);
    expect(toUpload).toHaveLength(0);
    expect(toDownload).toHaveLength(0);
  });

  it("skips server blobs missing a sha or rel_path (can't place on disk)", () => {
    const server: ServerBlob[] = [
      { id: "1", relPath: null, sha256: "abc" },
      { id: "2", relPath: "attachments/ok.png", sha256: "" },
      { id: "3", relPath: "attachments/good.png", sha256: "def" },
    ];
    const { toDownload } = diffAttachments([], server);
    expect(toDownload.map((b) => b.id)).toEqual(["3"]);
  });

  it("refuses server blobs whose relPath escapes attachments/ (path-traversal ACL bypass)", () => {
    const server: ServerBlob[] = [
      { id: "evil-ctx", relPath: ".context/index.sqlite", sha256: "1" },
      { id: "evil-note", relPath: "Team Plans.md", sha256: "2" },
      { id: "evil-dot", relPath: "attachments/.context/x", sha256: "3" },
      { id: "evil-up", relPath: "attachments/../secret", sha256: "4" },
      { id: "ok", relPath: "attachments/img.png", sha256: "5" },
      { id: "ok-sub", relPath: "attachments/sub/doc.pdf", sha256: "6" },
    ];
    const { toDownload } = diffAttachments([], server);
    // Only the two legitimate attachment paths survive; the rest are dropped.
    expect(toDownload.map((b) => b.id).sort()).toEqual(["ok", "ok-sub"]);
  });

  it("an edited file is not re-downloaded from its superseded server row", () => {
    // `Report.docx` was synced at sha A, then edited in Word → sha B. B has
    // been uploaded, so the server holds BOTH rows for that one path.
    const local: LocalAttachment[] = [{ relPath: "Docs/Report.docx", sha256: "B" }];
    const server: ServerBlob[] = [
      { id: "old", relPath: "Docs/Report.docx", sha256: "A" },
      { id: "new", relPath: "Docs/Report.docx", sha256: "B" },
    ];
    const { toUpload, toDownload } = diffAttachments(local, server);
    // Nothing to do: the bytes are on the server, and the stale row must NOT be
    // written back over the edit (which would flip-flop on every pass).
    expect(toUpload).toHaveLength(0);
    expect(toDownload).toHaveLength(0);
  });

  it("refuses a server blob whose path the disk occupies, whatever its case", () => {
    const local: LocalAttachment[] = [{ relPath: "Docs/Report.docx", sha256: "B" }];
    const server: ServerBlob[] = [
      { id: "case", relPath: "docs/report.docx", sha256: "A" },
      { id: "free", relPath: "Docs/Other.docx", sha256: "C" },
    ];
    const { toDownload } = diffAttachments(local, server);
    // Only the path no local file holds is downloadable.
    expect(toDownload.map((b) => b.id)).toEqual(["free"]);
  });
});

describe("isSafeAttachmentRelPath", () => {
  it("accepts only non-traversing paths under attachments/", () => {
    expect(isSafeAttachmentRelPath("attachments/a.png")).toBe(true);
    expect(isSafeAttachmentRelPath("attachments/sub/deep/b.pdf")).toBe(true);
    // Rejected: root files, dotfiles/.context, traversal, wrong root, bare dir.
    expect(isSafeAttachmentRelPath("note.md")).toBe(false);
    expect(isSafeAttachmentRelPath(".context/index.sqlite")).toBe(false);
    expect(isSafeAttachmentRelPath("attachments/.hidden")).toBe(false);
    expect(isSafeAttachmentRelPath("attachments/../x")).toBe(false);
    expect(isSafeAttachmentRelPath("attachments")).toBe(false);
    expect(isSafeAttachmentRelPath("attachments\\..\\x")).toBe(false);
    expect(isSafeAttachmentRelPath("")).toBe(false);
  });
});

describe("mimeForPath", () => {
  it("maps common extensions and falls back to octet-stream", () => {
    expect(mimeForPath("attachments/x.png")).toBe("image/png");
    expect(mimeForPath("a/b/c.PDF")).toBe("application/pdf");
    expect(mimeForPath("attachments/weird.xyz")).toBe("application/octet-stream");
    expect(mimeForPath("noext")).toBe("application/octet-stream");
  });
});

// In-memory two-sided store to exercise a full reconcile round-trip.
function makeDeps(
  localSeed: Array<{ relPath: string; bytes: Uint8Array }> = [],
  serverSeed: Array<{ id: string; relPath: string; bytes: Uint8Array }> = [],
) {
  const sha = (b: Uint8Array) => `sha-${Array.from(b).join(".")}`;
  const local = new Map<string, Uint8Array>(localSeed.map((f) => [f.relPath, f.bytes]));
  const server = new Map<string, { relPath: string; bytes: Uint8Array }>(
    serverSeed.map((f) => [f.id, { relPath: f.relPath, bytes: f.bytes }]),
  );
  let nextId = 100;

  const deps: AttachmentSyncDeps = {
    listLocal: async () =>
      [...local.entries()].map(([relPath, bytes]) => ({
        relPath,
        sha256: sha(bytes),
        size: bytes.byteLength,
      })),
    readLocal: async (relPath) => local.get(relPath)!,
    writeLocal: async (relPath, bytes) => {
      local.set(relPath, bytes);
    },
    listServer: async () =>
      [...server.entries()].map(([id, v]) => ({ id, relPath: v.relPath, sha256: sha(v.bytes) })),
    uploadServer: async (relPath, bytes) => {
      server.set(String(nextId++), { relPath, bytes });
    },
    downloadServer: async (id) => server.get(id)!.bytes,
  };
  return { deps, local, server };
}

describe("AttachmentSync.reconcile (two-way)", () => {
  it("uploads local-only files and downloads server-only files (byte-identical)", async () => {
    const upBytes = new Uint8Array([1, 2, 3]);
    const downBytes = new Uint8Array([9, 8, 7, 6]);
    const { deps, local, server } = makeDeps(
      [{ relPath: "attachments/local.png", bytes: upBytes }],
      [{ id: "srv1", relPath: "attachments/remote.pdf", bytes: downBytes }],
    );
    const sync = new AttachmentSync(deps);
    const res = await sync.reconcile();

    expect(res).toEqual({ uploaded: 1, downloaded: 1 });
    // The server-only file landed on disk, byte-identical.
    expect(Array.from(local.get("attachments/remote.pdf")!)).toEqual(Array.from(downBytes));
    // The local-only file was uploaded byte-identical.
    const uploaded = [...server.values()].find((v) => v.relPath === "attachments/local.png");
    expect(uploaded).toBeTruthy();
    expect(Array.from(uploaded!.bytes)).toEqual(Array.from(upBytes));
  });

  it("does not download a file whose delete is still in its grace window", async () => {
    const bytes = new Uint8Array([4, 4, 4]);
    const { deps, local } = makeDeps([], [{ id: "srv1", relPath: "Team/guide.pdf", bytes }]);
    // The file was just deleted on disk, so the diff reads it as "server-only".
    // The delete queue is what tells the mirror the difference (`binaryDeletes`).
    deps.isDeletePending = (relPath) => relPath === "Team/guide.pdf";
    deps.writeTreeLocal = async (relPath, b) => {
      local.set(relPath, b);
    };
    const sync = new AttachmentSync(deps);

    expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 0 });
    expect(local.has("Team/guide.pdf")).toBe(false);

    // Window closed without a delete (the file came back, the server refused):
    // the mirror resumes exactly as before.
    deps.isDeletePending = () => false;
    expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 1 });
    expect(local.has("Team/guide.pdf")).toBe(true);
  });

  it("is a no-op when both sides already match", async () => {
    const bytes = new Uint8Array([5, 5, 5]);
    const { deps } = makeDeps(
      [{ relPath: "attachments/x.png", bytes }],
      [{ id: "s1", relPath: "attachments/x.png", bytes }],
    );
    const res = await new AttachmentSync(deps).reconcile();
    expect(res).toEqual({ uploaded: 0, downloaded: 0 });
  });

  it("stops retrying when the server says attachment sync requires Pro", async () => {
    const { deps } = makeDeps([{ relPath: "attachments/local.png", bytes: new Uint8Array([1]) }]);
    let pro = false;
    const listServer = vi.fn(async () => {
      if (!pro) throw serverError(402, "attachment_sync_requires_pro");
      return [];
    });
    const notify = vi.fn();
    const onFileStates = vi.fn();
    const onEntitlementBlocked = vi.fn();
    const sync = new AttachmentSync({
      ...deps,
      listServer,
      notify,
      onFileStates,
      onEntitlementBlocked,
    });

    expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 0 });
    expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 0 });
    expect(listServer).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toMatch(/stay on this device/i);
    expect(notify.mock.calls[0]?.[0]).toMatch(/upgrade.*Pro/i);
    expect(onFileStates).toHaveBeenLastCalledWith({});
    expect(onEntitlementBlocked).toHaveBeenCalledTimes(1);
    expect(onEntitlementBlocked).toHaveBeenLastCalledWith(true);

    // A confirmed billing refresh explicitly re-enables the probe; successful
    // entitlement recovery resumes the ordinary mirror in this same session.
    pro = true;
    sync.resetEntitlement();
    expect(onEntitlementBlocked).toHaveBeenLastCalledWith(false);
    expect(await sync.reconcile()).toEqual({ uploaded: 1, downloaded: 0 });
    expect(listServer).toHaveBeenCalledTimes(2);
  });

  it("remembers a plan refusal without announcing it for a note-only vault", async () => {
    const { deps } = makeDeps();
    const listServer = vi.fn(async () => {
      throw serverError(402, "attachment_sync_requires_pro");
    });
    const notify = vi.fn();
    const onEntitlementBlocked = vi.fn();
    const sync = new AttachmentSync({
      ...deps,
      listServer,
      notify,
      onEntitlementBlocked,
    });

    expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 0 });
    expect(onEntitlementBlocked).toHaveBeenCalledWith(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("scheduleReconcile debounces a burst into a single pass", () => {
    const { deps } = makeDeps();
    const reconcile = vi.spyOn(AttachmentSync.prototype, "reconcile").mockResolvedValue({
      uploaded: 0,
      downloaded: 0,
    });
    let fn: (() => void) | null = null;
    const setTimeoutImpl = ((cb: () => void) => {
      fn = cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;

    const sync = new AttachmentSync(deps, 400, setTimeoutImpl, clearTimeoutImpl);
    sync.scheduleReconcile();
    sync.scheduleReconcile();
    sync.scheduleReconcile();
    // Two re-arms cleared the prior timer each time.
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(2);
    // Firing the debounced callback runs exactly one reconcile.
    fn!();
    expect(reconcile).toHaveBeenCalledTimes(1);
    reconcile.mockRestore();
  });
});

// Vault isolation: this sync is built per vault and captures that vault's server
// vaultId + IPC epoch, so it must go quiet the moment its vault stops being the
// open one. See `vaultScope.test.ts` / `docSessionVaultScope.test.ts`.
describe("AttachmentSync vault scoping", () => {
  it("stop() drops the pending debounced pass instead of leaking it", () => {
    const { deps } = makeDeps();
    const cleared: unknown[] = [];
    const setTimeoutImpl = (() =>
      7 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    const clearTimeoutImpl = ((h: unknown) => cleared.push(h)) as unknown as typeof clearTimeout;

    const sync = new AttachmentSync(deps, 400, setTimeoutImpl, clearTimeoutImpl);
    sync.scheduleReconcile();
    expect(sync.hasPendingReconcile()).toBe(true);

    sync.stop();
    // A live timer would keep this instance — and the vaultId it captured — alive
    // and fire a pass against the vault the user just left.
    expect(sync.hasPendingReconcile()).toBe(false);
    expect(cleared).toEqual([7]);
  });

  it("a debounced pass that fires after the vault changed is a no-op", async () => {
    const { deps, server } = makeDeps([
      { relPath: "attachments/only-local.png", bytes: new Uint8Array([1]) },
    ]);
    let current = true;
    let fn: (() => void) | null = null;
    const setTimeoutImpl = ((cb: () => void) => {
      fn = cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const sync = new AttachmentSync(
      { ...deps, isCurrent: () => current },
      400,
      setTimeoutImpl,
      (() => {}) as unknown as typeof clearTimeout,
    );
    sync.scheduleReconcile();
    current = false; // the user switched vaults while the pass was armed
    fn!();
    await Promise.resolve();
    // Nothing uploaded into the vault we left.
    expect(server.size).toBe(0);
  });

  it("reconcile() called directly for a stale vault uploads nothing", async () => {
    const { deps, local, server } = makeDeps(
      [{ relPath: "attachments/a.png", bytes: new Uint8Array([2]) }],
      [{ id: "s1", relPath: "attachments/b.pdf", bytes: new Uint8Array([3]) }],
    );
    const sync = new AttachmentSync({ ...deps, isCurrent: () => false });
    expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 0 });
    expect(server.size).toBe(1); // no upload into the old vault's blob store
    expect(local.size).toBe(1); // no download into the new vault's folder
  });

  it("swallows a failed listing instead of rejecting (every caller is fire-and-forget)", async () => {
    // The local listing is epoch-pinned, so Rust REJECTS it the moment the vault
    // changes, and the server listing fails whenever we're offline. Neither is an
    // exception for the caller: `void sync.reconcile()` would turn it into an
    // unhandled promise rejection.
    const { deps } = makeDeps();
    const local = new AttachmentSync({
      ...deps,
      listLocal: async () => {
        throw new Error("vault-mismatch: caller pinned vault epoch 1");
      },
    });
    await expect(local.reconcile()).resolves.toEqual({ uploaded: 0, downloaded: 0 });

    const offline = new AttachmentSync({
      ...deps,
      listServer: async () => {
        throw new Error("network down");
      },
    });
    await expect(offline.reconcile()).resolves.toEqual({ uploaded: 0, downloaded: 0 });
  });
});

// ---- intent → PUT → complete -----------------------------------------------
//
// The transport the desktop actually uses against a current server. Everything
// is injected, so these exercise the real decision-making — which step runs,
// what headers go out, what is retried and what is given up on — without Tauri,
// a webview or a live server.

/** An error shaped like the api client's `BlobTransportError`. */
function serverError(status: number, code?: string) {
  return Object.assign(new Error(code ?? `HTTP ${status}`), { status, code });
}

interface TransportLog {
  intents: Array<{ relPath: string; sha256: string; size: number }>;
  puts: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    range?: { start: number; end: number };
    bytes: number;
    via: "rust" | "webview";
  }>;
  completes: Array<{ url: string; body: unknown }>;
  partRequests: Array<{ url: string; partNumbers: number[] }>;
  downloadUrls: string[];
  fetches: Array<{ url: string; headers: Record<string, string> }>;
  legacyUploads: string[];
  legacyDownloads: string[];
  reads: string[];
  toasts: string[];
}

/**
 * Deps wired to a fake server that speaks the intent flow. `respond` decides
 * what the intent answers (or throws) per file, which is how each case below
 * picks its scenario.
 */
function makeTransport(
  files: Array<{ relPath: string; bytes: Uint8Array }>,
  respond: (input: { relPath: string; sha256: string; size: number }) => unknown,
  extra: Partial<AttachmentSyncDeps> = {},
) {
  const log: TransportLog = {
    intents: [],
    puts: [],
    completes: [],
    partRequests: [],
    downloadUrls: [],
    fetches: [],
    legacyUploads: [],
    legacyDownloads: [],
    reads: [],
    toasts: [],
  };
  const local = new Map(files.map((f) => [f.relPath, f.bytes]));
  const deps: AttachmentSyncDeps = {
    listLocal: async () =>
      [...local.entries()].map(([relPath, bytes]) => ({
        relPath,
        sha256: `sha-${relPath}`,
        size: bytes.byteLength,
      })),
    readLocal: async (relPath) => {
      log.reads.push(relPath);
      return local.get(relPath)!;
    },
    writeLocal: async (relPath, bytes) => {
      local.set(relPath, bytes);
    },
    listServer: async () => [],
    uploadServer: async (relPath) => {
      log.legacyUploads.push(relPath);
    },
    downloadServer: async (id) => {
      log.legacyDownloads.push(id);
      return new Uint8Array([0]);
    },
    createIntent: async (input) => {
      log.intents.push({ relPath: input.relPath, sha256: input.sha256, size: input.size });
      const answer = respond(input);
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
    completeUpload: async (url, body) => {
      log.completes.push({ url, body });
    },
    requestParts: async (url, partNumbers) => {
      log.partRequests.push({ url, partNumbers });
      return { parts: partNumbers.map((n) => ({ partNumber: n, url: `https://s3/fresh/${n}` })) };
    },
    // The Rust path: it is handed a PATH, never bytes — that is the point.
    putFile: async (input) => {
      const whole = local.get(input.relPath)!;
      const len = input.range ? input.range.end - input.range.start : whole.byteLength;
      log.puts.push({
        url: input.url,
        method: input.method,
        headers: input.headers,
        range: input.range,
        bytes: len,
        via: "rust",
      });
      return { status: 204, etag: `"etag-${log.puts.length}"` };
    },
    putBytes: async (input) => {
      log.puts.push({
        url: input.url,
        method: input.method,
        headers: input.headers,
        bytes: input.bytes.byteLength,
        via: "webview",
      });
      return { status: 204, etag: null };
    },
    authHeaders: () => ({ Authorization: "Bearer session-token" }),
    notify: (text) => {
      log.toasts.push(text);
    },
    ...extra,
  };
  return { deps, log, local };
}

const SINGLE_INTENT = {
  blobId: "blob-1",
  completeUrl: "https://api.test/api/blobs/blob-1/complete",
  upload: {
    kind: "single" as const,
    method: "PUT",
    url: "https://s3.test/bucket/key?X-Amz-Signature=abc",
    headers: { "content-type": "image/png", "content-length": "3" },
    expiresAt: Date.now() + 60_000,
    direct: true,
  },
};

describe("AttachmentSync upload transport (intent → PUT → complete)", () => {
  it("PUTs to the intent's URL with exactly its headers, then completes", async () => {
    const { deps, log } = makeTransport(
      [{ relPath: "attachments/a.png", bytes: new Uint8Array([1, 2, 3]) }],
      () => SINGLE_INTENT,
    );
    const res = await new AttachmentSync(deps).reconcile();

    expect(res.uploaded).toBe(1);
    expect(log.intents).toEqual([
      { relPath: "attachments/a.png", sha256: "sha-attachments/a.png", size: 3 },
    ]);
    expect(log.puts).toHaveLength(1);
    expect(log.puts[0].url).toBe(SINGLE_INTENT.upload.url);
    expect(log.puts[0].via).toBe("rust");
    // Exactly the presigned headers — a bearer here is what S3 rejects.
    expect(log.puts[0].headers).toEqual(SINGLE_INTENT.upload.headers);
    expect(Object.keys(log.puts[0].headers)).not.toContain("Authorization");
    expect(log.completes).toEqual([{ url: SINGLE_INTENT.completeUrl, body: {} }]);
    // Streaming from Rust means the bytes never passed through JS.
    expect(log.reads).toEqual([]);
    expect(log.legacyUploads).toEqual([]);
  });

  it("a deduped intent moves zero bytes and never opens the file", async () => {
    const { deps, log } = makeTransport(
      [{ relPath: "attachments/dupe.png", bytes: new Uint8Array([7, 7]) }],
      () => ({ deduped: true, blob: { id: "b", sha256: "s", size: 2, mime: null, relPath: null } }),
    );
    const res = await new AttachmentSync(deps).reconcile();

    expect(res.uploaded).toBe(1); // the server has it, which is what counts
    expect(log.reads).toEqual([]); // no readLocal
    expect(log.puts).toEqual([]); // no bytes
    expect(log.completes).toEqual([]);
  });

  it("uploads identical bytes at two paths ONCE, even with the lanes racing", async () => {
    // The loop used to be serial, so the second path found the bytes already on
    // the server and deduped for free. At `BINARY_CONCURRENCY` both lanes reach
    // the intent while the other's bytes are still ON THE WIRE — the server has
    // no completed blob to dedupe against yet, so it hands out a second upload
    // target and the same bytes go twice. Wasted bandwidth in exactly the
    // workload this pass optimises (500 binaries, many duplicates).
    const dupes = ["attachments/copy-a.png", "attachments/copy-b.png"];
    // Three files: `runProbeFirst` runs item 0 alone, so the two duplicates only
    // race each other if something else goes first.
    const all = ["attachments/probe.png", ...dupes];
    /** Shas whose bytes are FINISHED on the server — the only thing it can
     *  dedupe against. A transfer still in flight is not one. */
    const stored = new Set<string>();
    const intents: string[] = [];
    const puts: string[] = [];
    const { deps } = makeTransport(
      all.map((relPath) => ({ relPath, bytes: new Uint8Array([7, 7]) })),
      () => SINGLE_INTENT,
      {
        // Two paths, ONE content hash — what the path-derived default can't say.
        listLocal: async () =>
          all.map((relPath) => ({
            relPath,
            sha256: dupes.includes(relPath) ? "sha-shared" : `sha-${relPath}`,
            size: 2,
          })),
        createIntent: async (input) => {
          intents.push(input.sha256);
          await new Promise((r) => setTimeout(r, 2)); // a real round trip
          if (stored.has(input.sha256)) {
            return {
              deduped: true,
              blob: {
                id: `b-${input.sha256}`,
                sha256: input.sha256,
                size: 2,
                mime: null,
                relPath: null,
              },
            } as never;
          }
          return {
            ...SINGLE_INTENT,
            completeUrl: `https://api.test/complete/${input.sha256}`,
          } as never;
        },
        // Bytes take time — that is what makes the window a window.
        putFile: async (input) => {
          puts.push(input.relPath);
          await new Promise((r) => setTimeout(r, 30));
          return { status: 204, etag: '"e"' };
        },
        completeUpload: async (url) => {
          stored.add(url.slice(url.lastIndexOf("/") + 1));
        },
      },
    );
    const res = await new AttachmentSync(deps).reconcile();

    expect(res.uploaded).toBe(3);
    // Both duplicates asked — they each need their own `files` row — but only
    // one of them moved bytes.
    expect(intents.filter((sha) => sha === "sha-shared")).toHaveLength(2);
    expect(puts).toEqual(["attachments/probe.png", "attachments/copy-a.png"]);
  });

  it("splits a multipart upload at partBytes and completes with the ETags", async () => {
    const bytes = new Uint8Array(25).fill(9);
    const { deps, log } = makeTransport(
      [{ relPath: "attachments/clip.mp4", bytes }],
      () => ({
        blobId: "blob-mp",
        completeUrl: "https://api.test/api/blobs/blob-mp/complete",
        upload: {
          kind: "multipart" as const,
          method: "PUT",
          uploadId: "upload-9",
          partBytes: 10,
          parts: [
            { partNumber: 1, url: "https://s3/p1" },
            { partNumber: 2, url: "https://s3/p2" },
            { partNumber: 3, url: "https://s3/p3" },
          ],
          headers: {},
          expiresAt: Date.now() + 60_000,
          direct: true,
          partsUrl: "https://api.test/api/blobs/blob-mp/parts?t=tok",
        },
      }),
    );
    await new AttachmentSync(deps).reconcile();

    expect(log.puts.map((p) => p.range)).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 25 }, // the tail is short, not padded
    ]);
    expect(log.puts.map((p) => p.url)).toEqual([
      "https://s3/p1",
      "https://s3/p2",
      "https://s3/p3",
    ]);
    expect(log.completes[0].body).toEqual({
      uploadId: "upload-9",
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
  });

  it("re-mints a part URL whose presign expired, and uses the fresh one", async () => {
    const bytes = new Uint8Array(15).fill(1);
    let putCount = 0;
    const { deps, log } = makeTransport(
      [{ relPath: "attachments/big.mp4", bytes }],
      () => ({
        blobId: "blob-mp",
        completeUrl: "https://api.test/complete",
        upload: {
          kind: "multipart" as const,
          method: "PUT",
          uploadId: "u1",
          partBytes: 10,
          parts: [{ partNumber: 1, url: "https://s3/stale-1" }], // part 2 missing
          headers: {},
          expiresAt: Date.now(),
          direct: true,
          partsUrl: "https://api.test/parts?t=tok",
        },
      }),
      {
        putFile: async (input) => {
          putCount++;
          // The first part's presign has died since the intent was minted.
          const expired = input.url === "https://s3/stale-1";
          return { status: expired ? 403 : 204, etag: expired ? null : `"e${putCount}"` };
        },
      },
    );
    await new AttachmentSync(deps).reconcile();

    // Part 1 re-minted after the 403; part 2 re-minted because it was never
    // given. Compared as a SET: the parts of one file run in lanes now, so part
    // 2 (whose URL was missing from the intent) asks before part 1's 403 comes
    // back. Which part asks first is a race; that each asks exactly once, and
    // for itself, is the contract.
    expect([...log.partRequests].sort((a, b) => a.partNumbers[0] - b.partNumbers[0])).toEqual([
      { url: "https://api.test/parts?t=tok", partNumbers: [1] },
      { url: "https://api.test/parts?t=tok", partNumbers: [2] },
    ]);
    expect(log.completes[0].body).toMatchObject({ uploadId: "u1" });
  });

  it("retries the PUT (not the complete) on upload_incomplete", async () => {
    let completes = 0;
    const { deps, log } = makeTransport(
      [{ relPath: "attachments/a.png", bytes: new Uint8Array([1, 2, 3]) }],
      () => SINGLE_INTENT,
      {
        completeUpload: async () => {
          completes++;
          if (completes === 1) throw serverError(409, "upload_incomplete");
        },
      },
    );
    const res = await new AttachmentSync(deps).reconcile();

    expect(res.uploaded).toBe(1);
    expect(completes).toBe(2);
    expect(log.puts).toHaveLength(2); // the bytes were re-sent, then completed
  });

  it("falls back to the legacy route on 404 and stops probing intent", async () => {
    const { deps, log } = makeTransport(
      [
        { relPath: "attachments/a.png", bytes: new Uint8Array([1]) },
        { relPath: "attachments/b.png", bytes: new Uint8Array([2]) },
      ],
      () => serverError(404, "not_found"),
    );
    const sync = new AttachmentSync(deps);
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(2);
    expect(log.legacyUploads).toEqual(["attachments/a.png", "attachments/b.png"]);
    // One probe for the whole server, not one per file — and none on a re-run.
    expect(log.intents).toHaveLength(1);
    await sync.reconcile();
    expect(log.intents).toHaveLength(1);
  });

  it("aborts the whole pass on 402 and toasts exactly once", async () => {
    const { deps, log } = makeTransport(
      [
        { relPath: "attachments/a.png", bytes: new Uint8Array([1]) },
        { relPath: "attachments/b.png", bytes: new Uint8Array([2]) },
      ],
      () => serverError(402, "storage_limit_reached"),
    );
    const sync = new AttachmentSync(deps);
    expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 0 });

    // The second file is never even announced: the vault is full, not the file.
    expect(log.intents).toHaveLength(1);
    expect(log.toasts).toHaveLength(1);
    expect(log.toasts[0]).toMatch(/storage/i);
    // A later pass re-tries (the user may have freed space) but never re-toasts.
    await sync.reconcile();
    expect(log.intents).toHaveLength(2);
    expect(log.toasts).toHaveLength(1);
  });

  it("skips a 413/415 file permanently instead of retrying it every pass", async () => {
    const { deps, log } = makeTransport(
      [
        { relPath: "attachments/huge.mp4", bytes: new Uint8Array([1]) },
        { relPath: "attachments/ok.png", bytes: new Uint8Array([2]) },
      ],
      ({ relPath }) =>
        relPath === "attachments/huge.mp4"
          ? serverError(413, "attachment_too_large")
          : SINGLE_INTENT,
    );
    const sync = new AttachmentSync(deps);

    const first = await sync.reconcile();
    expect(first.uploaded).toBe(1); // only the good one
    expect(log.intents).toHaveLength(2);

    // Second pass: the refused file is not announced again; the other still is.
    const second = await sync.reconcile();
    expect(second.uploaded).toBe(1);
    expect(log.intents.map((i) => i.relPath)).toEqual([
      "attachments/huge.mp4",
      "attachments/ok.png",
      "attachments/ok.png",
    ]);
  });
});

// ── The sidebar's file dots ────────────────────────────────────────────────
// A `.pdf` row gets the same dot a note's row does, and it is the mirror that
// has to say so. Every case below is a way the dot could have lied: claiming
// synced for bytes the server never got, staying amber on a file it refused, or
// outliving the vault it belonged to.
describe("AttachmentSync per-file state (store.fileSyncState)", () => {
  /** Deps that publish states, plus the log of every map emitted. */
  function withStates(
    files: Array<{ relPath: string; bytes: Uint8Array }>,
    respond: Parameters<typeof makeTransport>[1],
    extra: Partial<AttachmentSyncDeps> = {},
  ) {
    const emissions: Array<Record<string, string>> = [];
    const { deps, log } = makeTransport(files, respond, {
      ...extra,
      onFileStates: (states) => {
        emissions.push({ ...states });
      },
    });
    return { deps, log, emissions, last: () => emissions[emissions.length - 1] ?? {} };
  }

  it("calls a file the server already holds synced, without moving a byte", async () => {
    const { deps, log, last } = withStates(
      [{ relPath: "Team/report.docx", bytes: new Uint8Array([1]) }],
      () => SINGLE_INTENT,
      {
        listServer: async () => [
          { id: "blob-1", relPath: "Team/report.docx", sha256: "sha-Team/report.docx" },
        ],
      },
    );
    await new AttachmentSync(deps).reconcile();

    expect(last()).toEqual({ "Team/report.docx": "synced" });
    expect(log.intents).toEqual([]); // nothing was announced, let alone sent
  });

  it("walks a new file queued → syncing → synced across its upload", async () => {
    const { deps, emissions } = withStates(
      [{ relPath: "Team/deck.pptx", bytes: new Uint8Array([1, 2, 3]) }],
      () => SINGLE_INTENT,
    );
    await new AttachmentSync(deps).reconcile();

    // In that order: the diff queues it, the upload claims it, the complete
    // confirms it. Anything else and the dot would jump straight to green.
    expect(emissions.map((e) => e["Team/deck.pptx"])).toEqual([
      "queued",
      "syncing",
      "synced",
    ]);
  });

  it("fails a file the server refuses for good, and only that file", async () => {
    const { deps, emissions, last } = withStates(
      [
        { relPath: "Media/huge.mp4", bytes: new Uint8Array([1]) },
        { relPath: "Media/ok.png", bytes: new Uint8Array([2]) },
      ],
      ({ relPath }) =>
        relPath === "Media/huge.mp4" ? serverError(413, "attachment_too_large") : SINGLE_INTENT,
    );
    const sync = new AttachmentSync(deps);
    await sync.reconcile();

    expect(last()).toEqual({ "Media/huge.mp4": "error", "Media/ok.png": "synced" });

    // A second pass re-derives the map WITHOUT asking again: the refusal is
    // remembered by content hash, so the dot stays red rather than flickering
    // back through amber on every reconcile.
    emissions.length = 0;
    await sync.reconcile();
    expect(emissions[0]["Media/huge.mp4"]).toBe("error");
    expect(last()["Media/huge.mp4"]).toBe("error");
  });

  it("leaves the hidden attachments/ store out — it has no row to badge", async () => {
    const { deps, last } = withStates(
      [
        { relPath: "attachments/dropped.png", bytes: new Uint8Array([1]) },
        { relPath: "Team/report.docx", bytes: new Uint8Array([2]) },
      ],
      () => SINGLE_INTENT,
    );
    await new AttachmentSync(deps).reconcile();

    expect(Object.keys(last())).toEqual(["Team/report.docx"]);
  });

  it("forgets a file that left the vault, because the map is rebuilt not merged", async () => {
    const local = new Map<string, Uint8Array>([
      ["Team/a.pdf", new Uint8Array([1])],
      ["Team/b.pdf", new Uint8Array([2])],
    ]);
    const { deps, last } = withStates([], () => SINGLE_INTENT, {
      listLocal: async () =>
        [...local.entries()].map(([relPath, bytes]) => ({
          relPath,
          sha256: `sha-${relPath}`,
          size: bytes.byteLength,
        })),
    });
    const sync = new AttachmentSync(deps);
    await sync.reconcile();
    expect(Object.keys(last()).sort()).toEqual(["Team/a.pdf", "Team/b.pdf"]);

    local.delete("Team/b.pdf");
    await sync.reconcile();
    expect(Object.keys(last())).toEqual(["Team/a.pdf"]);
  });

  it("clears the map on stop, so the dots leave with the vault", async () => {
    const { deps, last } = withStates(
      [{ relPath: "Team/report.docx", bytes: new Uint8Array([1]) }],
      () => SINGLE_INTENT,
    );
    const sync = new AttachmentSync(deps);
    await sync.reconcile();
    expect(last()).toEqual({ "Team/report.docx": "synced" });

    sync.stop();
    expect(last()).toEqual({});
  });
});

describe("AttachmentSync download transport (presigned URL)", () => {
  /** Deps whose server holds one blob and speaks `GET /api/blobs/:id/url`. */
  function makeDownload(
    target: unknown,
    extra: Partial<AttachmentSyncDeps> = {},
  ): { deps: AttachmentSyncDeps; log: TransportLog } {
    const { deps, log } = makeTransport([], () => SINGLE_INTENT, {
      listServer: async () => [
        { id: "blob-1", relPath: "attachments/remote.png", sha256: "deadbeef" },
      ],
      downloadUrl: async (id) => {
        log.downloadUrls.push(id);
        if (target instanceof Error) throw target;
        return target as never;
      },
      fetchToFile: async (input) => {
        log.fetches.push({ url: input.url, headers: input.headers });
        return { status: 200, bytes: 4 };
      },
      ...extra,
    });
    return { deps, log };
  }

  it("fetches a direct (presigned) URL with NO Authorization header", async () => {
    const { deps, log } = makeDownload({
      url: "https://s3.test/bucket/key?X-Amz-Signature=abc",
      expiresAt: Date.now() + 60_000,
      direct: true,
    });
    const res = await new AttachmentSync(deps).reconcile();

    expect(res.downloaded).toBe(1);
    expect(log.fetches).toHaveLength(1);
    // The whole point: a presign plus a bearer is rejected by S3, and the
    // bearer must not leak to a third-party host either way.
    expect(log.fetches[0].headers).toEqual({});
    expect(log.legacyDownloads).toEqual([]);
  });

  it("sends the bearer when the URL is our own route (direct: false)", async () => {
    const { deps, log } = makeDownload({
      url: "https://api.test/api/blobs/blob-1",
      expiresAt: null,
      direct: false,
    });
    await new AttachmentSync(deps).reconcile();
    expect(log.fetches[0].headers).toEqual({ Authorization: "Bearer session-token" });
  });

  it("falls back to the legacy download when /url answers 404", async () => {
    const { deps, log } = makeDownload(serverError(404, "not_found"));
    const sync = new AttachmentSync(deps);
    const res = await sync.reconcile();

    expect(res.downloaded).toBe(1);
    expect(log.fetches).toEqual([]);
    expect(log.legacyDownloads).toEqual(["blob-1"]);
    // Remembered per server, like the upload probe.
    await sync.reconcile();
    expect(log.downloadUrls).toEqual(["blob-1"]);
  });

  it("uses the webview fetch when the Rust command is missing, and only then", async () => {
    const seen: Array<Record<string, string>> = [];
    const { deps, log } = makeDownload(
      { url: "https://s3.test/key?sig", expiresAt: null, direct: true },
      {
        fetchToFile: async () => {
          throw new Error("Command download_attachment not found");
        },
        fetchBytes: async (url, headers) => {
          seen.push(headers);
          expect(url).toBe("https://s3.test/key?sig");
          return new Uint8Array([4, 4]);
        },
      },
    );
    const res = await new AttachmentSync(deps).reconcile();
    expect(res.downloaded).toBe(1);
    expect(seen).toEqual([{}]); // still no bearer on a presign
    expect(log.legacyDownloads).toEqual([]);
  });
});

// ── Bounded concurrency (audit finding #2) ─────────────────────────────────
// Every byte-moving loop here used to be `for (…) await …` — width 1 — so 500
// files cost ~2,000 strictly sequential round trips. These pin the two budgets
// that replaced it: six files in flight, and 32 MiB of them (Syncthing's
// `pullerMaxPendingKiB` default), plus the two semantics concurrency could have
// broken — a multipart complete's part ORDER, and the whole-pass 402 abort.

/** A `putFile` that records how many transfers overlap. */
function concurrencyProbe(delayMs = 0) {
  const state = { inflight: 0, max: 0, bytesInflight: 0, maxBytes: 0 };
  const putFile = async (input: { relPath: string; range?: { start: number; end: number } }) => {
    const size = sizeOf(input.relPath);
    state.inflight++;
    state.bytesInflight += size;
    state.max = Math.max(state.max, state.inflight);
    state.maxBytes = Math.max(state.maxBytes, state.bytesInflight);
    await new Promise((r) => setTimeout(r, delayMs));
    state.inflight--;
    state.bytesInflight -= size;
    return { status: 204, etag: `"etag-${input.relPath}"` };
  };
  return { state, putFile };
}

const FILE_SIZES = new Map<string, number>();
const sizeOf = (relPath: string) => FILE_SIZES.get(relPath) ?? 1;

/** N files, each reported at `size` bytes without allocating them. */
function manyFiles(n: number, size: number) {
  const names = Array.from({ length: n }, (_, i) => `attachments/f${i}.bin`);
  for (const name of names) FILE_SIZES.set(name, size);
  return names;
}

describe("AttachmentSync bounded concurrency", () => {
  it("moves files in parallel, but never more than six at once", async () => {
    const names = manyFiles(20, 1);
    const { state, putFile } = concurrencyProbe(1);
    const { deps, log } = makeTransport(
      names.map((relPath) => ({ relPath, bytes: new Uint8Array([1]) })),
      () => SINGLE_INTENT,
      { putFile },
    );
    const res = await new AttachmentSync(deps).reconcile();

    expect(res.uploaded).toBe(20);
    expect(log.completes).toHaveLength(20);
    // Parallel (the old serial loop would have pinned this at 1) and bounded.
    expect(state.max).toBeGreaterThan(1);
    expect(state.max).toBeLessThanOrEqual(6);
  });

  it("holds no more than the byte budget in flight, whatever the file count", async () => {
    const EIGHT_MIB = 8 * 1024 * 1024;
    const names = manyFiles(20, EIGHT_MIB);
    const { state, putFile } = concurrencyProbe(1);
    const { deps } = makeTransport(
      names.map((relPath) => ({ relPath, bytes: new Uint8Array([1]) })),
      () => SINGLE_INTENT,
      {
        putFile,
        // The sizes the mirror budgets against, without allocating 160 MB.
        listLocal: async () =>
          names.map((relPath) => ({ relPath, sha256: `sha-${relPath}`, size: EIGHT_MIB })),
      },
    );
    await new AttachmentSync(deps).reconcile();

    // 32 MiB / 8 MiB ⇒ four lanes' worth of BYTES, even though six lanes exist.
    expect(state.maxBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(state.max).toBeLessThanOrEqual(4);
    expect(state.max).toBeGreaterThan(1);
  });

  it("completes a multipart upload in partNumber order when parts finish out of order", async () => {
    const bytes = new Uint8Array(25).fill(9);
    const { deps, log } = makeTransport(
      [{ relPath: "attachments/clip.mp4", bytes }],
      () => ({
        blobId: "blob-mp",
        completeUrl: "https://api.test/complete",
        upload: {
          kind: "multipart" as const,
          method: "PUT",
          uploadId: "u-order",
          partBytes: 10,
          parts: [
            { partNumber: 1, url: "https://s3/p1" },
            { partNumber: 2, url: "https://s3/p2" },
            { partNumber: 3, url: "https://s3/p3" },
          ],
          headers: {},
          expiresAt: Date.now() + 60_000,
          direct: true,
          partsUrl: "https://api.test/parts?t=tok",
        },
      }),
      {
        // Part 3 answers first, part 1 last — the shape S3 rejects if the
        // complete is assembled in finish order.
        putFile: async (input) => {
          const n = Number(input.url.slice(-1));
          await new Promise((r) => setTimeout(r, (4 - n) * 3));
          return { status: 204, etag: `"etag-p${n}"` };
        },
      },
    );
    await new AttachmentSync(deps).reconcile();

    expect(log.completes[0].body).toEqual({
      uploadId: "u-order",
      parts: [
        { partNumber: 1, etag: '"etag-p1"' },
        { partNumber: 2, etag: '"etag-p2"' },
        { partNumber: 3, etag: '"etag-p3"' },
      ],
    });
  });

  it("stops starting new uploads the moment one answers 402", async () => {
    const names = manyFiles(20, 1);
    let intents = 0;
    const { deps, log } = makeTransport(
      names.map((relPath) => ({ relPath, bytes: new Uint8Array([1]) })),
      () => {
        intents++;
        // The first file is the probe and succeeds; the vault fills after it.
        return intents === 1 ? SINGLE_INTENT : serverError(402, "storage_limit_reached");
      },
      { putFile: concurrencyProbe(1).putFile },
    );
    const sync = new AttachmentSync(deps);
    const res = await sync.reconcile();

    // The lanes already in flight finish their refusal; nothing behind them is
    // ever announced — the whole point of AbortPass.
    expect(log.intents.length).toBeLessThan(20);
    expect(log.intents.length).toBeLessThanOrEqual(1 + 6);
    expect(res.uploaded).toBe(1);
    expect(log.toasts).toHaveLength(1); // one fact about the vault, not per file
  });
});
