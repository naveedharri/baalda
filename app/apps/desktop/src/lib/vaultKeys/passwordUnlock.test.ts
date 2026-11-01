// Seamless keys F: the password unlocks the account key. Session behaviour
// against a fake server, plus the wire shapes of the contract's endpoints.
import { describe, expect, it, vi } from "vitest";
import { ApiClient, type AccountKeysBody } from "../api";
import {
  fromBase64,
  generateAccountKeypair,
  publicKeyFromPrivate,
  randomBytes,
  toBase64,
  unwrapAccountKeyWithUnlock,
  wrapAccountKeyWithUnlock,
} from "./crypto";
import { createVaultKeySession, type VaultKeysApi, type VaultKeyStore } from "./session";

function keysWith(account: Uint8Array | null) {
  let acct = account;
  return {
    getAccountPrivateKey: vi.fn(async () => acct),
    setAccountPrivateKey: vi.fn(async (k: Uint8Array) => void (acct = k)),
    getDeviceLinkKey: vi.fn(async () => null),
    setDeviceLinkKey: vi.fn(async () => {}),
    deleteDeviceLinkKey: vi.fn(async () => {}),
    getVaultKey: vi.fn(async () => null),
    setVaultKey: vi.fn(async () => {}),
    isVaultKeyProvisional: vi.fn(async () => false),
    setVaultKeyProvisional: vi.fn(async () => {}),
    clearCache: vi.fn(),
  } satisfies VaultKeyStore;
}

function serverWith(me: AccountKeysBody | null, unlock: Awaited<ReturnType<NonNullable<VaultKeysApi["unlockAccountKey"]>>>) {
  const state = { me, puts: [] as string[] };
  const api = {
    getMyKeys: vi.fn(async () => state.me),
    putMyKeys: vi.fn(async (b: AccountKeysBody) => void (state.me = b)),
    unlockAccountKey: vi.fn(async () => unlock),
    putPasswordWrap: vi.fn(async (w: string) => {
      state.puts.push(w);
      if (state.me) state.me = { ...state.me, privWrappedPassword: w };
    }),
    registerPendingDevice: vi.fn(async () => {}),
    getDeviceKey: vi.fn(async () => null),
  } as unknown as VaultKeysApi;
  return { api, state };
}

function sessionOf(api: VaultKeysApi, keys: VaultKeyStore) {
  return createVaultKeySession({
    api,
    keys,
    pins: { get: async () => null, set: async () => {} },
    features: async () => new Set(["vault-keys"]),
    keysAllowed: () => false,
    isMember: async () => true,
    selfUserId: () => "u1",
    deviceId: () => "d1",
  });
}

