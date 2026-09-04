import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(),
  setVaultConfig: vi.fn(),
  listTree: vi.fn(),
  listNoteTitles: vi.fn(),
  writeNote: vi.fn(),
  writeNoteIfMissing: vi.fn(),
  readNote: vi.fn(),
  ensureFolder: vi.fn(),
  renamePath: vi.fn(),
  trashNote: vi.fn(),
  deletePath: vi.fn(),
  deleteFolderIfEmpty: vi.fn(),
  isVaultMismatch: vi.fn(() => false),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry, type InboundHost } from "../registry";

/**
 * Inbound reconciliation, wired end to end against a fake disk.
 *
 * `inbound.test.ts` covers the decision rules in isolation. This covers the
 * things only the wiring can get wrong: that the right IPC is called, that a doc
 * is RELEASED before its file moves, that the tree is re-read afterwards (without
 * which the outbound half undoes the move), and that nothing inbound happens at
 * all without a persisted baseline for this collection.
 *
 * The fake disk MUTATES, deliberately. A rename mock that returned a path without
 * moving anything would hide the exact bug this feature fixes: after the move, the
 * old path must no longer look like a local note the server has never heard of.
 */

const ORG = "org-1";
const VAULT = "vault-1";

/** A mutable stand-in for the vault folder. */
class FakeDisk {
  /** relPath → docId, for the notes the local index knows. */
  notes = new Map<string, string>();
  folders = new Set<string>();
  /** relPath → body, for the emptiness check on unconfirmed notes. */
  bodies = new Map<string, string>();
  trashed: Array<{ from: string; to: string }> = [];

  tree(): TreeNode {
    const dirs = [...this.folders].map((f) => ({
      id: f,
      name: f,
      path: f,
      isDir: true,
      children: [],
      childrenLoaded: true,
    }));
    const files = [...this.notes.keys()].map((p) => ({
      id: p,
      name: p,
      path: p,
      isDir: false,
    }));
    return {
      id: "root",
      name: "vault",
      path: "",
      isDir: true,
      childrenLoaded: true,
      children: [...dirs, ...files],
    };
  }

  titles() {
    return [...this.notes].map(([path, id]) => ({ path, id, title: null }));
  }
}

function install(disk: FakeDisk) {
  vi.mocked(ipc.listTree).mockImplementation((async () => disk.tree()) as never);
  vi.mocked(ipc.listNoteTitles).mockImplementation((async () => disk.titles()) as never);
  vi.mocked(ipc.readNote).mockImplementation((async (p: string) =>
    disk.bodies.get(p) ?? "") as never);
  vi.mocked(ipc.ensureFolder).mockImplementation((async (p: string) => {
    disk.folders.add(p);
  }) as never);
  vi.mocked(ipc.writeNoteIfMissing).mockImplementation((async (p: string) => {
    if (disk.notes.has(p)) return false;
    disk.notes.set(p, `local-${p}`);
    return true;
  }) as never);
  vi.mocked(ipc.renamePath).mockImplementation((async (from: string, to: string) => {
    const docId = disk.notes.get(from);
    if (docId === undefined) throw new Error("source path does not exist");
    if (disk.notes.has(to)) throw new Error("destination already exists");
    disk.notes.delete(from);
    disk.notes.set(to, docId);
    const body = disk.bodies.get(from);
    if (body !== undefined) {
      disk.bodies.delete(from);
      disk.bodies.set(to, body);
    }
    return to;
  }) as never);
  vi.mocked(ipc.deleteFolderIfEmpty).mockImplementation((async (p: string) => {
    if (!disk.folders.has(p)) return true; // already gone — the goal state
    const prefix = p + "/";
    const occupied =
      [...disk.notes.keys()].some((n) => n.startsWith(prefix)) ||
      [...disk.folders].some((f) => f.startsWith(prefix));
    if (occupied) return false;
    disk.folders.delete(p);
    return true;
  }) as never);
  vi.mocked(ipc.trashNote).mockImplementation((async (p: string, stamp: string) => {
    if (!disk.notes.has(p)) throw new Error("path does not exist");
    disk.notes.delete(p);
    disk.bodies.delete(p);
    const dest = `.context/trash/${stamp}/${p}`;
    disk.trashed.push({ from: p, to: dest });
    return dest;
  }) as never);
}

