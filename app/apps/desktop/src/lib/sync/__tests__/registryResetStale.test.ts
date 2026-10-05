// #304: `reset()` must leave the registry STALE, not unbound. A pass that was
// mid-await when the vault switched has to resume to `stale() === true` and an
// epoch pin Rust rejects, never to "fresh and unpinned".

import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  readNote: vi.fn(async () => {
    throw new Error("No such file or directory");
  }),
  getDiskBase: vi.fn(async () => null),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import { VaultRegistry } from "../registry";
import type { VaultScope, VaultScopeSource } from "../vaultScope";

function scope(epoch: number): VaultScope {
  return {
    generation: epoch,
    orgId: "org-1",
    vaultPath: "/vault-a",
    vaultEpoch: epoch,
    signal: new AbortController().signal,
    serverVaultId: null,
    isCurrent: () => true, // teardown runs BEFORE the scope manager's end()
  };
}

describe("VaultRegistry.reset (#304)", () => {
  it("reads as stale and keeps the old epoch pin after reset", async () => {
    const current = scope(7);
    const scopes: VaultScopeSource = { current: () => current };
    const reg = new VaultRegistry({} as ApiClient, scopes);
    await reg.primeLocal("org-1");

    reg.reset();

    const r = reg as unknown as { stale(): boolean; epoch(): number | null };
    expect(r.stale()).toBe(true);
    expect(r.epoch()).toBe(7);
  });

  it("a failed read after reset is 'unknown', never 'none'", async () => {
    const current = scope(3);
    const reg = new VaultRegistry({} as ApiClient, { current: () => current });
    await reg.primeLocal("org-1");
    reg.reset();

    expect(await reg.unseenWorkVerdict("n1", "Team/a.md")).toBe("unknown");
    expect(vi.mocked(ipc.readNote)).toHaveBeenCalledWith("Team/a.md", 3);
  });

  it("stays unbound (legacy) when it was never bound", async () => {
    const reg = new VaultRegistry({} as ApiClient, { current: () => null });
    reg.reset();
    expect((reg as unknown as { stale(): boolean }).stale()).toBe(false);
    expect(await reg.unseenWorkVerdict("n1", "a.md")).toBe("none");
  });
});
