// Issue #129 — one doc_id mapped to TWO local paths ("duplicate path alias").
//
// The reported state: 470 mapped paths for 464 note identities, six identities
// at two paths each with byte-identical markdown, and a header that alternates
// "Syncing 0/6" / "Sync incomplete" forever.
//
// This is the client half. The shape reproduced here is the one the reporter
// named as the leading candidate — a move that left the source file in place:
//
//   * the server moved note `d1` from `Old/note.md` to `New/note.md`;
//   * the file now exists at BOTH paths locally (the inbound rename is refused
//     because Rust will not rename onto an existing file, so the source stays);
//   * `Old/note.md` is therefore missing from the server listing on every pass,
//     gets re-registered, and the server answers 200 with the row's CANONICAL
//     path — which `syncStructure` files under the LOCAL path anyway.
//
// Three invariants are asserted, all of which fail today:
//   1. one path per docId (`byPath` must not hold an alias);
//   2. the reverse map must point at the path the SERVER agrees with;
//   3. a second pull must not re-register the same path again (the re-register
//      per pass is what re-stamps `registering 0/N` and re-badges the doc
//      `queued` forever — the pinned counter).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  ensureFolder: vi.fn(async () => false),
  readNote: vi.fn(async () => ""),
  renamePath: vi.fn(async (_from: string, to: string) => to),
  writeTrashCopy: vi.fn(async () => "trash"),
  deletePath: vi.fn(async () => {}),
  noteExists: vi.fn(async () => true),
  rebindNoteId: vi.fn(async () => true),
  isVaultMismatch: () => false,
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const COLLECTION = "col-1";
const OLD = "Old/note.md";
const NEW = "New/note.md";

/** Both copies on disk, under their folders. */
function tree(): TreeNode {
  return {
    id: "root",
    name: "vault",
    path: "",
    isDir: true,
    childrenLoaded: true,
    children: [
      {
        id: "Old",
        name: "Old",
        path: "Old",
        isDir: true,
        childrenLoaded: true,
        children: [{ id: OLD, name: "note.md", path: OLD, isDir: false }],
      },
      {
        id: "New",
        name: "New",
        path: "New",
        isDir: true,
        childrenLoaded: true,
        children: [{ id: NEW, name: "note.md", path: NEW, isDir: false }],
      },
    ],
  } as TreeNode;
}

/** The config this device carries: it still believes the note lives at OLD. */
function config(): string {
  return JSON.stringify({
    organizationId: ORG,
    serverVaultId: COLLECTION,
    docs: { [OLD]: "d1" },
    folders: { Old: "f-old", New: "f-new" },
    pushed: ["d1"],
    baseline: { d1: OLD },
  });
}

/**
 * The server, faithful to `http/routes/registry.ts POST /notes`:
 *   - a live row at the requested path IS this note (200, adopt);
 *   - otherwise `INSERT … ON CONFLICT (id) DO NOTHING`, and when the id already
 *     exists in this vault at a DIFFERENT path the row's CANONICAL path is
 *     echoed back (200) — registry.ts:765-787.
 */
function fakeApi() {
  const notes = [{ id: "d1", rel_path: NEW }];
  const createNote = vi.fn(
    async (input: { relPath: string; docId?: string }) => {
      const atPath = notes.find(
        (n) => n.rel_path.toLowerCase() === input.relPath.toLowerCase(),
      );
      if (atPath) return { id: atPath.id, docId: atPath.id, rel_path: atPath.rel_path };
      const byId = input.docId ? notes.find((n) => n.id === input.docId) : undefined;
      if (byId) {
        // The existing-ID no-op: the row does NOT move to `input.relPath`.
        return { id: byId.id, docId: byId.id, rel_path: byId.rel_path };
      }
      const row = { id: `srv-${input.relPath}`, rel_path: input.relPath };
      notes.push(row);
      return { id: row.id, docId: row.id, rel_path: row.rel_path };
    },
  );
  const api = {
    listVaults: vi.fn(async () => [{ id: COLLECTION, name: "vault", organization_id: ORG }]),
    createVault: vi.fn(async () => ({ id: COLLECTION, name: "vault", organization_id: ORG })),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({
      folders: [
        { id: "f-old", path: "Old" },
        { id: "f-new", path: "New" },
      ],
      tombstones: [],
    })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `f-${input.path}` })),
    listNotes: vi.fn(async () => notes),
    listNoteRegistry: vi.fn(async () => ({ notes: [...notes], tombstones: [] })),
    // The paged twin the reconciler actually calls; identical answer.
    listNoteRegistryPaged: vi.fn(async () => ({ notes: [...notes], tombstones: [] })),
    createNote,
    updateNote: vi.fn(async () => ({})),
    accessCheck: vi.fn(async (_v: string, ids: string[]) => ids),
  } as unknown as ApiClient;
  return { api, createNote, notes };
}

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockClear().mockResolvedValue(config());
  vi.mocked(ipc.setVaultConfig).mockClear();
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
  vi.mocked(ipc.listNoteTitles)
    .mockClear()
    // The index still keys the surviving source file by the note's own doc_id —
    // that is what makes the re-registration ask the server about `d1`.
    .mockResolvedValue([
      { id: "d1", path: OLD, title: "note" },
      { id: "local-new", path: NEW, title: "note" },
    ]);
  // Rust refuses a rename onto an existing file (`notefile.rs`), so the inbound
  // move OLD → NEW cannot run: the source survives.
  vi.mocked(ipc.renamePath)
    .mockClear()
    .mockImplementation(async (_from: string, to: string) => {
      if (to === NEW) throw new Error("destination already exists");
      return to;
    });
});

describe("issue #129 — a duplicate path alias for an already-registered identity", () => {
  it("never maps two local paths to one docId", async () => {
    const { api } = fakeApi();
    const reg = new VaultRegistry(api);

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "vault" }, tree());

    const mapped = reg.mappedNotes();
    const paths = [OLD, NEW].filter((p) => reg.getMapping(p) !== null);
    const docIds = new Set(paths.map((p) => reg.getMapping(p)!.docId));
    expect({ paths, docIds: [...docIds] }).toEqual({ paths: [NEW], docIds: ["d1"] });
    // …and the reverse map agrees with the server, not with the stale copy.
    expect(reg.pathForDocId("d1")).toBe(NEW);
    expect(mapped).toEqual([{ docId: "d1", relPath: NEW }]);
  });

  it("does not re-register the stale path on every pull (the pinned 0/N counter)", async () => {
    const { api, createNote } = fakeApi();
    const reg = new VaultRegistry(api);

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "vault" }, tree());
    const afterFirst = createNote.mock.calls.length;
    await reg.pull();
    await reg.pull();

    // Today: one `createNote(OLD)` per pass, forever — each one re-enters the
    // `registering` phase with a fresh 0/N and re-badges `d1` as queued.
    expect(createNote.mock.calls.map((c) => c[0].relPath)).toEqual(
      new Array(afterFirst).fill(OLD).slice(0, afterFirst),
    );
    expect(createNote.mock.calls.length).toBe(afterFirst);
  });

  it("writes only one path per docId to .context/config.json", async () => {
    const { api } = fakeApi();
    const reg = new VaultRegistry(api);

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "vault" }, tree());
    await reg.flushCheckpoint();

    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    expect(writes.length).toBeGreaterThan(0);
    const docs = (JSON.parse(writes[writes.length - 1][0] as string) as {
      docs: Record<string, string>;
    }).docs;
    const ids = Object.values(docs);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
