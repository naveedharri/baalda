import { describe, expect, it } from "vitest";
import {
  AttachmentSync,
  planBinarySync,
  type AttachmentSyncDeps,
  type BinaryPlanContext,
  type LocalAttachment,
  type ServerBlob,
} from "../attachments";

// The server keeps ONE version per `files` row, so a mirror that uploads
// whatever the listing lacks turns two devices holding different bytes into a
// fight: each uploads its own and retires the other's, forever. These pin the
// three-way that replaced it (local vs server vs the base this device last
// agreed on) and the 409 `stale_base` guard behind it.

const ctx = (ids: Record<string, string>, bases: Record<string, string>): BinaryPlanContext => ({
  docIdFor: (p) => ids[p] ?? null,
  baseFor: (d) => bases[d] ?? null,
});
const L = (relPath: string, sha256: string): LocalAttachment => ({ relPath, sha256 });
const S = (id: string, relPath: string, sha256: string, docId: string | null): ServerBlob => ({
  id,
  relPath,
  sha256,
  docId,
});

describe("planBinarySync — the decision table", () => {
  const P = "Team/r.docx";

  it("local == server → agreed, nothing moves", () => {
    const plan = planBinarySync([L(P, "v1")], [S("b1", P, "v1", "D")], ctx({ [P]: "D" }, {}));
    expect(plan.agreed).toEqual([{ relPath: P, docId: "D", sha256: "v1" }]);
    expect(plan.toUpload).toEqual([]);
    expect(plan.toDownload).toEqual([]);
    expect(plan.toReplace).toEqual([]);
  });

  it("local == base, server moved → a teammate's edit: download over local, no trash copy", () => {
    const plan = planBinarySync(
      [L(P, "v1")],
      [S("b2", P, "v2", "D")],
      ctx({ [P]: "D" }, { D: "v1" }),
    );
    expect(plan.toUpload).toEqual([]);
    expect(plan.toReplace).toHaveLength(1);
    expect(plan.toReplace[0]).toMatchObject({ keepCopy: false, reason: "teammate-edit" });
    expect(plan.toReplace[0].blob).toMatchObject({ id: "b2", sha256: "v2", relPath: P });
  });

  it("server == base, local moved → a local edit: upload with baseSha", () => {
    const plan = planBinarySync(
      [L(P, "v3")],
      [S("b1", P, "v1", "D")],
      ctx({ [P]: "D" }, { D: "v1" }),
    );
    expect(plan.toUpload).toEqual([{ relPath: P, sha256: "v3", baseSha: "v1" }]);
    expect(plan.toReplace).toEqual([]);
  });

  it("no base and the server differs → server canonical, local kept in trash", () => {
    const plan = planBinarySync([L(P, "v1")], [S("b2", P, "v2", "D")], ctx({ [P]: "D" }, {}));
    expect(plan.toUpload).toEqual([]);
    expect(plan.toReplace[0]).toMatchObject({ keepCopy: true, reason: "no-base" });
  });

  it("all three differ → conflict: server canonical, local kept in trash", () => {
    const plan = planBinarySync(
      [L(P, "v4")],
      [S("b3", P, "v3", "D")],
      ctx({ [P]: "D" }, { D: "v1" }),
    );
    expect(plan.toUpload).toEqual([]);
    expect(plan.toReplace[0]).toMatchObject({ keepCopy: true, reason: "conflict" });
  });

  it("an unmapped local file at a doc's path is matched by path (a fresh device)", () => {
    const plan = planBinarySync([L("team/R.docx", "old")], [S("b", P, "new", "D")], ctx({}, {}));
    expect(plan.toUpload).toEqual([]);
    expect(plan.toReplace[0]).toMatchObject({ keepCopy: true, reason: "no-base" });
    // The bytes land where the file is on THIS disk.
    expect(plan.toReplace[0].blob.relPath).toBe("team/R.docx");
  });

  it("a doc with no server row, a doc-less row, and attachments/ keep the content-hash diff", () => {
    const plan = planBinarySync(
      [L("Team/new.pdf", "n"), L("Team/legacy.pdf", "l2"), L("attachments/a.png", "a2")],
      [S("x", "Team/legacy.pdf", "l1", null), S("y", "attachments/a.png", "a1", null)],
      ctx({ "Team/new.pdf": "N" }, {}),
    );
    expect(plan.toUpload.map((a) => a.relPath).sort()).toEqual([
      "Team/legacy.pdf",
      "Team/new.pdf",
      "attachments/a.png",
    ]);
    expect(plan.toReplace).toEqual([]);
    expect(plan.toDownload).toEqual([]);
  });

  it("a consumed doc row is never also a plain download at its server path", () => {
    // The server row was renamed elsewhere; the local file is known by id.
    const plan = planBinarySync(
      [L("Old/r.docx", "v1")],
      [S("b2", "New/r.docx", "v2", "D")],
      ctx({ "Old/r.docx": "D" }, { D: "v1" }),
    );
    expect(plan.toDownload).toEqual([]);
    expect(plan.toReplace[0].blob.relPath).toBe("Old/r.docx");
  });
});

