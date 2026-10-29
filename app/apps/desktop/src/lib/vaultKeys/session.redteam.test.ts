// Red team (W3, desktop): converting a vault must never leave a key the
// server accepted that no device holds, never generate a second key over a
// claimed one, and never key a vault with a key the keychain did not keep.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountKeysBody, MyVaultKeys, VaultKeyInit } from "../api";
import { fromBase64, openSealedVk, toBase64 } from "./crypto";
import { createVaultKeySession, type VaultKeySessionDeps } from "./session";
import { keychainVaultKeyStore, setSecretIoForTests } from "./store";

/** One server shared by every device of one account. */
function server() {
  let me: AccountKeysBody | null = null;
  const vaults = new Map<string, { vkCheck: string; generation: number; wrap: string }>();
  const claims = new Map<string, string>();
  const conv = { allowed: true, ready: true };
  const api = {
    initVaultKeys: vi.fn(async (vaultId: string, b: VaultKeyInit) => {
      if (vaults.has(vaultId)) return "already-keyed" as const;
      const claim = claims.get(vaultId);
      if (claim && claim !== b.vkCheck) return "pending-mismatch" as const;
      vaults.set(vaultId, { vkCheck: b.vkCheck, generation: b.generation, wrap: b.sealedVkForSelf });
      return "created" as const;
    }),
    getMyVaultKeys: vi.fn(async (vaultId: string): Promise<MyVaultKeys> => {
      const v = vaults.get(vaultId);
      if (!v) return { keyed: false, pending: false, conversionAllowed: conv.allowed, encryptionRequested: true };
      return { keyed: true, pending: false, vkCheck: v.vkCheck, generation: v.generation, wraps: [{ generation: v.generation, sealedVk: v.wrap }] };
    }),
    listVaultKeyRequests: vi.fn(async () => []),
    postVaultKeyWrap: vi.fn(async () => {}),
    putMyKeys: vi.fn(async (b: AccountKeysBody) => void (me = b)),
    getMyKeys: vi.fn(async () => me),
    registerPendingDevice: vi.fn(async () => {}),
    listPendingDevices: vi.fn(async () => []),
    getDeviceKey: vi.fn(async () => null),
    putDeviceKey: vi.fn(async () => {}),
    denyDevice: vi.fn(async () => {}),
    registerPendingVaultKey: vi.fn(async (vaultId: string, b: { vkCheck: string }) => {
      // Let a concurrent device interleave here.
      await Promise.resolve();
      const have = claims.get(vaultId);
      if (have && have !== b.vkCheck) return "claimed" as const;
      claims.set(vaultId, b.vkCheck);
      return "registered" as const;
    }),
    getAllowlistCandidates: vi.fn(async () => []),
    postAllowlist: vi.fn(async () => ({ rejected: [] as string[] })),
    getConversionReady: vi.fn(async () => conv.ready),
  };
  return { api, vaults, claims, conv };
}

/** A device's keychain. `dropWrites` simulates a keychain that reports success but keeps nothing. */
function keychain(shared: { account: Uint8Array | null }) {
  const vks = new Map<string, Uint8Array>();
  const provisional = new Set<string>();
  const ctl = { failWrite: false, dropWrites: false };
  return {
    vks,
    provisional,
    ctl,
    getDeviceLinkKey: vi.fn(async () => null),
    setDeviceLinkKey: vi.fn(async () => {}),
    deleteDeviceLinkKey: vi.fn(async () => {}),
    getAccountPrivateKey: vi.fn(async () => shared.account),
    setAccountPrivateKey: vi.fn(async (k: Uint8Array) => void (shared.account = k)),
    getVaultKey: vi.fn(async (id: string) => vks.get(id) ?? null),
    setVaultKey: vi.fn(async (id: string, vk: Uint8Array) => {
      if (ctl.failWrite) throw new Error("keychain write failed");
      if (!ctl.dropWrites) vks.set(id, vk);
    }),
    deleteVaultKey: vi.fn(async (id: string) => void vks.delete(id)),
    isVaultKeyProvisional: vi.fn(async (id: string) => provisional.has(id)),
    setVaultKeyProvisional: vi.fn(async (id: string, on: boolean) => void (on ? provisional.add(id) : provisional.delete(id))),
    clearCache: vi.fn(),
  };
}

function device(api: ReturnType<typeof server>["api"], keys: ReturnType<typeof keychain>, deviceId: string) {
  const pins = new Map<string, string>();
  const deps: VaultKeySessionDeps = {
    api: api as unknown as VaultKeySessionDeps["api"],
    keys,
    pins: { get: async (u) => pins.get(u) ?? null, set: async (u, f) => void pins.set(u, f) },
    features: async () => new Set(["vault-keys"]),
    keysAllowed: () => false,
    isMember: async () => true,
    selfUserId: () => "u1",
    deviceId: () => deviceId,
    canConvert: async () => true,
  };
  return createVaultKeySession(deps);
}

