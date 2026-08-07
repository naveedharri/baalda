// Bulk structure registration (phase 2): bounded concurrency, incremental
// checkpointing, resume-after-interrupt, cancellation on a vault switch, and
// honest per-item failure reporting.
//
// The behaviour under test replaces a sequential `for (…) await create(…)` that
// registered a 500-note vault at concurrency 1, persisted the doc map exactly
// once at the very end, swallowed per-item failures into `console.error`, and
// reported no progress at all.
//
// Everything is faked: no Tauri, no network. `.context/config.json` is modelled
// as a single string so a checkpoint can genuinely be read back by a second run.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null as string | null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listNoteTitles: vi.fn(
    async () => [] as Array<{ id: string; path: string; title: string }>,
  ),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
  isVaultMismatch: (e: unknown) =>
    e instanceof Error && e.message.startsWith("vault-mismatch"),
}));
vi.mock("../../vault/seed", () => ({
  seedWelcomeContent: vi.fn(async () => {}),
}));

import { ApiError, type ApiClient, type RegisteredNote } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { VaultRegistry } from "../registry";
import { REGISTRY_CONCURRENCY } from "../pool";
import type { SyncProgressSink } from "../progress";
import type {
  DocSyncState,
  SyncProgressPhase,
  VaultScope,
} from "../vaultScope";
import { reconcileWithTree } from "./helpers/reconcile";

const ORG = "org-1";
const VAULT = "v-1";

/** A settled-later async step, so concurrency is actually observable. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A server `notes` row shaped like the real API's snake_case response. */
const serverNote = (
  relPath: string,
  id = `srv-${relPath}`,
): RegisteredNote => ({
  id,
  rel_path: relPath,
  title: null,
});

/** Build a flat tree of `n` notes plus `folders` directories. */
function tree(n: number, folders: string[] = []): TreeNode {
  const children: TreeNode[] = folders.map((path) => ({
    id: path,
    name: path.split("/").pop()!,
    path,
    isDir: true,
    children: [],
  }));
  for (let i = 0; i < n; i++) {
    children.push({
      id: `n${i}`,
      name: `Note${i}.md`,
      path: `Note${i}.md`,
      isDir: false,
    });
  }
  return { id: "root", name: "vault", path: "", isDir: true, children };
}

interface FakeApiOpts {
  /** Notes already on the server (adopted, not created). */
  serverNotes?: Array<{ id: string; rel_path: string }>;
  serverFolders?: Array<{ id: string; path: string }>;
  /** Make specific note paths fail; `status` picks retryable (5xx) vs terminal. */
  failNotes?: Map<string, number>;
}

function fakeApi(opts: FakeApiOpts = {}) {
  const state = {
    inFlight: 0,
    maxInFlight: 0,
    createdNotes: [] as string[],
    createdFolders: [] as string[],
    noteAttempts: new Map<string, number>(),
  };
  const enter = async () => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await tick();
  };
  const api = {
    listVaults: vi.fn(async () => [
      { id: VAULT, name: "v", organization_id: ORG },
    ]),
    createVault: vi.fn(async () => ({
      id: VAULT,
      name: "v",
      organization_id: ORG,
    })),
    listFolders: vi.fn(async () => opts.serverFolders ?? []),
    listNotes: vi.fn(async () => opts.serverNotes ?? []),
    listNoteRegistry: vi.fn(async () => ({
      notes: opts.serverNotes ?? [],
      tombstones: [],
    })),
    createFolder: vi.fn(async (input: { path: string }) => {
      await enter();
      try {
        state.createdFolders.push(input.path);
        return { id: `folder-${input.path}`, path: input.path };
      } finally {
        state.inFlight--;
      }
    }),
    createNote: vi.fn(async (input: { relPath: string; docId?: string }) => {
      await enter();
      try {
        state.noteAttempts.set(
          input.relPath,
          (state.noteAttempts.get(input.relPath) ?? 0) + 1,
        );
        const status = opts.failNotes?.get(input.relPath);
        if (status !== undefined) throw new ApiError(status, `boom ${status}`);
        state.createdNotes.push(input.relPath);
        return serverNote(input.relPath, input.docId ?? `srv-${input.relPath}`);
      } finally {
        state.inFlight--;
      }
    }),
  } as unknown as ApiClient;
  return { api, state };
}

/** A VaultScope stand-in whose currency the test controls. */
function scopeSource(current = true) {
  const state = { current };
  const scope: VaultScope = {
    generation: 1,
    orgId: ORG,
    vaultPath: "/vaults/a",
    vaultEpoch: 7,
    signal: new AbortController().signal,
    serverVaultId: null,
    isCurrent: () => state.current,
  };
  return { source: { current: () => scope }, state, scope };
}

