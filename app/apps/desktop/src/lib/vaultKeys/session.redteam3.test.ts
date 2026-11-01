// Red team round 3 (desktop as the target): a malicious or compromised server,
// or a database writer, feeding the key session crafted lists. The desktop must
// stay bounded, never seal the vault key on ambiguity, and never hand the
// account key to a device the person did not start.
import { describe, expect, it, vi } from "vitest";
import type { AccountKeysBody, MyVaultKeys, VaultKeyInit } from "../api";
import { deviceCode, generateAccountKeypair, toBase64 } from "./crypto";
import {
  createVaultKeySession,
  MAX_KEY_REQUESTS_PER_RUN,
  MAX_PENDING_DEVICES,
  type VaultKeySessionDeps,
} from "./session";

function harness() {
  let me: AccountKeysBody | null = null;
  const vaults = new Map<string, { vkCheck: string; generation: number; wrap: string }>();
  let requests: unknown = [];
  let devices: unknown = [];
  const api = {
    initVaultKeys: vi.fn(async (vaultId: string, b: VaultKeyInit) => {
      if (vaults.has(vaultId)) return "already-keyed" as const;
      vaults.set(vaultId, { vkCheck: b.vkCheck, generation: b.generation, wrap: b.sealedVkForSelf });
      return "created" as const;
    }),
    getMyVaultKeys: vi.fn(async (vaultId: string): Promise<MyVaultKeys> => {
      const v = vaults.get(vaultId);
      if (!v) return { keyed: false, pending: false, conversionAllowed: false, encryptionRequested: false };
      return { keyed: true, pending: false, vkCheck: v.vkCheck, generation: v.generation, wraps: [{ generation: v.generation, sealedVk: v.wrap }] };
    }),
    listVaultKeyRequests: vi.fn(async () => requests),
    postVaultKeyWrap: vi.fn(async (_v: string, _w: { userId: string }, _k?: string) => {}),
    putMyKeys: vi.fn(async (b: AccountKeysBody) => void (me = b)),
    getMyKeys: vi.fn(async () => me),
    registerPendingDevice: vi.fn(async () => {}),
    listPendingDevices: vi.fn(async () => devices),
    getDeviceKey: vi.fn(async () => null),
    putDeviceKey: vi.fn(async () => {}),
    denyDevice: vi.fn(async () => {}),
    registerPendingVaultKey: vi.fn(async () => "registered" as const),
    getAllowlistCandidates: vi.fn(async () => []),
    postAllowlist: vi.fn(async () => ({ rejected: [] as string[] })),
    getConversionReady: vi.fn(async () => false),
  };
  let account: Uint8Array | null = null;
  const vks = new Map<string, Uint8Array>();
  const keys = {
    getDeviceLinkKey: vi.fn(async () => null),
    setDeviceLinkKey: vi.fn(async () => {}),
    deleteDeviceLinkKey: vi.fn(async () => {}),
    getAccountPrivateKey: vi.fn(async () => account),
    setAccountPrivateKey: vi.fn(async (k: Uint8Array) => void (account = k)),
    getVaultKey: vi.fn(async (id: string) => vks.get(id) ?? null),
    setVaultKey: vi.fn(async (id: string, vk: Uint8Array) => void vks.set(id, vk)),
    isVaultKeyProvisional: vi.fn(async () => false),
    setVaultKeyProvisional: vi.fn(async () => {}),
    clearCache: vi.fn(),
  };
  const pins = new Map<string, string>();
  const isMember = vi.fn(async (_vaultId: string, _userId: string) => true);
  const deps: VaultKeySessionDeps = {
    api: api as unknown as VaultKeySessionDeps["api"],
    keys,
    pins: { get: async (u) => pins.get(u) ?? null, set: async (u, f) => void pins.set(u, f) },
    features: async () => new Set(["vault-keys"]),
    keysAllowed: () => true,
    isMember,
    selfUserId: () => "u1",
    deviceId: () => "d-mine",
  };
  const session = createVaultKeySession(deps);
  return {
    api,
    isMember,
    pins,
    session,
    setRequests: (r: unknown) => void (requests = r),
    setDevices: (d: unknown) => void (devices = d),
    async ready() {
      await session.ensureAccountKeys();
      expect((await session.ensureVaultKey("v1")).state).toBe("ready");
    },
  };
}

const pub = () => toBase64(generateAccountKeypair().publicKey);