describe("red team: converting a vault on the desktop", () => {
  afterEach(() => setSecretIoForTests());
  it("a keychain write failure stops before any server call: nothing claimed, nothing keyed", async () => {
    const srv = server();
    const shared = { account: null as Uint8Array | null };
    const keys = keychain(shared);
    const s = device(srv.api, keys, "d1");
    await s.ensureAccountKeys();
    keys.ctl.failWrite = true;
    await expect(s.convertVault("v1")).rejects.toThrow("keychain write failed");
    expect(srv.api.registerPendingVaultKey).not.toHaveBeenCalled();
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
    expect(srv.claims.size).toBe(0);
  });

  it("a keychain that silently keeps nothing never registers a key no device holds", async () => {
    const srv = server();
    const mem = new Map<string, string>();
    const ctl = { drop: false };
    setSecretIoForTests({
      get: async (k) => mem.get(k) ?? null,
      set: async (k, v) => void (ctl.drop ? undefined : mem.set(k, v)),
      delete: async (k) => void mem.delete(k),
    });
    const keys = keychainVaultKeyStore("https://srv.test", "u1");
    const s = device(srv.api, keys as unknown as ReturnType<typeof keychain>, "d1");
    await s.ensureAccountKeys();
    ctl.drop = true;
    srv.conv.ready = false;
    await expect(s.convertVault("v1")).rejects.toThrow("keychain did not keep");
    // Had it claimed, a relaunch would generate a NEW key that the claim then
    // refuses forever (pending_mismatch): the vault stuck converting with a
    // key nobody holds.
    expect(srv.api.registerPendingVaultKey).not.toHaveBeenCalled();
    ctl.drop = false;
    keys.clearCache();
    srv.conv.ready = true;
    expect(await s.convertVault("v1")).toBe("converted");
    expect(await keys.isVaultKeyProvisional("v1")).toBe(false);
    expect(srv.vaults.get("v1")!.vkCheck).toBe(srv.claims.get("v1"));
  });

  it("two devices of the owner converting at once end with ONE key, held by both", async () => {
    const srv = server();
    const shared = { account: null as Uint8Array | null };
    const k1 = keychain(shared);
    const k2 = keychain(shared);
    const a = device(srv.api, k1, "d1");
    const b = device(srv.api, k2, "d2");
    await a.ensureAccountKeys();
    await b.ensureAccountKeys();
    const [ra, rb] = await Promise.all([a.convertVault("v1"), b.convertVault("v1")]);
    expect([ra, rb].sort()).toEqual(["claimed-elsewhere", "converted"]);
    expect(srv.vaults.size).toBe(1);
    const loser = ra === "converted" ? { s: b, k: k2 } : { s: a, k: k1 };
    const winner = ra === "converted" ? k1 : k2;
    // The loser adopts the accepted key through its own account's wrap.
    expect(await loser.s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
    expect(loser.k.vks.get("v1")).toEqual(winner.vks.get("v1"));
    expect(loser.k.provisional.has("v1")).toBe(false);
    // The accepted key is the one the server's check and wrap name.
    const v = srv.vaults.get("v1")!;
    const opened = openSealedVk(shared.account!, fromBase64(v.wrap));
    expect(toBase64(opened)).toBe(toBase64(winner.vks.get("v1")!));
  });

  it("crash after keys/init committed but before the answer: relaunch keeps the SAME key, no second key", async () => {
    const srv = server();
    const shared = { account: null as Uint8Array | null };
    const keys = keychain(shared);
    const s = device(srv.api, keys, "d1");
    await s.ensureAccountKeys();
    srv.api.initVaultKeys.mockImplementationOnce(async (vaultId: string, b: VaultKeyInit) => {
      srv.vaults.set(vaultId, { vkCheck: b.vkCheck, generation: b.generation, wrap: b.sealedVkForSelf });
      throw new Error("process killed");
    });
    await expect(s.convertVault("v1")).rejects.toThrow();
    const vk = keys.vks.get("v1")!;
    // Relaunch: a fresh session over the same keychain.
    const again = device(srv.api, keys, "d1");
    expect(await again.gateVaultOpen("v1")).toBe("proceed");
    expect(keys.vks.get("v1")).toBe(vk);
    expect(keys.setVaultKey).toHaveBeenCalledTimes(1);
    expect(keys.provisional.has("v1")).toBe(false);
  });

  it("sign-out (session reset) mid-conversion keeps the keychain key; the next sign-in resumes with it", async () => {
    const srv = server();
    const shared = { account: null as Uint8Array | null };
    const keys = keychain(shared);
    const s = device(srv.api, keys, "d1");
    await s.ensureAccountKeys();
    srv.conv.ready = false;
    expect(await s.convertVault("v1")).toBe("waiting-ready");
    const vk = keys.vks.get("v1")!;
    s.clear();
    s.dispose();
    expect(keys.deleteVaultKey).not.toHaveBeenCalled();
    srv.conv.ready = true;
    const next = device(srv.api, keys, "d1");
    expect(await next.convertVault("v1")).toBe("converted");
    expect(keys.vks.get("v1")).toBe(vk);
    expect(srv.vaults.get("v1")!.vkCheck).toBe(srv.claims.get("v1"));
  });

  it("while a keyed vault waits for its key the first sync pass is paused (no local file touched)", async () => {
    const srv = server();
    const shared = { account: null as Uint8Array | null };
    const keys = keychain(shared);
    const s = device(srv.api, keys, "d1");
    await s.ensureAccountKeys();
    srv.api.getMyVaultKeys.mockResolvedValueOnce({ keyed: true, pending: true } as MyVaultKeys);
    expect(await s.gateVaultOpen("v1")).toBe("paused");
    srv.api.getMyVaultKeys.mockRejectedValueOnce(new Error("offline"));
    expect(await s.gateVaultOpen("v1")).toBe("paused");
  });
});