/** A recording progress sink. */
function recordingSink() {
  const phases: SyncProgressPhase[] = [];
  const docs: Array<[string, DocSyncState]> = [];
  let done = 0;
  let failed = 0;
  const sink: SyncProgressSink = {
    phase: (p) => phases.push(p),
    addTotal: () => {},
    item: (outcome) => {
      done++;
      if (outcome === "failed") failed++;
    },
    doc: (docId, state) => docs.push([docId, state]),
    flush: () => {},
  };
  return { sink, phases, docs, counts: () => ({ done, failed }) };
}

/** `.context/config.json` modelled as one mutable string, like the real file. */
function configFile(initial: string | null = null) {
  let content = initial;
  vi.mocked(ipc.getVaultConfig).mockImplementation(async () => content);
  vi.mocked(ipc.setVaultConfig).mockImplementation(async (c: string) => {
    content = c;
  });
  return {
    read: () =>
      content ? (JSON.parse(content) as Record<string, unknown>) : null,
    raw: () => content,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.setVaultConfig).mockResolvedValue(undefined);
  vi.mocked(ipc.listNoteTitles).mockResolvedValue([]);
  vi.mocked(ipc.writeNote).mockResolvedValue(undefined);
  vi.mocked(ipc.writeNoteIfMissing).mockClear().mockResolvedValue(true);
});

