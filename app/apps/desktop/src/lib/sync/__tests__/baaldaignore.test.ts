// The vault's .baaldaignore (#401): the on-disk face of its one sync setting.
// An owner's or admin's edit becomes the vault's rules; a member's edit, an
// edit made against an older revision and an empty file are put back; a file
// the app could not send stays as it is until it can.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncRuleSet } from "../../syncRules/match";

const fakeRegistry = vi.hoisted(() => {
  const reg = {
    // Sync rules (#401): these fixtures have none.
    isParked: () => false,
    filterBlobListing: <T,>(b: T[]) => b,
    isFrozenPath: () => false,
    isExcludedPath: () => false,
    frozenFilePaths: () => [] as string[],
    rules: null as unknown as SyncRuleSet,
    setSyncRules: (r: SyncRuleSet) => {
      reg.rules = r;
    },
    syncRules: () => reg.rules,
    changeRules: async (r: SyncRuleSet, install: () => Promise<void>) => {
      reg.rules = r;
      await install();
    },
    parkedCount: () => ({ notes: 0, files: 0 }),
    vaultId: null as string | null,
    // Phase A of `enable`: the local prime. False here — this suite is about the
    // reconcile-and-teardown path, and a prime that adopts nothing is exactly
    // the pre-prime behaviour these assertions were written against.
    primeLocal: vi.fn(async (_orgId: string) => false),
    reconcile: vi.fn(async () => ({ seeded: false })),
    // Resolves true ("something changed") so the tests can assert the tree
    // refresh fires — a false pull deliberately skips it to avoid flicker.
    pull: vi.fn(async () => true),
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
    // Versioning: the manager also mirrors {docId → last-edit} out of the pull.
    setNoteMetaListener: vi.fn(),
    // …and the vault's shared item colors, from that same pull.
    setColorListener: vi.fn(),
    setFailureListener: vi.fn(),
    // Inbound reconciliation: the manager hands itself over as the host that can
    // make the editor/doc-store let go of a doc before its file moves.
    inboundHost: null as unknown,
    setInboundHost: vi.fn((host: unknown) => {
      reg.inboundHost = host;
    }),
    mappedNotes: vi.fn((): Array<{ docId: string; relPath: string }> => []),
    isPushed: vi.fn(() => false),
    markPushed: vi.fn(),
    flushCheckpoint: vi.fn(async () => {}),
    materializePendingFromBootstrap: vi.fn(async () => false),
    pendingFromBootstrapCount: vi.fn(() => 0),
    failures: vi.fn((): unknown[] => []),
    hasFailures: vi.fn(() => false),
    heldRefusals: vi.fn((): unknown[] => []),
    retryHeldRefusals: vi.fn(() => false),
    limitCode: vi.fn((): string | null => null),
  };
  return reg;
});


const ipcMock = vi.hoisted(() => ({
  readRulesFile: vi.fn(async (): Promise<string | null> => null),
  writeRulesFile: vi.fn(async (_text: string) => true),
  getSyncRules: vi.fn(async (): Promise<unknown> => null),
  setSyncRules: vi.fn(async (_doc: unknown) => ({ changed: true })),
  getVaultConfig: vi.fn(async (): Promise<string | null> => null),
}));
const toasts = vi.hoisted(() => [] as Array<{ text: string; tone?: string }>);

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));
vi.mock("../../ipc", async (orig) => ({ ...(await orig<object>()), ...ipcMock }));
vi.mock("../../toast", async (orig) => ({
  ...(await orig<object>()),
  toast: (text: string, tone?: string) => {
    toasts.push({ text, tone });
    return 0;
  },
}));

import { ApiError } from "../../api";
import { api } from "../../auth/authManager";
import { DEFAULT_BAALDAIGNORE, rulesTextOf } from "../../syncRules/baaldaignore";
import { SyncManager } from "../docSession";
import type { VaultScope } from "../vaultScope";

const scope = { isCurrent: () => true, vaultEpoch: 1, orgId: "org-1" } as unknown as VaultScope;
const ALL = new Set(["sync-rules", "more-file-types", "baaldaignore"]);

type Res = Awaited<ReturnType<typeof api.getSyncRules>>;
function serverRules(version: 1 | 2, patterns: string, revision: number, folders = { hidden: false, build: false }): Res {
  return {
    rules: { version, patterns, types: { code: false, extra: false }, folders },
    revision,
    updatedAt: null,
    updatedBy: null,
  };
}

function manager(features: ReadonlySet<string> = ALL) {
  const sm = new SyncManager();
  (sm as unknown as { serverFeatures: () => Promise<ReadonlySet<string>> }).serverFeatures = async () => features;
  return sm;
}
const applied = (sm: SyncManager, text: string, revision: number | null) => {
  (sm as unknown as { appliedRules: unknown }).appliedRules = { text, revision };
};
const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const lastDoc = () => last(ipcMock.setSyncRules.mock.calls)?.[0] as
  | { version: number; patterns: string; types: unknown; folders: unknown; revision: number | null }
  | undefined;