interface ServerState {
  notes: Array<{ id: string; rel_path: string }>;
  tombstones?: string[] | null;
  folders?: Array<{ id: string; path: string }>;
  folderTombstones?: string[] | null;
}

function fakeApi(state: ServerState) {
  return {
    listVaults: vi.fn(async () => [{ id: VAULT, name: "v", organization_id: ORG }]),
    createVault: vi.fn(),
    listFolders: vi.fn(async () => state.folders ?? []),
    listFolderRegistry: vi.fn(async () => ({
      folders: state.folders ?? [],
      tombstones: state.folderTombstones === undefined ? [] : state.folderTombstones,
    })),
    createFolder: vi.fn(async (i: { path: string }) => ({ id: `folder-${i.path}`, path: i.path })),
    listNotes: vi.fn(async () => state.notes),
    listNoteRegistry: vi.fn(async () => ({
      notes: state.notes,
      tombstones: state.tombstones === undefined ? [] : state.tombstones,
    })),
    createNote: vi.fn(async (i: { relPath: string; docId?: string }) => ({
      id: i.docId ?? `note-${i.relPath}`,
      rel_path: i.relPath,
    })),
    deleteNote: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => {}),
  } as unknown as ApiClient;
}

function recordingHost() {
  const released: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const removed: Array<{ path: string; trashedTo: string | null }> = [];
  const host: InboundHost = {
    releaseDoc: async (docId) => {
      released.push(docId);
    },
    notePathChanged: (_docId, from, to) => renamed.push({ from, to }),
    noteRemoved: (_docId, path, trashedTo) => removed.push({ path, trashedTo }),
  };
  return { host, released, renamed, removed };
}

/**
 * Reconcile once so a baseline exists, hand that baseline back the way a relaunch
 * would (through `.context/config.json`), then reconcile again against a changed
 * server. Inbound compares against a prior agreement, so a single pass can never
 * exercise it.
 */
async function twoPasses(opts: { disk: FakeDisk; first: ServerState; then: ServerState }) {
  install(opts.disk);
  const reg1 = new VaultRegistry(fakeApi(opts.first));
  reg1.setInboundHost(recordingHost().host);
  await reg1.reconcile({ organizationId: ORG, vaultName: "v" });

  const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
  const written = writes[writes.length - 1]?.[0] as string;
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(written as never);
  vi.mocked(ipc.renamePath).mockClear();
  vi.mocked(ipc.trashNote).mockClear();
  vi.mocked(ipc.ensureFolder).mockClear();

  const api = fakeApi(opts.then);
  const reg = new VaultRegistry(api);
  const host = recordingHost();
  reg.setInboundHost(host.host);
  await reg.reconcile({ organizationId: ORG, vaultName: "v" });
  return { reg, api, ...host };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null as never);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined as never);
  vi.mocked(ipc.isVaultMismatch).mockReturnValue(false);
});

describe("inbound is disabled without a baseline", () => {
  it("does not move or remove anything on a first reconcile", async () => {
    // A fresh device has no record of a prior agreement, so every difference is
    // ambiguous. It must degrade to outbound-only — the behaviour we had before —
    // rather than guess which side moved.
    const disk = new FakeDisk();
    disk.notes.set("local.md", "d1");
    install(disk);
    const reg = new VaultRegistry(fakeApi({ notes: [{ id: "d1", rel_path: "server.md" }] }));
    reg.setInboundHost(recordingHost().host);

    await reg.reconcile({ organizationId: ORG, vaultName: "v" });

    expect(ipc.renamePath).not.toHaveBeenCalled();
    expect(ipc.trashNote).not.toHaveBeenCalled();
  });
});

describe("inbound folder creation", () => {
  it("creates a server-only folder locally — what makes an MCP folder appear at all", async () => {
    // The reported bug. `create_folder` over MCP always produces an EMPTY folder,
    // and an empty folder has no note to drag it onto disk, so it was invisible on
    // every device forever.
    const disk = new FakeDisk();
    disk.notes.set("a.md", "d1");
    await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "a.md" }] },
      then: {
        notes: [{ id: "d1", rel_path: "a.md" }],
        folders: [{ id: "f1", path: "Ideas" }],
      },
    });
    expect(ipc.ensureFolder).toHaveBeenCalledWith("Ideas", null);
    expect(disk.folders.has("Ideas")).toBe(true);
  });

  it("is idempotent — a second pass creates nothing", async () => {
    const disk = new FakeDisk();
    disk.notes.set("a.md", "d1");
    disk.folders.add("Ideas");
    await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "a.md" }], folders: [{ id: "f1", path: "Ideas" }] },
      then: { notes: [{ id: "d1", rel_path: "a.md" }], folders: [{ id: "f1", path: "Ideas" }] },
    });
    expect(ipc.ensureFolder).not.toHaveBeenCalled();
  });
});