// ── A server that keeps one version per doc, and two devices on it ─────────

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const shaOf = (b: Uint8Array) => `sha:${dec(b)}`;

class FakeServer {
  /** docId → the one ready version. */
  rows = new Map<string, { id: string; relPath: string; bytes: Uint8Array }>();
  pending = new Map<string, { docId: string; relPath: string; bytes?: Uint8Array }>();
  uploads: Array<{ device: string; sha: string; baseSha: string | null }> = [];
  private next = 1;

  seed(docId: string, relPath: string, content: string) {
    this.rows.set(docId, { id: `blob-${this.next++}`, relPath, bytes: enc(content) });
  }
  current(docId: string): string | null {
    const r = this.rows.get(docId);
    return r ? dec(r.bytes) : null;
  }
  list(): ServerBlob[] {
    return [...this.rows.entries()].map(([docId, r]) => ({
      id: r.id,
      relPath: r.relPath,
      sha256: shaOf(r.bytes),
      docId,
      size: r.bytes.byteLength,
    }));
  }
  meta(docId: string): ServerBlob {
    return this.list().find((b) => b.docId === docId)!;
  }
  byId(id: string): Uint8Array {
    for (const r of this.rows.values()) if (r.id === id) return r.bytes;
    throw new Error(`no blob ${id}`);
  }
}

interface Device {
  name: string;
  files: Map<string, Uint8Array>;
  ids: Map<string, string>;
  /** The persisted half of the base (what `.context/config.json` holds). */
  bases: Map<string, string>;
  trash: Array<{ relPath: string; content: string }>;
  notices: string[];
  /** Serve this listing instead of the live one on the next pass (a stale read). */
  staleListing: ServerBlob[] | null;
  failTrash: boolean;
  sync: AttachmentSync;
  /** A fresh AttachmentSync over the same persisted state — an app restart. */
  restart: () => void;
}

function device(name: string, server: FakeServer, seed: Record<string, string>, ids: Record<string, string>): Device {
  const d = {
    name,
    files: new Map(Object.entries(seed).map(([p, c]) => [p, enc(c)])),
    ids: new Map(Object.entries(ids)),
    bases: new Map<string, string>(),
    trash: [],
    notices: [],
    staleListing: null,
    failTrash: false,
  } as unknown as Device;
  const deps = (): AttachmentSyncDeps => ({
    listLocal: async () =>
      [...d.files.entries()].map(([relPath, b]) => ({ relPath, sha256: shaOf(b), size: b.byteLength })),
    readLocal: async (p) => d.files.get(p)!,
    writeLocal: async (p, b) => void d.files.set(p, b),
    writeTreeLocal: async (p, b) => void d.files.set(p, b),
    listServer: async () => {
      const stale = d.staleListing;
      d.staleListing = null;
      return stale ?? server.list();
    },
    uploadServer: async () => {
      throw new Error("legacy route not expected");
    },
    downloadServer: async (id) => server.byId(id),
    createIntent: async (input) => {
      const docId = input.docId as string;
      const cur = server.rows.get(docId);
      if (cur && shaOf(cur.bytes) === input.sha256) {
        return { deduped: true as const, blob: { ...server.meta(docId) } as never };
      }
      if (cur && input.baseSha && shaOf(cur.bytes) !== input.baseSha) {
        throw Object.assign(new Error("stale"), {
          status: 409,
          code: "stale_base",
          body: { code: "stale_base", current: server.meta(docId) },
        });
      }
      const blobId = `pending-${input.sha256}`;
      server.pending.set(blobId, { docId, relPath: input.relPath });
      server.uploads.push({ device: name, sha: input.sha256, baseSha: input.baseSha ?? null });
      return {
        blobId,
        completeUrl: `complete:${blobId}`,
        upload: {
          kind: "single" as const,
          method: "PUT",
          url: `put:${blobId}`,
          headers: {},
          expiresAt: Date.now() + 60_000,
          direct: true,
        },
      };
    },
    putBytes: async ({ url, bytes }) => {
      server.pending.get(url.slice(4))!.bytes = bytes;
      return { status: 204, etag: null };
    },
    completeUpload: async (url) => {
      const id = url.slice(9);
      const p = server.pending.get(id)!;
      server.pending.delete(id);
      // One version per doc: the new row retires the old one.
      server.rows.set(p.docId, { id: `blob-${id}`, relPath: p.relPath, bytes: p.bytes! });
    },
    knownFileId: (p) => d.ids.get(p) ?? null,
    registerFile: async ({ id }) => id,
    localFileIds: async () => new Map(),
    rememberFileId: (p, id) => void d.ids.set(p, id),
    fileBase: (docId) => d.bases.get(docId) ?? null,
    setFileBase: (docId, sha) => void d.bases.set(docId, sha),
    keepLocalCopy: async (p) => {
      if (d.failTrash) throw new Error("disk full");
      d.trash.push({ relPath: p, content: dec(d.files.get(p)!) });
      return `.context/trash/x/${p}`;
    },
    notify: (text) => void d.notices.push(text),
  });
  d.sync = new AttachmentSync(deps());
  d.restart = () => {
    d.sync = new AttachmentSync(deps());
  };
  return d;
}