const OWNER_TEXT = DEFAULT_BAALDAIGNORE + "\nprojects/app/code/\n";

beforeEach(() => {
  vi.restoreAllMocks();
  for (const f of Object.values(ipcMock)) f.mockReset();
  ipcMock.readRulesFile.mockResolvedValue(null);
  ipcMock.writeRulesFile.mockResolvedValue(true);
  ipcMock.getSyncRules.mockResolvedValue(null);
  ipcMock.setSyncRules.mockResolvedValue({ changed: true });
  ipcMock.getVaultConfig.mockResolvedValue(null);
  fakeRegistry.rules = new SyncRuleSet("");
  toasts.length = 0;
});

describe(".baaldaignore in a synced vault", () => {
  it("a vault with no rules gets the default file, with today's ignores and every file type on", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(1, "", 0));
    const put = vi.spyOn(api, "putSyncRulesFile");
    const sm = manager();
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(put).not.toHaveBeenCalled();
    expect(lastDoc()).toMatchObject({
      version: 2,
      patterns: DEFAULT_BAALDAIGNORE,
      types: { code: true, extra: true },
      folders: { hidden: true, build: true },
    });
    expect(ipcMock.writeRulesFile).toHaveBeenCalledWith(DEFAULT_BAALDAIGNORE, 1);
    // What the defaults hide is exactly what was hidden before the file.
    const r = fakeRegistry.rules;
    expect(r.excludes(".obsidian", true)).toBe(true);
    expect(r.excludes("projects/app/node_modules/x/index.js", false)).toBe(true);
    expect(r.excludes("Build/plan.md", false)).toBe(false);
    expect(r.excludes("projects/app/src/main.ts", false)).toBe(false);
  });

  it("an older server keeps the optional types off", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(1, "", 0));
    await manager(new Set(["sync-rules"])).refreshSyncRules(scope, "org-1", { pull: false });
    expect(lastDoc()?.types).toEqual({ code: false, extra: false });
  });

  it("an owner's edit becomes the vault's rules", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(2, DEFAULT_BAALDAIGNORE, 3));
    const put = vi.spyOn(api, "putSyncRulesFile").mockResolvedValue(serverRules(2, OWNER_TEXT, 4));
    ipcMock.readRulesFile.mockResolvedValue(OWNER_TEXT);
    const sm = manager();
    applied(sm, DEFAULT_BAALDAIGNORE, 3);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(put).toHaveBeenCalledWith("org-1", OWNER_TEXT, 3);
    expect(lastDoc()).toMatchObject({ patterns: OWNER_TEXT, revision: 4 });
    expect(fakeRegistry.rules.excludes("projects/app/code/a.md", false)).toBe(true);
    expect(last(toasts)?.tone).toBe("success");
  });

  it("a member's edit is put back with a toast", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(2, DEFAULT_BAALDAIGNORE, 3));
    vi.spyOn(api, "putSyncRulesFile").mockRejectedValue(new ApiError(403, "no", { error: "sync_rules_admin_required" }));
    ipcMock.readRulesFile.mockResolvedValue(OWNER_TEXT);
    const sm = manager();
    applied(sm, DEFAULT_BAALDAIGNORE, 3);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(ipcMock.writeRulesFile).toHaveBeenCalledWith(DEFAULT_BAALDAIGNORE, 1);
    expect(fakeRegistry.rules.excludes("projects/app/code/a.md", false)).toBe(false);
    expect(last(toasts)?.text).toMatch(/Only owners and admins/);
  });

  it("an edit made while the vault's rules moved on is replaced, never sent", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(2, DEFAULT_BAALDAIGNORE + "\ndocs/\n", 5));
    const put = vi.spyOn(api, "putSyncRulesFile");
    ipcMock.readRulesFile.mockResolvedValue(OWNER_TEXT);
    const sm = manager();
    applied(sm, DEFAULT_BAALDAIGNORE, 3);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(put).not.toHaveBeenCalled();
    expect(ipcMock.writeRulesFile).toHaveBeenCalledWith(DEFAULT_BAALDAIGNORE + "\ndocs/\n", 1);
  });

  it("a stale file (what this device last applied) simply follows the vault", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(2, OWNER_TEXT, 4));
    const put = vi.spyOn(api, "putSyncRulesFile");
    ipcMock.readRulesFile.mockResolvedValue(DEFAULT_BAALDAIGNORE);
    const sm = manager();
    applied(sm, DEFAULT_BAALDAIGNORE, 3);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(put).not.toHaveBeenCalled();
    expect(ipcMock.writeRulesFile).toHaveBeenCalledWith(OWNER_TEXT, 1);
    expect(toasts).toEqual([]);
  });

  it("an empty file is read as missing and written back, never as 'ignore nothing'", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(2, OWNER_TEXT, 4));
    const put = vi.spyOn(api, "putSyncRulesFile");
    ipcMock.readRulesFile.mockResolvedValue("  \n");
    const sm = manager();
    applied(sm, OWNER_TEXT, 4);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(put).not.toHaveBeenCalled();
    expect(ipcMock.writeRulesFile).toHaveBeenCalledWith(OWNER_TEXT, 1);
  });

  it("an edit the server never answered stays in the file for the next try", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(2, DEFAULT_BAALDAIGNORE, 3));
    vi.spyOn(api, "putSyncRulesFile").mockRejectedValue(new TypeError("Failed to fetch"));
    ipcMock.readRulesFile.mockResolvedValue(OWNER_TEXT);
    const sm = manager();
    applied(sm, DEFAULT_BAALDAIGNORE, 3);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(ipcMock.writeRulesFile).not.toHaveBeenCalled();
    expect(lastDoc()?.patterns ?? DEFAULT_BAALDAIGNORE).toBe(DEFAULT_BAALDAIGNORE);
  });

  it("a rule list over the caps is refused with an error toast and the file is kept", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(2, DEFAULT_BAALDAIGNORE, 3));
    const put = vi.spyOn(api, "putSyncRulesFile");
    ipcMock.readRulesFile.mockResolvedValue("a/\n".repeat(600));
    const sm = manager();
    applied(sm, DEFAULT_BAALDAIGNORE, 3);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(put).not.toHaveBeenCalled();
    expect(ipcMock.writeRulesFile).not.toHaveBeenCalled();
    expect(last(toasts)?.tone).toBe("error");
  });

  it("no answer from the server changes nothing, the file included", async () => {
    vi.spyOn(api, "getSyncRules").mockRejectedValue(new TypeError("Failed to fetch"));
    ipcMock.readRulesFile.mockResolvedValue(OWNER_TEXT);
    await manager().refreshSyncRules(scope, "org-1", { pull: false });
    expect(ipcMock.setSyncRules).not.toHaveBeenCalled();
    expect(ipcMock.writeRulesFile).not.toHaveBeenCalled();
  });

  it("rules saved from the old Sync tab read as the same file, written out", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(1, "projects/app/code/\n", 2, { hidden: true, build: false }));
    await manager().refreshSyncRules(scope, "org-1", { pull: false });
    const text = lastDoc()!.patterns;
    expect(text).toContain("node_modules/");
    expect(text).not.toMatch(/^\.\*$/m);
    expect(text).toContain("projects/app/code/");
    const r = fakeRegistry.rules;
    expect(r.excludes(".github/ci.yml", false)).toBe(false);
    expect(r.excludes("projects/app/code/a.md", false)).toBe(true);
  });

  it("a local vault's own rules become the vault's when it has none yet", async () => {
    vi.spyOn(api, "getSyncRules").mockResolvedValue(serverRules(1, "", 0));
    const put = vi.spyOn(api, "putSyncRulesFile").mockResolvedValue(serverRules(2, OWNER_TEXT, 1));
    const sm = manager();
    applied(sm, OWNER_TEXT, null);
    await sm.refreshSyncRules(scope, "org-1", { pull: false });
    expect(put).toHaveBeenCalledWith("org-1", OWNER_TEXT, 0);
    expect(ipcMock.writeRulesFile).toHaveBeenCalledWith(OWNER_TEXT, 1);
  });
});

