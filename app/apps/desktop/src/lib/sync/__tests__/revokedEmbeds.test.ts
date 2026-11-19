import { describe, expect, it } from "vitest";
import {
  AttachmentSync,
  findEmbedReferences,
  type AttachmentSyncDeps,
  type ServerBlob,
} from "../attachments";

// #408: `attachments/` drops that only now-hidden notes embed leave the disk.
type Base = { sha: string; origin: "up" | "down" };
const sha = (b: Uint8Array) => `sha-${Array.from(b).join(".")}`;
const IMG = "attachments/abc123.png";

function harness(opts: {
  authority?: boolean;
  referenced?: string[] | null;
  listFails?: boolean;
} = {}) {
  const local = new Map<string, Uint8Array>();
  const server = new Map<string, { relPath: string; bytes: Uint8Array }>();
  const bases = new Map<string, Base>();
  const uploads: string[] = [];
  const removed: string[] = [];
  const trashed: string[] = [];
  const suppressed: string[] = [];
  const state = { authority: opts.authority ?? true, listFails: opts.listFails ?? false };
  const deps: AttachmentSyncDeps = {
    listLocal: async () =>
      [...local.entries()].map(([relPath, bytes]) => ({ relPath, sha256: sha(bytes), size: bytes.byteLength })),
    readLocal: async (p) => local.get(p)!,
    writeLocal: async (p, b) => void local.set(p, b),
    listServer: async (): Promise<ServerBlob[]> => {
      if (state.listFails) throw Object.assign(new Error("boom"), { status: 500 });
      return [...server.entries()].map(([id, v]) => ({ id, relPath: v.relPath, sha256: sha(v.bytes) }));
    },
    uploadServer: async (relPath, bytes) => {
      uploads.push(relPath);
      server.set(`u${uploads.length}`, { relPath, bytes });
    },
    downloadServer: async (id) => server.get(id)!.bytes,
    removeLocal: async (p) => {
      removed.push(p);
      local.delete(p);
    },
    trashLocal: async (p) => {
      trashed.push(p);
      local.delete(p);
      return `.context/trash/${p}`;
    },
    suppressDelete: (p) => void suppressed.push(p),
    attachmentBase: (p) => bases.get(p) ?? null,
    setAttachmentBase: (p, s, origin) => {
      const cur = bases.get(p);
      if (cur && cur.sha === s && cur.origin === "up") return;
      bases.set(p, { sha: s, origin });
    },
    forgetAttachmentBase: (p) => void bases.delete(p),
    revocationAuthority: () => state.authority,
    referencedAttachments: async () =>
      opts.referenced === null ? null : new Set(opts.referenced ?? []),
  };
  return { deps, local, server, bases, uploads, removed, trashed, suppressed, state };
}

/** A teammate's image arrives by download, then the note embedding it is hidden. */
async function downloadedThenHidden(h: ReturnType<typeof harness>) {
  const bytes = new Uint8Array([1, 2, 3]);
  h.server.set("b1", { relPath: IMG, bytes });
  const sync = new AttachmentSync(h.deps);
  expect(await sync.reconcile()).toEqual({ uploaded: 0, downloaded: 1 });
  expect(h.bases.get(IMG)).toEqual({ sha: sha(bytes), origin: "down" });
  h.server.delete("b1"); // the listing no longer names it for this member
  return sync;
}

