import { describe, expect, it, vi } from "vitest";
import { ApiError, type AccountKeysBody, type MyVaultKeys, type VaultKeyInit, type VaultKeyRequest } from "../api";
import {
  fromBase64,
  generateAccountKeypair,
  generateVaultKey,
  makeVkCheck,
  openSealedVk,
  keyFingerprint,
  sealTo,
  sealVkTo,
  shortFingerprint,
  toBase64,
  vaultKeyToWords,
} from "./crypto";
import { publicKeyFromPrivate as generateAccountKeypairPub } from "./crypto";
import { createVaultKeySession, resetVaultKeySessions, type VaultKeySessionDeps } from "./session";

/** A fake server that holds only what the real one would: blobs, never keys. */
function fakeServer() {
  let me: AccountKeysBody | null = null;
  const vaults = new Map<string, { vkCheck: string; generation: number; wraps: Map<string, string> }>();
  const requests = new Map<string, VaultKeyRequest[]>();
  const posted: { vaultId: string; userId: string; header: string }[] = [];
  let pendingDevices: { deviceId: string; publicKey: string }[] = [];
  const deviceKeys = new Map<string, string>();
  let caller = "u1";
  const api = {
    initVaultKeys: vi.fn(async (vaultId: string, b: VaultKeyInit) => {
      if (vaults.has(vaultId)) return "already-keyed" as const;
      vaults.set(vaultId, {
        vkCheck: b.vkCheck,
        generation: b.generation,
        wraps: new Map([[caller, b.sealedVkForSelf]]),
      });
      return "created" as const;
    }),
    getMyVaultKeys: vi.fn(async (vaultId: string): Promise<MyVaultKeys> => {
      const v = vaults.get(vaultId);
      if (!v) throw new ApiError(404, "not keyed");
      const w = v.wraps.get(caller);
      if (!w) return { pending: true };
      return { pending: false, vkCheck: v.vkCheck, generation: v.generation, wraps: [{ generation: v.generation, sealedVk: w }] };
    }),
    listVaultKeyRequests: vi.fn(async (vaultId: string) => requests.get(vaultId) ?? []),
    postVaultKeyWrap: vi.fn(async (vaultId: string, w: { userId: string; sealedVk: string }, header: string) => {
      posted.push({ vaultId, userId: w.userId, header });
      vaults.get(vaultId)!.wraps.set(w.userId, w.sealedVk);
    }),
    putMyKeys: vi.fn(async (b: AccountKeysBody) => void (me = b)),
    getMyKeys: vi.fn(async () => me),
    registerPendingDevice: vi.fn(async (deviceId: string, publicKey: string) => {
      if (!pendingDevices.some((d) => d.deviceId === deviceId)) pendingDevices.push({ deviceId, publicKey });
    }),
    listPendingDevices: vi.fn(async () => pendingDevices.slice()),
    getDeviceKey: vi.fn(async (deviceId: string) => deviceKeys.get(deviceId) ?? null),
    putDeviceKey: vi.fn(async (deviceId: string, w: string) => {
      deviceKeys.set(deviceId, w);
      pendingDevices = pendingDevices.filter((d) => d.deviceId !== deviceId);
    }),
    denyDevice: vi.fn(async (deviceId: string) => {
      pendingDevices = pendingDevices.filter((d) => d.deviceId !== deviceId);
    }),
  };
  return {
    api,
    vaults,
    deviceKeys,
    requests,
    posted,
    as: (u: string) => void (caller = u),
    setMe: (b: AccountKeysBody | null) => void (me = b),
  };
}