describe("bounded concurrency", () => {
  it("registers 60 notes with at most REGISTRY_CONCURRENCY requests in flight", async () => {
    const { api, state } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(60),
    );

    expect(state.createdNotes).toHaveLength(60);
    expect(state.maxInFlight).toBeGreaterThan(1); // NOT the old sequential loop
    expect(state.maxInFlight).toBeLessThanOrEqual(REGISTRY_CONCURRENCY);
  });

  it("creates folders parents-first so every parentId resolves", async () => {
    const { api, state } = fakeApi();
    const reg = new VaultRegistry(api);
    // Deliberately shuffled input; depth ordering must come from the engine.
    const t: TreeNode = {
      id: "root",
      name: "v",
      path: "",
      isDir: true,
      children: [
        {
          id: "a",
          name: "A",
          path: "A",
          isDir: true,
          children: [
            {
              id: "ab",
              name: "B",
              path: "A/B",
              isDir: true,
              children: [
                {
                  id: "abc",
                  name: "C",
                  path: "A/B/C",
                  isDir: true,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    await reconcileWithTree(reg, { organizationId: ORG, vaultName: "v" }, t);

    expect(state.createdFolders).toEqual(["A", "A/B", "A/B/C"]);
    const calls = vi.mocked(api.createFolder).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.path === "A/B")?.parentId).toBe("folder-A");
    expect(calls.find((c) => c.path === "A/B/C")?.parentId).toBe("folder-A/B");
  });
});

describe("incremental checkpointing + resume", () => {
  it("flushes the doc map DURING the run, not once at the end", async () => {
    const cfg = configFile();
    const { api } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(60),
    );

    // 60 notes at a 25-item batch ⇒ several writes. The old code wrote exactly 1.
    expect(vi.mocked(ipc.setVaultConfig).mock.calls.length).toBeGreaterThan(1);
    expect(reg.checkpointWrites()).toBeGreaterThan(1);
    expect(
      Object.keys((cfg.read()!.docs as Record<string, string>) ?? {}),
    ).toHaveLength(60);
  });

  it("keeps the work a killed run finished — the next run only creates the rest", async () => {
    // Run 1 dies after 30 notes: everything it created is on the server, and the
    // config it checkpointed records the collection id.
    const cfg = configFile();
    const created: string[] = [];
    const { api } = fakeApi();
    const { source, state } = scopeSource();
    vi.mocked(api.createNote).mockImplementation(
      async (input: { relPath: string }) => {
        await tick();
        created.push(input.relPath);
        if (created.length >= 30) state.current = false; // kill -9 stand-in
        return serverNote(input.relPath);
      },
    );
    const reg1 = new VaultRegistry(api, source);
    await reconcileWithTree(
      reg1,
      { organizationId: ORG, vaultName: "v" },
      tree(50),
    );
    expect(created.length).toBeGreaterThanOrEqual(30);
    expect(created.length).toBeLessThan(50); // it really did stop early
    expect(cfg.read()!.serverVaultId).toBe(VAULT);

    // Run 2 sees the survivors as server rows and creates only the remainder.
    const alreadyThere = created.map((rel) => ({
      id: `srv-${rel}`,
      rel_path: rel,
    }));
    const second = fakeApi({ serverNotes: alreadyThere });
    const reg2 = new VaultRegistry(second.api);
    await reconcileWithTree(
      reg2,
      { organizationId: ORG, vaultName: "v" },
      tree(50),
    );

    expect(second.state.createdNotes).toHaveLength(50 - created.length);
    expect(reg2.allDocIds()).toHaveLength(50);
  });

  it("round-trips the content-push checkpoint through config.json", async () => {
    const cfg = configFile();
    const { api } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(3),
    );
    reg.markPushed("srv-Note0.md");
    reg.markPushed("srv-Note1.md");
    await reg.flushCheckpoint();
    expect(cfg.read()!.pushed).toEqual(["srv-Note0.md", "srv-Note1.md"]);

    // A fresh registry (relaunch) adopts it, so the upload skips those docs.
    // The server still lists the notes, as it would on a real relaunch. An empty
    // listing here would mean something else entirely — absent with no tombstone
    // is how a REVOKED share looks, and inbound is meant to stop claiming those
    // (which drops their push checkpoint along with the mapping).
    const reg2 = new VaultRegistry(
      fakeApi({
        serverNotes: [0, 1, 2].map((i) => ({
          id: `srv-Note${i}.md`,
          rel_path: `Note${i}.md`,
        })),
      }).api,
    );
    await reconcileWithTree(
      reg2,
      { organizationId: ORG, vaultName: "v" },
      tree(3),
    );
    expect(reg2.isPushed("srv-Note0.md")).toBe(true);
    expect(reg2.isPushed("srv-Note2.md")).toBe(false);
  });

  it("registerNote never reads config.json (O(1) amortized, not O(N) bytes)", async () => {
    configFile();
    const { api } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(1),
    );
    const readsAfterReconcile = vi.mocked(ipc.getVaultConfig).mock.calls.length;
    const writesAfterReconcile = vi.mocked(ipc.setVaultConfig).mock.calls
      .length;

    for (let i = 0; i < 10; i++) {
      await reg.registerNote(`New${i}.md`, `New ${i}`, `doc-new-${i}`);
    }
    // No read-modify-write per note; the batch hasn't even filled yet.
    expect(vi.mocked(ipc.getVaultConfig).mock.calls.length).toBe(
      readsAfterReconcile,
    );
    expect(vi.mocked(ipc.setVaultConfig).mock.calls.length).toBe(
      writesAfterReconcile,
    );
    await reg.flushCheckpoint();
    expect(vi.mocked(ipc.setVaultConfig).mock.calls.length).toBe(
      writesAfterReconcile + 1,
    );
    expect(reg.getMapping("New9.md")).toEqual({
      vaultId: VAULT,
      docId: "doc-new-9",
    });
  });
});

describe("cancellation on a vault switch", () => {
  it("stops the pool and writes nothing more once the scope goes stale", async () => {
    const cfg = configFile();
    const { api, state: apiState } = fakeApi();
    const { source, state } = scopeSource();
    const reg = new VaultRegistry(api, source);

    let seen = 0;
    vi.mocked(api.createNote).mockImplementation(
      async (input: { relPath: string }) => {
        await tick();
        seen++;
        if (seen === 10) state.current = false; // the user switched vaults
        return serverNote(input.relPath);
      },
    );

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(200),
    );

    // The pool re-checks per item, so it abandons within one in-flight batch.
    expect(seen).toBeLessThan(200);
    expect(seen).toBeLessThanOrEqual(10 + REGISTRY_CONCURRENCY);
    // And nothing from vault A's run is written into the folder now open.
    const writesAfterStale = vi.mocked(ipc.setVaultConfig).mock.calls.length;
    await reg.flushCheckpoint();
    expect(vi.mocked(ipc.setVaultConfig).mock.calls.length).toBe(
      writesAfterStale,
    );
    expect(apiState.maxInFlight).toBeLessThanOrEqual(REGISTRY_CONCURRENCY);
    // Materialization for the stale vault never ran either.
    expect(vi.mocked(ipc.writeNoteIfMissing)).not.toHaveBeenCalled();
    void cfg;
  });

  it("a stale run reports nothing — vault A's counts never land in vault B's bar", async () => {
    // The registry is a process singleton, so by the time a reconcile for the
    // vault we LEFT reaches its next item, `setProgressSink` has already been
    // pointed at the NEW vault's reporter.
    configFile();
    const { api } = fakeApi();
    const { source, state } = scopeSource();
    const reg = new VaultRegistry(api, source);
    const before = recordingSink();
    reg.setProgressSink(before.sink);

    const nextVault = recordingSink();
    let n = 0;
    vi.mocked(api.createNote).mockImplementation(
      async (input: { relPath: string }) => {
        await tick();
        if (++n === 3) {
          // The user switches vaults; the new vault's `enable` immediately claims
          // the shared registry's progress sink.
          state.current = false;
          reg.setProgressSink(nextVault.sink);
        }
        return serverNote(input.relPath);
      },
    );

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(50),
    );

    // Everything from the switch onward is silent: the in-flight lanes finish
    // their requests but report nothing into the vault now on screen.
    expect(nextVault.counts()).toEqual({ done: 0, failed: 0 });
    expect(nextVault.phases).toEqual([]);
    expect(nextVault.docs).toEqual([]);
    // The vault it belonged to did see its own progress, up to the switch.
    expect(before.counts().done).toBeGreaterThan(0);
  });

  it("reset() disposes the checkpointer so a pending flush cannot land later", async () => {
    const cfg = configFile();
    const { api } = fakeApi();
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(2),
    );
    const writes = vi.mocked(ipc.setVaultConfig).mock.calls.length;
    reg.markPushed("srv-Note0.md"); // dirty, batch not full
    reg.reset();
    await reg.flushCheckpoint();
    expect(vi.mocked(ipc.setVaultConfig).mock.calls.length).toBe(writes);
    expect(cfg.read()!.pushed ?? []).toEqual([]);
  });
});