describe("revoked embeds (#408)", () => {
  it("removes a downloaded attachment only hidden notes embed, and never re-uploads it", async () => {
    const h = harness();
    const sync = await downloadedThenHidden(h);
    await sync.reconcile();
    expect(h.removed).toEqual([IMG]);
    expect(h.suppressed).toEqual([IMG]);
    expect(h.local.has(IMG)).toBe(false);
    expect(h.bases.has(IMG)).toBe(false);
    expect(h.uploads).toEqual([]);
  });

  it("keeps it when a local note the user can still read embeds it", async () => {
    const h = harness({ referenced: [IMG] });
    const sync = await downloadedThenHidden(h);
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.local.has(IMG)).toBe(true);
    expect(h.uploads).toEqual([]); // hidden, not missing: no re-upload either
  });

  it("keeps it when the reference check cannot answer", async () => {
    const h = harness({ referenced: null });
    const sync = await downloadedThenHidden(h);
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.local.has(IMG)).toBe(true);
  });

  it("keeps it without a fresh ACL signal, and still does not re-upload", async () => {
    const h = harness({ authority: false });
    const sync = await downloadedThenHidden(h);
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.local.has(IMG)).toBe(true);
    expect(h.uploads).toEqual([]);
  });

  it("never removes a file this device uploaded itself", async () => {
    const h = harness();
    h.local.set(IMG, new Uint8Array([4, 5]));
    const sync = new AttachmentSync(h.deps);
    expect(await sync.reconcile()).toEqual({ uploaded: 1, downloaded: 0 });
    expect(h.bases.get(IMG)?.origin).toBe("up");
    // A later listing match never downgrades our own upload.
    await sync.reconcile();
    expect(h.bases.get(IMG)?.origin).toBe("up");
    h.server.clear();
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.trashed).toEqual([]);
    expect(h.local.has(IMG)).toBe(true);
    expect(h.uploads).toEqual([IMG]); // no second upload
  });

  it("never touches a local-only attachment with no server identity", async () => {
    const h = harness();
    h.local.set(IMG, new Uint8Array([7]));
    h.state.listFails = false;
    // No base recorded and nothing listed: an ordinary new drop that uploads.
    const sync = new AttachmentSync(h.deps);
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.trashed).toEqual([]);
    expect(h.uploads).toEqual([IMG]);
  });

  it("moves a copy edited here since the download to .context/trash", async () => {
    const h = harness();
    const sync = await downloadedThenHidden(h);
    h.local.set(IMG, new Uint8Array([9, 9]));
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.trashed).toEqual([IMG]);
    expect(h.local.has(IMG)).toBe(false);
  });

  it("removes nothing when the blob listing fails", async () => {
    const h = harness();
    const sync = await downloadedThenHidden(h);
    h.state.listFails = true;
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.trashed).toEqual([]);
    expect(h.local.has(IMG)).toBe(true);
  });

  it("removes nothing past the cap", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) {
      h.server.set(`b${i}`, { relPath: `attachments/x${i}.png`, bytes: new Uint8Array([i]) });
    }
    const sync = new AttachmentSync(h.deps);
    await sync.reconcile();
    expect(h.local.size).toBe(30);
    h.server.clear();
    // 30 > max(20, ceil(30 * 0.5) = 15) = 20.
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.local.size).toBe(30);
    expect(h.uploads).toEqual([]);
  });
});

describe("revoked embeds: a note that is itself leaving (#408)", () => {
  const notes = [
    { id: "hidden-1", path: "Secret/plan.md" },
    { id: "open-1", path: "Open/readme.md" },
  ];
  const texts: Record<string, string> = {
    "Secret/plan.md": `![](${IMG})`,
    "Open/readme.md": "no images here",
  };

  it("removes the image when its embedding note is in the same revocation group, still on disk", async () => {
    const leaving = new Set(["hidden-1"]);
    const h = harness();
    h.deps.referencedAttachments = (paths) =>
      findEmbedReferences(paths, notes, async (p) => texts[p], (n) => leaving.has(n.id));
    const sync = await downloadedThenHidden(h);
    await sync.reconcile();
    expect(h.removed).toEqual([IMG]);
    expect(h.local.has(IMG)).toBe(false);
  });

  it("keeps it when the embedding note is not leaving", async () => {
    const h = harness();
    h.deps.referencedAttachments = (paths) =>
      findEmbedReferences(paths, notes, async (p) => texts[p], () => false);
    const sync = await downloadedThenHidden(h);
    await sync.reconcile();
    expect(h.removed).toEqual([]);
    expect(h.local.has(IMG)).toBe(true);
  });

  it("a failed note read answers 'cannot tell', so nothing is removed", async () => {
    const h = harness();
    h.deps.referencedAttachments = (paths) =>
      findEmbedReferences(paths, notes, async () => { throw new Error("read failed"); }, () => false);
    const sync = await downloadedThenHidden(h);
    await sync.reconcile();
    expect(h.removed).toEqual([]);
  });
});
