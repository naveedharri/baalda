// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { redactToken, requireVaultKey, splitSyncToken } from "../src/crypto/transport.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());
const b64 = (b: Buffer) => b.toString("base64");

function call(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      ...authHeaders(user),
      "content-type": "application/json",
      ...(vk ? { "x-baalda-vk": b64(vk) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setup() {
  const owner = await signUp("owner@keys.test");
  const member = await signUp("member@keys.test");
  const outsider = await signUp("outsider@keys.test");
  const org = await createOrg(owner, "Keys", `keys-${Date.now()}`);
  await seedMember(org.id, member.userId, "member");
  const vaultId = await seedVault(org.id);
  const vk = randomBytes(32);
  return { owner, member, outsider, orgId: org.id, vaultId, vk };
}

async function init(s: Awaited<ReturnType<typeof setup>>, user = s.owner) {
  return call(user, "POST", `/vaults/${s.vaultId}/keys/init`, {
    vkCheck: b64(makeVkCheck(s.vk, s.vaultId)),
    generation: 1,
    sealedVkForSelf: b64(randomBytes(80)),
  });
}

describe("vault key routes", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("are not there with the flag off", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", undefined);
    const s = await setup();
    expect((await init(s)).status).toBe(404);
    expect((await call(s.owner, "GET", "/me/keys")).status).toBe(404);
  });

  it("init: the first claimer wins, a second init is 409", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([init(s), init(s, s.member)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const { rows } = await pool.query("SELECT phase, generation FROM vault_crypto_state WHERE vault_id = $1", [s.vaultId]);
    expect(rows).toEqual([{ phase: "keyed", generation: 1 }]);
    expect((await call(s.outsider, "POST", `/vaults/${s.vaultId}/keys/init`, {})).status).toBe(404);
  });

  it("mine: a member without a wrap gets 202 pending and a queued request", async () => {
    const s = await setup();
    await init(s);
    const res = await call(s.member, "GET", `/vaults/${s.vaultId}/keys/mine`);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ pending: true });
    const mine = await (await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/mine`)).json();
    expect(mine.wraps).toHaveLength(1);
    expect(mine.generation).toBe(1);

    // The holder sees the request once the requester published a public key.
    expect((await call(s.member, "PUT", "/me/keys", { publicKey: b64(randomBytes(32)) })).status).toBe(200);
    const reqs = await (await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/requests`)).json();
    expect(reqs.requests.map((r: { userId: string }) => r.userId)).toEqual([s.member.userId]);
    // A non-holder may not list requests.
    expect((await call(s.member, "GET", `/vaults/${s.vaultId}/keys/requests`)).status).toBe(403);
  });

  it("wraps: holder with a valid key succeeds; no key, wrong key, non-holder or non-member refused", async () => {
    const s = await setup();
    await init(s);
    await call(s.member, "GET", `/vaults/${s.vaultId}/keys/mine`);
    const body = (userId: string) => ({ userId, generation: 1, sealedVk: b64(randomBytes(80)) });
    const path = `/vaults/${s.vaultId}/keys/wraps`;

    expect((await call(s.owner, "POST", path, body(s.member.userId))).status).toBe(409);
    expect((await call(s.owner, "POST", path, body(s.member.userId), randomBytes(32))).status).toBe(409);
    expect((await call(s.member, "POST", path, body(s.member.userId), s.vk)).status).toBe(403);
    expect((await call(s.owner, "POST", path, body(s.outsider.userId), s.vk)).status).toBe(404);

    const ok = await call(s.owner, "POST", path, body(s.member.userId), s.vk);
    expect(ok.status).toBe(201);
    const { rows } = await pool.query("SELECT 1 FROM vault_key_requests WHERE vault_id = $1", [s.vaultId]);
    expect(rows).toHaveLength(0);
    expect((await call(s.member, "GET", `/vaults/${s.vaultId}/keys/mine`)).status).toBe(200);
  });

  it("a removed member loses their wraps and requests", async () => {
    const s = await setup();
    await init(s);
    await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/wraps`, {
      userId: s.member.userId, generation: 1, sealedVk: b64(randomBytes(80)),
    }, s.vk);
    const del = await call(s.owner, "DELETE", `/orgs/${s.orgId}/members/${s.member.userId}`);
    expect(del.status).toBe(200);
    const { rows } = await pool.query("SELECT 1 FROM vault_key_wraps WHERE user_id = $1", [s.member.userId]);
    expect(rows).toHaveLength(0);
  });

  it("never overwrites key material (wraps, account keys, device keys)", async () => {
    const s = await setup();
    await init(s);
    const path = `/vaults/${s.vaultId}/keys/wraps`;
    const first = b64(randomBytes(80));
    await call(s.owner, "POST", path, { userId: s.member.userId, generation: 1, sealedVk: first }, s.vk);
    await call(s.owner, "POST", path, { userId: s.member.userId, generation: 1, sealedVk: b64(randomBytes(80)) }, s.vk);
    const mine = await (await call(s.member, "GET", `/vaults/${s.vaultId}/keys/mine`)).json();
    expect(mine.wraps[0].sealedVk).toBe(first);

    const pk = b64(randomBytes(32));
    expect((await call(s.owner, "PUT", "/me/keys", { publicKey: pk })).status).toBe(200);
    expect((await call(s.owner, "PUT", "/me/keys", { publicKey: pk })).status).toBe(200);
    expect((await call(s.owner, "PUT", "/me/keys", { publicKey: b64(randomBytes(32)) })).status).toBe(409);
    expect((await (await call(s.owner, "GET", "/me/keys")).json()).publicKey).toBe(pk);

    const dk = b64(randomBytes(64));
    expect((await call(s.owner, "PUT", "/me/devices/d1/key", { privWrapped: dk })).status).toBe(200);
    expect((await call(s.owner, "PUT", "/me/devices/d1/key", { privWrapped: b64(randomBytes(64)) })).status).toBe(409);
  });

  it("me/keys and device keys round-trip", async () => {
    const s = await setup();
    const pk = b64(randomBytes(32));
    await call(s.owner, "PUT", "/me/keys", { publicKey: pk, privWrappedRecovery: b64(randomBytes(64)) });
    expect((await call(s.owner, "PUT", "/me/devices/mac-1/key", { privWrapped: b64(randomBytes(64)) })).status).toBe(200);
    const me = await (await call(s.owner, "GET", "/me/keys")).json();
    expect(me.publicKey).toBe(pk);
    expect(me.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual(["mac-1"]);
  });

  it("requireVaultKey: unkeyed passes, keyed needs the right key", async () => {
    const s = await setup();
    const probe = new Hono();
    probe.get("/p", async (c) => {
      const r = await requireVaultKey(c, s.vaultId);
      return r.ok ? c.json({ keyed: r.keyed, hasKey: !!r.key }) : r.response;
    });
    const hit = (vk?: Buffer) => probe.request("/p", { headers: vk ? { "x-baalda-vk": b64(vk) } : {} });
    expect(await (await hit()).json()).toEqual({ keyed: false, hasKey: false });
    await init(s);
    const none = await hit();
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: "key_required" });
    expect((await hit(randomBytes(32))).status).toBe(409);
    expect(await (await hit(s.vk)).json()).toEqual({ keyed: true, hasKey: true });
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    expect(await (await hit()).json()).toEqual({ keyed: false, hasKey: false });
  });
});

describe("sync token key suffix", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLWJ5dGVzLWFyZS0zMi1ieXRlcy1sb25nISE";
  it("splits on the last dot only when the suffix is a 32-byte key", () => {
    const vk = randomBytes(32);
    const split = splitSyncToken(`${jwt}.${b64(vk)}`);
    expect(split.jwt).toBe(jwt);
    expect(split.vk?.equals(vk)).toBe(true);
    expect(splitSyncToken(jwt)).toEqual({ jwt, vk: null });
    expect(splitSyncToken(`${jwt}.${b64(randomBytes(16))}`).vk).toBeNull();
    expect(splitSyncToken("")).toEqual({ jwt: "", vk: null });
  });
  it("redacts the key from log output", () => {
    const vk = b64(randomBytes(32));
    const line = redactToken(`${jwt}.${vk}`);
    expect(line).not.toContain(vk);
    expect(line).toBe(`<token length ${jwt.length}>`);
  });
});
