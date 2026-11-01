import { describe, expect, it, vi } from "vitest";
import { ApiError, type AccountKeysBody, type MyVaultKeys, type VaultKeyInit, type VaultKeyRequest } from "../api";
import {
  fromBase64,
  generateAccountKeypair,
  generateVaultKey,
  makeVkCheck,
  openSealedVk,
  allowlistMac,
  keyFingerprint,
  sealTo,
  sealVkTo,
  shortFingerprint,
  toBase64,
  vaultKeyToWords,
} from "./crypto";
import { publicKeyFromPrivate as generateAccountKeypairPub } from "./crypto";
import { createVaultKeySession, resetVaultKeySessions, type VaultKeySessionDeps } from "./session";
import { forgetVaultKeyMaterial } from "./forget";

/** A fake server that holds only what the real one would: blobs, never keys. */
type InitAnswer = "created" | "already-keyed" | "not-ready" | "pending-mismatch";

function fakeServer() {
  let me: AccountKeysBody | null = null;
  const vaults = new Map<string, { vkCheck: string; generation: number; wraps: Map<string, string> }>();
  const requests = new Map<string, VaultKeyRequest[]>();
  const posted: { vaultId: string; userId: string; header: string }[] = [];
  let pendingDevices: { deviceId: string; publicKey: string }[] = [];
  const conv = {
    allowed: false,
    ready: false,
    claims: new Map<string, { vkCheck: string; deviceId: string }>(),
    candidates: [] as { kind: string; id: string; hash: string }[],
    allowlists: [] as { vaultId: string; entries: { kind: string; id: string; mac: string }[]; header: string }[],
    readyPolls: [] as string[],
  };
  const deviceKeys = new Map<string, string>();
  let caller = "u1";
  const api = {
    initVaultKeys: vi.fn(async (vaultId: string, b: VaultKeyInit): Promise<InitAnswer> => {
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
      if (!v) return { keyed: false, pending: false, conversionAllowed: conv.allowed, encryptionRequested: conv.allowed };
      const w = v.wraps.get(caller);
      if (!w) return { keyed: true, pending: true };
      return {
        keyed: true,
        pending: false,
        vkCheck: v.vkCheck,
        generation: v.generation,
        wraps: [{ generation: v.generation, sealedVk: w }],
      };
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
    registerPendingVaultKey: vi.fn(
      async (vaultId: string, b: { vkCheck: string; generation: number; deviceId: string }, _vk: string) => {
        const have = conv.claims.get(vaultId);
        // Idempotent for the same check; any other check is a second claimer.
        if (have && have.vkCheck !== b.vkCheck) return "claimed" as const;
        conv.claims.set(vaultId, { vkCheck: b.vkCheck, deviceId: b.deviceId });
        return "registered" as const;
      },
    ),
    getAllowlistCandidates: vi.fn(async () => conv.candidates.slice()),
    postAllowlist: vi.fn(async (vaultId: string, entries: { kind: string; id: string; mac: string }[], header: string) => {
      conv.allowlists.push({ vaultId, entries, header });
      return { rejected: [] as string[] };
    }),
    getConversionReady: vi.fn(async (_vaultId: string, header: string) => {
      conv.readyPolls.push(header);
      return conv.ready;
    }),
  };
  return {
    api,
    vaults,
    conv,
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
  const provisional = new Set<string>();
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
    deleteVaultKey: vi.fn(async (id: string) => void vks.delete(id)),
    provisional,
    isVaultKeyProvisional: vi.fn(async (id: string) => provisional.has(id)),
    setVaultKeyProvisional: vi.fn(async (id: string, on: boolean) => void (on ? provisional.add(id) : provisional.delete(id))),
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
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "unkeyed", conversionAllowed: false, encryptionRequested: false });
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
      keyed: true,
      pending: true,
      vkCheck: srv.vaults.get("v1")!.vkCheck,
      generation: 1,
    });
    expect(await member.restoreWithVaultKey("v1", words)).toBe("restored");
    expect(srv.posted.map((p) => p.userId)).toEqual(["u2"]);
    expect(await member.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
  });

  it("seals a `missing` member (no request filed) exactly like a request, and reports it as sealed", async () => {
    const srv = fakeServer();
    const ownerKeys = fakeKeys();
    const owner = session({ api: srv.api, keys: ownerKeys, isMember: async (_v, userId) => userId === "u2" });
    await owner.ensureAccountKeys();
    await owner.ensureVaultKey("v1");
    const memberPair = generateAccountKeypair();
    srv.requests.set("v1", [
      { userId: "u2", publicKey: toBase64(memberPair.publicKey), requestedAt: "", keyChangedAt: null, kind: "missing" },
    ]);
    const res = await owner.serviceKeyRequests("v1");
    expect(res.sealed).toEqual([{ userId: "u2", fingerprint: shortFingerprint(memberPair.publicKey) }]);
    expect(srv.vaults.get("v1")!.wraps.has("u2")).toBe(true);
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
    srv.api.getMyVaultKeys.mockRejectedValueOnce(new ApiError(404, "Unknown vault"));
    await expect(s.ensureVaultKey("v1")).rejects.toThrow();
    srv.api.getMyVaultKeys.mockRejectedValueOnce(new ApiError(503, "down"));
    await expect(s.ensureVaultKey("v1")).rejects.toThrow();
    srv.api.getMyVaultKeys.mockRejectedValueOnce(new Error("timeout"));
    await expect(s.ensureVaultKey("v1")).rejects.toThrow();
    const held = generateVaultKey();
    keys.vks.set("v1", held);
    // A confirmed held key + a server that says "unkeyed" is a wiped vk_check
    // until proven otherwise: refused (never synced as plaintext), key kept.
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "key-mismatch" });
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
    expect(keys.vks.get("v1")).toBe(held);
  });

  it("stores nothing when init is refused as already keyed", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    await keys.setAccountPrivateKey(generateAccountKeypair().privateKey);
    const s = session({ api: srv.api, keys });
    srv.api.getMyVaultKeys.mockResolvedValueOnce({ keyed: false, pending: false, conversionAllowed: false, encryptionRequested: false });
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
    expect(await old.approveDevice(pending[0], waiting.code.toUpperCase())).toBe(true);

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
    expect(await old.approveDevice(d, "0000 0000")).toBe(false);
    expect(srv.api.putDeviceKey).not.toHaveBeenCalled();
    await old.denyDevice(d.deviceId);
    expect(await old.pendingDevices()).toEqual([]);
  });

  it("lost every device from the approval wait: awaiting → fresh key → ready, vault keys untouched", async () => {
    const srv = fakeServer();
    srv.as("u2");
    srv.setMe({ publicKey: toBase64(generateAccountKeypair().publicKey) }); // the lost devices' key
    const keys = fakeKeys();
    keys.vks.set("v9", generateVaultKey()); // a vault key held here must survive
    const heldBefore = keys.vks.get("v9");
    const member = session({ api: srv.api, keys, selfUserId: () => "u2", keysAllowed: () => false });

    const waiting = await member.ensureAccountKeys();
    expect(waiting.state).toBe("awaiting-device-approval");
    expect(await member.accountKeyCode()).toBeNull();

    expect(await member.startFreshAccountKey()).toBe(true);
    const code = await member.accountKeyCode();
    const published = fromBase64((await srv.api.getMyKeys())!.publicKey);
    // The code the person shares is exactly what teammates' "key changed" shows.
    expect(code).toBe(shortFingerprint(published));
    expect(await keys.getDeviceLinkKey()).toBeNull();
    expect(await member.ensureAccountKeys()).toEqual({ state: "ready", isNew: false });
    expect(keys.vks.get("v9")).toBe(heldBefore);
    expect(keys.deleteVaultKey).not.toHaveBeenCalled();
    expect(keys.setVaultKey).not.toHaveBeenCalled();
  });

  it("a refused fresh key (429 rate_limited) stores nothing locally", async () => {
    const srv = fakeServer();
    srv.as("u2");
    const old = toBase64(generateAccountKeypair().publicKey);
    srv.setMe({ publicKey: old });
    srv.api.putMyKeys.mockRejectedValueOnce(
      new ApiError(429, "x", { error: "Try again in about 20 hours.", code: "rate_limited", retryAfter: 72000 }),
    );
    const keys = fakeKeys();
    const member = session({ api: srv.api, keys, selfUserId: () => "u2", keysAllowed: () => false });
    await member.ensureAccountKeys();
    await expect(member.startFreshAccountKey()).rejects.toBeInstanceOf(ApiError);
    expect(await keys.getAccountPrivateKey()).toBeNull();
    expect(await member.accountKeyCode()).toBeNull();
    expect((await srv.api.getMyKeys())!.publicKey).toBe(old);
    expect((await member.ensureAccountKeys()).state).toBe("awaiting-device-approval");
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

describe("converting an existing vault", () => {
  async function ownerSetup(over: Partial<VaultKeySessionDeps> = {}) {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys, keysAllowed: () => false, canConvert: async () => true, ...over });
    await s.ensureAccountKeys();
    return { srv, keys, s };
  }

  it("gate false (or no gate) does nothing at all", async () => {
    const { srv, keys, s } = await ownerSetup();
    srv.conv.allowed = false;
    expect(await s.convertVault("v1")).toBe("not-allowed");
    expect(keys.setVaultKey).not.toHaveBeenCalled();
    expect(srv.api.registerPendingVaultKey).not.toHaveBeenCalled();
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "unkeyed", conversionAllowed: false, encryptionRequested: false });
  });

  it("a member (not owner/admin) never converts", async () => {
    const { srv, keys, s } = await ownerSetup({ canConvert: async () => false });
    srv.conv.allowed = true;
    expect(await s.convertVault("v1")).toBe("not-allowed");
    expect(keys.setVaultKey).not.toHaveBeenCalled();
  });

  it("stores the key first, claims, allowlists, waits for ready, then inits", async () => {
    const { srv, keys, s } = await ownerSetup();
    srv.conv.allowed = true;
    srv.conv.candidates = [{ kind: "mcp_token", id: "t1", hash: "abc" }];
    expect(await s.convertVault("v1")).toBe("waiting-ready");
    const vk = keys.vks.get("v1")!;
    expect(vk).toBeDefined();
    // The keychain write happened before the first server call.
    expect(keys.setVaultKey.mock.invocationCallOrder[0]).toBeLessThan(
      srv.api.registerPendingVaultKey.mock.invocationCallOrder[0],
    );
    expect(srv.conv.allowlists[0].entries).toEqual([
      { kind: "mcp_token", id: "t1", mac: toBase64(allowlistMac(vk, "t1", "abc")) },
    ]);
    expect(srv.conv.allowlists[0].header).toBe(toBase64(vk));
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();

    srv.conv.ready = true;
    expect(await s.convertVault("v1")).toBe("converted");
    expect(keys.vks.get("v1")).toBe(vk); // same key throughout
    expect(srv.api.initVaultKeys).toHaveBeenCalledTimes(1);
    expect(srv.vaults.get("v1")!.vkCheck).toBe(srv.conv.claims.get("v1")!.vkCheck);
    expect(s.headerFor("v1")).toBe(toBase64(vk));
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
  });

  it("owner review: nothing is allow-listed or converted until the owner answers", async () => {
    const { srv, s } = await ownerSetup({ reviewConnections: true });
    srv.conv.allowed = true;
    srv.conv.ready = true; // even a ready gate waits for the review
    srv.conv.candidates = [
      { kind: "mcp_token", id: "t1", hash: "h1", label: "Claude", lastUsedAt: new Date().toISOString() },
      { kind: "public_link", id: "l1", hash: "h2", label: "a.md" },
    ] as never;
    expect(await s.convertVault("v1")).toBe("needs-review");
    expect(srv.api.postAllowlist).not.toHaveBeenCalled();
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
    expect(s.pendingConversionReview("v1")?.map((c) => c.id)).toEqual(["t1", "l1"]);
    // Asking again without an answer changes nothing.
    expect(await s.convertVault("v1")).toBe("needs-review");
    expect(srv.api.postAllowlist).not.toHaveBeenCalled();
  });

  it("owner review: checked ones get MACs, unchecked ones are sent as excluded, then conversion proceeds", async () => {
    const { srv, keys, s } = await ownerSetup({ reviewConnections: true });
    srv.conv.allowed = true;
    srv.conv.candidates = [
      { kind: "mcp_token", id: "t1", hash: "h1" },
      { kind: "oauth_grant", id: "g1", hash: "h2" },
    ] as never;
    expect(await s.convertVault("v1")).toBe("needs-review");
    s.submitConversionReview("v1", new Set(["mcp_token:t1"]));
    expect(s.pendingConversionReview("v1")).toBeNull();
    expect(await s.convertVault("v1")).toBe("waiting-ready");
    const vk = keys.vks.get("v1")!;
    const call = srv.api.postAllowlist.mock.calls[0] as unknown[];
    expect(call[1]).toEqual([{ kind: "mcp_token", id: "t1", mac: toBase64(allowlistMac(vk, "t1", "h1")) }]);
    expect(call[3]).toEqual([{ kind: "oauth_grant", id: "g1" }]);

    // The server now records the exclusion: it is not re-sent, and a token
    // minted while pending is a NEW undecided one that needs its own review.
    srv.conv.candidates = [
      { kind: "mcp_token", id: "t1", hash: "h1", allowed: true },
      { kind: "oauth_grant", id: "g1", hash: "h2", excluded: true },
      { kind: "mcp_token", id: "t2", hash: "h3" },
    ] as never;
    expect(await s.convertVault("v1")).toBe("needs-review");
    expect(s.pendingConversionReview("v1")?.map((c) => c.id)).toEqual(["t2"]);
    s.submitConversionReview("v1", new Set(["mcp_token:t2"]));
    srv.conv.ready = true;
    expect(await s.convertVault("v1")).toBe("converted");
    const calls = srv.api.postAllowlist.mock.calls;
    const last = calls[calls.length - 1] as unknown[];
    expect((last[1] as { id: string }[]).map((e) => e.id).sort()).toEqual(["t1", "t2"]);
    expect(last[3]).toEqual([]);
  });

  it("an earlier review on another device (server says allowed/excluded) is not asked again", async () => {
    const { srv, s } = await ownerSetup({ reviewConnections: true });
    srv.conv.allowed = true;
    srv.conv.ready = true;
    srv.conv.candidates = [
      { kind: "mcp_token", id: "t1", hash: "h1", allowed: true },
      { kind: "public_link", id: "l1", hash: "h2", excluded: true },
    ] as never;
    expect(await s.convertVault("v1")).toBe("converted");
    expect(s.pendingConversionReview("v1")).toBeNull();
  });

  it("a crash between steps resumes with the same key and the same check", async () => {
    const { srv, keys } = await ownerSetup();
    srv.conv.allowed = true;
    const first = session({ api: srv.api, keys, keysAllowed: () => false, canConvert: async () => true });
    await first.ensureAccountKeys();
    srv.api.getAllowlistCandidates.mockRejectedValueOnce(new Error("crash"));
    await expect(first.convertVault("v1")).rejects.toThrow();
    const vk = keys.vks.get("v1")!;
    const claimed = srv.conv.claims.get("v1")!.vkCheck;

    // App restarts: a fresh session, the keychain survived.
    const again = session({ api: srv.api, keys, keysAllowed: () => false, canConvert: async () => true });
    await again.ensureAccountKeys();
    srv.conv.ready = true;
    expect(await again.convertVault("v1")).toBe("converted");
    expect(keys.vks.get("v1")).toBe(vk);
    expect(srv.conv.claims.get("v1")!.vkCheck).toBe(claimed);
    expect(keys.setVaultKey).toHaveBeenCalledTimes(1);
  });

  it("init that already landed (lost answer) still converges on our key", async () => {
    const { srv, keys, s } = await ownerSetup();
    srv.conv.allowed = true;
    srv.conv.ready = true;
    srv.api.initVaultKeys.mockImplementationOnce(async (vaultId: string, b: VaultKeyInit) => {
      srv.vaults.set(vaultId, { vkCheck: b.vkCheck, generation: b.generation, wraps: new Map([["u1", b.sealedVkForSelf]]) });
      throw new Error("connection reset");
    });
    await expect(s.convertVault("v1")).rejects.toThrow();
    const vk = keys.vks.get("v1")!;
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
    expect(keys.vks.get("v1")).toBe(vk);
  });

  it("init refused as not ready keeps waiting; a pending mismatch adopts nothing", async () => {
    const { srv, keys, s } = await ownerSetup();
    srv.conv.allowed = true;
    srv.conv.ready = true;
    srv.api.initVaultKeys.mockResolvedValueOnce("not-ready");
    expect(await s.convertVault("v1")).toBe("waiting-ready");
    srv.api.initVaultKeys.mockResolvedValueOnce("pending-mismatch");
    expect(await s.convertVault("v1")).toBe("claimed-elsewhere");
    expect(s.headerFor("v1")).toBeNull();
    expect(keys.setVaultKey).toHaveBeenCalledTimes(1); // the one key, kept
    // Every conversion call carried the key.
    for (const call of srv.api.registerPendingVaultKey.mock.calls) expect(call[2]).toBe(toBase64(keys.vks.get("v1")!));
  });

  it("another device holds the claim (409): adopt nothing, never init", async () => {
    const { srv, keys, s } = await ownerSetup();
    srv.conv.allowed = true;
    srv.conv.claims.set("v1", { vkCheck: "someone-else", deviceId: "d9" });
    expect(await s.convertVault("v1")).toBe("claimed-elsewhere");
    expect(srv.api.postAllowlist).not.toHaveBeenCalled();
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
    expect(s.headerFor("v1")).toBeNull();
    // Their key arrives later through keys/mine and replaces ours only after it verifies.
    const theirs = generateVaultKey();
    const pub = generateAccountKeypairPub((await keys.getAccountPrivateKey())!);
    srv.vaults.set("v1", {
      vkCheck: toBase64(await makeVkCheck(theirs, "v1", 1)),
      generation: 1,
      wraps: new Map([["u1", toBase64(sealVkTo(pub, theirs))]]),
    });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
    expect(keys.vks.get("v1")).toEqual(theirs);
  });
});

