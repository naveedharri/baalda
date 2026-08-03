// SyncManager teardown, the other half of vault isolation (see
// `vaultScope.test.ts` for the scope primitive and the registry guards).
//
// `syncManager` is a process singleton whose `disable()` used to clear the
// provider, presence and engine but leave the debounced registry-pull timer
// armed and the registry's `serverVaultId` + path maps intact. That timer then
// fired against the vault the user had just switched to, holding the previous
// vault's server ids. These tests pin the teardown contract and prove the scope
// guard holds even when a call site swaps vaults WITHOUT tearing down first.
//
// The registry is faked here so nothing touches the network or Tauri, and so the
// vault engine stays out of the way (`vaultId === null` ⇒ no socket).

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because importing `../docSession` evaluates its `syncManager`
// singleton, which constructs a VaultRegistry at module-eval time — before a
// plain `const` here would be initialized.
const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: null as string | null,
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => {}),
    reset: vi.fn(),
    getMapping: vi.fn(() => null),
    pathForDocId: vi.fn(() => null),
    allDocIds: vi.fn((): string[] => []),
    // Bulk-sync surface (phase 2): the manager reports progress through the
    // registry and drives the content upload off its mapped-note list.
    setProgressSink: vi.fn(),
    // Phase 3: the manager mirrors the path→docId map out to the sidebar
    // (coalesced), so the fake keeps the listener it is handed.
    mapListener: null as (() => void) | null,
    setMapListener: vi.fn((cb: (() => void) | null) => {
      reg.mapListener = cb;
    }),
    mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
    isPushed: vi.fn(() => false),
    markPushed: vi.fn(),
    flushCheckpoint: vi.fn(async () => {}),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
  };
  return reg;
});

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

import type { SessionInfo } from "../../api";
import type { TreeNode } from "../../ipc";
import { SyncManager } from "../docSession";
import type { SyncProgressSink } from "../progress";
import { vaultScopes, type DocSyncState, type SyncProgress } from "../vaultScope";

const ORG_A = "org-a";
const ORG_B = "org-b";

function emptyTree(): TreeNode {
  return { id: "root", name: "vault", path: "", isDir: true, children: [] };
}

/** A deferred promise, to hold an async step open across a vault switch. */
function gate() {
  let open!: () => void;
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { waited, open };
}

function session(orgId = ORG_A): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: orgId,
  } as unknown as SessionInfo;
}

beforeEach(() => {
  vi.useRealTimers();
  fakeRegistry.reset.mockClear();
  fakeRegistry.pull.mockClear();
  fakeRegistry.reconcile.mockClear().mockImplementation(async () => ({ seeded: false }));
  // A vault with nothing mapped and nothing confirmed is the neutral starting
  // point; tests that care set these explicitly.
  fakeRegistry.mappedNotes.mockReturnValue([]);
  fakeRegistry.isPushed.mockReturnValue(false);
  // The scope manager is process-wide; start each test from a clean slate.
  vaultScopes.end();
});

