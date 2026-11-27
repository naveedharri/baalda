// The idle-pull brake: a local reason that keeps re-arming pulls which change
// nothing is slowed to an exponential gap; a real change releases it.
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because importing `../docSession` evaluates its `syncManager`
// singleton, which constructs a VaultRegistry at module-eval time — before a
// plain `const` here would be initialized.
const fakeRegistry = vi.hoisted(() => {
  const reg = {
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

vi.mock("../registry", () => ({
  VaultRegistry: class {
    constructor() {
      return fakeRegistry;
    }
  },
}));

import type { SessionInfo } from "../../api";
import { SyncManager } from "../docSession";
import { vaultScopes } from "../vaultScope";

function session(): SessionInfo {
  return {
    user: { id: "u1", name: "Ann", email: "ann@example.com" },
    activeOrganizationId: "org-a",
  } as unknown as SessionInfo;
}

/** Each pull stays open until the test releases it. */

async function enabled(): Promise<SyncManager> {
  vi.useFakeTimers();
  const sm = new SyncManager();
  await sm.enable(session(), { orgId: "org-a", name: "a", path: "/vaults/a", epoch: 1 });
  return sm;
}

/** Every pull "changes" what `changed()` says, then re-asks for `reason`. */
function loop(
  sm: SyncManager,
  reason: "reauth" | "watcher",
  changed: () => boolean,
  fileChange = false,
): void {
  fakeRegistry.pull.mockReset().mockImplementation(async () => {
    const c = changed();
    setTimeout(() => sm.handleRegistryChanged(reason, { fileChange }), 0);
    return c;
  });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fakeRegistry.mappedNotes.mockReturnValue([]);
  fakeRegistry.isPushed.mockReturnValue(false);
  vaultScopes.end();
});

describe("SyncManager — idle registry pull brake", () => {
  it("caps a reauth that keeps re-arming no-change pulls", async () => {
    const sm = await enabled();
    loop(sm, "reauth", () => false);
    fakeRegistry.pull.mockClear();
    sm.handleRegistryChanged("reauth");
    await vi.advanceTimersByTimeAsync(120_000);
    // Unbraked this is ~480 pulls (one per 250ms); braked it is a handful.
    expect(fakeRegistry.pull.mock.calls.length).toBeLessThanOrEqual(12);
    sm.disable();
    vi.useRealTimers();
  });

  it("gives folder-only watcher re-arms the full backoff", async () => {
    const sm = await enabled();
    loop(sm, "watcher", () => false);
    fakeRegistry.pull.mockClear();
    sm.handleRegistryChanged("watcher");
    await vi.advanceTimersByTimeAsync(120_000);
    // 3 at full speed, then 2, 4, 8, 16, 30, 30 s gaps (unbraked: ~57 at the observed 2.1 s).
    expect(fakeRegistry.pull.mock.calls.length).toBeLessThanOrEqual(9);
    sm.disable();
    vi.useRealTimers();
  });

  it("a watcher batch with a real file still pulls within 2 s while braked", async () => {
    const sm = await enabled();
    loop(sm, "watcher", () => false);
    sm.handleRegistryChanged("watcher");
    await vi.advanceTimersByTimeAsync(120_000); // braked deep into the backoff
    fakeRegistry.pull.mockReset().mockResolvedValue(false);
    sm.handleRegistryChanged("watcher", { fileChange: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    sm.disable();
    vi.useRealTimers();
  });

  it("a braked reauth never delays a teammate's frame pull already armed", async () => {
    const sm = await enabled();
    loop(sm, "reauth", () => false);
    sm.handleRegistryChanged("reauth");
    await vi.advanceTimersByTimeAsync(120_000); // braked deep into the backoff
    fakeRegistry.pull.mockReset().mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(31_000);
    // One more teammate pull that changes nothing, just ended…
    sm.handleRegistryChanged("registry-frame");
    await vi.advanceTimersByTimeAsync(2_500);
    fakeRegistry.pull.mockClear();
    // …and a second after it the next new note: its frame, then the reauth.
    await vi.advanceTimersByTimeAsync(1_000);
    sm.handleRegistryChanged("registry-frame");
    sm.handleRegistryChanged("reauth");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fakeRegistry.pull).toHaveBeenCalledTimes(1);
    sm.disable();
    vi.useRealTimers();
  });

  it("a pull that changes something releases the brake", async () => {
    const sm = await enabled();
    let change = false;
    loop(sm, "reauth", () => change);
    sm.handleRegistryChanged("reauth");
    await vi.advanceTimersByTimeAsync(60_000);
    // Braked now: one changing pull puts the next back on the 250ms path.
    change = true;
    await vi.advanceTimersByTimeAsync(31_000);
    change = false;
    fakeRegistry.pull.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakeRegistry.pull.mock.calls.length).toBeGreaterThanOrEqual(3);
    sm.disable();
    vi.useRealTimers();
  });
});
