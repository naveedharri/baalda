import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({ id: "root", name: "", path: "", isDir: true, children: [], childrenLoaded: true })),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  rebindNoteId: vi.fn(async () => true),
  isVaultMismatch: () => false,
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { seedWelcomeContent } from "../../vault/seed";
import { VaultRegistry } from "../registry";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";

function emptyTree(): TreeNode {
  return { id: "root", name: "vault", path: "", isDir: true, children: [] };
}

/** Minimal fake of the ApiClient surface reconcile() touches. */
function fakeApi(opts: {
  vaults: Array<{ id: string; name: string; organization_id: string }>;
  notes?: Array<{ id: string; rel_path: string }>;
}) {
  const createVault = vi.fn(async (input: { name: string; organizationId: string }) => {
    const v = { id: `created-${input.name}`, name: input.name, organization_id: input.organizationId };
    opts.vaults.push(v);
    return v;
  });
  const createNote = vi.fn(async (input: { relPath: string }) => ({
    id: `note-${input.relPath}`,
    rel_path: input.relPath,
  }));
  const api = {
    listVaults: vi.fn(async () => opts.vaults),
    createVault,
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}` })),
    listNotes: vi.fn(async () => opts.notes ?? []),
    listNoteRegistry: vi.fn(async () => ({ notes: opts.notes ?? [], tombstones: [] })),
    // The paged twin the reconciler actually calls; identical answer.
    listNoteRegistryPaged: vi.fn(async () => ({ notes: opts.notes ?? [], tombstones: [] })),
    createNote,
  } as unknown as ApiClient;
  return { api, createVault, createNote };
}

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.writeNote).mockClear();
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
  vi.mocked(ipc.rebindNoteId).mockClear().mockResolvedValue(true);
  vi.mocked(seedWelcomeContent).mockClear();
});

describe("VaultRegistry.reconcile — vault adoption (joining member)", () => {
  it("adopts the org's existing server vault even when the local folder name differs", async () => {
    // Owner created the vault under a folder named "MyNotes"; the member's fresh
    // per-vault folder is slugged from the org name ("acme") — no name match.
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-owner", name: "MyNotes", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Team/hello.md" }],
    });
    const reg = new VaultRegistry(api);
    const { seeded } = await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());

    expect(createVault).not.toHaveBeenCalled();
    expect(reg.vaultId).toBe("v-owner");
    expect(seeded).toBe(false); // populated vault never gets welcome content
    // Server-only note materialized locally so the sidebar shows it. The third
    // argument is the vault-epoch pin (null here — no VaultScope in this unit
    // test); in the app it is what makes Rust refuse the write after a switch.
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Team/hello.md", "", null);
    expect(reg.getMapping("Team/hello.md")).toEqual({ vaultId: "v-owner", docId: "n1" });
    expect(reg.healthInventory()).toEqual({
      hasServerVault: true,
      notePaths: ["Team/hello.md"],
      folderPaths: [],
      filePaths: [],
    });
  });

  it("resolves a mapped note through a case-different disk spelling", async () => {
    // `byPath` is keyed by the path the SERVER says the doc lives at, but the
    // sidebar and the presence announce both work from the DISK spelling — and
    // on macOS/Windows `Projects/Community/x.md` and `Projects/community/x.md`
    // are one file. An exact-only lookup therefore reported "not mapped" for a
    // perfectly well mapped note, which is one of the ways a joiner's presence
    // dot went missing (#125).
    const { api } = fakeApi({
      vaults: [{ id: "v-owner", name: "MyNotes", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Projects/Community/plan.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());

    const mapping = { vaultId: "v-owner", docId: "n1" };
    // Exact spelling: unchanged on both accessors, and the cheap path.
    expect(reg.getMapping("Projects/Community/plan.md")).toEqual(mapping);
    expect(reg.getMappingCi("Projects/Community/plan.md")).toEqual(mapping);
    // Disk spelling differs only in case — same file, so the same doc.
    expect(reg.getMapping("Projects/community/plan.md")).toBeNull();
    expect(reg.getMappingCi("Projects/community/plan.md")).toEqual(mapping);
    expect(reg.getMappingCi("projects/COMMUNITY/PLAN.md")).toEqual(mapping);
    // A path that genuinely isn't mapped still answers null, both ways.
    expect(reg.getMappingCi("Projects/Community/other.md")).toBeNull();
  });

  it("adopts by id (oldest in org) — a name-matching vault never wins over it", async () => {
    // Names collide and differ per device; every device must deterministically
    // land on the SAME server vault. The org's oldest vault is the canonical one,
    // even when a legacy fork happens to match this folder's name.
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-original", name: "Old", organization_id: ORG },
        { id: "v-fork", name: "acme", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(createVault).not.toHaveBeenCalled();
    expect(reg.vaultId).toBe("v-original");
  });

  it("ignores server vaults from other orgs and creates one when the org has none", async () => {
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-other", name: "acme", organization_id: "other-org" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(createVault).toHaveBeenCalledWith({ name: "acme", organizationId: ORG });
    expect(reg.vaultId).toBe("created-acme");
  });

  it("keeps the vault recorded in .context/config.json when it still exists", async () => {
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-cfg", docs: {} }),
    );
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-other", name: "acme", organization_id: ORG },
        { id: "v-cfg", name: "whatever", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(reg.vaultId).toBe("v-cfg"); // the recorded id wins over oldest-in-org
    expect(createVault).not.toHaveBeenCalled();
  });

  it("discards a config vault id that belongs to a DIFFERENT org", async () => {
    // A folder previously bound to org A must not drag A's vault into
    // org B — identity is (org id, vault id), never the folder.
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-org-a", docs: {} }),
    );
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-org-a", name: "acme", organization_id: "org-a" },
        { id: "v-org-b", name: "beta", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(reg.vaultId).toBe("v-org-b");
    expect(createVault).not.toHaveBeenCalled();
  });

  it("heals a stale config vault id (wiped/foreign server) by re-adopting the org vault", async () => {
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-gone", docs: { "old.md": "dead-doc" } }),
    );
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-live", name: "Team Vault", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Welcome.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "some-folder" }, emptyTree());
    expect(reg.vaultId).toBe("v-live");
    expect(createVault).not.toHaveBeenCalled();
    // Mapping rebuilt from the live vault, not the dead config.
    expect(reg.getMapping("old.md")).toBeNull();
    expect(reg.getMapping("Welcome.md")).toEqual({ vaultId: "v-live", docId: "n1" });
  });

  it("treats the config a vault UNSYNC leaves behind as no config at all", async () => {
    // "Make this vault local only" rewrites `.context/config.json` to a bare
    // tombstone — no `serverVaultId`, no `docs`, no `pushed`, no `baseline`, no
    // `authored`. That file is the whole feature: with the old one in place the
    // folder stays stamped for a vault that no longer exists and can never sync
    // again. This pins the other half — that the cleared file is INERT, so the
    // folder reconciles exactly as a never-synced one would.
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ unsyncedAt: "2026-09-18T10:00:00.000Z", unsyncedFrom: "org-dead" }),
    );
    const { api, createVault } = fakeApi({ vaults: [] });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "acme" },
      emptyTree(),
    );
    // Nothing was adopted from the file, so this is a brand-new vault.
    expect(createVault).toHaveBeenCalledWith({ name: "acme", organizationId: ORG });
    expect(reg.vaultId).toBe("created-acme");
    expect(reg.getMapping("Welcome.md")).toBeNull();
  });
});

describe("VaultRegistry.reconcile — seeding and materialization rules", () => {
  it("seeds welcome content ONLY for a just-created vault (seedIfEmpty) with empty server + folder", async () => {
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "fresh", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    const { seeded } = await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "fresh", seedIfEmpty: true },
      emptyTree(),
    );
    expect(seeded).toBe(true);
    expect(seedWelcomeContent).toHaveBeenCalledTimes(1);
  });

  it("does not seed without creation intent, even when server and folder are both empty", async () => {
    // Turning on sync for an opened folder, or joining an empty team vault,
    // must never invent content — only the "New vault" flows pass seedIfEmpty.
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "fresh", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    const { seeded } = await reconcileWithTree(reg, { organizationId: ORG, vaultName: "fresh" }, emptyTree());
    expect(seeded).toBe(false);
    expect(seedWelcomeContent).not.toHaveBeenCalled();
  });

  it("does not seed when the local folder already has content", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
    });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [{ id: "a", name: "Mine.md", path: "Mine.md", isDir: false }],
    };
    const { seeded } = await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "laptop", seedIfEmpty: true },
      tree,
    );
    expect(seeded).toBe(false);
    expect(seedWelcomeContent).not.toHaveBeenCalled();
    // The local-only note was registered on the server instead.
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ relPath: "Mine.md" }));
  });

  it("materializes only server-only notes; files already on disk are untouched", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [
        { id: "n1", rel_path: "Shared.md" }, // server-only → materialize
        { id: "n2", rel_path: "Mine.md" }, // also local → leave alone
      ],
    });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [{ id: "a", name: "Mine.md", path: "Mine.md", isDir: false }],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, tree);
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Shared.md", "", null);
  });

  // ── The 428-note regression ────────────────────────────────────────────────
  // `reconcile` used to take the tree from its caller, and the caller had only
  // the SIDEBAR's tree — which is lazy: top level only, every unexpanded folder
  // an empty `children` placeholder. Handed that, `flattenTree` saw root-level
  // notes and nothing else, so every nested note the server already knew about
  // was classified server-only and materialized as an EMPTY file over real
  // content. These two tests pin both halves of the fix.

  it("reads the FULL tree itself, so nested notes register instead of being missed", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
    });
    const reg = new VaultRegistry(api);
    const full: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [
        { id: "r", name: "Root.md", path: "Root.md", isDir: false },
        {
          id: "Context",
          name: "Context",
          path: "Context",
          isDir: true,
          children: [
            { id: "c1", name: "brand.md", path: "Context/brand.md", isDir: false },
            {
              id: "Context/brand",
              name: "brand",
              path: "Context/brand",
              isDir: true,
              children: [
                {
                  id: "c2",
                  name: "kit.md",
                  path: "Context/brand/kit.md",
                  isDir: false,
                },
              ],
            },
          ],
        },
      ],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, full);

    // Every depth reaches the server, not just the root.
    const registered = createNote.mock.calls.map((c) => c[0].relPath).sort();
    expect(registered).toEqual(["Context/brand.md", "Context/brand/kit.md", "Root.md"]);
    expect(reg.getMapping("Context/brand/kit.md")).not.toBeNull();
  });

  it("never materializes over a nested note that exists on disk", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      // The server knows all three. All three are also on disk, nested.
      notes: [
        { id: "n1", rel_path: "Context/brand.md" },
        { id: "n2", rel_path: "Context/brand/kit.md" },
        { id: "n3", rel_path: "Daily/2026-08-03.md" },
      ],
    });
    const reg = new VaultRegistry(api);
    const dir = (path: string, children: TreeNode[]): TreeNode => ({
      id: path,
      name: path.split("/").pop()!,
      path,
      isDir: true,
      children,
    });
    const file = (path: string): TreeNode => ({
      id: path,
      name: path.split("/").pop()!,
      path,
      isDir: false,
    });
    const full: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [
        dir("Context", [
          file("Context/brand.md"),
          dir("Context/brand", [file("Context/brand/kit.md")]),
        ]),
        dir("Daily", [file("Daily/2026-08-03.md")]),
      ],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, full);

    // Nothing is server-only, so nothing is written at all. Before the fix this
    // fired three empty writes — one per nested note — and each one was a note
    // truncated to zero bytes.
    expect(vi.mocked(ipc.writeNoteIfMissing)).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.writeNote)).not.toHaveBeenCalled();
  });

  it("materialization is create-only, so a wrong server-only verdict costs nothing", async () => {
    // Belt and braces: even if the local list were short again (here the tree
    // omits a file the server has), the write must not be able to clobber. The
    // real command checks the filesystem; the mock stands in for a file that is
    // already there.
    vi.mocked(ipc.writeNoteIfMissing).mockResolvedValue(false);
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Context/brand.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    // It tried — and the create-only command refused, without failing the run.
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Context/brand.md", "", null);
    expect(vi.mocked(ipc.writeNote)).not.toHaveBeenCalled();
    expect(reg.hasFailures()).toBe(false);
  });

  // ── Materializing WITH content (#93) ──────────────────────────────────────
  // A placeholder is a real file write, so the watcher reports it and the sync
  // layer treats it as an external edit. On a device that already holds the
  // note's CRDT, that "edit" was the file being 0 bytes — diff-merged into the
  // populated doc as a delete-all and pushed, destroying the server's copy. So
  // the created file is filled in from the local CRDT when there is one, and
  // left empty (to hydrate lazily) when there isn't.

  it("fills a freshly created placeholder in from this device's own CRDT", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Deleted.md" }],
    });
    const reg = new VaultRegistry(api);
    const hydrated: Array<{ docId: string; path: string }> = [];
    reg.setInboundHost({
      releaseDoc: async () => {},
      notePathChanged: () => {},
      noteRemoved: () => {},
      materializeContent: async (docId, path) => {
        hydrated.push({ docId, path });
        return true;
      },
    });

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    // Create-only first, ALWAYS — that guard is what makes a wrong "server-only"
    // verdict cost nothing — and only then the content.
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Deleted.md", "", null);
    expect(hydrated).toEqual([{ docId: "n1", path: "Deleted.md" }]);
  });

  // ── Materialized notes keep the SERVER's doc_id (#147) ────────────────────
  // `writeNoteIfMissing` re-indexes synchronously and Rust mints a FRESH uuid
  // for a path it has never seen, so without a rebind the note carries two
  // identities forever: the editor's bridge keys by the index id and `DocSync`
  // keys by the server id — two Y.Docs, two local CRDT logs, one file. Every
  // teammate joining a shared vault got that for every note they didn't have.

  it("rebinds a freshly materialized note to the server's doc_id, before hydrating", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Team/joined.md" }],
    });
    const order: string[] = [];
    vi.mocked(ipc.rebindNoteId).mockImplementation(async () => {
      order.push("rebind");
      return true;
    });
    const reg = new VaultRegistry(api);
    reg.setInboundHost({
      releaseDoc: async () => {},
      notePathChanged: () => {},
      noteRemoved: () => {},
      materializeContent: async () => {
        order.push("hydrate");
        return true;
      },
    });

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    expect(vi.mocked(ipc.rebindNoteId)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.rebindNoteId)).toHaveBeenCalledWith("Team/joined.md", "n1", null);
    // Identity first: `materializeContent` promotes a bridge under the server
    // id and writes through it, and that write re-indexes — the id must already
    // be bound or `id_for_path` preserves the fork instead.
    expect(order).toEqual(["rebind", "hydrate"]);
  });

  it("does not rebind a path that already held a file", async () => {
    // The create-only guard said no: the row there belongs to a real local note
    // whose identity is none of this pass's business.
    vi.mocked(ipc.writeNoteIfMissing).mockResolvedValue(false);
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Mine.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Mine.md", "", null);
    expect(vi.mocked(ipc.rebindNoteId)).not.toHaveBeenCalled();
  });

  it("a failed rebind is logged, not fatal — the pull carries on", async () => {
    // Falling back to the pre-#147 behaviour (a note with a local-only index id)
    // is strictly better than abandoning the note, or the whole pass.
    vi.mocked(ipc.rebindNoteId).mockRejectedValue(new Error("id taken"));
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Team/joined.md" }],
    });
    const reg = new VaultRegistry(api);
    const hydrated: string[] = [];
    reg.setInboundHost({
      releaseDoc: async () => {},
      notePathChanged: () => {},
      noteRemoved: () => {},
      materializeContent: async (_docId, path) => {
        hydrated.push(path);
        return true;
      },
    });

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    expect(hydrated).toEqual(["Team/joined.md"]);
    expect(reg.hasFailures()).toBe(false);
  });

  it("does not ask for content when the file was already there", async () => {
    // `writeNoteIfMissing` returning false means a real note occupies the path.
    // Writing a doc's text over it is exactly the clobber the create-only guard
    // exists to prevent.
    vi.mocked(ipc.writeNoteIfMissing).mockResolvedValue(false);
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Mine.md" }],
    });
    const reg = new VaultRegistry(api);
    let asked = 0;
    reg.setInboundHost({
      releaseDoc: async () => {},
      notePathChanged: () => {},
      noteRemoved: () => {},
      materializeContent: async () => {
        asked++;
        return true;
      },
    });

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    expect(asked).toBe(0);
  });

  it("keeps the empty placeholder when this device has no CRDT for the note", async () => {
    // The fresh-device case: nothing to fill it with, so it stays 0 bytes and
    // hydrates on open (or from the vault channel's backfill).
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Teammate.md" }],
    });
    const reg = new VaultRegistry(api);
    reg.setInboundHost({
      releaseDoc: async () => {},
      notePathChanged: () => {},
      noteRemoved: () => {},
      materializeContent: async () => false,
    });

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    expect(vi.mocked(ipc.writeNoteIfMissing)).toHaveBeenCalledWith("Teammate.md", "", null);
    expect(reg.hasFailures()).toBe(false);
  });

  it("survives a host that throws while hydrating (the placeholder stands)", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Broken.md" }],
    });
    const reg = new VaultRegistry(api);
    reg.setInboundHost({
      releaseDoc: async () => {},
      notePathChanged: () => {},
      noteRemoved: () => {},
      materializeContent: async () => {
        throw new Error("no store");
      },
    });

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    // Best-effort by contract: a failed hydrate leaves today's behaviour, which
    // is a 0-byte placeholder — not a failed reconcile.
    expect(reg.hasFailures()).toBe(false);
  });

  it("suppresses ONE watcher echo per created placeholder", async () => {
    // The file the registry just wrote is not an external edit. One event per
    // created path is consumed; the next one is real.
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Echo.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    expect(reg.consumeMaterialized("Echo.md")).toBe(true);
    expect(reg.consumeMaterialized("Echo.md")).toBe(false);
    expect(reg.consumeMaterialized("Never-written.md")).toBe(false);
  });

  it("claims an echo for a binary the blob mirror materialized too", async () => {
    // A tree binary lands on disk the same way and owes the same one echo —
    // the sync layer marks it (`AttachmentSync.downloadOne`) through this.
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "laptop", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    reg.markMaterialized("Team/report.docx");
    expect(reg.consumeMaterialized("Team/report.docx")).toBe(true);
    expect(reg.consumeMaterialized("Team/report.docx")).toBe(false);
  });
});

describe("VaultRegistry.reconcile — paths the server says this user cannot see", () => {
  // Prod 2026-09-23: a member whose disk still held ~3,900 folders from before
  // their parents went Private re-registered all of them every ~10 s. The server
  // now answers `not_readable`; the client must stop asking, quietly, and must
  // never touch the files.
  it("asks once, records no failure, and leaves the paths alone on later passes", async () => {
    const { api, createNote } = fakeApi({ vaults: [{ id: "v1", name: "v", organization_id: ORG }] });
    const { ApiError } = await import("../../api");
    const refuse = () => new ApiError(409, "not readable", { code: "not_readable" });
    const createFolder = vi.fn(async () => { throw refuse(); });
    (api as unknown as { createFolder: unknown }).createFolder = createFolder;
    createNote.mockImplementation(async () => { throw refuse(); });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root", name: "v", path: "", isDir: true,
      children: [{
        id: "r", name: "Restricted", path: "Restricted", isDir: true,
        children: [{ id: "p", name: "plan.md", path: "Restricted/plan.md", isDir: false }],
      }],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree);
    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(reg.failures()).toEqual([]);

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree);
    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(reg.failures()).toEqual([]);
    expect(vi.mocked(ipc.writeNote)).not.toHaveBeenCalled();
  });

  it("treats the path as ordinary again once the server lists it", async () => {
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "v", organization_id: ORG }] });
    const { ApiError } = await import("../../api");
    let hidden = true;
    const createFolder = vi.fn(async (input: { path: string }) => {
      if (hidden) throw new ApiError(409, "not readable", { code: "not_readable" });
      return { id: `folder-${input.path}` };
    });
    const listFolderRegistry = vi.fn(async () => ({
      folders: hidden ? [] : [{ id: "f-r", path: "Restricted", name: "Restricted", parent_id: null }],
      tombstones: [],
    }));
    Object.assign(api as object, { createFolder, listFolderRegistry, listFolders: vi.fn(async () => []) });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root", name: "v", path: "", isDir: true,
      children: [{ id: "r", name: "Restricted", path: "Restricted", isDir: true, children: [] }],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree);
    hidden = false; // the owner shared it back
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree);
    hidden = true; // …and made it Private again: asked afresh, not remembered forever
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, tree);
    expect(createFolder).toHaveBeenCalledTimes(2);
  });
});

describe("VaultRegistry tree-binary `files` map", () => {
  it("persists registered binaries under their own config key, never into `docs`", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Welcome.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    expect(reg.getFileId("Team/report.docx")).toBeNull();
    reg.setFileId("Team/report.docx", "file-1");
    expect(reg.getFileId("Team/report.docx")).toBe("file-1");

    // The write is checkpointed, never a synchronous read-modify-write — the
    // next pass's flush is what puts it on disk.
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    const written = writes[writes.length - 1][0] as string;
    const cfg = JSON.parse(written) as { files?: Record<string, string>; docs?: Record<string, string> };
    expect(cfg.files).toEqual({ "Team/report.docx": "file-1" });
    // The note map is the CRDT join and a binary must never appear in it: it
    // feeds `registerNote`, the bridge and the content uploader.
    expect(Object.keys(cfg.docs ?? {})).not.toContain("Team/report.docx");
  });

  it("re-writes config.json after a reset, even when the contents are identical", async () => {
    // `writeConfig`'s no-op memo is only honest while this registry is the LAST
    // thing that wrote the file. A teardown ends that — `store.clearVaultStamp`
    // writes the same `.context/config.json` through `ipc.setVaultConfig`, and
    // deleting `.context/` by hand (the documented dev habit) empties it — so a
    // memo that survives `reset()` would leave the doc-id map unpersisted for
    // the rest of the session.
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "laptop", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    await reg.flushCheckpoint();
    const lastWrite = (): string | undefined => {
      const calls = vi.mocked(ipc.setVaultConfig).mock.calls;
      return calls.length > 0 ? (calls[calls.length - 1][0] as string) : undefined;
    };
    const first = lastWrite() as string;
    expect(first).toBeTruthy();
    // The memo holds while this registry is still the writer: an identical flush
    // costs nothing (a 5,000-note config is ~500 KB, rewritten on a timer).
    const writes = vi.mocked(ipc.setVaultConfig).mock.calls.length;
    await reg.flushCheckpoint();
    expect(vi.mocked(ipc.setVaultConfig).mock.calls.length).toBe(writes);

    // …and it does NOT hold across a teardown, even though the bytes are the same.
    reg.reset();
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    await reg.flushCheckpoint();

    expect(vi.mocked(ipc.setVaultConfig).mock.calls.length).toBeGreaterThan(writes);
    expect(lastWrite()).toEqual(first);
  });

  it("round-trips the bytes confirmation, and an older config loads unconfirmed", async () => {
    // `files` says a ROW exists; `filesConfirmed` says the SERVER HAS THE BYTES.
    // Only the second may license a revocation to take the file off this disk,
    // so it has to survive a restart on its own — and a config written before
    // the key existed must load as unconfirmed rather than as permission.
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "laptop", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    reg.setFileId("Team/report.docx", "file-1");
    reg.setFileId("Team/slides.pptx", "file-2");
    // Registered is not uploaded: neither is announced yet.
    expect(reg.fileDocIds()).toEqual([]);
    reg.confirmFileBytes("Team/report.docx");
    expect(reg.fileBytesConfirmed("file-1")).toBe(true);
    expect(reg.fileBytesConfirmed("file-2")).toBe(false);

    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    await reg.flushCheckpoint();
    const writes = vi.mocked(ipc.setVaultConfig).mock.calls;
    const cfg = JSON.parse(writes[writes.length - 1][0] as string) as {
      files?: Record<string, string>;
      filesConfirmed?: string[];
    };
    expect(cfg.files).toEqual({ "Team/report.docx": "file-1", "Team/slides.pptx": "file-2" });
    expect(cfg.filesConfirmed).toEqual(["file-1"]);

    // Reload it as a fresh session: the claim survives.
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(JSON.stringify(cfg) as never);
    const reloaded = new VaultRegistry(api);
    await reconcileWithTree(reloaded, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    expect(reloaded.fileBytesConfirmed("file-1")).toBe(true);
    expect(reloaded.fileBytesConfirmed("file-2")).toBe(false);

    // …and the same config WITHOUT the key — everything an older client wrote —
    // loads with nothing confirmed.
    const legacy = { ...cfg };
    delete legacy.filesConfirmed;
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(JSON.stringify(legacy) as never);
    const older = new VaultRegistry(api);
    await reconcileWithTree(older, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    expect(older.getFileId("Team/report.docx")).toBe("file-1");
    expect(older.fileBytesConfirmed("file-1")).toBe(false);
    expect(older.fileDocIds()).toEqual([]);
  });

  it("drops the confirmation with the row it was made about", async () => {
    // A path re-used by a different file must not inherit a claim made about
    // the bytes that used to live there.
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "laptop", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());

    reg.setFileId("Team/report.docx", "file-1");
    reg.confirmFileBytes("Team/report.docx");
    reg.forgetFileId("Team/report.docx");
    reg.setFileId("Team/report.docx", "file-1");
    expect(reg.fileBytesConfirmed("file-1")).toBe(false);

    // A RENAME is the opposite case: same bytes, same row, so the claim rides
    // along (it is keyed by id, not path).
    reg.confirmFileBytes("Team/report.docx");
    reg.moveFileId("Team/report.docx", "Archive/report.docx");
    expect(reg.fileBytesConfirmed("file-1")).toBe(true);
    expect(reg.fileDocIds()).toEqual(["file-1"]);
  });

  it("forgets binary ids on a vault switch — an id from vault A names nothing in B", async () => {
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "laptop", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "laptop" }, emptyTree());
    reg.setFileId("Team/report.docx", "file-1");

    reg.reset();
    expect(reg.getFileId("Team/report.docx")).toBeNull();
  });
});

describe("VaultRegistry.registerNote", () => {
  it("returns null before reconcile (sync not enabled yet)", async () => {
    const { api } = fakeApi({ vaults: [] });
    const reg = new VaultRegistry(api);
    expect(await reg.registerNote("New.md", "New")).toBeNull();
  });

  it("registers a new note into the adopted vault and persists the mapping", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "acme", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Welcome.md" }],
    });
    const reg = new VaultRegistry(api);
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "acme" }, emptyTree());
    const mapping = await reg.registerNote("Ideas/New.md", "New");
    expect(createNote).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "Ideas/New.md", vaultId: "v1" }),
    );
    expect(mapping).toEqual({ vaultId: "v1", docId: "note-Ideas/New.md" });
    // Idempotent: a second call returns the cached mapping without re-creating.
    const again = await reg.registerNote("Ideas/New.md", "New");
    expect(again).toEqual(mapping);
    expect(createNote).toHaveBeenCalledTimes(1);
  });
});