describe("first sync pass gate", () => {
  it("proceeds only on a known safe state; errors and missing keys pause", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys, keysAllowed: () => false });
    await s.ensureAccountKeys();
    expect(await s.gateVaultOpen("v1")).toBe("proceed"); // unkeyed

    srv.vaults.set("v1", { vkCheck: toBase64(await makeVkCheck(generateVaultKey(), "v1", 1)), generation: 1, wraps: new Map() });
    expect(await s.gateVaultOpen("v1")).toBe("paused"); // keyed, waiting for a teammate

    srv.api.getMyVaultKeys.mockRejectedValueOnce(new Error("timeout"));
    expect(await s.gateVaultOpen("v1")).toBe("paused"); // unknown

    const off = session({ api: srv.api, keys, features: async () => new Set() });
    expect(await off.gateVaultOpen("v1")).toBe("proceed"); // server without vault keys
  });
});

// A malicious operator with full database read/write but no vault key. Every
// server answer below is something they can make the real server return.
describe("database attacker (no vault key)", () => {
  async function keyedOwner() {
    const srv = fakeServer();
    const keys = fakeKeys();
    const pins = memPins();
    const s = session({ api: srv.api, keys, pins, keysAllowed: () => false });
    await s.ensureAccountKeys();
    // Keyed the normal way; this device holds the confirmed key.
    const real = generateVaultKey();
    const pub = generateAccountKeypairPub((await keys.getAccountPrivateKey())!);
    srv.vaults.set("v1", {
      vkCheck: toBase64(await makeVkCheck(real, "v1", 1)),
      generation: 1,
      wraps: new Map([["u1", toBase64(sealVkTo(pub, real))]]),
    });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
    expect(keys.vks.get("v1")).toEqual(real);
    keys.setVaultKey.mockClear();
    return { srv, keys, pins, s, real, pub };
  }

  it("vk_check wiped (server says unkeyed): refuses, never re-keys, never syncs as plaintext", async () => {
    const { srv, keys, s, real } = await keyedOwner();
    srv.vaults.delete("v1"); // keys/mine now answers keyed:false
    srv.conv.allowed = true; // even with the rollout gate and the opt-in on
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "key-mismatch" });
    expect(await s.gateVaultOpen("v1")).toBe("paused");
    expect(s.headerFor("v1")).toBeNull();
    expect(srv.api.initVaultKeys).not.toHaveBeenCalled();
    expect(keys.setVaultKey).not.toHaveBeenCalled();
    expect(keys.vks.get("v1")).toEqual(real);
  });

  it("vk_check swapped for the attacker's own key + a forged wrap: refused, real key kept", async () => {
    const { srv, keys, s, real, pub } = await keyedOwner();
    const theirs = generateVaultKey();
    // Anyone can seal to a public key, so the attacker forges our wrap too,
    // and bumps the generation so it is the one picked.
    srv.vaults.set("v1", {
      vkCheck: toBase64(await makeVkCheck(theirs, "v1", 2)),
      generation: 2,
      wraps: new Map([["u1", toBase64(sealVkTo(pub, theirs))]]),
    });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "key-mismatch" });
    expect(await s.gateVaultOpen("v1")).toBe("paused");
    expect(s.headerFor("v1")).toBeNull();
    expect(keys.setVaultKey).not.toHaveBeenCalled();
    expect(keys.vks.get("v1")).toEqual(real);
    // Nothing is sealed to anyone under the attacker's key either.
    srv.requests.set("v1", [{ userId: "u2", publicKey: toBase64(generateAccountKeypair().publicKey), requestedAt: "" }]);
    expect((await s.serviceKeyRequests("v1")).sealed).toEqual([]);
  });

  it("wrap deleted (server says pending) with a swapped check: refused, not 'waiting'", async () => {
    const { srv, keys, s, real } = await keyedOwner();
    srv.vaults.set("v1", { vkCheck: toBase64(await makeVkCheck(generateVaultKey(), "v1", 1)), generation: 1, wraps: new Map() });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "key-mismatch" });
    expect(keys.vks.get("v1")).toEqual(real);
  });

  it("a member's public key replaced in the database: TOFU refuses, never seals", async () => {
    const { srv, s, pins } = await keyedOwner();
    const member = generateAccountKeypair();
    srv.requests.set("v1", [{ userId: "u2", publicKey: toBase64(member.publicKey), requestedAt: "" }]);
    expect((await s.serviceKeyRequests("v1")).sealed).toHaveLength(1);
    expect(pins.m.get("u2")).toBe(keyFingerprint(member.publicKey));
    srv.posted.length = 0;
    // The attacker deletes u2's wrap and re-queues the request with their own key.
    const attacker = generateAccountKeypair();
    srv.requests.set("v1", [{ userId: "u2", publicKey: toBase64(attacker.publicKey), requestedAt: "" }]);
    const res = await s.serviceKeyRequests("v1");
    expect(res.sealed).toEqual([]);
    expect(res.keyChanged.map((k) => k.userId)).toEqual(["u2"]);
    expect(srv.posted).toEqual([]);
  });

  it("RESIDUAL: a member row + key inserted before any seal is sealed to (first use), and surfaced", async () => {
    // Membership is judged from server data (the members API), which the
    // attacker controls, and there is no pin yet: trust on first use seals.
    // The result names the person (the app shows "<name> was given access").
    // Documented residual; key transparency is the full fix.
    const { srv, s } = await keyedOwner();
    const fake = generateAccountKeypair();
    srv.requests.set("v1", [{ userId: "inserted", publicKey: toBase64(fake.publicKey), requestedAt: "" }]);
    const res = await s.serviceKeyRequests("v1");
    expect(res.sealed.map((x) => x.userId)).toEqual(["inserted"]);
  });

  it("a member check that says no never seals", async () => {
    const { srv, keys } = await keyedOwner();
    const s = session({ api: srv.api, keys, isMember: async () => false });
    await s.ensureVaultKey("v1");
    srv.requests.set("v1", [{ userId: "ghost", publicKey: toBase64(generateAccountKeypair().publicKey), requestedAt: "" }]);
    const res = await s.serviceKeyRequests("v1");
    expect(res.sealed).toEqual([]);
    expect(res.refused).toEqual(["ghost"]);
  });

  it("only a provisional (unconfirmed conversion) key may be replaced by a wrap", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys, keysAllowed: () => false, canConvert: async () => true });
    await s.ensureAccountKeys();
    srv.conv.allowed = true;
    srv.conv.claims.set("v1", { vkCheck: "someone-else", deviceId: "d9" });
    expect(await s.convertVault("v1")).toBe("claimed-elsewhere");
    expect(keys.provisional.has("v1")).toBe(true);
    // While still unkeyed a provisional key does not block (conversion in progress).
    expect(await s.gateVaultOpen("v1")).toBe("proceed");
    const theirs = generateVaultKey();
    const pub = generateAccountKeypairPub((await keys.getAccountPrivateKey())!);
    srv.vaults.set("v1", {
      vkCheck: toBase64(await makeVkCheck(theirs, "v1", 1)),
      generation: 1,
      wraps: new Map([["u1", toBase64(sealVkTo(pub, theirs))]]),
    });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
    expect(keys.provisional.has("v1")).toBe(false);
    // Now confirmed: a later swap is refused like any other.
    const evil = generateVaultKey();
    srv.vaults.set("v1", {
      vkCheck: toBase64(await makeVkCheck(evil, "v1", 1)),
      generation: 1,
      wraps: new Map([["u1", toBase64(sealVkTo(pub, evil))]]),
    });
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "key-mismatch" });
    expect(keys.vks.get("v1")).toEqual(theirs);
  });
});