describe(".baaldaignore in a vault that doesn't sync", () => {
  it("writes the defaults and applies them with every type on", async () => {
    const sm = manager();
    await sm.applyLocalRulesFile();
    expect(ipcMock.writeRulesFile).toHaveBeenCalledWith(DEFAULT_BAALDAIGNORE);
    expect(lastDoc()).toMatchObject({ version: 2, types: { code: true, extra: true } });
  });

  it("applies the file's own lines", async () => {
    ipcMock.readRulesFile.mockResolvedValue(OWNER_TEXT);
    const sm = manager();
    await sm.applyLocalRulesFile();
    expect(ipcMock.writeRulesFile).not.toHaveBeenCalled();
    expect(fakeRegistry.rules.excludes("projects/app/code/a.md", false)).toBe(true);
  });

  it("leaves a folder stamped for sync to the sync session", async () => {
    ipcMock.getVaultConfig.mockResolvedValue(JSON.stringify({ serverVaultId: "v-1", docs: {} }));
    ipcMock.readRulesFile.mockResolvedValue(OWNER_TEXT);
    await manager().applyLocalRulesFile();
    expect(ipcMock.setSyncRules).not.toHaveBeenCalled();
    expect(ipcMock.writeRulesFile).not.toHaveBeenCalled();
  });
});

describe("rulesTextOf", () => {
  it("is the file itself for version 2 and today's ignores for nothing saved", () => {
    expect(rulesTextOf({ version: 2, patterns: "x/\n" })).toBe("x/\n");
    expect(rulesTextOf(null)).toBe(DEFAULT_BAALDAIGNORE);
    expect(rulesTextOf({ version: 1, patterns: "" })).toBe(DEFAULT_BAALDAIGNORE);
  });
});