const P = "Team/report.docx";
const read = (d: Device) => dec(d.files.get(P)!);

describe("AttachmentSync three-way, two devices on one server", () => {
  it("the production flip converges: an upgraded pair with no bases settles on the server's version", async () => {
    // A holds V1, B holds V2, and the server holds whichever uploaded last.
    const server = new FakeServer();
    server.seed("D", P, "V2");
    const a = device("A", server, { [P]: "V1" }, { [P]: "D" });
    const b = device("B", server, { [P]: "V2" }, { [P]: "D" });

    for (let round = 0; round < 3; round++) {
      await a.sync.reconcile();
      await b.sync.reconcile();
    }

    // Nobody uploaded: with no base, the server is canonical.
    expect(server.uploads).toEqual([]);
    expect(server.current("D")).toBe("V2");
    expect(read(a)).toBe("V2");
    expect(read(b)).toBe("V2");
    // A's divergent copy is recoverable, once, and A was told.
    expect(a.trash).toEqual([{ relPath: P, content: "V1" }]);
    expect(a.notices).toHaveLength(1);
    expect(b.trash).toEqual([]);
    expect(a.bases.get("D")).toBe("sha:V2");
    expect(b.bases.get("D")).toBe("sha:V2");
  });

  it("a teammate's edit reaches the other device instead of being reverted", async () => {
    const server = new FakeServer();
    server.seed("D", P, "V1");
    const a = device("A", server, { [P]: "V1" }, { [P]: "D" });
    const b = device("B", server, { [P]: "V1" }, { [P]: "D" });
    await a.sync.reconcile();
    await b.sync.reconcile();

    // B edits; B uploads with its base.
    b.files.set(P, enc("V2"));
    await b.sync.reconcile();
    expect(server.uploads).toEqual([{ device: "B", sha: "sha:V2", baseSha: "sha:V1" }]);

    // A still holds V1 (== its base): it downloads, never uploads, keeps no copy.
    await a.sync.reconcile();
    await a.sync.reconcile();
    await b.sync.reconcile();
    expect(read(a)).toBe("V2");
    expect(server.current("D")).toBe("V2");
    expect(server.uploads).toHaveLength(1);
    expect(a.trash).toEqual([]);
  });

  it("the base survives a restart (persisted), so a restarted stale device still downloads", async () => {
    const server = new FakeServer();
    server.seed("D", P, "V1");
    const a = device("A", server, { [P]: "V1" }, { [P]: "D" });
    await a.sync.reconcile();
    expect(a.bases.get("D")).toBe("sha:V1");

    server.seed("D", P, "V2"); // a teammate's upload while A was closed
    a.restart();
    await a.sync.reconcile();
    expect(read(a)).toBe("V2");
    expect(a.trash).toEqual([]);
    expect(server.uploads).toEqual([]);
  });

  it("a concurrent edit that loses the race gets 409 stale_base, keeps its copy, and downloads the winner", async () => {
    const server = new FakeServer();
    server.seed("D", P, "V1");
    const a = device("A", server, { [P]: "V1" }, { [P]: "D" });
    const b = device("B", server, { [P]: "V1" }, { [P]: "D" });
    await a.sync.reconcile();
    await b.sync.reconcile();

    a.files.set(P, enc("V3"));
    b.files.set(P, enc("V4"));
    // B lists the server before A's upload lands…
    b.staleListing = server.list();
    await a.sync.reconcile();
    expect(server.current("D")).toBe("V3");
    // …so B plans an upload from base V1, and the server refuses it.
    await b.sync.reconcile();
    expect(server.current("D")).toBe("V3");
    expect(read(b)).toBe("V3");
    expect(b.trash).toEqual([{ relPath: P, content: "V4" }]);
    expect(b.bases.get("D")).toBe("sha:V3");
    // Settled: another round moves nothing.
    const before = server.uploads.length;
    await a.sync.reconcile();
    await b.sync.reconcile();
    expect(server.uploads.length).toBe(before);
  });

  it("never overwrites a divergent local file when the recovery copy fails", async () => {
    const server = new FakeServer();
    server.seed("D", P, "V2");
    const a = device("A", server, { [P]: "V1" }, { [P]: "D" });
    a.failTrash = true;
    await a.sync.reconcile();
    expect(read(a)).toBe("V1");
    expect(server.current("D")).toBe("V2");
    expect(server.uploads).toEqual([]);
  });

  it("a genuine local edit still uploads, carrying its base", async () => {
    const server = new FakeServer();
    server.seed("D", P, "V1");
    const a = device("A", server, { [P]: "V1" }, { [P]: "D" });
    await a.sync.reconcile();
    a.files.set(P, enc("V5"));
    await a.sync.reconcile();
    expect(server.current("D")).toBe("V5");
    expect(server.uploads).toEqual([{ device: "A", sha: "sha:V5", baseSha: "sha:V1" }]);
    expect(a.bases.get("D")).toBe("sha:V5");
  });
});
