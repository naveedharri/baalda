import { describe, expect, it, vi } from "vitest";
import { ApiError, type AccountKeysBody, type MyVaultKeys, type VaultKeyInit, type VaultKeyRequest } from "../api";
import {
  fromBase64,
  generateAccountKeypair,
  generateVaultKey,
  makeVkCheck,
  openSealedVk,
  sealVkTo,
  toBase64,
  unwrapPrivateKeyWithPhrase,
} from "./crypto";
import { createVaultKeySession, resetVaultKeySessions, type VaultKeySessionDeps } from "./session";

const FAST = { m: 256, t: 1, p: 1 };

/** A fake server that holds only what the real one would: blobs, never keys. */
function fakeServer() {
  let me: AccountKeysBody | null = null;
  const vaults = new Map<string, { vkCheck: string; generation: number; wraps: Map<string, string> }>();
  const requests = new Map<string, VaultKeyRequest[]>();
  const posted: { vaultId: string; userId: string; header: string }[] = [];
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
  };
  return {
    api,
    vaults,
    requests,
    posted,
    as: (u: string) => void (caller = u),
    setMe: (b: AccountKeysBody | null) => void (me = b),
  };
}

function fakeKeys() {
  let account: Uint8Array | null = null;
  const vks = new Map<string, Uint8Array>();
  return {
    vks,
    getAccountPrivateKey: vi.fn(async () => account),
    setAccountPrivateKey: vi.fn(async (k: Uint8Array) => void (account = k)),
    getVaultKey: vi.fn(async (id: string) => vks.get(id) ?? null),
    setVaultKey: vi.fn(async (id: string, vk: Uint8Array) => void vks.set(id, vk)),
    clearCache: vi.fn(),
  };
}

function session(over: Partial<VaultKeySessionDeps> & Pick<VaultKeySessionDeps, "api" | "keys">) {
  return createVaultKeySession({
    features: async () => new Set(["vault-keys"]),
    keysAllowed: () => true,
    isMember: async () => true,
    argon2: FAST,
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

  it("first run: makes a keypair, a recovery phrase, publishes, and keys a vault", async () => {
    const srv = fakeServer();
    const keys = fakeKeys();
    const s = session({ api: srv.api, keys });
    const acct = await s.ensureAccountKeys();
    expect(acct.state).toBe("ready");
    if (acct.state !== "ready" || !acct.isNew) throw new Error("expected a new account");
    expect(acct.phrase.split(" ")).toHaveLength(24);
    const priv = await keys.getAccountPrivateKey();
    const published = (await srv.api.getMyKeys())!;
    expect(await unwrapPrivateKeyWithPhrase(acct.phrase, fromBase64(published.privWrappedRecovery))).toEqual(priv);
    // Second run on the same device: nothing new to show.
    expect(await s.ensureAccountKeys()).toEqual({ state: "ready", isNew: false });

    expect(await s.ensureVaultKey("v1")).toEqual({ state: "ready", generation: 1 });
    expect(s.headerFor("v1")).toBe(toBase64(keys.vks.get("v1")!));
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

  it("new device without the private key needs recovery, and recovers with the phrase", async () => {
    const srv = fakeServer();
    const first = session({ api: srv.api, keys: fakeKeys() });
    const acct = await first.ensureAccountKeys();
    if (acct.state !== "ready" || !acct.isNew) throw new Error("expected a new account");

    const keys = fakeKeys();
    const second = session({ api: srv.api, keys });
    expect(await second.ensureAccountKeys()).toEqual({ state: "needs-recovery-or-approval" });
    expect(srv.api.putMyKeys).toHaveBeenCalledTimes(1);
    expect(await second.recoverWithPhrase("abandon ".repeat(23) + "art")).toBe(false);
    expect(await second.recoverWithPhrase(acct.phrase)).toBe(true);
    expect(await second.ensureAccountKeys()).toEqual({ state: "ready", isNew: false });
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
    expect(await owner.serviceKeyRequests("v1")).toEqual({ sealed: ["u2"], refused: ["u9"] });
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