describe("password unlock (seamless keys F)", () => {
  const unlockKey = randomBytes(32);
  const pair = generateAccountKeypair();
  const pubB64 = toBase64(pair.publicKey);

  it("wrap format: AAD binds user and public key", () => {
    const w = wrapAccountKeyWithUnlock(unlockKey, "u1", pubB64, pair.privateKey);
    expect(unwrapAccountKeyWithUnlock(unlockKey, "u1", pubB64, w)).toEqual(pair.privateKey);
    expect(() => unwrapAccountKeyWithUnlock(unlockKey, "u2", pubB64, w)).toThrow();
    expect(() => unwrapAccountKeyWithUnlock(randomBytes(32), "u1", pubB64, w)).toThrow();
  });

  it("a device holding the key writes the wrap when missing, then leaves a current one alone", async () => {
    const { api, state } = serverWith({ publicKey: pubB64, privWrappedPassword: null }, { unlockKey: toBase64(unlockKey) });
    const s = sessionOf(api, keysWith(pair.privateKey));
    expect(await s.unlockWithPassword("pw")).toBe("wrap-written");
    expect(state.puts).toHaveLength(1);
    expect(unwrapAccountKeyWithUnlock(unlockKey, "u1", pubB64, fromBase64(state.puts[0]))).toEqual(pair.privateKey);
    expect(await s.unlockWithPassword("pw")).toBe("wrap-current");
    expect(state.puts).toHaveLength(1);
  });

  it("a new device adopts the key from the wrap and is ready with no approval", async () => {
    const wrap = toBase64(wrapAccountKeyWithUnlock(unlockKey, "u1", pubB64, pair.privateKey));
    const { api } = serverWith({ publicKey: pubB64, privWrappedPassword: wrap }, { unlockKey: toBase64(unlockKey) });
    const keys = keysWith(null);
    const s = sessionOf(api, keys);
    expect(await s.unlockWithPassword("pw")).toBe("unlocked");
    expect(keys.setAccountPrivateKey).toHaveBeenCalledWith(pair.privateKey);
    expect(await s.ensureAccountKeys()).toEqual({ state: "ready", isNew: false });
  });

  it("refuses a wrap whose key is not the account key /me/keys names (falls back to approval)", async () => {
    const other = generateAccountKeypair();
    // A wrap of another private key, bound to the listed public key.
    const wrap = toBase64(wrapAccountKeyWithUnlock(unlockKey, "u1", pubB64, other.privateKey));
    const { api } = serverWith({ publicKey: pubB64, privWrappedPassword: wrap }, { unlockKey: toBase64(unlockKey) });
    const keys = keysWith(null);
    expect(await sessionOf(api, keys).unlockWithPassword("pw")).toBe("fallback");
    expect(keys.setAccountPrivateKey).not.toHaveBeenCalled();
  });

  it("no_password / unlock off / wrong password change nothing", async () => {
    for (const answer of ["unavailable", "wrong-password"] as const) {
      const { api, state } = serverWith({ publicKey: pubB64 }, answer);
      const keys = keysWith(null);
      expect(await sessionOf(api, keys).unlockWithPassword("pw")).toBe(answer);
      expect(keys.setAccountPrivateKey).not.toHaveBeenCalled();
      expect(state.puts).toHaveLength(0);
    }
  });

  it("a key that arrives after the sign-in (approval) gets a wrap on the next run", async () => {
    const { api, state } = serverWith({ publicKey: pubB64, privWrappedPassword: null }, { unlockKey: toBase64(unlockKey) });
    const keys = keysWith(null);
    const s = sessionOf(api, keys);
    expect(await s.unlockWithPassword("pw")).toBe("fallback");
    await keys.setAccountPrivateKey(pair.privateKey); // approved from another computer
    expect((await s.ensureAccountKeys()).state).toBe("ready");
    expect(state.puts).toHaveLength(1);
    expect(publicKeyFromPrivate(unwrapAccountKeyWithUnlock(unlockKey, "u1", pubB64, fromBase64(state.puts[0])))).toEqual(
      pair.publicKey,
    );
  });
});

// ── lockstep with the contract's JSON ────────────────────────────────────────

function client(status: number, body: unknown, seen: Array<{ method: string; url: string; body: unknown }> = []) {
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return new ApiClient({ baseUrl: "http://server.test", token: "t", fetchImpl: fetchImpl as never });
}

describe("F wire shapes", () => {
  it("POST /api/me/keys/unlock { password } → { unlockKey }", async () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = [];
    expect(await client(200, { unlockKey: "a2V5" }, seen).unlockAccountKey("pw")).toEqual({ unlockKey: "a2V5" });
    expect(seen[0]).toMatchObject({ method: "POST", url: expect.stringMatching(/^http:\/\/server\.test\/api\/me\/keys\/unlock(\?|$)/), body: { password: "pw" } });
  });
  it("401 wrong_password, 409 no_password, 503 password_unlock_off", async () => {
    expect(await client(401, { error: "wrong_password" }).unlockAccountKey("pw")).toBe("wrong-password");
    // The server's real shape, and a 401 that is about the session, not the password.
    expect(await client(401, { error: "Wrong password", code: "wrong_password" }).unlockAccountKey("pw")).toBe("wrong-password");
    expect(await client(401, { error: "Authentication required" }).unlockAccountKey("pw")).toBe("unavailable");
    expect(await client(409, { error: "no_password" }).unlockAccountKey("pw")).toBe("unavailable");
    expect(await client(503, { error: "password_unlock_off" }).unlockAccountKey("pw")).toBe("unavailable");
  });
  it("PUT /api/me/keys/password-wrap { privWrapped } → { stored: true }", async () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = [];
    await client(200, { stored: true }, seen).putPasswordWrap("d3JhcA==");
    expect(seen[0]).toMatchObject({
      method: "PUT",
      url: expect.stringMatching(/^http:\/\/server\.test\/api\/me\/keys\/password-wrap(\?|$)/),
      body: { privWrapped: "d3JhcA==" },
    });
  });
  it("GET /api/me/keys carries privWrappedPassword", async () => {
    expect(await client(200, { publicKey: "cGs=", privWrappedPassword: "d3JhcA==" }).getMyKeys()).toMatchObject({
      publicKey: "cGs=",
      privWrappedPassword: "d3JhcA==",
    });
  });
});
