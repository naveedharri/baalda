// Live-server check of the seamless key flows (env-gated like joinKeyShare):
// invite, join code, password unlock and conversion all leave the joiner with a
// verified vault key and NO key-request servicing by anyone afterwards (except
// conversion, which takes exactly one owner run), plus the negative case.
//   KEYS_IT=http://localhost:3010 pnpm vitest run src/lib/vaultKeys/seamlessFlows.it.test.ts
// Server: BAALDA_VAULT_KEYS=on, VAULT_KEY_CONVERSION=on, ACCOUNT_KEY_PEPPER set.
// Creates throwaway @demo.local accounts. One ApiClient + session per device.
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api";
import { createVaultKeySession, type KeyPinStore, type VaultKeyStore } from "./session";
import { VAULT_KEYS } from "../serverFeatures";
import { newSecret, secretHash } from "./crypto";

const BASE = process.env.KEYS_IT;
const PASSWORD = "demopass1234";

function memoryKeys(): VaultKeyStore {
  let account: Uint8Array | null = null;
  let link: Uint8Array | null = null;
  const vaults = new Map<string, Uint8Array>();
  const provisional = new Set<string>();
  return {
    getAccountPrivateKey: async () => account,
    setAccountPrivateKey: async (k) => void (account = k),
    getDeviceLinkKey: async () => link,
    setDeviceLinkKey: async (k) => void (link = k),
    deleteDeviceLinkKey: async () => void (link = null),
    getVaultKey: async (id) => vaults.get(id) ?? null,
    setVaultKey: async (id, vk) => void vaults.set(id, vk),
    isVaultKeyProvisional: async (id) => provisional.has(id),
    setVaultKeyProvisional: async (id, on) => void (on ? provisional.add(id) : provisional.delete(id)),
    clearCache: () => {},
  };
}
function memoryPins(): KeyPinStore {
  const m = new Map<string, string>();
  return { get: async (u) => m.get(u) ?? null, set: async (u, f) => void m.set(u, f) };
}

type Person = { api: ApiClient; email: string; userId: string };

async function signUp(label: string, tag: string, email = `seamless-${label}-${tag}@demo.local`): Promise<Person> {
  const api = new ApiClient({ baseUrl: BASE });
  await api.signUp({ email, password: PASSWORD, name: label });
  const session = (await api.getSession())!;
  return { api, email, userId: session.user.id };
}

/** Another computer of the same person: a fresh client, signed in with the password. */
async function signInElsewhere(email: string): Promise<Person> {
  const api = new ApiClient({ baseUrl: BASE });
  await api.signIn({ email, password: PASSWORD });
  const session = (await api.getSession())!;
  return { api, email, userId: session.user.id };
}

function device(
  p: Person,
  orgId: () => string | null,
  opts: { keysAllowed?: boolean; deviceId?: string; canConvert?: boolean } = {},
) {
  return createVaultKeySession({
    api: p.api,
    keys: memoryKeys(),
    pins: memoryPins(),
    features: async () => new Set([VAULT_KEYS]),
    keysAllowed: () => opts.keysAllowed ?? false,
    selfUserId: () => p.userId,
    deviceId: () => opts.deviceId ?? `dev-${p.userId}`,
    canConvert: async () => opts.canConvert ?? false,
    isMember: async (_v, uid) => {
      const id = orgId();
      if (!id) return false;
      const { members } = await p.api.getMembersOverview(id);
      return members.some((m) => m.userId === uid);
    },
  });
}

/** Owner with a keyed vault (new vaults are keyed by the owner's device). */
async function ownerWithKeyedVault(tag: string) {
  const owner = await signUp("owner", tag);
  const org = await owner.api.createOrganization({ name: `Seamless ${tag}`, slug: `seamless-${tag}` });
  const vault = await owner.api.createVault({ name: `Seamless ${tag}`, organizationId: org.id });
  await owner.api.setActiveOrganization(org.id);
  const ownerDevice = device(owner, () => org.id, { keysAllowed: true });
  expect((await ownerDevice.ensureAccountKeys()).state).toBe("ready");
  expect((await ownerDevice.ensureVaultKey(vault.id)).state).toBe("ready");
  return { owner, org, vault, ownerDevice };
}

