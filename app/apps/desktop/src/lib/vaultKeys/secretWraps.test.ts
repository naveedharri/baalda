// Seamless keys B (invite-time keys) and C (join codes with a device secret):
// the secret-wrap crypto, the session steps, and lockstep with the contract's JSON.
import { describe, expect, it, vi } from "vitest";
import { ApiClient, type MyVaultKeys } from "../api";
import { parseInviteDeepLink } from "../inviteLink";
import {
  decodeSecret,
  encodeCrockford,
  fromBase64,
  generateAccountKeypair,
  generateVaultKey,
  makeVkCheck,
  newSecret,
  openSealedVk,
  secretHash,
  toBase64,
  unwrapVkWithSecret,
  wrapVkWithSecret,
} from "./crypto";
import { createVaultKeySession, type VaultKeysApi, type VaultKeyStore } from "./session";
import { joinCodeSecret } from "./runtime";

describe("secret wraps (crypto)", () => {
  it("secrets are 26 Crockford chars that round-trip 16 bytes", () => {
    const s = newSecret();
    expect(s).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(encodeCrockford(decodeSecret(s)!)).toBe(s);
    expect(decodeSecret(s.toLowerCase())).toEqual(decodeSecret(s));
    expect(decodeSecret("short")).toBeNull();
  });
  it("binds purpose, vault and generation", () => {
    const vk = generateVaultKey();
    const s = newSecret();
    const w = wrapVkWithSecret(s, "invite", "v1", 1, vk);
    expect(unwrapVkWithSecret(s, "invite", "v1", 1, w)).toEqual(vk);
    expect(() => unwrapVkWithSecret(s, "join", "v1", 1, w)).toThrow();
    expect(() => unwrapVkWithSecret(s, "invite", "v2", 1, w)).toThrow();
    expect(() => unwrapVkWithSecret(s, "invite", "v1", 2, w)).toThrow();
    expect(() => unwrapVkWithSecret(newSecret(), "invite", "v1", 1, w)).toThrow();
  });
  it("secretHash is hex sha256 of the utf8 secret", () => {
    expect(secretHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("links and codes carry the secret", () => {
  it("baalda://invite/<id>?server=…&k=<S>", () => {
    const s = newSecret();
    expect(parseInviteDeepLink(`baalda://invite/inv1?server=https%3A%2F%2Fapi.test&k=${s}`)?.secret).toBe(s);
    expect(parseInviteDeepLink("baalda://invite/inv1?server=https%3A%2F%2Fapi.test")?.secret).toBeUndefined();
    expect(parseInviteDeepLink("baalda://invite/inv1?k=not-a-secret")?.secret).toBeUndefined();
  });
  it("`<code>-<J>` yields J; a plain 8-char code yields nothing", () => {
    const j = newSecret();
    expect(joinCodeSecret(`ABCD2345-${j}`)).toBe(j);
    expect(joinCodeSecret(`ABCD2345-${j.toLowerCase()}`)).toBe(j);
    expect(joinCodeSecret("ABCD2345")).toBeNull();
  });
});

// ── session ──────────────────────────────────────────────────────────────────

async function keyedVault(vaultId: string, generation = 1) {
  const vk = generateVaultKey();
  const vkCheck = toBase64(await makeVkCheck(vk, vaultId, generation));
  return { vk, vkCheck, generation };
}

function store(vks = new Map<string, Uint8Array>(), account: Uint8Array | null = null) {
  let acct = account;
  return {
    vks,
    getAccountPrivateKey: vi.fn(async () => acct),
    setAccountPrivateKey: vi.fn(async (k: Uint8Array) => void (acct = k)),
    getDeviceLinkKey: vi.fn(async () => null),
    setDeviceLinkKey: vi.fn(async () => {}),
    deleteDeviceLinkKey: vi.fn(async () => {}),
    getVaultKey: vi.fn(async (id: string) => vks.get(id) ?? null),
    setVaultKey: vi.fn(async (id: string, vk: Uint8Array) => void vks.set(id, vk)),
    isVaultKeyProvisional: vi.fn(async () => false),
    setVaultKeyProvisional: vi.fn(async () => {}),
    clearCache: vi.fn(),
  } satisfies VaultKeyStore & { vks: Map<string, Uint8Array> };
}

function fakeApi(mine: MyVaultKeys, me: { publicKey: string } | null = null) {
  return {
    getMyVaultKeys: vi.fn(async () => mine),
    getMyKeys: vi.fn(async () => me),
    postVaultKeyWrap: vi.fn(async () => {}),
    putInviteWrap: vi.fn(async () => {}),
    putJoinWrap: vi.fn(async () => "stored" as const),
  } as unknown as VaultKeysApi & {
    postVaultKeyWrap: ReturnType<typeof vi.fn>;
    putInviteWrap: ReturnType<typeof vi.fn>;
    putJoinWrap: ReturnType<typeof vi.fn>;
  };
}

function pins() {
  const m = new Map<string, string>();
  return { m, get: async (u: string) => m.get(u) ?? null, set: async (u: string, f: string) => void m.set(u, f) };
}

function sessionOf(api: VaultKeysApi, keys: VaultKeyStore, p = pins()) {
  return createVaultKeySession({
    api,
    keys,
    pins: p,
    features: async () => new Set(["vault-keys"]),
    keysAllowed: () => false,
    isMember: async () => true,
    selfUserId: () => "u2",
    deviceId: () => "d1",
  });
}

describe("invite-time keys (B1/B2/B4)", () => {
  it("wraps the verified key per invitee; the invitee's secret opens it and it verifies", async () => {
    const v = await keyedVault("v1");
    const mine: MyVaultKeys = { keyed: true, pending: false, vkCheck: v.vkCheck, generation: 1, wraps: [] };
    const owner = sessionOf(fakeApi(mine), store(new Map([["v1", v.vk]])));
    expect((await owner.ensureVaultKey("v1")).state).toBe("ready");
    const m = owner.inviteKeyMaterial("v1", ["a@x.com", "b@x.com"])!;
    expect(m.vkBase64).toBe(toBase64(v.vk));
    expect(m.vaultKeys).toMatchObject({ vaultId: "v1", generation: 1 });
    expect(m.vaultKeys.items.map((i) => i.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(new Set(m.vaultKeys.items.map((i) => i.secret)).size).toBe(2);

    // The invitee (no key yet) adopts it from GET invite-wrap, then self-seals.
    const invitee = generateAccountKeypair();
    const api = fakeApi(mine, { publicKey: toBase64(invitee.publicKey) });
    const keys = store(new Map(), invitee.privateKey);
    const s = sessionOf(api, keys);
    const item = m.vaultKeys.items[0];
    const wraps = [{ invitationId: "i1", generation: 1, wrappedVk: item.wrappedVk }];
    expect(await s.adoptFromSecret("v1", "invite", newSecret(), wraps)).toBe("no-match");
    expect(keys.setVaultKey).not.toHaveBeenCalled();
    expect(await s.adoptFromSecret("v1", "invite", item.secret, wraps)).toBe("adopted");
    expect(keys.vks.get("v1")).toEqual(v.vk);
    expect(s.headerFor("v1")).toBe(toBase64(v.vk));
    expect(api.postVaultKeyWrap).toHaveBeenCalledTimes(1);
    const [, self] = api.postVaultKeyWrap.mock.calls[0];
    expect(self.userId).toBe("u2");
    expect(openSealedVk(invitee.privateKey, fromBase64(self.sealedVk))).toEqual(v.vk);
  });

  it("never stores a key that does not verify against the vault's check", async () => {
    const v = await keyedVault("v1");
    const other = generateVaultKey();
    const s1 = newSecret();
    const mine: MyVaultKeys = { keyed: true, pending: false, vkCheck: v.vkCheck, generation: 1, wraps: [] };
    const keys = store();
    const s = sessionOf(fakeApi(mine), keys);
    const wraps = [{ generation: 1, wrappedVk: toBase64(wrapVkWithSecret(s1, "invite", "v1", 1, other)) }];
    expect(await s.adoptFromSecret("v1", "invite", s1, wraps)).toBe("no-match");
    expect(keys.setVaultKey).not.toHaveBeenCalled();
  });

  it("seals to an invitee's existing account key and pins it; a changed pinned key is skipped", async () => {
    const v = await keyedVault("v1");
    const mine: MyVaultKeys = { keyed: true, pending: false, vkCheck: v.vkCheck, generation: 1, wraps: [] };
    const api = fakeApi(mine);
    const p = pins();
    const owner = sessionOf(api, store(new Map([["v1", v.vk]])), p);
    await owner.ensureVaultKey("v1");
    const a = generateAccountKeypair();
    const sealed = await owner.sealInviteResults("v1", [
      { email: "a@x.com", invitationId: "i1", emailed: true, publicKey: toBase64(a.publicKey), inviteeUserId: "u9" },
      { email: "b@x.com", invitationId: "i2", emailed: true, publicKey: null, inviteeUserId: null },
    ]);
    expect(sealed).toEqual(["u9"]);
    const [vaultId, invitationId, body, header] = api.putInviteWrap.mock.calls[0];
    expect([vaultId, invitationId, header]).toEqual(["v1", "i1", toBase64(v.vk)]);
    expect(body.publicKey).toBe(toBase64(a.publicKey));
    expect(body.generation).toBe(1);
    expect(openSealedVk(a.privateKey, fromBase64(body.sealedVk))).toEqual(v.vk);
    expect(p.m.has("u9")).toBe(true);

    const swapped = generateAccountKeypair();
    expect(
      await owner.sealInviteResults("v1", [
        { email: "a@x.com", invitationId: "i3", emailed: true, publicKey: toBase64(swapped.publicKey), inviteeUserId: "u9" },
      ]),
    ).toEqual([]);
  });
});

describe("join codes (C)", () => {
  it("the admin's join wrap opens with J for the joiner", async () => {
    const v = await keyedVault("v1");
    const mine: MyVaultKeys = { keyed: true, pending: false, vkCheck: v.vkCheck, generation: 1, wraps: [] };
    const api = fakeApi(mine);
    const admin = sessionOf(api, store(new Map([["v1", v.vk]])));
    await admin.ensureVaultKey("v1");
    const j = newSecret();
    expect(await admin.uploadJoinWrap("v1", j, "ABCD2345")).toBe("stored");
    const [vaultId, body, header] = api.putJoinWrap.mock.calls[0];
    expect([vaultId, header]).toEqual(["v1", toBase64(v.vk)]);
    expect(body).toMatchObject({ secretHash: secretHash(j), generation: 1, code: "ABCD2345" });

    const keys = store();
    const joiner = sessionOf(fakeApi(mine), keys);
    expect(await joiner.adoptFromSecret("v1", "join", j, [{ generation: 1, wrappedVk: body.wrappedVk }])).toBe("adopted");
    expect(keys.vks.get("v1")).toEqual(v.vk);
  });
  it("a device without the key uploads nothing", async () => {
    const v = await keyedVault("v1");
    const api = fakeApi({ keyed: true, pending: false, vkCheck: v.vkCheck, generation: 1, wraps: [] });
    expect(await sessionOf(api, store()).uploadJoinWrap("v1", newSecret(), "ABCD2345")).toBe("no-key");
    expect(api.putJoinWrap).not.toHaveBeenCalled();
  });
});

// ── lockstep with the contract's JSON ────────────────────────────────────────

type Seen = { method: string; url: string; body: unknown; headers: Record<string, string> };
function client(status: number, body: unknown, seen: Seen[] = []) {
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    h.forEach((v, k) => (headers[k] = v));
    seen.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, headers });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return new ApiClient({ baseUrl: "http://server.test", token: "t", fetchImpl: fetchImpl as never });
}
const path = (s: Seen) => new URL(s.url).pathname;

describe("B/C wire shapes", () => {
  it("B1 POST invitations: vaultKeys in the body, X-Baalda-VK, results gain publicKey/inviteeUserId", async () => {
    const seen: Seen[] = [];
    const results = [
      { email: "a@x.com", invitationId: "i1", emailed: true, publicKey: "cGs=", inviteeUserId: "u9" },
      { email: "b@x.com", invitationId: "i2", emailed: true, publicKey: null, inviteeUserId: null },
    ];
    const vaultKeys = { vaultId: "v1", generation: 1, items: [{ email: "a@x.com", wrappedVk: "d3I=", secret: "S".repeat(26) }] };
    const got = await client(200, { results }, seen).inviteMany(
      "o1",
      { emails: ["a@x.com", "b@x.com"], role: "member", access: null, vaultKeys },
      "dms=",
    );
    expect(got).toEqual(results);
    expect(path(seen[0])).toBe("/api/orgs/o1/invitations");
    expect(seen[0].body).toEqual({ emails: ["a@x.com", "b@x.com"], role: "member", access: null, vaultKeys });
    expect(seen[0].headers["x-baalda-vk"]).toBe("dms=");
  });
  it("B1 without the key: no vaultKeys, no header", async () => {
    const seen: Seen[] = [];
    await client(200, { results: [] }, seen).inviteMany("o1", { emails: ["a@x.com"], role: "member", access: null });
    expect(seen[0].body).toEqual({ emails: ["a@x.com"], role: "member", access: null });
    expect(seen[0].headers["x-baalda-vk"]).toBeUndefined();
  });
  it("B2 PUT keys/invite-wraps/:invitationId { sealedVk, publicKey, generation } → 201 { stored }", async () => {
    const seen: Seen[] = [];
    await client(201, { stored: true }, seen).putInviteWrap("v1", "i1", { sealedVk: "c2U=", publicKey: "cGs=", generation: 1 }, "dms=");
    expect(seen[0].method).toBe("PUT");
    expect(path(seen[0])).toBe("/api/vaults/v1/keys/invite-wraps/i1");
    expect(seen[0].body).toEqual({ sealedVk: "c2U=", publicKey: "cGs=", generation: 1 });
    expect(seen[0].headers["x-baalda-vk"]).toBe("dms=");
  });
  it("B4 GET keys/invite-wrap → { wraps }", async () => {
    const seen: Seen[] = [];
    const wraps = [{ invitationId: "i1", generation: 1, wrappedVk: "d3I=" }];
    expect(await client(200, { wraps }, seen).getInviteWraps("v1")).toEqual(wraps);
    expect(path(seen[0])).toBe("/api/vaults/v1/keys/invite-wrap");
    expect(await client(200, {}).getInviteWraps("v1")).toEqual([]);
  });
  it("C PUT keys/join-wraps { secretHash, wrappedVk, generation, code } → stored | 409 stale_code", async () => {
    const seen: Seen[] = [];
    const body = { secretHash: "ab".repeat(32), wrappedVk: "d3I=", generation: 1, code: "ABCD2345" };
    expect(await client(201, { stored: true }, seen).putJoinWrap("v1", body, "dms=")).toBe("stored");
    expect(seen[0].method).toBe("PUT");
    expect(path(seen[0])).toBe("/api/vaults/v1/keys/join-wraps");
    expect(seen[0].body).toEqual(body);
    expect(seen[0].headers["x-baalda-vk"]).toBe("dms=");
    expect(await client(409, { error: "stale_code" }).putJoinWrap("v1", body, "dms=")).toBe("stale-code");
  });
  it("C GET keys/join-wrap?h=<hash> → { wrap } | { wrap: null }", async () => {
    const seen: Seen[] = [];
    const h = "ab".repeat(32);
    expect(await client(200, { wrap: { generation: 1, wrappedVk: "d3I=" } }, seen).getJoinWrap("v1", h)).toEqual({
      generation: 1,
      wrappedVk: "d3I=",
    });
    expect(path(seen[0])).toBe("/api/vaults/v1/keys/join-wrap");
    expect(new URL(seen[0].url).searchParams.get("h")).toBe(h);
    expect(await client(200, { wrap: null }).getJoinWrap("v1", h)).toBeNull();
  });
});