describe("inbound rename", () => {
  it("moves the file and leaves exactly ONE note behind", async () => {
    const disk = new FakeDisk();
    disk.notes.set("old.md", "d1");
    const r = await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "old.md" }] },
      then: { notes: [{ id: "d1", rel_path: "new.md" }] },
    });

    expect(ipc.renamePath).toHaveBeenCalledWith("old.md", "new.md", null);
    // The whole point: one file at the new path. Before this, the old path kept
    // the content and the new path was materialized as a second, empty file.
    expect([...disk.notes.keys()]).toEqual(["new.md"]);
    // Released BEFORE the move — a bridge still holding the old path would egest
    // afterwards, recreating the file AND forking it under a fresh doc_id.
    expect(r.released).toEqual(["d1"]);
    expect(r.renamed).toEqual([{ from: "old.md", to: "new.md" }]);
    // And the old path is not pushed back up as a new note.
    expect(vi.mocked(r.api.createNote)).not.toHaveBeenCalled();
  });

  it("does not re-materialize the old path afterwards", async () => {
    // The re-read guard: without it, the outbound half still sees `old.md` as a
    // local note missing from the server and `new.md` as server-only.
    const disk = new FakeDisk();
    disk.notes.set("old.md", "d1");
    await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "old.md" }] },
      then: { notes: [{ id: "d1", rel_path: "new.md" }] },
    });
    expect(disk.notes.size).toBe(1);
  });
});