const newTag = () => Math.random().toString(36).slice(2, 8);

describe.skipIf(!BASE)("seamless vault keys (live server)", () => {
  it("1. invite an EXISTING account: accepting installs the key, the gate proceeds", async () => {
    const tag = newTag();
    const { owner, org, vault, ownerDevice } = await ownerWithKeyedVault(tag);
    const mate = await signUp("mate", tag);
    const mateDevice = device(mate, () => org.id);
    expect((await mateDevice.ensureAccountKeys()).state).toBe("ready");

    const material = ownerDevice.inviteKeyMaterial(vault.id, [mate.email])!;
    expect(material).not.toBeNull();
    const results = await owner.api.inviteMany(
      org.id,
      { emails: [mate.email], role: "member", access: null, vaultKeys: material.vaultKeys },
      material.vkBase64,
    );
    console.log("[seamless-it 1] invite results", JSON.stringify(results.map((r) => ({ ...r, publicKey: !!r.publicKey }))));
    expect(results[0].invitationId).toBeTruthy();
    expect(results[0].inviteeUserId).toBe(mate.userId);
    expect(results[0].publicKey).toBeTruthy();
    expect((await ownerDevice.sealInviteResults(vault.id, results)).map((s) => s.userId)).toEqual([mate.userId]);

    await mate.api.acceptInvitation(results[0].invitationId!);
    expect(await mateDevice.gateVaultOpen(vault.id)).toBe("proceed");
    expect(mateDevice.headerFor(vault.id)).toBe(ownerDevice.headerFor(vault.id));
  }, 60_000);

  it("2. invite an email with NO account: sign up, accept, the secret k opens the key", async () => {
    const tag = newTag();
    const { owner, org, vault, ownerDevice } = await ownerWithKeyedVault(tag);
    const email = `seamless-new-${tag}@demo.local`;
    const material = ownerDevice.inviteKeyMaterial(vault.id, [email])!;
    const k = material.vaultKeys.items[0].secret; // what the emailed link's #k= carries
    const results = await owner.api.inviteMany(
      org.id,
      { emails: [email], role: "member", access: null, vaultKeys: material.vaultKeys },
      material.vkBase64,
    );
    expect(results[0].invitationId).toBeTruthy();
    expect(results[0].publicKey ?? null).toBeNull();

    const mate = await signUp("new", tag, email);
    await mate.api.acceptInvitation(results[0].invitationId!);
    const mateDevice = device(mate, () => org.id);
    expect((await mateDevice.ensureAccountKeys()).state).toBe("ready");
    const wraps = await mate.api.getInviteWraps(vault.id);
    expect(wraps.map((w) => w.wrappedVk)).toEqual([material.vaultKeys.items[0].wrappedVk]);
    expect(await mateDevice.adoptFromSecret(vault.id, "invite", k, wraps)).toBe("adopted");
    expect(await mateDevice.gateVaultOpen(vault.id)).toBe("proceed");
    expect(mateDevice.headerFor(vault.id)).toBe(ownerDevice.headerFor(vault.id));
  }, 60_000);

  it("3. the long join code: joining with <code>-<J> opens the key", async () => {
    const tag = newTag();
    const { owner, org, vault, ownerDevice } = await ownerWithKeyedVault(tag);
    const code = await owner.api.getJoinCode();
    const j = newSecret();
    expect(await ownerDevice.uploadJoinWrap(vault.id, j, code)).toBe("stored");

    const mate = await signUp("joiner", tag);
    const joined = await mate.api.joinVault(`${code}-${j}`);
    expect(joined.organizationId).toBe(org.id);
    const mateDevice = device(mate, () => org.id);
    expect((await mateDevice.ensureAccountKeys()).state).toBe("ready");
    const wrap = await mate.api.getJoinWrap(vault.id, secretHash(j));
    expect(wrap).not.toBeNull();
    expect(await mateDevice.adoptFromSecret(vault.id, "join", j, [wrap!])).toBe("adopted");
    expect(await mateDevice.gateVaultOpen(vault.id)).toBe("proceed");
    expect(mateDevice.headerFor(vault.id)).toBe(ownerDevice.headerFor(vault.id));
  }, 60_000);

  it("4. password unlock: a second computer is ready without approval and opens the vault", async () => {
    const tag = newTag();
    const { owner, org, vault, ownerDevice } = await ownerWithKeyedVault(tag);
    expect(await ownerDevice.unlockWithPassword(PASSWORD)).toBe("wrap-written");
    expect(await ownerDevice.unlockWithPassword(PASSWORD)).toBe("wrap-current");

    const laptop = await signInElsewhere(owner.email);
    const laptopDevice = device(laptop, () => org.id, { deviceId: `laptop-${tag}` });
    expect(await laptopDevice.unlockWithPassword("not the password")).toBe("wrong-password");
    expect(await laptopDevice.unlockWithPassword(PASSWORD)).toBe("unlocked");
    expect(await laptopDevice.ensureAccountKeys()).toEqual({ state: "ready", isNew: false });
    expect(await laptopDevice.gateVaultOpen(vault.id)).toBe("proceed");
    expect(laptopDevice.headerFor(vault.id)).toBe(ownerDevice.headerFor(vault.id));
  }, 60_000);

  it("5. an existing 2-member vault is encrypted automatically: one owner run keys the other member", async () => {
    const tag = newTag();
    const owner = await signUp("owner", tag);
    const org = await owner.api.createOrganization({ name: `Seamless ${tag}`, slug: `seamless-${tag}` });
    const vault = await owner.api.createVault({ name: `Seamless ${tag}`, organizationId: org.id });
    await owner.api.setActiveOrganization(org.id);
    const ownerDevice = device(owner, () => org.id, { canConvert: true });
    expect((await ownerDevice.ensureAccountKeys()).state).toBe("ready");
    const before = await ownerDevice.ensureVaultKey(vault.id);
    console.log("[seamless-it 5] before conversion", JSON.stringify(before));
    expect(before.state).toBe("unkeyed");

    const mate = await signUp("mate", tag);
    await mate.api.joinVault(await owner.api.getJoinCode());
    const mateDevice = device(mate, () => org.id);
    expect((await mateDevice.ensureAccountKeys()).state).toBe("ready");

    // No opt-in: the server allows converting every unkeyed vault. The other
    // member's account key satisfies the safety rule.
    let conv = await ownerDevice.convertVault(vault.id);
    for (let i = 0; i < 3 && conv === "waiting-ready"; i++) conv = await ownerDevice.convertVault(vault.id);
    console.log("[seamless-it 5] convert", conv);
    expect(conv).toBe("converted");

    // The member filed no request: listed as `missing`, sealed by ONE owner run.
    const listed = await owner.api.listVaultKeyRequests(vault.id);
    console.log("[seamless-it 5] listed", JSON.stringify(listed.map((r) => ({ userId: r.userId, kind: r.kind }))));
    expect(listed.find((r) => r.userId === mate.userId)?.kind).toBe("missing");
    const served = await ownerDevice.serviceKeyRequests(vault.id);
    expect(served.sealed.map((s) => s.userId)).toContain(mate.userId);

    expect(await mateDevice.gateVaultOpen(vault.id)).toBe("proceed");
    expect(mateDevice.headerFor(vault.id)).toBe(ownerDevice.headerFor(vault.id));
  }, 90_000);

  it("7. a SOLO account converts only once its password wraps the account key", async () => {
    const tag = newTag();
    const solo = await signUp("solo", tag);
    const org = await solo.api.createOrganization({ name: `Seamless ${tag}`, slug: `seamless-${tag}` });
    await solo.api.setActiveOrganization(org.id);
    const soloDevice = device(solo, () => org.id, { canConvert: true });
    expect((await soloDevice.ensureAccountKeys()).state).toBe("ready");
    const me = await solo.api.getMyKeys();
    console.log("[seamless-it 7] /me/keys devices", JSON.stringify(me?.devices), "wrap", !!me?.privWrappedPassword);
    // A first computer has no device row (only approvals add one).
    expect(me?.devices).toEqual([]);
    expect(me?.privWrappedPassword ?? null).toBeNull();

    const vault = await solo.api.createVault({ name: `Seamless ${tag}`, organizationId: org.id });
    expect((await soloDevice.ensureVaultKey(vault.id)).state).toBe("unkeyed");
    expect(await soloDevice.convertVault(vault.id)).toBe("not-safe-yet");
    const mine = await solo.api.getMyVaultKeys(vault.id);
    console.log("[seamless-it 7] keys/mine after not-safe-yet", JSON.stringify(mine));
    expect(mine.keyed).toBe(false);
    expect(mine.pending).toBe(false);
    expect(soloDevice.headerFor(vault.id)).toBeNull();

    // The person's password now wraps the account key: conversion goes ahead.
    expect(await soloDevice.unlockWithPassword(PASSWORD)).toBe("wrap-written");
    let conv = await soloDevice.convertVault(vault.id);
    for (let i = 0; i < 3 && conv === "waiting-ready"; i++) conv = await soloDevice.convertVault(vault.id);
    expect(conv).toBe("converted");
    const after = await solo.api.getMyVaultKeys(vault.id);
    expect(after.keyed && !after.pending).toBe(true);
    expect(soloDevice.headerFor(vault.id)).toBeTruthy();
  }, 60_000);

  it("8. a BRAND-NEW account: the unlock right after sign-up (no key yet) wraps the first key, so its solo vault converts", async () => {
    const tag = newTag();
    const fresh = await signUp("fresh", tag);
    const org = await fresh.api.createOrganization({ name: `Seamless ${tag}`, slug: `seamless-${tag}` });
    await fresh.api.setActiveOrganization(org.id);
    const freshDevice = device(fresh, () => org.id, { canConvert: true, keysAllowed: true });
    // What store.signUp now does, before any account key exists.
    expect(await freshDevice.unlockWithPassword(PASSWORD)).toBe("fallback");
    expect(await fresh.api.getMyKeys()).toBeNull();
    // The first key run creates the account key and writes the password wrap.
    expect((await freshDevice.ensureAccountKeys()).state).toBe("ready");
    expect((await fresh.api.getMyKeys())?.privWrappedPassword).toBeTruthy();

    const vault = await fresh.api.createVault({ name: `Seamless ${tag}`, organizationId: org.id });
    let conv = await freshDevice.convertVault(vault.id);
    for (let i = 0; i < 3 && conv === "waiting-ready"; i++) conv = await freshDevice.convertVault(vault.id);
    expect(conv).toBe("converted");
    const after = await fresh.api.getMyVaultKeys(vault.id);
    expect(after.keyed && !after.pending).toBe(true);
  }, 60_000);

  it("6. negative: an invitation without a key and no servicing leaves the member paused", async () => {
    const tag = newTag();
    const { owner, org, vault } = await ownerWithKeyedVault(tag);
    const email = `seamless-plain-${tag}@demo.local`;
    // A device without the key invites as before: no vaultKeys, no header.
    const results = await owner.api.inviteMany(org.id, { emails: [email], role: "member", access: null });
    expect(results[0].invitationId).toBeTruthy();
    const mate = await signUp("plain", tag, email);
    await mate.api.acceptInvitation(results[0].invitationId!);
    const mateDevice = device(mate, () => org.id);
    expect((await mateDevice.ensureAccountKeys()).state).toBe("ready");
    expect(await mate.api.getInviteWraps(vault.id)).toEqual([]);
    expect(await mateDevice.gateVaultOpen(vault.id)).toBe("paused");
    expect((await mateDevice.ensureVaultKey(vault.id)).state).toBe("waiting-for-teammate");
    expect(mateDevice.headerFor(vault.id)).toBeNull();
  }, 60_000);
});