describe("honest failure reporting", () => {
  it("retries a 5xx and succeeds without recording a failure", async () => {
    const { api, state } = fakeApi({ failNotes: new Map() });
    let attempts = 0;
    vi.mocked(api.createNote).mockImplementation(
      async (input: { relPath: string }) => {
        await tick();
        attempts++;
        if (attempts === 1) throw new ApiError(503, "unavailable");
        return serverNote(input.relPath);
      },
    );
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(1),
    );
    expect(attempts).toBe(2);
    expect(reg.hasFailures()).toBe(false);
    expect(reg.getMapping("Note0.md")).not.toBeNull();
    void state;
  });

  it("records a terminal per-note failure instead of swallowing it", async () => {
    const { api, state } = fakeApi({ failNotes: new Map([["Note1.md", 409]]) });
    const { sink, docs, counts } = recordingSink();
    const reg = new VaultRegistry(api, undefined, sink);
    vi.mocked(ipc.listNoteTitles).mockResolvedValue([
      { id: "local-1", path: "Note1.md", title: "One" },
    ]);

    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(3),
    );

    // A 4xx is not retried — one attempt, then reported.
    expect(state.noteAttempts.get("Note1.md")).toBe(1);
    expect(reg.hasFailures()).toBe(true);
    const f = reg.failures()[0];
    expect(f).toMatchObject({
      kind: "note",
      path: "Note1.md",
      code: "doc_id_conflict",
    });
    // Unmapped on purpose: mapping it would point sync at a doc we can't access.
    expect(reg.getMapping("Note1.md")).toBeNull();
    // The failed doc is reported as `error`, keyed by its docId.
    expect(docs).toContainEqual(["local-1", "error"]);
    expect(counts().failed).toBe(1);
    // The other two still registered — one bad note never abandons the run.
    expect(reg.getMapping("Note0.md")).not.toBeNull();
    expect(reg.getMapping("Note2.md")).not.toBeNull();
  });

  it("treats a 402 plan limit as terminal AND stops the rest of the run", async () => {
    const { api } = fakeApi();
    let n = 0;
    vi.mocked(api.createNote).mockImplementation(
      async (input: { relPath: string }) => {
        await tick();
        n++;
        if (n === 1) {
          throw new ApiError(402, "vault limit reached", {
            code: "vault_limit_reached",
          });
        }
        return serverNote(input.relPath);
      },
    );
    const reg = new VaultRegistry(api);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(100),
    );

    expect(reg.limitCode()).toBe("vault_limit_reached");
    expect(reg.failures()[0].code).toBe("vault_limit_reached");
    // Bounded: it does not grind through 100 notes that would all 402.
    expect(n).toBeLessThanOrEqual(REGISTRY_CONCURRENCY);
  });

  it("reports the registering phase and a per-item count", async () => {
    const { api } = fakeApi();
    const { sink, phases, counts } = recordingSink();
    const reg = new VaultRegistry(api, undefined, sink);
    await reconcileWithTree(
      reg,
      { organizationId: ORG, vaultName: "v" },
      tree(5, ["Sub"]),
    );
    expect(phases).toContain("registering");
    expect(counts().done).toBe(6); // 5 notes + 1 folder
    expect(counts().failed).toBe(0);
  });
});
