import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileReport } from "../reconcileReport";
import { vaultScopes } from "../vaultScope";

/**
 * Reconcile entries belong to the vault they were recorded under, and every
 * reader sees only the open vault's (#304's visible half: vault A's "kept on
 * this device" rows used to fill vault B's banner and Activity).
 */

const A = { orgId: "org-a", vaultPath: "/vaults/a", vaultEpoch: 1 };
const B = { orgId: "org-b", vaultPath: "/vaults/b", vaultEpoch: 2 };

afterEach(() => {
  vaultScopes.begin(A);
  reconcileReport.clear();
  vaultScopes.begin(B);
  reconcileReport.clear();
  vaultScopes.end();
  reconcileReport.clear();
});

describe("reconcileReport per vault", () => {
  it("shows only the open vault's entries and keeps the others for later", () => {
    vaultScopes.begin(A);
    reconcileReport.record({ kind: "keptLocally", docId: "a1", path: "Daily/1.md", detail: "t/1" });
    reconcileReport.record({ kind: "restoredFromServer", docId: "a2", path: "Daily/2.md" });
    expect(reconcileReport.items()).toHaveLength(2);

    vaultScopes.begin(B);
    expect(reconcileReport.items()).toEqual([]);
    reconcileReport.record({ kind: "renamedConflict", path: "X.md", newPath: "X (conflict).md" });
    expect(reconcileReport.items().map((it) => it.path)).toEqual(["X.md"]);

    // Back to A (a new scope for the same folder): its entries are still there.
    vaultScopes.begin(A);
    expect(reconcileReport.items().map((it) => it.docId)).toEqual(["a1", "a2"]);
  });

  it("hides entries recorded with no vault open while a vault is open", () => {
    vaultScopes.end();
    reconcileReport.record({ kind: "keptLocally", docId: "stray", path: "S.md", detail: "t/s" });
    expect(reconcileReport.items()).toHaveLength(1);
    vaultScopes.begin(A);
    expect(reconcileReport.items()).toEqual([]);
  });

  it("drains, clears and forgets per vault", () => {
    vaultScopes.begin(A);
    reconcileReport.record({ kind: "keptLocally", docId: "a1", path: "A1.md", detail: "t/a1" });
    vaultScopes.begin(B);
    reconcileReport.record({ kind: "keptLocally", docId: "b1", path: "B1.md", detail: "t/b1" });
    expect(reconcileReport.drain().map((it) => it.docId)).toEqual(["b1"]);
    expect(reconcileReport.drain()).toEqual([]);
    // A's doc id does nothing from B.
    expect(reconcileReport.forgetReadable(new Set(["a1"]))).toBe(0);
    reconcileReport.clear();
    vaultScopes.begin(A);
    expect(reconcileReport.drain().map((it) => it.docId)).toEqual(["a1"]);
    expect(reconcileReport.forgetReadable(new Set(["a1"]))).toBe(1);
    expect(reconcileReport.items()).toEqual([]);
  });

  it("notifies subscribers with the new vault's view on vaultChanged", () => {
    vaultScopes.begin(A);
    reconcileReport.record({ kind: "folderKept", path: "F" });
    const cb = vi.fn();
    const off = reconcileReport.subscribe(cb);
    vaultScopes.begin(B);
    reconcileReport.vaultChanged();
    expect(cb).toHaveBeenLastCalledWith([]);
    vaultScopes.begin(A);
    reconcileReport.vaultChanged();
    expect(cb.mock.lastCall?.[0].map((it: { path: string }) => it.path)).toEqual(["F"]);
    off();
  });

  it("does not re-seed an identical saved entry twice in one session", () => {
    vaultScopes.begin(A);
    const item = { kind: "keptLocally" as const, docId: "a1", path: "A1.md", detail: "t/a1" };
    reconcileReport.record(item, { at: 1000, seeded: true });
    reconcileReport.record(item, { at: 1000, seeded: true });
    expect(reconcileReport.items()).toHaveLength(1);
    // A different time is a different fact.
    reconcileReport.record(item, { at: 2000, seeded: true });
    expect(reconcileReport.items()).toHaveLength(2);
  });
});