describe("inbound delete", () => {
  it("trashes a tombstoned note and reports where it went", async () => {
    const disk = new FakeDisk();
    disk.notes.set("bye.md", "d1");
    const r = await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "bye.md" }] },
      then: { notes: [], tombstones: ["d1"] },
    });

    expect(disk.notes.has("bye.md")).toBe(false);
    // Recoverable, never a hard delete: this reconciler once destroyed 428 notes.
    expect(ipc.deletePath).not.toHaveBeenCalled();
    expect(disk.trashed[0].to).toContain(".context/trash/");
    expect(r.released).toEqual(["d1"]);
    expect(r.removed[0]?.path).toBe("bye.md");
    // Crucially it is NOT pushed back up, which is what produced the ghost note.
    expect(vi.mocked(r.api.createNote)).not.toHaveBeenCalled();
  });

  it("trashes a MATERIALIZED note the server deleted, while the path→docId join is live", async () => {
    // The undeletable-note bug. Nothing is on disk to begin with: the file
    // arrives via `writeNoteIfMissing`, and Rust's indexer mints a local id for
    // it that is NOT the server's docId (the mock mirrors that). `registry.byPath`
    // is the only place the two identities are joined, and inbound wasn't
    // consulting it — so the tombstone matched nothing, the doc read as "already
    // gone locally", and the outbound half re-registered the still-present file
    // under a brand-new docId. The deleted note came back, and deleting THAT just
    // repeated the cycle.
    const disk = new FakeDisk();
    install(disk);
    const state: ServerState = {
      notes: [{ id: "srv-1", rel_path: "naveed-test.md" }],
      tombstones: [],
    };
    const api = fakeApi(state);
    const reg = new VaultRegistry(api);
    reg.setInboundHost(recordingHost().host);
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });
    // The premise: materialized under an identity of its own.
    expect(disk.notes.get("naveed-test.md")).toBe("local-naveed-test.md");

    // Hand the baseline back the way the next pass reads it, then delete the note
    // server-side — same app session, so the registry still holds the join.
    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      writes[writes.length - 1]?.[0] as never,
    );
    state.notes = [];
    state.tombstones = ["srv-1"];
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });

    expect(disk.trashed[0]?.from).toBe("naveed-test.md");
    expect(disk.notes.has("naveed-test.md")).toBe(false);
    expect(vi.mocked(api.createNote)).not.toHaveBeenCalled();
  });

  it("trashes it across a relaunch too, from the persisted path→docId join", async () => {
    // The common MCP shape: the note is deleted while the app isn't running, so
    // the in-memory join is gone by the time anyone reconciles. `config.json`'s
    // `docs` map was being written every pass and read by nobody, which left the
    // relaunch with no way to recognise the file as the deleted doc.
    const disk = new FakeDisk();
    const r = await twoPasses({
      disk,
      first: { notes: [{ id: "srv-1", rel_path: "naveed-test.md" }] },
      then: { notes: [], tombstones: ["srv-1"] },
    });

    expect(disk.trashed[0]?.from).toBe("naveed-test.md");
    expect(disk.notes.has("naveed-test.md")).toBe(false);
    expect(vi.mocked(r.api.createNote)).not.toHaveBeenCalled();
  });

  it("leaves a note the user deleted and recreated at the same path alone", async () => {
    // The reason inbound cannot just trash on a path match. `docs` is what makes
    // this safe: it tracks the CURRENT docId at each path, so the recreated note
    // carries a new id there and the old doc's tombstone finds nothing to remove.
    const disk = new FakeDisk();
    install(disk);
    const state: ServerState = { notes: [{ id: "old", rel_path: "reused.md" }], tombstones: [] };
    const api = fakeApi(state);
    const reg = new VaultRegistry(api);
    reg.setInboundHost(recordingHost().host);
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });

    // The user deletes it in the app and makes a new note at the same path.
    await reg.deletePath("reused.md");
    disk.notes.set("reused.md", "local-new");
    disk.bodies.set("reused.md", "a completely different note");
    await reg.registerNote("reused.md", null, "brand-new");

    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(writes[writes.length - 1]?.[0] as never);
    state.notes = [{ id: "brand-new", rel_path: "reused.md" }];
    state.tombstones = ["old"];

    const reg2 = new VaultRegistry(fakeApi(state));
    reg2.setInboundHost(recordingHost().host);
    await reg2.reconcile({ organizationId: ORG, vaultName: "v" });

    expect(disk.notes.has("reused.md")).toBe(true);
    expect(ipc.trashNote).not.toHaveBeenCalled();
  });

  it("REMOVES a file whose access was revoked, and stops re-registering it", async () => {
    // `GET /api/notes` is ACL-filtered, so a revoked share looks like a delete;
    // the tombstone set is what tells them apart. Both end with the file in the
    // vault's recoverable trash — a revocation that leaves a readable `.md`
    // behind is cosmetic, since the ex-reader can open it in any editor forever.
    const disk = new FakeDisk();
    disk.notes.set("shared.md", "d1");
    const r = await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "shared.md" }] },
      then: { notes: [], tombstones: [] },
    });

    expect(disk.notes.has("shared.md")).toBe(false);
    expect(ipc.trashNote).toHaveBeenCalledWith("shared.md", expect.any(String), null);
    // And it is NOT re-registered on the way out, which would resurrect it as an
    // unsyncable ghost.
    expect(vi.mocked(r.api.createNote)).not.toHaveBeenCalled();
    expect(r.reg.hasFailures()).toBe(false);
  });

  it("brings a revoked note BACK when access is restored", async () => {
    // The round trip that makes the removal safe to do at all. Private takes the
    // file; setting the item back to Shared or Read-only has to return it, or a
    // permission toggle would be a one-way door. The server kept the content, so
    // the file is re-materialised empty and hydrates on open.
    const disk = new FakeDisk();
    disk.notes.set("shared.md", "d1");
    install(disk);

    // Pass 1: agreed it is ours.
    const reg1 = new VaultRegistry(fakeApi({ notes: [{ id: "d1", rel_path: "shared.md" }] }));
    reg1.setInboundHost(recordingHost().host);
    await reg1.reconcile({ organizationId: ORG, vaultName: "v" });
    const carry = () => {
      const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
      vi.mocked(ipc.getVaultConfig).mockResolvedValue(
        writes[writes.length - 1]?.[0] as never,
      );
    };
    carry();

    // Pass 2: access revoked — gone from the listing, no tombstone.
    const reg2 = new VaultRegistry(fakeApi({ notes: [], tombstones: [] }));
    reg2.setInboundHost(recordingHost().host);
    await reg2.reconcile({ organizationId: ORG, vaultName: "v" });
    expect(disk.notes.has("shared.md")).toBe(false);
    carry();

    // Pass 3: access restored — the server lists it again.
    vi.mocked(ipc.writeNoteIfMissing).mockClear();
    const reg3 = new VaultRegistry(fakeApi({ notes: [{ id: "d1", rel_path: "shared.md" }] }));
    reg3.setInboundHost(recordingHost().host);
    await reg3.reconcile({ organizationId: ORG, vaultName: "v" });
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("shared.md", "", null);
    expect(disk.notes.has("shared.md")).toBe(true);
  });

  it("refuses to trash when the server reports no tombstones field", async () => {
    // `null` means "this server cannot answer", which must never be read as
    // "nothing is deleted" and certainly not as "everything is".
    const disk = new FakeDisk();
    disk.notes.set("bye.md", "d1");
    await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "bye.md" }] },
      then: { notes: [], tombstones: null },
    });
    expect(disk.notes.has("bye.md")).toBe(true);
    expect(ipc.trashNote).not.toHaveBeenCalled();
  });

  it("leaves an unconfirmed, non-empty note alone and records it as an orphan", async () => {
    // This device never confirmed the note's content upstream, so its text may
    // exist nowhere else — removing it could destroy the only copy.
    const disk = new FakeDisk();
    disk.notes.set("mine.md", "d1");
    disk.bodies.set("mine.md", "words nobody else has");
    const r = await twoPasses({
      disk,
      first: { notes: [{ id: "d1", rel_path: "mine.md" }] },
      then: { notes: [], tombstones: ["d1"] },
    });

    expect(disk.notes.has("mine.md")).toBe(true);
    expect(ipc.trashNote).not.toHaveBeenCalled();
    expect(r.reg.failures().map((f) => f.kind)).toContain("orphan");
  });
});