describe("membership ended: forgetting a vault key", () => {
  it("drops the verified key and the keychain copy + marker; the account key and other vaults stay", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys });
    await s.ensureAccountKeys();
    await s.ensureVaultKey("v1");
    await s.ensureVaultKey("v2");
    keys.provisional.add("v1");
    const account = await keys.getAccountPrivateKey();

    s.forgetVerified("v1");
    expect(await forgetVaultKeyMaterial(keys, ["v1"])).toEqual(["v1"]);
    expect(s.headerFor("v1")).toBeNull();
    expect(keys.vks.has("v1")).toBe(false);
    expect(keys.provisional.has("v1")).toBe(false);
    expect(s.headerFor("v2")).not.toBeNull();
    expect(keys.vks.has("v2")).toBe(true);
    expect(await keys.getAccountPrivateKey()).toBe(account);

    // Re-invited later: the wrap on the server opens again (nothing lost).
    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
  });

  it("one keychain failure never stops the others", async () => {
    const keys = fakeKeys();
    keys.vks.set("a", new Uint8Array(32));
    keys.vks.set("b", new Uint8Array(32));
    keys.deleteVaultKey.mockRejectedValueOnce(new Error("keychain locked"));
    expect(await forgetVaultKeyMaterial(keys, ["a", "b"])).toEqual(["b"]);
    expect(keys.vks.has("a")).toBe(true);
  });
});