describe("red team 3: crafted key requests from the server", () => {
  it("thousands of requests: bounded wraps and member checks per run, no throw", async () => {
    const h = harness();
    await h.ready();
    h.setRequests(Array.from({ length: 5000 }, (_, i) => ({ userId: `u${i + 10}`, publicKey: pub() })));
    const out = await h.session.serviceKeyRequests("v1");
    expect(h.api.postVaultKeyWrap.mock.calls.length).toBeLessThanOrEqual(MAX_KEY_REQUESTS_PER_RUN);
    expect(h.isMember.mock.calls.length).toBeLessThanOrEqual(MAX_KEY_REQUESTS_PER_RUN);
    expect(out.sealed.length + out.refused.length).toBeLessThanOrEqual(MAX_KEY_REQUESTS_PER_RUN);
  });

  it("junk listed ahead of a real teammate cannot starve them: reached within two runs", async () => {
    const h = harness();
    await h.ready();
    h.isMember.mockImplementation(async (_v: string, u: string) => u === "u-real");
    h.setRequests([
      ...Array.from({ length: MAX_KEY_REQUESTS_PER_RUN + 10 }, (_, i) => ({ userId: `fake${i}`, publicKey: pub() })),
      { userId: "u-real", publicKey: pub() },
    ]);
    const first = await h.session.serviceKeyRequests("v1");
    const second = await h.session.serviceKeyRequests("v1");
    expect([...first.sealed, ...second.sealed].map((s) => s.userId)).toEqual(["u-real"]);
  });

  it("junk devices listed ahead of the person's real computer: it is offered by the second listing", async () => {
    const h = harness();
    await h.session.ensureAccountKeys();
    h.setDevices([
      ...Array.from({ length: MAX_PENDING_DEVICES * 2 }, (_, i) => ({ deviceId: `junk${i}`, publicKey: pub() })),
      { deviceId: "d-real", publicKey: pub() },
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) for (const d of await h.session.pendingDevices()) seen.add(d.deviceId);
    expect(seen.has("d-real")).toBe(true);
  });

  it("a person removed mid-run (server: not_member) is skipped; the rest are still sealed", async () => {
    const h = harness();
    await h.ready();
    h.setRequests([
      { userId: "u-gone", publicKey: pub() },
      { userId: "u-a", publicKey: pub() },
      { userId: "u-b", publicKey: pub() },
    ]);
    h.api.postVaultKeyWrap.mockImplementation(async (_v: string, w: { userId: string }) => {
      if (w.userId === "u-gone") {
        throw Object.assign(new Error("That person isn't a member of this vault"), { status: 404, body: { code: "not_member" } });
      }
    });
    const out = await h.session.serviceKeyRequests("v1");
    expect(out.sealed.map((s) => s.userId)).toEqual(["u-a", "u-b"]);
    expect(out.refused).toEqual(["u-gone"]);
    // Any other failure still stops the run (nothing silently swallowed).
    h.api.postVaultKeyWrap.mockImplementation(async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    h.setRequests([{ userId: "u-c", publicKey: pub() }]);
    await expect(h.session.serviceKeyRequests("v1")).rejects.toThrow("boom");
  });

  it("one person listed thousands of times with one key: sealed once, checked once", async () => {
    const h = harness();
    await h.ready();
    const k = pub();
    h.setRequests(Array.from({ length: 3000 }, () => ({ userId: "u2", publicKey: k })));
    const out = await h.session.serviceKeyRequests("v1");
    expect(out.sealed.map((s) => s.userId)).toEqual(["u2"]);
    expect(h.api.postVaultKeyWrap).toHaveBeenCalledTimes(1);
    expect(h.isMember).toHaveBeenCalledTimes(1);
  });

  it("one person listed with two different keys (unpinned): refused, nothing sealed, nothing pinned", async () => {
    const h = harness();
    await h.ready();
    h.setRequests([
      { userId: "u2", publicKey: pub() }, // the attacker's, first
      { userId: "u2", publicKey: pub() }, // the real one
    ]);
    const out = await h.session.serviceKeyRequests("v1");
    expect(out.refused).toEqual(["u2"]);
    expect(out.sealed).toEqual([]);
    expect(h.api.postVaultKeyWrap).not.toHaveBeenCalled();
    expect(h.pins.has("u2")).toBe(false);
  });

  it("malformed listings (object, null, junk rows) seal nothing and never throw", async () => {
    const h = harness();
    await h.ready();
    for (const junk of [{}, null, "x", 42, [null, 5, "u", { userId: 7, publicKey: [] }, { userId: "u3" }]]) {
      h.setRequests(junk);
      const out = await h.session.serviceKeyRequests("v1");
      expect(out.sealed).toEqual([]);
    }
    expect(h.api.postVaultKeyWrap).not.toHaveBeenCalled();
  });
});

describe("red team 3: device approval phishing", () => {
  it("a device the person never started cannot be approved by clicking: the code must be typed", async () => {
    const h = harness();
    await h.session.ensureAccountKeys();
    // A database writer adds a pending device for this account with its own key.
    const attacker = generateAccountKeypair().publicKey;
    h.setDevices([{ deviceId: "d-evil", publicKey: toBase64(attacker) }]);
    const [d] = await h.session.pendingDevices();
    expect(d.deviceId).toBe("d-evil");
    // Clicking Approve with nothing typed, or a guess, hands over nothing.
    for (const typed of ["", "        ", "0000 0000", "abcd", undefined as unknown as string]) {
      expect(await h.session.approveDevice(d, typed)).toBe(false);
    }
    expect(h.api.putDeviceKey).not.toHaveBeenCalled();
    // Only the code the new computer itself shows works (case/space-insensitive).
    expect(await h.session.approveDevice(d, deviceCode(attacker).replace(" ", "").toUpperCase())).toBe(true);
    expect(h.api.putDeviceKey).toHaveBeenCalledTimes(1);
  });

  it("a flood of pending devices raises a bounded number of prompts; junk is ignored", async () => {
    const h = harness();
    await h.session.ensureAccountKeys();
    h.setDevices([
      ...Array.from({ length: 1000 }, (_, i) => ({ deviceId: `d${i}`, publicKey: pub() })),
    ]);
    expect((await h.session.pendingDevices()).length).toBe(MAX_PENDING_DEVICES);
    h.setDevices({ not: "a list" });
    expect(await h.session.pendingDevices()).toEqual([]);
    h.setDevices([null, 3, { deviceId: "x" }, { deviceId: "d-mine", publicKey: pub() }]);
    expect(await h.session.pendingDevices()).toEqual([]);
  });
});
