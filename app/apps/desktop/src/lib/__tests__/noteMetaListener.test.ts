// SyncManager's half of the last-edited plumbing: it forwards the registry's
// {docId → last-edit} map to the UI, and it applies the same vault-scope gate as
// the path→docId mirror — a pull that lands after a vault switch describes the
// vault we left, and the honest answer there is an empty map.

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because importing the module under test evaluates its
// `syncManager` singleton, which constructs a VaultRegistry at module-eval time.
const fakeRegistry = vi.hoisted(() => {
  const reg = {
    vaultId: null as string | null,
    reconcile: vi.fn(async () => ({ seeded: false })),
    pull: vi.fn(async () => {}),
    reset: vi.fn(),
    getMapping: vi.fn(() => null),
    pathForDocId: vi.fn(() => null),
    allDocIds: vi.fn((): string[] => []),
    setProgressSink: vi.fn(),
    setMapListener: vi.fn(),
    noteMetaListener: null as
      | ((meta: Record<string, { userId: string | null; name: string | null; at: string }>) => void)
      | null,
    setNoteMetaListener: vi.fn(
      (
        cb:
          | ((
              meta: Record<string, { userId: string | null; name: string | null; at: string }>,
            ) => void)
          | null,
      ) => {
        reg.noteMetaListener = cb;
      },
    ),
    // Item colors ride the same pull; this suite doesn't exercise them.
    setColorListener: vi.fn(),
    setInboundHost: vi.fn(),
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

vi.mock("../sync/registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

import type { NoteLastEdited, SessionInfo } from "../api";
import { SyncManager } from "../sync/docSession";
import { vaultScopes } from "../sync/vaultScope";

const AT = "2026-08-11T10:00:00.000Z";
const META: Record<string, NoteLastEdited> = { "doc-a": { userId: "u1", name: "Ada", at: AT } };

function session(orgId = "org-a"): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: orgId,
  } as unknown as SessionInfo;
}

async function enabled(orgId = "org-a"): Promise<SyncManager> {
  const sm = new SyncManager();
  await sm.enable(session(orgId), { orgId, name: orgId, path: `/vaults/${orgId}`, epoch: 1 });
  return sm;
}

beforeEach(() => {
  vi.useRealTimers();
  fakeRegistry.reconcile.mockClear().mockImplementation(async () => ({ seeded: false }));
  fakeRegistry.mappedNotes.mockReturnValue([]);
  vaultScopes.end();
});

describe("SyncManager — note last-edit forwarding", () => {
  it("subscribes to the registry on construction and forwards its map", async () => {
    const sm = await enabled();
    const seen: Array<Record<string, NoteLastEdited>> = [];
    sm.setNoteMetaListener((meta) => seen.push(meta));

    fakeRegistry.noteMetaListener?.(META);

    expect(seen).toEqual([META]);
  });

  it("publishes an EMPTY map for a pull that lands after a vault switch", async () => {
    const sm = await enabled("org-a");
    const seen: Array<Record<string, NoteLastEdited>> = [];
    sm.setNoteMetaListener((meta) => seen.push(meta));

    // Another vault becomes current without this manager tearing down — the exact
    // shape of the historical cross-vault leak.
    vaultScopes.begin({ orgId: "org-b", vaultPath: "/vaults/org-b", vaultEpoch: 2 });
    fakeRegistry.noteMetaListener?.(META);

    expect(seen).toEqual([{}]);
  });

  it("clears the UI's stamps on disable, rather than going silent", async () => {
    const sm = await enabled();
    const seen: Array<Record<string, NoteLastEdited>> = [];
    sm.setNoteMetaListener((meta) => seen.push(meta));
    fakeRegistry.noteMetaListener?.(META);

    sm.disable();

    expect(seen[seen.length - 1]).toEqual({});
  });

  it("is a no-op with no subscriber", async () => {
    const sm = await enabled();
    sm.setNoteMetaListener(undefined);
    expect(() => fakeRegistry.noteMetaListener?.(META)).not.toThrow();
  });
});