describe("inbound folder deletion", () => {
  it("removes an emptied local folder the server deleted and does not re-register it", async () => {
    // THE reappearing-folder bug, end to end: without a tombstone this device
    // saw "missing from the server" and re-registered the folder, resurrecting
    // it for the whole team on every pull.
    const disk = new FakeDisk();
    disk.folders.add("Team");
    disk.notes.set("Team/plan.md", "d1");
    const { api } = await twoPasses({
      disk,
      first: {
        notes: [{ id: "d1", rel_path: "Team/plan.md" }],
        folders: [{ id: "f1", path: "Team" }],
      },
      then: { notes: [], tombstones: ["d1"], folders: [], folderTombstones: ["f1"] },
    });

    // The note left via its own tombstone first, then the emptied folder.
    expect(disk.trashed.map((t) => t.from)).toEqual(["Team/plan.md"]);
    expect(disk.folders.has("Team")).toBe(false);
    expect(vi.mocked(api.createFolder)).not.toHaveBeenCalled();
  });

  it("keeps a deleted folder that still holds content, re-registering it fresh", async () => {
    // An unconfirmed note blocks its folder's removal — content must live
    // somewhere — so the folder stays and goes back up under a NEW id.
    const disk = new FakeDisk();
    disk.folders.add("Team");
    disk.notes.set("Team/mine.md", "d1");
    disk.bodies.set("Team/mine.md", "words nobody else has");
    const { api } = await twoPasses({
      disk,
      first: {
        notes: [{ id: "d1", rel_path: "Team/mine.md" }],
        folders: [{ id: "f1", path: "Team" }],
      },
      then: { notes: [], tombstones: ["d1"], folders: [], folderTombstones: ["f1"] },
    });

    expect(disk.folders.has("Team")).toBe(true);
    expect(vi.mocked(api.createFolder)).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Team" }),
    );
  });

  it("removes the emptied old directory after a server-side folder move, and does not re-register it", async () => {
    const disk = new FakeDisk();
    disk.folders.add("Projects");
    disk.folders.add("Projects/vid");
    disk.notes.set("Projects/vid/a.md", "d1");
    const { api } = await twoPasses({
      disk,
      first: {
        notes: [{ id: "d1", rel_path: "Projects/vid/a.md" }],
        folders: [{ id: "fp", path: "Projects" }, { id: "f1", path: "Projects/vid" }],
      },
      then: {
        notes: [{ id: "d1", rel_path: "Archive/vid/a.md" }],
        folders: [
          { id: "fp", path: "Projects" },
          { id: "fa", path: "Archive" },
          { id: "f1", path: "Archive/vid" },
        ],
      },
    });
    // The note followed the move, the emptied old directory is gone, and — the
    // part that used to bite the whole team — no empty twin was created upstream.
    expect(disk.notes.has("Archive/vid/a.md")).toBe(true);
    expect(disk.folders.has("Projects/vid")).toBe(false);
    expect(vi.mocked(api.createFolder)).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "Projects/vid" }),
    );
  });

  it("re-creates a folder at a path the server MOVED away from, so a file left there registers", async () => {
    // Production case ("1 not synced", forever): the server moved
    // `Projects/vid` to `Archive/vid`. The old directory stayed on disk (it held
    // a file the per-note rename never carried), the old path → id entry stayed
    // in the map, and every later file dropped into the old directory was
    // registered with the MOVED folder's id — refused as path_folder_mismatch.
    const disk = new FakeDisk();
    disk.folders.add("Projects");
    disk.folders.add("Projects/vid");
    const first: ServerState = {
      notes: [],
      folders: [{ id: "f1", path: "Projects/vid" }],
    };
    install(disk);
    const reg1 = new VaultRegistry(fakeApi(first));
    await reg1.reconcile({ organizationId: ORG, vaultName: "v" });
    expect(reg1.getFolderId("Projects/vid")).toBe("f1");
    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(writes[writes.length - 1]?.[0] as never);

    // The server moved the folder; a new note appears in the OLD directory.
    disk.notes.set("Projects/vid/new.md", "d-new");
    const api = fakeApi({
      notes: [],
      folders: [
        { id: "folder-Projects", path: "Projects" },
        { id: "fa", path: "Archive" },
        { id: "f1", path: "Archive/vid" },
      ],
    });
    vi.mocked(api.createFolder).mockClear();
    vi.mocked(api.createNote).mockClear();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(recordingHost().host);
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });

    // The stale entry is gone, the old path is a NEW folder under its real
    // parent, and the note registers against it — not against the moved id.
    expect(vi.mocked(api.createFolder)).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Projects/vid", parentId: "folder-Projects" }),
    );
    expect(reg.getFolderId("Projects/vid")).toBe("folder-Projects/vid");
    expect(reg.getFolderId("Archive/vid")).toBe("f1");
    expect(vi.mocked(api.createNote)).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "Projects/vid/new.md", folderId: "folder-Projects/vid" }),
    );
    expect(reg.getMapping("Projects/vid/new.md")?.docId).toBe("d-new");
    expect(reg.failures()).toEqual([]);
  });

  it("trashes an EMPTY leftover of a deleted note that the plan could only suppress", async () => {
    // The file at the deleted note's path is still on disk, but the local index
    // keys it under a different id (a re-indexed placeholder). The plan can't
    // prove it is the same note, so it only suppresses re-registration; for an
    // empty file that left a zero-byte stub nobody could sync or count.
    const disk = new FakeDisk();
    disk.folders.add("Team");
    disk.notes.set("Team/stub.md", "d1");
    const { api } = await twoPasses({
      disk,
      // Between passes the local index re-keyed the file: swap its id below.
      first: {
        notes: [{ id: "d1", rel_path: "Team/stub.md" }],
        folders: [{ id: "f1", path: "Team" }],
      },
      then: { notes: [], tombstones: ["d1"], folders: [{ id: "f1", path: "Team" }] },
    });
    // twoPasses already trashed the file under its ORIGINAL id (the plain path,
    // covered elsewhere). Re-run the deleted state with the file re-keyed and
    // present again, as the production stubs were.
    disk.notes.set("Team/stub.md", "local-rekeyed");
    disk.trashed.length = 0;
    vi.mocked(api.createNote).mockClear();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(recordingHost().host);
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });

    expect(disk.trashed.map((t) => t.from)).toEqual(["Team/stub.md"]);
    expect(vi.mocked(api.createNote)).not.toHaveBeenCalled();
  });

  it("leaves a NON-empty suppressed leftover alone (it may be someone's work)", async () => {
    const disk = new FakeDisk();
    disk.folders.add("Team");
    disk.notes.set("Team/stub.md", "d1");
    const { api } = await twoPasses({
      disk,
      first: {
        notes: [{ id: "d1", rel_path: "Team/stub.md" }],
        folders: [{ id: "f1", path: "Team" }],
      },
      then: { notes: [], tombstones: ["d1"], folders: [{ id: "f1", path: "Team" }] },
    });
    disk.notes.set("Team/stub.md", "local-rekeyed");
    disk.bodies.set("Team/stub.md", "typed here after the delete");
    disk.trashed.length = 0;
    vi.mocked(api.createNote).mockClear();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(recordingHost().host);
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });

    expect(disk.trashed).toEqual([]);
    expect(vi.mocked(api.createNote)).not.toHaveBeenCalled(); // still no ghost
  });

  it("stops claiming a non-empty leftover, so a LATER pass syncs the user's content", async () => {
    // The regression behind "dragging a folder in doesn't start syncing, and on
    // reload it never does". A previously-synced folder was deleted server-side,
    // leaving tombstones AND baseline entries for its paths. Re-importing the
    // folder puts files back on those exact paths under fresh local index ids, so
    // `planInbound` hits `dead && loc === undefined` and suppresses every one of
    // them — in production, all 176 `Daily/*` notes: `0/174`, nothing queued, no
    // error shown, and only opening a note synced it (the editor calls
    // `registerNote` directly, bypassing `suppress`).
    //
    // The pass that discovers this still suppresses (no mid-pass ghost), but it
    // must RELEASE the baseline claim so the next pass can register the file as
    // the new local note it is.
    const disk = new FakeDisk();
    disk.folders.add("Team");
    disk.notes.set("Team/stub.md", "d1");
    const { api } = await twoPasses({
      disk,
      first: {
        notes: [{ id: "d1", rel_path: "Team/stub.md" }],
        folders: [{ id: "f1", path: "Team" }],
      },
      then: { notes: [], tombstones: ["d1"], folders: [{ id: "f1", path: "Team" }] },
    });
    // Re-imported: same path, fresh local id, real content.
    disk.notes.set("Team/stub.md", "local-rekeyed");
    disk.bodies.set("Team/stub.md", "# a day\n\nreal content the user dropped in");
    disk.trashed.length = 0;

    // Pass 3 discovers the dead-but-present file: suppressed, not trashed, and
    // the claim is dropped (surfaced, not silent).
    vi.mocked(api.createNote).mockClear();
    const reg = new VaultRegistry(api);
    reg.setInboundHost(recordingHost().host);
    await reg.reconcile({ organizationId: ORG, vaultName: "v" });
    expect(disk.trashed).toEqual([]); // never destroy content we can't identify
    expect(vi.mocked(api.createNote)).not.toHaveBeenCalled(); // no ghost this pass
    expect(reg.failures().map((f) => f.reason).join(" ")).toContain(
      "deleted on the server",
    );

    // Pass 4 — the reload. THIS is what used to never happen. Feed it the config
    // pass 3 actually persisted (the harness pins `getVaultConfig` otherwise), so
    // this is a genuine restart against the released baseline.
    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      writes[writes.length - 1]?.[0] as never,
    );
    vi.mocked(api.createNote).mockClear();
    const reg2 = new VaultRegistry(api);
    reg2.setInboundHost(recordingHost().host);
    await reg2.reconcile({ organizationId: ORG, vaultName: "v" });

    expect(vi.mocked(api.createNote)).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "Team/stub.md" }),
    );
    expect(reg2.getMapping("Team/stub.md")).not.toBeNull();
    expect(disk.trashed).toEqual([]); // still never trashed
  });

  it("does nothing on folder tombstones the server did not answer about (null)", async () => {
    const disk = new FakeDisk();
    disk.folders.add("Team");
    disk.notes.set("a.md", "d1");
    await twoPasses({
      disk,
      first: {
        notes: [{ id: "d1", rel_path: "a.md" }],
        folders: [{ id: "f1", path: "Team" }],
      },
      then: {
        notes: [{ id: "d1", rel_path: "a.md" }],
        folders: [],
        folderTombstones: null,
      },
    });
    expect(disk.folders.has("Team")).toBe(true);
    expect(ipc.deleteFolderIfEmpty).not.toHaveBeenCalled();
  });
});
