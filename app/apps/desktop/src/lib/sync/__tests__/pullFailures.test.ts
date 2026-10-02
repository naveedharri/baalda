// A registry pull that keeps failing. The pull is the only path that registers
// a NEW note or folder — content edits ride their own sockets — so a streak of
// failed pulls used to read as "edits sync, new notes never appear" with
// nothing on screen but a console line. These pin the streak: the counter, the
// two thresholds, the Health row, the pill stamp, and the clear.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeRegistry = vi.hoisted(() => ({
  pull: vi.fn(async (): Promise<boolean> => true),
  setProgressSink: vi.fn(),
  setMapListener: vi.fn(),
  setNoteMetaListener: vi.fn(),
  setColorListener: vi.fn(),
  setFailureListener: vi.fn(),
  setInboundHost: vi.fn(),
  mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
  failures: vi.fn((): unknown[] => []),
  hasFailures: vi.fn(() => false),
  heldRefusals: vi.fn((): unknown[] => []),
  retryHeldRefusals: vi.fn(() => false),
  limitCode: vi.fn((): string | null => null),
}));

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

vi.mock("../../ipc", () => ({
  isVaultMismatch: () => false,
  noteExists: vi.fn(async () => true),
  clearYjsDoc: vi.fn(async () => {}),
  listTags: vi.fn(async () => []),
  listNoteTitles: vi.fn(async () => []),
}));

vi.mock("../../auth/authManager", () => ({
  api: {
    listVaultBlobs: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => new Uint8Array()),
  },
}));

import {
  PULL_FAILED_CODE,
  PULL_FAILURE_PERSIST_MS,
  PULL_FAILURE_THRESHOLD,
  SyncManager,
} from "../docSession";
import type { SyncProgress, VaultScope } from "../vaultScope";

/** The private surface these tests drive, named once. */
interface Internals {
  pullRegistry(scope: VaultScope): Promise<boolean>;
  withRefusals(p: SyncProgress | null): SyncProgress | null;
  progress: unknown;
}

const scope = { isCurrent: () => true, vaultEpoch: 1 } as unknown as VaultScope;

function manager() {
  const sm = new SyncManager();
  const inner = sm as unknown as Internals;
  // A finished run, so a verdict change re-stamps its phase.
  let phase: SyncProgress["phase"] = "done";
  const progress = {
    snapshot: () => ({ phase, done: 1, total: 1, failed: 0 }) as SyncProgress,
    phase: vi.fn((p: SyncProgress["phase"]) => {
      phase = p;
    }),
    flush: vi.fn(),
  };
  inner.progress = progress;
  return { sm, inner, progress };
}

async function failPull(inner: Internals, message = "HTTP 502") {
  fakeRegistry.pull.mockRejectedValueOnce(new Error(message));
  await expect(inner.pullRegistry(scope)).rejects.toThrow(message);
}

beforeEach(() => {
  fakeRegistry.pull.mockReset().mockResolvedValue(true);
});

describe("failed registry pulls", () => {
  it("are said only from the third in a row, with the last error", async () => {
    const { sm, inner } = manager();
    for (let i = 1; i < PULL_FAILURE_THRESHOLD; i++) {
      await failPull(inner, `fail ${i}`);
      expect(sm.pullFailure()).toBeNull();
    }
    await failPull(inner, "last one");
    expect(sm.pullFailure()).toMatchObject({ count: PULL_FAILURE_THRESHOLD, reason: "last one" });
  });

  it("are said once a streak outlives the persistence window, whatever its count", async () => {
    const { sm, inner } = manager();
    await failPull(inner);
    const since = sm.pullFailure(Number.MAX_SAFE_INTEGER)!.since;
    expect(sm.pullFailure(since + PULL_FAILURE_PERSIST_MS - 1)).toBeNull();
    expect(sm.pullFailure(since + PULL_FAILURE_PERSIST_MS)).toMatchObject({ count: 1 });
  });

  it("restart the count after a pull that succeeds", async () => {
    const { sm, inner } = manager();
    await failPull(inner);
    await failPull(inner);
    await inner.pullRegistry(scope);
    await failPull(inner);
    expect(sm.pullFailure()).toBeNull();
    expect(sm.pullFailure(Number.MAX_SAFE_INTEGER)).toMatchObject({ count: 1 });
  });

  it("add one vault-wide Health row while raised, and drop it on the next success", async () => {
    const { sm, inner } = manager();
    for (let i = 0; i < PULL_FAILURE_THRESHOLD; i++) await failPull(inner, "HTTP 504");
    expect(sm.syncFailures().registry).toEqual([
      { kind: "pull", path: "", docId: null, reason: "HTTP 504", code: PULL_FAILED_CODE },
    ]);
    await inner.pullRegistry(scope);
    expect(sm.pullFailure()).toBeNull();
    expect(sm.syncFailures().registry).toEqual([]);
  });

  it("keep the finished run off done while raised, and put it back on success", async () => {
    const { inner, progress } = manager();
    for (let i = 0; i < PULL_FAILURE_THRESHOLD; i++) await failPull(inner);
    expect(progress.phase).toHaveBeenLastCalledWith("error");
    expect(inner.withRefusals({ phase: "error", done: 1, total: 1, failed: 0 })).toMatchObject({
      pullFailing: true,
    });

    await inner.pullRegistry(scope);
    expect(progress.phase).toHaveBeenLastCalledWith("done");
    expect(inner.withRefusals({ phase: "error", done: 1, total: 1, failed: 0 })).not.toHaveProperty(
      "pullFailing",
    );
  });

  it("do not re-stamp the run before the threshold", async () => {
    const { inner, progress } = manager();
    await failPull(inner);
    expect(progress.phase).not.toHaveBeenCalled();
  });
});
