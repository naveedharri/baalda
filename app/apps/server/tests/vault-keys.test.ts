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
import { markEncryptionRequested, seedMember, seedVault } from "./helpers/seed.js";

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

/** `requested`: the vault was opted in ("Encrypt this vault"); default on. */
async function setup({ requested = true }: { requested?: boolean } = {}) {
  const owner = await signUp("owner@keys.test");
  const member = await signUp("member@keys.test");
  const outsider = await signUp("outsider@keys.test");
  const org = await createOrg(owner, "Keys", `keys-${Date.now()}`);
  await seedMember(org.id, member.userId, "member");
  const vaultId = await seedVault(org.id);
  if (requested) await markEncryptionRequested(vaultId, owner.userId);
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
    expect(await res.json()).toMatchObject({
      pending: true,
      generation: 1,
      vkCheck: b64(
        (await pool.query("SELECT vk_check FROM vaults WHERE id = $1", [s.vaultId])).rows[0].vk_check,
      ),
    });
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
    expect((await call(s.member, "POST", path, body(s.owner.userId), s.vk)).status).toBe(403);
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
    // No recovery wrap (account kit dropped): accepted, stored as null.
    expect((await call(s.owner, "PUT", "/me/keys", { publicKey: pk, privWrappedRecovery: null })).status).toBe(200);
    expect((await (await call(s.owner, "GET", "/me/keys")).json()).privWrappedRecovery).toBeNull();
    const same = await call(s.owner, "PUT", "/me/keys", { publicKey: pk });
    expect(await same.json()).toEqual({ saved: true, replaced: false });

    // Replacing the account key (lost every device) keeps the old one in history.
    const pk2 = b64(randomBytes(32));
    const rep = await call(s.owner, "PUT", "/me/keys", { publicKey: pk2 });
    expect(await rep.json()).toEqual({ saved: true, replaced: true });
    const me = await (await call(s.owner, "GET", "/me/keys")).json();
    expect(me.publicKey).toBe(pk2);
    expect(me.keyChangedAt).not.toBeNull();
    const hist = await pool.query("SELECT public_key FROM user_key_history WHERE user_id = $1", [s.owner.userId]);
    expect(hist.rows.map((r) => b64(r.public_key))).toEqual([pk]);

    await call(s.owner, "POST", "/me/devices", { deviceId: "d1", publicKey: b64(randomBytes(32)) });
    const dk = b64(randomBytes(64));
    expect((await call(s.owner, "PUT", "/me/devices/d1/key", { privWrapped: dk })).status).toBe(200);
    expect((await call(s.owner, "PUT", "/me/devices/d1/key", { privWrapped: b64(randomBytes(64)) })).status).toBe(409);
  });

  it("device links: register, list pending, approve, fetch, revoke; never another user's", async () => {
    const s = await setup();
    const devPk = b64(randomBytes(32));
    expect((await call(s.member, "POST", "/me/devices", { deviceId: "laptop", publicKey: devPk, name: "Laptop" })).status).toBe(201);
    // Idempotent; a different key for the same device is refused.
    expect((await call(s.member, "POST", "/me/devices", { deviceId: "laptop", publicKey: devPk })).status).toBe(200);
    expect((await call(s.member, "POST", "/me/devices", { deviceId: "laptop", publicKey: b64(randomBytes(32)) })).status).toBe(409);

    const pending = await (await call(s.member, "GET", "/me/devices/pending")).json();
    expect(pending.devices).toMatchObject([{ deviceId: "laptop", publicKey: devPk, name: "Laptop" }]);
    // Another user sees nothing and cannot approve it.
    expect((await (await call(s.owner, "GET", "/me/devices/pending")).json()).devices).toEqual([]);
    expect((await call(s.owner, "PUT", "/me/devices/laptop/key", { privWrapped: b64(randomBytes(64)) })).status).toBe(404);

    expect((await call(s.member, "GET", "/me/devices/laptop/key")).status).toBe(404);
    const wrapped = b64(randomBytes(64));
    expect((await call(s.member, "PUT", "/me/devices/laptop/key", { privWrapped: wrapped })).status).toBe(200);
    const got = await call(s.member, "GET", "/me/devices/laptop/key");
    expect(await got.json()).toEqual({ privWrapped: wrapped });
    expect((await (await call(s.member, "GET", "/me/devices/pending")).json()).devices).toEqual([]);
    expect((await call(s.owner, "GET", "/me/devices/laptop/key")).status).toBe(404);

    // Remove: the wrap is kept (revoked), never deleted, and no longer served.
    expect((await call(s.member, "DELETE", "/me/devices/laptop")).status).toBe(200);
    expect((await call(s.member, "GET", "/me/devices/laptop/key")).status).toBe(404);
    const kept = await pool.query("SELECT revoked_at FROM user_device_keys WHERE user_id = $1", [s.member.userId]);
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0].revoked_at).not.toBeNull();

    // Pending cap.
    for (let i = 0; i < 5; i++) {
      expect((await call(s.member, "POST", "/me/devices", { deviceId: `d${i}`, publicKey: b64(randomBytes(32)) })).status).toBe(201);
    }
    expect((await call(s.member, "POST", "/me/devices", { deviceId: "d9", publicKey: b64(randomBytes(32)) })).status).toBe(429);
  });

  it("self-wrap with a valid key; a re-seal after a key change keeps the old wrap in history", async () => {
    const s = await setup();
    await init(s);
    const path = `/vaults/${s.vaultId}/keys/wraps`;
    // A member with no wrap cannot wrap for others, but may self-wrap with the key.
    expect((await call(s.member, "POST", path, { userId: s.owner.userId, generation: 1, sealedVk: b64(randomBytes(80)) }, s.vk)).status).toBe(403);
    expect((await call(s.member, "POST", path, { userId: s.member.userId, generation: 1, sealedVk: b64(randomBytes(80)) })).status).toBe(409);
    const own = b64(randomBytes(80));
    expect((await call(s.member, "POST", path, { userId: s.member.userId, generation: 1, sealedVk: own }, s.vk)).status).toBe(201);

    await call(s.member, "PUT", "/me/keys", { publicKey: b64(randomBytes(32)) });
    await new Promise((r) => setTimeout(r, 5));
    await call(s.member, "PUT", "/me/keys", { publicKey: b64(randomBytes(32)) }); // replaced
    const mine = await call(s.member, "GET", `/vaults/${s.vaultId}/keys/mine`);
    expect(mine.status).toBe(202);
    const reqs = await (await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/requests`)).json();
    expect(reqs.requests[0].keyChangedAt).not.toBeNull();

    const fresh = b64(randomBytes(80));
    expect((await call(s.owner, "POST", path, { userId: s.member.userId, generation: 1, sealedVk: fresh }, s.vk)).status).toBe(201);
    const after = await (await call(s.member, "GET", `/vaults/${s.vaultId}/keys/mine`)).json();
    expect(after.wraps.map((w: { sealedVk: string }) => w.sealedVk)).toEqual([fresh]);
    const hist = await pool.query("SELECT sealed_vk FROM vault_key_wrap_history WHERE user_id = $1", [s.member.userId]);
    expect(hist.rows.map((r) => b64(r.sealed_vk))).toEqual([own]);
  });

  it("keys/mine on an unkeyed vault reports the conversion gate (default off)", async () => {
    const s = await setup({ requested: false });
    const res = await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/mine`);
    expect(await res.json()).toEqual({ keyed: false, conversionAllowed: false, encryptionRequested: false });
    vi.stubEnv("VAULT_KEY_CONVERSION", "on");
    vi.stubEnv("MIN_CLIENT_VERSION", "0.1.90");
    const mine = async (version?: string) =>
      (await app.request(`/api/vaults/${s.vaultId}/keys/mine`, {
        headers: { ...authHeaders(s.owner), ...(version ? { "x-baalda-version": version } : {}) },
      })).json();
    // An existing vault stays unkeyed until an owner/admin opts it in.
    expect(await mine("0.1.95")).toEqual({ keyed: false, conversionAllowed: false, encryptionRequested: false });
    expect((await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/request-encryption`)).status).toBe(201);
    expect((await mine("0.1.80")).conversionAllowed).toBe(false);
    expect(await mine("0.1.95")).toEqual({ keyed: false, conversionAllowed: true, encryptionRequested: true });
    expect((await mine()).conversionAllowed).toBe(false);
    // Requested but the rollout gate is closed: not allowed, but reported as requested.
    vi.stubEnv("VAULT_KEY_CONVERSION", "off");
    expect(await mine("0.1.95")).toEqual({ keyed: false, conversionAllowed: false, encryptionRequested: true });
  });

  it("request-encryption: owner/admin only, idempotent, one-way, audited", async () => {
    const s = await setup({ requested: false });
    const admin = await signUp("admin@keys.test");
    await seedMember(s.orgId, admin.userId, "admin");
    const path = `/vaults/${s.vaultId}/keys/request-encryption`;
    const state = async () =>
      (await pool.query("SELECT encryption_requested_at, encryption_requested_by FROM vaults WHERE id = $1", [s.vaultId])).rows[0];

    const denied = await call(s.member, "POST", path);
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("access_manager_required");
    expect((await call(s.outsider, "POST", path)).status).toBe(404);
    expect((await state()).encryption_requested_at).toBeNull();

    const first = await call(admin, "POST", path);
    expect(first.status).toBe(201);
    const after = await state();
    expect(after.encryption_requested_at).not.toBeNull();
    expect(after.encryption_requested_by).toBe(admin.userId);

    // Repeat (even by the owner) changes nothing.
    const again = await call(s.owner, "POST", path);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ encryptionRequested: true, requestedBy: admin.userId });
    expect(await state()).toEqual(after);

    const audit = await pool.query(
      "SELECT actor_user_id, entity_type, entity_id, action FROM access_audit WHERE organization_id = $1 AND action = 'encryption_requested'",
      [s.orgId],
    );
    expect(audit.rows).toEqual([
      { actor_user_id: admin.userId, entity_type: "vault", entity_id: s.vaultId, action: "encryption_requested" },
    ]);
    // A member still reads the state (UI shows "being set up").
    expect((await (await call(s.member, "GET", `/vaults/${s.vaultId}/keys/mine`)).json()).encryptionRequested).toBe(true);
  });

  it("pending and init refuse a vault nobody opted in; both work once requested", async () => {
    const s = await setup({ requested: false });
    const vkCheck = b64(makeVkCheck(s.vk, s.vaultId));
    const pending = () =>
      call(s.owner, "POST", `/vaults/${s.vaultId}/keys/pending`, { vkCheck, generation: 1, deviceId: "d1" }, s.vk);
    const unchanged = async () => {
      const v = await pool.query("SELECT vk_check FROM vaults WHERE id = $1", [s.vaultId]);
      expect(v.rows[0].vk_check).toBeNull();
      for (const t of ["vault_pending_keys", "vault_key_wraps", "vault_crypto_state"]) {
        expect((await pool.query(`SELECT 1 FROM ${t} WHERE vault_id = $1`, [s.vaultId])).rowCount).toBe(0);
      }
    };

    const p = await pending();
    expect(p.status).toBe(409);
    expect((await p.json()).code).toBe("encryption_not_requested");
    const i = await init(s);
    expect(i.status).toBe(409);
    expect((await i.json()).code).toBe("encryption_not_requested");
    await unchanged();

    expect((await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/request-encryption`)).status).toBe(201);
    expect((await pending()).status).toBe(200);
    // Init must present the SAME check bytes as the pending row.
    const done = await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/init`, {
      vkCheck,
      generation: 1,
      sealedVkForSelf: b64(randomBytes(80)),
    });
    expect(done.status).toBe(201);
    const v = await pool.query("SELECT vk_check FROM vaults WHERE id = $1", [s.vaultId]);
    expect(v.rows[0].vk_check).not.toBeNull();
  });

  it("request-encryption is not there with the flag off", async () => {
    const s = await setup({ requested: false });
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    expect((await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/request-encryption`)).status).toBe(404);
  });

  it("a vault created with vault keys on is requested automatically; flag off sets nothing", async () => {
    const owner = await signUp("creator@keys.test");
    const org = await createOrg(owner, "Create", `create-${Date.now()}`);
    const create = async (name: string) => {
      const res = await call(owner, "POST", "/vaults", { name, organizationId: org.id });
      expect(res.status).toBe(201);
      const { id } = await res.json();
      return (await pool.query("SELECT encryption_requested_at, encryption_requested_by FROM vaults WHERE id = $1", [id])).rows[0];
    };
    const on = await create("On");
    expect(on.encryption_requested_at).not.toBeNull();
    expect(on.encryption_requested_by).toBe(owner.userId);
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    expect(await create("Off")).toEqual({ encryption_requested_at: null, encryption_requested_by: null });
  });

  it("/health advertises vault-keys only with the flag on", async () => {
    expect((await (await app.request("/health")).json()).features).toContain("vault-keys");
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    expect((await (await app.request("/health")).json()).features).not.toContain("vault-keys");
  });

  it("me/keys and device keys round-trip", async () => {
    const s = await setup();
    const pk = b64(randomBytes(32));
    await call(s.owner, "PUT", "/me/keys", { publicKey: pk, privWrappedRecovery: b64(randomBytes(64)) });
    await call(s.owner, "POST", "/me/devices", { deviceId: "mac-1", publicKey: b64(randomBytes(32)) });
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
