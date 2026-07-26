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
      [...local.entries()].map(([relPath, bytes]) => ({ relPath, sha256: sha(bytes) })),
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

  it("is a no-op when both sides already match", async () => {
    const bytes = new Uint8Array([5, 5, 5]);
    const { deps } = makeDeps(
      [{ relPath: "attachments/x.png", bytes }],
      [{ id: "s1", relPath: "attachments/x.png", bytes }],
    );
    const res = await new AttachmentSync(deps).reconcile();
    expect(res).toEqual({ uploaded: 0, downloaded: 0 });
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