function fakeKeys() {
  let account: Uint8Array | null = null;
  const vks = new Map<string, Uint8Array>();
  let link: Uint8Array | null = null;
  return {
    vks,
    getDeviceLinkKey: vi.fn(async () => link),
    setDeviceLinkKey: vi.fn(async (k: Uint8Array) => void (link = k)),
    deleteDeviceLinkKey: vi.fn(async () => void (link = null)),
    getAccountPrivateKey: vi.fn(async () => account),
    setAccountPrivateKey: vi.fn(async (k: Uint8Array) => void (account = k)),
    getVaultKey: vi.fn(async (id: string) => vks.get(id) ?? null),
    setVaultKey: vi.fn(async (id: string, vk: Uint8Array) => void vks.set(id, vk)),
    clearCache: vi.fn(),
  };
}

function memPins() {
  const m = new Map<string, string>();
  return { m, get: async (u: string) => m.get(u) ?? null, set: async (u: string, f: string) => void m.set(u, f) };
}

function session(over: Partial<VaultKeySessionDeps> & Pick<VaultKeySessionDeps, "api" | "keys">) {
  return createVaultKeySession({
    features: async () => new Set(["vault-keys"]),
    keysAllowed: () => true,
    isMember: async () => true,
    pins: memPins(),
    selfUserId: () => "u1",
    deviceId: () => "d1",
    ...over,
  });
}