describe("SyncManager.disable — teardown completeness", () => {
  it("leaves no live timer, a reset registry, and no current scope", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    expect(sm.isEnabled()).toBe(true);
    expect(sm.currentScope()?.isCurrent()).toBe(true);
    // `enable` retires the previous vault first, so it resets too. Only the
    // disable() below is under test here.
    fakeRegistry.reset.mockClear();

    // Arm the debounced registry pull, then tear down before it can fire.
    sm.handleRegistryChanged();
    expect(sm.hasPendingRegistryPull()).toBe(true);

    const scope = sm.currentScope()!;
    sm.disable();

    expect(sm.hasPendingRegistryPull()).toBe(false); // cleared, not orphaned
    expect(fakeRegistry.reset).toHaveBeenCalledTimes(1); // maps + serverVaultId gone
    expect(sm.isEnabled()).toBe(false);
    expect(sm.currentScope()).toBeNull();
    expect(scope.isCurrent()).toBe(false);
    expect(scope.signal.aborted).toBe(true);
    expect(vaultScopes.current()).toBeNull();

    // And nothing fires later either.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a registry signal arriving after disable() does not even arm the timer", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    sm.disable();

    // An in-flight frame from the vault we just left. Arming here is what created
    // the original bug, so the guard has to reject it outright.
    sm.handleRegistryChanged();
    expect(sm.hasPendingRegistryPull()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("is idempotent — a second disable() is harmless", async () => {
    const sm = new SyncManager();
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    sm.disable();
    sm.disable();
    expect(sm.isEnabled()).toBe(false);
    expect(sm.currentScope()).toBeNull();
    expect(vaultScopes.current()).toBeNull();
  });
});

describe("SyncManager registry-pull timer across a vault switch", () => {
  it("a timer that survives the switch is a no-op", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    sm.handleRegistryChanged();
    expect(sm.hasPendingRegistryPull()).toBe(true);

    // Deliberately NOT calling disable(): this models a call site that swaps the
    // vault without tearing sync down first — the original bug, and the mistake a
    // future call site will repeat. The scope guard alone must hold the line.
    vaultScopes.begin({ orgId: ORG_B, vaultPath: "/vaults/b", vaultEpoch: 2 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeRegistry.pull).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("pulls normally while the vault is unchanged (the guard blocks only stale work)", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    const refreshed = vi.fn();
    sm.setRegistryListener(refreshed);
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    sm.handleRegistryChanged();
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    expect(refreshed).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("SyncManager — settling after a teammate's structural change", () => {
  /** Enable, then fire a debounced registry pull and let it land. */
  async function pullOnce(sm: SyncManager) {
    sm.handleRegistryChanged();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("stamps a terminal phase when every mapped note is confirmed", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    const progress: Array<SyncProgress | null> = [];
    sm.setSyncProgressListener((p) => progress.push(p));
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "doc-1", relPath: "a.md" }]);
    fakeRegistry.isPushed.mockReturnValue(true);
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    await sm.whenBulkSyncSettled();

    await pullOnce(sm);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    expect(progress[progress.length - 1]?.phase).toBe("done");
    fakeRegistry.mappedNotes.mockReturnValue([]);
    fakeRegistry.isPushed.mockReturnValue(false);
    vi.useRealTimers();
  });

  it("does NOT claim done while a note this device has not confirmed exists", async () => {
    // A teammate's new note arrives as a mapped row plus an EMPTY placeholder
    // file, so "done" here would claim the vault is fully synced while that note
    // has no content on this device — and the sidebar would badge its row
    // unsynced, contradicting the pill. The content pass has to run first.
    vi.useFakeTimers();
    const sm = new SyncManager();
    const progress: Array<SyncProgress | null> = [];
    sm.setSyncProgressListener((p) => progress.push(p));
    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "doc-new", relPath: "Teammate.md" }]);
    fakeRegistry.isPushed.mockReturnValue(false);
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    await sm.whenBulkSyncSettled();

    await pullOnce(sm);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    expect(progress.some((p) => p?.phase === "done")).toBe(false);
    fakeRegistry.mappedNotes.mockReturnValue([]);
    vi.useRealTimers();
  });
});

describe("SyncManager.enable — scope handover", () => {
  it("retires the previous vault's scope and registry before reconciling", async () => {
    const sm = new SyncManager();
    await sm.enable(session(ORG_A), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    const first = sm.currentScope()!;
    fakeRegistry.reset.mockClear();

    await sm.enable(session(ORG_B), emptyTree(), {
      orgId: ORG_B,
      name: "b",
      path: "/vaults/b",
      epoch: 2,
    });

    expect(first.isCurrent()).toBe(false);
    expect(fakeRegistry.reset).toHaveBeenCalledTimes(1); // A's maps dropped first
    const second = sm.currentScope()!;
    expect(second.orgId).toBe(ORG_B);
    expect(second.vaultPath).toBe("/vaults/b");
    expect(second.vaultEpoch).toBe(2);
  });

  it("a reconcile that spans a switch never brings sync up for the vault it left", async () => {
    const held = gate();
    fakeRegistry.reconcile.mockImplementationOnce(async () => {
      await held.waited;
      return { seeded: false };
    });
    const sm = new SyncManager();
    const enabling = sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });

    // Vault switch mid-reconcile, again without the caller tearing sync down.
    vaultScopes.begin({ orgId: ORG_B, vaultPath: "/vaults/b", vaultEpoch: 2 });
    held.open();

    const result = await enabling;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("vault changed");
    // Crucially: sync did NOT turn on for vault A while B is the current vault.
    expect(sm.isEnabled()).toBe(false);
  });

  it("mirrors bulk-sync progress to the store listeners, and nulls it on disable", async () => {
    // The exact contract phase 3 renders: `syncProgress` + a docId-keyed
    // `docSyncState` patch, both pushed through listeners (the sync layer never
    // imports the store), and both dropped when the vault goes away.
    const sm = new SyncManager();
    const progress: Array<SyncProgress | null> = [];
    const patches: Array<Record<string, DocSyncState | null>> = [];
    sm.setSyncProgressListener((p) => progress.push(p));
    sm.setDocStateListener((p) => patches.push(p));

    let sink: SyncProgressSink | null = null;
    fakeRegistry.setProgressSink.mockImplementation((s: SyncProgressSink) => {
      sink = s;
    });
    fakeRegistry.reconcile.mockImplementationOnce(async () => {
      sink!.phase("registering", 2);
      sink!.doc("doc-1", "queued");
      sink!.item("ok");
      sink!.flush();
      return { seeded: false };
    });

    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    await sm.whenBulkSyncSettled();

    expect(progress[0]).toEqual({ phase: "registering", done: 0, total: 2, failed: 0 });
    expect(progress[progress.length - 1]).toEqual({
      phase: "registering",
      done: 1,
      total: 2,
      failed: 0,
    });
    expect(patches).toEqual([{ "doc-1": "queued" }]);

    sm.disable();
    expect(progress[progress.length - 1]).toBeNull();
    // And a late emission from the vault we left is silenced.
    const settled = progress.length;
    sink!.item("ok");
    sink!.flush();
    expect(progress).toHaveLength(settled);
    fakeRegistry.setProgressSink.mockReset();
  });

  it("mirrors the registry's path→docId index, coalesced, and clears it on disable", async () => {
    // What the sidebar badges rows with. It has to be REACTIVE (the old code read
    // `registry.getMapping()` during render, so a row kept a stale badge), and it
    // has to be COALESCED (the registry fires once per mapped note).
    vi.useFakeTimers();
    const sm = new SyncManager();
    const maps: Array<Record<string, string>> = [];
    sm.setRegistryMapListener((m) => maps.push(m));
    // Fires immediately so a late subscriber isn't blind until the next change.
    expect(maps).toEqual([{}]);

    fakeRegistry.mappedNotes.mockReturnValue([
      { docId: "doc-1", relPath: "Work/a.md" },
      { docId: "doc-2", relPath: "b.md" },
    ]);
    await sm.enable(session(), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });

    // 200 per-note notifications must not become 200 store writes.
    const before = maps.length;
    for (let i = 0; i < 200; i++) fakeRegistry.mapListener?.();
    expect(maps).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(150);
    expect(maps).toHaveLength(before + 1);
    expect(maps[maps.length - 1]).toEqual({ "Work/a.md": "doc-1", "b.md": "doc-2" });

    // Leaving the vault publishes an EMPTY map rather than going silent, so the
    // sidebar can't keep badging rows against the vault we left.
    sm.disable();
    expect(maps[maps.length - 1]).toEqual({});

    // And a notification that arrives after the switch is published as empty too.
    fakeRegistry.mapListener?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(maps[maps.length - 1]).toEqual({});
    fakeRegistry.mappedNotes.mockReturnValue([]);
    vi.useRealTimers();
  });

  it("does not leak the previous vault's mapping into the next one", async () => {
    vi.useFakeTimers();
    const sm = new SyncManager();
    const maps: Array<Record<string, string>> = [];
    sm.setRegistryMapListener((m) => maps.push(m));

    fakeRegistry.mappedNotes.mockReturnValue([{ docId: "doc-a", relPath: "Welcome.md" }]);
    await sm.enable(session(ORG_A), emptyTree(), {
      orgId: ORG_A,
      name: "a",
      path: "/vaults/a",
      epoch: 1,
    });
    fakeRegistry.mapListener?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(maps[maps.length - 1]).toEqual({ "Welcome.md": "doc-a" });

    // A notification armed for vault A, then a switch to B before it fires. Both
    // vaults have a `Welcome.md`, so publishing A's docId would badge B's row
    // against a doc that isn't its own.
    fakeRegistry.mapListener?.();
    vaultScopes.begin({ orgId: ORG_B, vaultPath: "/vaults/b", vaultEpoch: 2 });
    await vi.advanceTimersByTimeAsync(150);
    expect(maps[maps.length - 1]).toEqual({});
    fakeRegistry.mappedNotes.mockReturnValue([]);
    vi.useRealTimers();
  });

  it("a vault with no active organization is refused and left fully torn down", async () => {
    const sm = new SyncManager();
    const result = await sm.enable(
      { ...session(), activeOrganizationId: null } as unknown as SessionInfo,
      emptyTree(),
      { orgId: "", name: "a", path: "/vaults/a", epoch: 1 },
    );
    expect(result.ok).toBe(false);
    expect(sm.isEnabled()).toBe(false);
    expect(sm.currentScope()).toBeNull();
  });
});