describe("vault key session", () => {
  it("is a no-op without the server feature", async () => {
    const srv = fakeServer();
    const s = session({ api: srv.api, keys: fakeKeys(), features: async () => new Set() });
    expect(await s.ensureAccountKeys()).toEqual({ state: "disabled" });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "disabled" });
    expect(srv.api.getMyKeys).not.toHaveBeenCalled();
    expect(srv.api.getMyVaultKeys).not.toHaveBeenCalled();
  });

  it("first run: makes a keypair, publishes it, keys a vault and reveals its words", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys });
    expect(await s.ensureAccountKeys()).toEqual({ state: "ready", isNew: true });
    const priv = (await keys.getAccountPrivateKey())!;
    const published = (await srv.api.getMyKeys())!;
    expect(fromBase64(published.publicKey)).toEqual(generateAccountKeypairPub(priv));
    expect(await s.ensureAccountKeys()).toEqual({ state: "ready", isNew: false });

    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1, created: true });
    expect(s.headerFor("v1")).toBe(toBase64(keys.vks.get("v1")!));
    expect(s.revealVaultKey("v1")).toBe(vaultKeyToWords(keys.vks.get("v1")!));
    expect(s.revealVaultKey("v2")).toBeNull();
    // Next launch: the same key, not "created" again.
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
  });

  it("leaves an unkeyed vault alone when keying is not allowed", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    await keys.setAccountPrivateKey(generateAccountKeypair().privateKey);
    const s = session({ api: srv.api, keys, keysAllowed: () => false });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "unkeyed" });
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
    expect(s.headerFor("v1")).toBeNull();
  });

  it("new device: restores with the owner's vault key words; a wrong key is never stored", async () => {
    const srv = fakeServer();
    const ownerKeys = fakeKeys();
    const owner = session({ api: srv.api, keys: ownerKeys });
    await owner.ensureAccountKeys();
    await owner.ensureVaultKey("v1");
    const words = owner.revealVaultKey("v1")!;

    // The same account on a new device: server has keys, device has none.
    const keys = fakeKeys();
    const device = session({ api: srv.api, keys });
    expect((await device.ensureAccountKeys()).state).toBe("awaiting-device-approval");
    expect(await device.restoreWithVaultKey("v1", "abandon ".repeat(23) + "zoo")).toBe("invalid-words");
    expect(await device.restoreWithVaultKey("v1", vaultKeyToWords(generateVaultKey()))).toBe("wrong-key");
    expect(keys.setVaultKey).not.toHaveBeenCalled();
    expect(await device.restoreWithVaultKey("v1", ` ${words.toUpperCase()} `)).toBe("restored");
    expect(keys.vks.get("v1")).toEqual(ownerKeys.vks.get("v1"));
    expect(device.headerFor("v1")).toBe(toBase64(ownerKeys.vks.get("v1")!));
    // No account key on this device: nothing sealed on its behalf.
    expect(srv.api.postVaultKeyWrap).not.toHaveBeenCalled();
  });

  it("restore seals the key to ourselves when the account key is ready", async () => {
    const srv = fakeServer();
    const owner = session({ api: srv.api, keys: fakeKeys() });
    await owner.ensureAccountKeys();
    await owner.ensureVaultKey("v1");
    const words = owner.revealVaultKey("v1")!;
    srv.as("u2");
    srv.setMe(null);
    const keys = fakeKeys();
    const member = session({ api: srv.api, keys, selfUserId: () => "u2", keysAllowed: () => false });
    await member.ensureAccountKeys();
    // Pending answer still carries vk_check, so the typed key can be verified.
    srv.api.getMyVaultKeys.mockResolvedValueOnce({
      pending: true,
      vkCheck: srv.vaults.get("v1")!.vkCheck,
      generation: 1,
    });
    expect(await member.restoreWithVaultKey("v1", words)).toBe("restored");
    expect(srv.posted.map((p) => p.userId)).toEqual(["u2"]);
    expect(await member.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
  });

  it("waits for a teammate, then the holder seals for a member and refuses a non-member", async () => {
    const srv = fakeServer();
    const ownerKeys = fakeKeys();
    const owner = session({
      api: srv.api,
      keys: ownerKeys,
      isMember: async (_v, userId) => userId === "u2",
    });
    await owner.ensureAccountKeys();
    await owner.ensureVaultKey("v1");

    srv.as("u2");
    const memberKeys = fakeKeys();
    const member = session({ api: srv.api, keys: memberKeys, keysAllowed: () => false });
    const memberPair = generateAccountKeypair();
    await memberKeys.setAccountPrivateKey(memberPair.privateKey);
    expect(await member.ensureVaultKey("v1")).toEqual({ state: "waiting-for-teammate" });

    const outsider = generateAccountKeypair();
    srv.requests.set("v1", [
      { userId: "u2", publicKey: toBase64(memberPair.publicKey), requestedAt: "" },
      { userId: "u9", publicKey: toBase64(outsider.publicKey), requestedAt: "" },
    ]);
    srv.as("u1");
    const res = await owner.serviceKeyRequests("v1");
    expect(res.sealed).toEqual([{ userId: "u2", fingerprint: shortFingerprint(memberPair.publicKey) }]);
    expect(res.sealed[0].fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(res.refused).toEqual(["u9"]);
    expect(srv.posted).toEqual([{ vaultId: "v1", userId: "u2", header: toBase64(ownerKeys.vks.get("v1")!) }]);
    expect(srv.vaults.get("v1")!.wraps.has("u9")).toBe(false);

    srv.as("u2");
    expect(await member.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
    expect(memberKeys.vks.get("v1")).toEqual(ownerKeys.vks.get("v1"));
  });

  it("refuses a key that does not open vk_check", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const pair = generateAccountKeypair();
    await keys.setAccountPrivateKey(pair.privateKey);
    const real = generateVaultKey();
    const wrong = generateVaultKey();
    // The server's check is for `real`, but the wrap (and the keychain) hold `wrong`.
    srv.vaults.set("v1", {
      vkCheck: toBase64(await makeVkCheck(real, "v1", 1)),
      generation: 1,
      wraps: new Map([["u1", toBase64(sealVkTo(pair.publicKey, wrong))]]),
    });
    await keys.setVaultKey("v1", wrong);
    const s = session({ api: srv.api, keys });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "key-mismatch" });
    expect(s.headerFor("v1")).toBeNull();
    // Never "repaired" by writing the wrong key back.
    expect(keys.setVaultKey).toHaveBeenCalledTimes(1);
    expect(openSealedVk(pair.privateKey, fromBase64(srv.vaults.get("v1")!.wraps.get("u1")!))).toEqual(wrong);
  });

  it("refuses to seal when a member's pinned key changed", async () => {
    const srv = fakeServer();
    const pins = memPins();
    const owner = session({ api: srv.api, keys: fakeKeys(), pins });
    await owner.ensureAccountKeys();
    await owner.ensureVaultKey("v1");
    const first = generateAccountKeypair();
    srv.requests.set("v1", [{ userId: "u2", publicKey: toBase64(first.publicKey), requestedAt: "" }]);
    expect((await owner.serviceKeyRequests("v1")).sealed).toHaveLength(1);
    // The server now offers a different key for the same person.
    const swapped = generateAccountKeypair();
    srv.requests.set("v1", [{ userId: "u2", publicKey: toBase64(swapped.publicKey), requestedAt: "" }]);
    const res = await owner.serviceKeyRequests("v1");
    expect(res.sealed).toEqual([]);
    expect(res.keyChanged).toEqual([
      { userId: "u2", fingerprint: shortFingerprint(swapped.publicKey), publicKey: toBase64(swapped.publicKey) },
    ]);
    expect(srv.api.postVaultKeyWrap).toHaveBeenCalledTimes(1);
  });

  it("refuses keys when the server's account key is not this device's", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys });
    await s.ensureAccountKeys();
    srv.setMe({ publicKey: toBase64(generateAccountKeypair().publicKey), privWrappedRecovery: "AA==" });
    expect(await s.ensureAccountKeys()).toEqual({ state: "security-warning" });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "security-warning" });
    expect(srv.api.getMyVaultKeys).not.toHaveBeenCalled();
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
  });

  it("never auto-keys on an uncertain answer, nor over a key this device holds", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    await keys.setAccountPrivateKey(generateAccountKeypair().privateKey);
    const s = session({ api: srv.api, keys });
    srv.api.getMyVaultKeys.mockRejectedValueOnce(new ApiError(503, "down"));
    await expect(s.ensureVaultKey("v1")).rejects.toThrow();
    srv.api.getMyVaultKeys.mockRejectedValueOnce(new Error("timeout"));
    await expect(s.ensureVaultKey("v1")).rejects.toThrow();
    const held = generateVaultKey();
    keys.vks.set("v1", held);
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "unkeyed" });
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
    expect(keys.vks.get("v1")).toBe(held);
  });

  it("stores nothing when init is refused as already keyed", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    await keys.setAccountPrivateKey(generateAccountKeypair().privateKey);
    const s = session({ api: srv.api, keys });
    srv.api.getMyVaultKeys.mockRejectedValueOnce(new ApiError(404, "not keyed"));
    srv.api.initVaultKeys.mockResolvedValueOnce("already-keyed");
    // Then the real answer: keyed, no wrap for us yet.
    srv.vaults.set("v1", { vkCheck: toBase64(await makeVkCheck(generateVaultKey(), "v1", 1)), generation: 1, wraps: new Map() });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "waiting-for-teammate" });
    expect(keys.setVaultKey).not.toHaveBeenCalled();
  });

  it("links a new device only after another device approves its code", async () => {
    const srv = fakeServer();
    const oldKeys = fakeKeys();
    const old = session({ api: srv.api, keys: oldKeys, deviceId: () => "d-old" });
    await old.ensureAccountKeys();

    const newKeys = fakeKeys();
    const fresh = session({ api: srv.api, keys: newKeys, deviceId: () => "d-new" });
    const waiting = await fresh.ensureAccountKeys();
    if (waiting.state !== "awaiting-device-approval") throw new Error("expected pending");
    expect(waiting.code).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
    // A logged-in session alone yields nothing: still pending on retry.
    expect(await fresh.ensureAccountKeys()).toEqual(waiting);
    expect(newKeys.setAccountPrivateKey).not.toHaveBeenCalled();

    const pending = await old.pendingDevices();
    expect(pending.map((d) => [d.deviceId, d.code])).toEqual([["d-new", waiting.code]]);
    expect(await old.approveDevice(pending[0])).toBe(true);

    expect(await fresh.ensureAccountKeys()).toEqual({ state: "ready", isNew: false });
    expect(await newKeys.getAccountPrivateKey()).toEqual(await oldKeys.getAccountPrivateKey());
    expect(await newKeys.getDeviceLinkKey()).toBeNull();
  });

  it("never adopts a device approval that is not the account key", async () => {
    const srv = fakeServer();
    const old = session({ api: srv.api, keys: fakeKeys(), deviceId: () => "d-old" });
    await old.ensureAccountKeys();
    const newKeys = fakeKeys();
    const fresh = session({ api: srv.api, keys: newKeys, deviceId: () => "d-new" });
    await fresh.ensureAccountKeys();
    // A server-forged approval: some other key sealed to the new device.
    const link = (await newKeys.getDeviceLinkKey())!;
    srv.deviceKeys.set("d-new", toBase64(sealTo(generateAccountKeypairPub(link), generateAccountKeypair().privateKey)));
    expect((await fresh.ensureAccountKeys()).state).toBe("awaiting-device-approval");
    expect(newKeys.setAccountPrivateKey).not.toHaveBeenCalled();
  });

  it("an approval with a mismatched code is refused, deny removes the request", async () => {
    const srv = fakeServer();
    const old = session({ api: srv.api, keys: fakeKeys(), deviceId: () => "d-old" });
    await old.ensureAccountKeys();
    const fresh = session({ api: srv.api, keys: fakeKeys(), deviceId: () => "d-new" });
    await fresh.ensureAccountKeys();
    const [d] = await old.pendingDevices();
    expect(await old.approveDevice({ ...d, code: "0000 0000" })).toBe(false);
    expect(srv.api.putDeviceKey).not.toHaveBeenCalled();
    await old.denyDevice(d.deviceId);
    expect(await old.pendingDevices()).toEqual([]);
  });

  it("lost every device: a fresh account key, and a teammate approves the changed key by code", async () => {
    const srv = fakeServer();
    const pins = memPins();
    const owner = session({ api: srv.api, keys: fakeKeys(), pins, isMember: async () => true });
    await owner.ensureAccountKeys();
    await owner.ensureVaultKey("v1");
    const first = generateAccountKeypair();
    srv.requests.set("v1", [{ userId: "u2", publicKey: toBase64(first.publicKey), requestedAt: "" }]);
    await owner.serviceKeyRequests("v1");

    // u2 lost every device and starts over (explicit choice, no local key).
    srv.as("u2");
    srv.setMe({ publicKey: toBase64(first.publicKey) });
    const keys = fakeKeys();
    const member = session({ api: srv.api, keys, selfUserId: () => "u2", keysAllowed: () => false });
    expect(await member.startFreshAccountKey()).toBe(true);
    expect(await member.startFreshAccountKey()).toBe(false); // never replaces a held key
    const freshPub = fromBase64((await srv.api.getMyKeys())!.publicKey);

    srv.as("u1");
    srv.requests.set("v1", [{ userId: "u2", publicKey: toBase64(freshPub), requestedAt: "" }]);
    const res = await owner.serviceKeyRequests("v1");
    expect(res.sealed).toEqual([]);
    const change = res.keyChanged[0];
    expect(await owner.approveChangedKey("v1", { ...change, fingerprint: "0000 0000 0000 0000" })).toBe(false);
    expect(await owner.approveChangedKey("v1", change)).toBe(true);
    expect(pins.m.get("u2")).toBe(keyFingerprint(freshPub));

    srv.as("u2");
    expect((await member.ensureVaultKey("v1")).state).toBe("ready");
  });

  it("sign-out clears every verified key", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys });
    await s.ensureAccountKeys();
    await s.ensureVaultKey("v1");
    expect(s.headerFor("v1")).not.toBeNull();
    resetVaultKeySessions();
    expect(s.headerFor("v1")).toBeNull();
    expect(keys.clearCache).toHaveBeenCalled();
    s.dispose();
  });
});
