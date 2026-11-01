// SPDX-License-Identifier: Apache-2.0
//
// Seamless vault keys (contract A, B1–B4, C): the vault key reaches an
// invited or code-joining person without a teammate online, and every stored
// wrap comes from a device that proved it holds the key.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { auth } from "../src/auth/auth.js";
import { memoryOutbox } from "../src/email/mailer.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, bearerHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { markEncryptionRequested, seedMember, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());
const b64 = (b: Buffer) => b.toString("base64");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const secret = () => Array.from(randomBytes(26), (x) => CROCKFORD[x % 32]).join("");

function call(user: TestUser, method: string, path: string, body?: unknown, vk?: Buffer) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      ...authHeaders(user),
      "x-baalda-version": VAULT_KEYS_MIN_DESKTOP,
      ...(vk ? { "x-baalda-vk": b64(vk) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setup() {
  const owner = await signUp("owner@seamless.test");
  const member = await signUp("member@seamless.test");
  const org = await createOrg(owner, "Seamless", `seamless-${Date.now()}`);
  await seedMember(org.id, member.userId, "member");
  const vaultId = await seedVault(org.id);
  await markEncryptionRequested(vaultId, owner.userId);
  const vk = randomBytes(32);
  const init = await call(owner, "POST", `/vaults/${vaultId}/keys/init`, {
    vkCheck: b64(makeVkCheck(vk, vaultId)),
    generation: 1,
    sealedVkForSelf: b64(randomBytes(80)),
  });
  expect(init.status).toBe(201);
  return { owner, member, orgId: org.id, vaultId, vk };
}

async function publishKey(user: TestUser, key = randomBytes(32)) {
  expect((await call(user, "PUT", "/me/keys", { publicKey: b64(key) })).status).toBe(200);
  return key;
}

describe("seamless vault keys", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    memoryOutbox.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("A: keys/requests lists members with an account key and no wrap as `missing`", async () => {
    const s = await setup();
    const third = await signUp("third@seamless.test");
    await seedMember(s.orgId, third.userId, "member");
    const noKey = await signUp("nokey@seamless.test");
    await seedMember(s.orgId, noKey.userId, "member");
    await publishKey(s.member);
    await publishKey(third);
    // `third` asked (keys/mine files a request); `member` never did.
    expect((await call(third, "GET", `/vaults/${s.vaultId}/keys/mine`)).status).toBe(202);

    const res = await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/requests`);
    expect(res.status).toBe(200);
    const { requests } = (await res.json()) as { requests: Array<{ userId: string; kind: string }> };
    const byUser = Object.fromEntries(requests.map((r) => [r.userId, r.kind]));
    expect(byUser).toEqual({ [s.member.userId]: "missing", [third.userId]: "request" });

    // Once sealed, the member is no longer missing.
    await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/wraps`, {
      userId: s.member.userId, generation: 1, sealedVk: b64(randomBytes(80)),
    }, s.vk);
    const after = (await (await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/requests`)).json()) as {
      requests: Array<{ userId: string }>;
    };
    expect(after.requests.map((r) => r.userId)).toEqual([third.userId]);
  });

  it("B1: vaultKeys needs the key; no proof creates no invitation; with proof the secret rides only in the fragment", async () => {
    const s = await setup();
    const S = secret();
    const wrappedVk = b64(randomBytes(72));
    const body = {
      emails: ["new@seamless.test"],
      role: "member",
      access: null,
      vaultKeys: { vaultId: s.vaultId, generation: 1, items: [{ email: "new@seamless.test", wrappedVk, secret: S }] },
    };
    const refused = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, body);
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("key_required");
    expect((await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, body, randomBytes(32))).status).toBe(409);
    const { rows: none } = await pool.query(`SELECT 1 FROM invitation WHERE "organizationId" = $1`, [s.orgId]);
    expect(none).toHaveLength(0);

    const ok = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, body, s.vk);
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text.includes(S)).toBe(false);
    const { results } = JSON.parse(text) as { results: Array<Record<string, unknown>> };
    expect(results[0]).toMatchObject({ email: "new@seamless.test", emailed: true, publicKey: null, inviteeUserId: null });
    const invitationId = results[0].invitationId as string;
    const { rows } = await pool.query("SELECT * FROM invitation_vault_keys WHERE invitation_id = $1", [invitationId]);
    expect(rows[0].wrapped_vk.toString("base64")).toBe(wrappedVk);
    expect(JSON.stringify(rows).includes(S)).toBe(false);
    const mail = memoryOutbox.find((m) => m.to === "new@seamless.test");
    expect(JSON.stringify(mail)).toContain(`/invite/${invitationId}#k=${S}`);

    // A vault of another org is refused; malformed envelope is a 400.
    const other = await signUp("other@seamless.test");
    const otherOrg = await createOrg(other, "Other", `other-${Date.now()}`);
    const otherVault = await seedVault(otherOrg.id);
    expect((await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, {
      ...body, emails: ["x@seamless.test"], vaultKeys: { ...body.vaultKeys, vaultId: otherVault },
    }, s.vk)).status).toBe(400);
    expect((await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, {
      ...body, emails: ["y@seamless.test"], vaultKeys: { vaultId: s.vaultId },
    }, s.vk)).status).toBe(400);
  });

  it("B1 without vaultKeys is unchanged; invitee's existing account key is reported", async () => {
    const s = await setup();
    const existing = await signUp("existing@seamless.test");
    const pk = await publishKey(existing);
    const res = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, { emails: ["existing@seamless.test"] });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(results[0]).toMatchObject({ publicKey: b64(pk), inviteeUserId: existing.userId });
    const mail = memoryOutbox.find((m) => m.to === "existing@seamless.test");
    expect(JSON.stringify(mail)).not.toContain("#k=");
  });

  it("B2+B3+B4: a direct seal to the invitee's current key becomes their wrap on accept; secret wrap stays fetchable", async () => {
    const s = await setup();
    const invitee = await signUp("invitee@seamless.test");
    const pk = await publishKey(invitee);
    const wrappedVk = b64(randomBytes(72));
    const res = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, {
      emails: ["invitee@seamless.test"],
      vaultKeys: { vaultId: s.vaultId, generation: 1, items: [{ email: "invitee@seamless.test", wrappedVk, secret: secret() }] },
    }, s.vk);
    const invitationId = ((await res.json()) as { results: Array<{ invitationId: string }> }).results[0].invitationId;
    const sealedVk = b64(randomBytes(80));
    const path = `/vaults/${s.vaultId}/keys/invite-wraps/${invitationId}`;
    const sealBody = { sealedVk, publicKey: b64(pk), generation: 1 };

    expect((await call(s.owner, "PUT", path, sealBody)).status).toBe(409);
    expect((await call(s.member, "PUT", path, sealBody, s.vk)).status).toBe(403);
    expect((await call(s.owner, "PUT", `/vaults/${s.vaultId}/keys/invite-wraps/nope`, sealBody, s.vk)).status).toBe(404);
    expect((await call(s.owner, "PUT", path, sealBody, s.vk)).status).toBe(201);
    expect((await call(s.owner, "PUT", path, sealBody, s.vk)).status).toBe(201);

    await auth.api.acceptInvitation({ headers: bearerHeaders(invitee), body: { invitationId } });
    const { rows } = await pool.query(
      "SELECT generation, sealed_vk, sealed_by_user_id FROM vault_key_wraps WHERE vault_id = $1 AND user_id = $2",
      [s.vaultId, invitee.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed_vk.toString("base64")).toBe(sealedVk);
    expect(rows[0].sealed_by_user_id).toBe(s.owner.userId);
    const mine = await call(invitee, "GET", `/vaults/${s.vaultId}/keys/mine`);
    expect(mine.status).toBe(200);

    const fetched = await call(invitee, "GET", `/vaults/${s.vaultId}/keys/invite-wrap`);
    expect(await fetched.json()).toEqual({ wraps: [{ invitationId, generation: 1, wrappedVk }] });
    // Another member never sees someone else's invitation wraps.
    expect(await (await call(s.member, "GET", `/vaults/${s.vaultId}/keys/invite-wrap`)).json()).toEqual({ wraps: [] });

    // Accepted now: B2 no longer applies.
    expect((await call(s.owner, "PUT", path, sealBody, s.vk)).status).toBe(404);
  });

  it("B3: a seal to an older account key is skipped; the accept still succeeds", async () => {
    const s = await setup();
    const invitee = await signUp("stale@seamless.test");
    const oldKey = await publishKey(invitee);
    const res = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, { emails: ["stale@seamless.test"] });
    const invitationId = ((await res.json()) as { results: Array<{ invitationId: string }> }).results[0].invitationId;
    expect((await call(s.owner, "PUT", `/vaults/${s.vaultId}/keys/invite-wraps/${invitationId}`, {
      sealedVk: b64(randomBytes(80)), publicKey: b64(oldKey), generation: 1,
    }, s.vk)).status).toBe(201);
    await publishKey(invitee); // replaced (lost every device)
    await auth.api.acceptInvitation({ headers: bearerHeaders(invitee), body: { invitationId } });
    const { rows } = await pool.query("SELECT 1 FROM member WHERE \"userId\" = $1 AND \"organizationId\" = $2", [
      invitee.userId, s.orgId,
    ]);
    expect(rows).toHaveLength(1);
    const { rows: wraps } = await pool.query("SELECT 1 FROM vault_key_wraps WHERE user_id = $1", [invitee.userId]);
    expect(wraps).toHaveLength(0);
  });

  it("B3 on the join-code path with a live invitation", async () => {
    const s = await setup();
    const invitee = await signUp("bycode@seamless.test");
    const pk = await publishKey(invitee);
    const res = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, { emails: ["bycode@seamless.test"] });
    const invitationId = ((await res.json()) as { results: Array<{ invitationId: string }> }).results[0].invitationId;
    await call(s.owner, "PUT", `/vaults/${s.vaultId}/keys/invite-wraps/${invitationId}`, {
      sealedVk: b64(randomBytes(80)), publicKey: b64(pk), generation: 1,
    }, s.vk);
    await pool.query("UPDATE session SET \"activeOrganizationId\" = $1 WHERE \"userId\" = $2", [s.orgId, s.owner.userId]);
    const code = ((await (await call(s.owner, "GET", "/orgs/join-code")).json()) as { code: string }).code;
    const joined = await call(invitee, "POST", "/orgs/join", { code: `${code}-${secret()}` });
    expect(joined.status).toBe(200);
    const { rows } = await pool.query("SELECT 1 FROM vault_key_wraps WHERE vault_id = $1 AND user_id = $2", [
      s.vaultId, invitee.userId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("C: join-code secret wraps: owner/admin with the key, current code only, member fetch, capped, gone with the code", async () => {
    const s = await setup();
    await pool.query("UPDATE session SET \"activeOrganizationId\" = $1 WHERE \"userId\" = $2", [s.orgId, s.owner.userId]);
    const code = ((await (await call(s.owner, "GET", "/orgs/join-code")).json()) as { code: string }).code;
    const J = secret();
    const secretHash = createHash("sha256").update(J, "utf8").digest("hex");
    const wrappedVk = b64(randomBytes(72));
    const body = { secretHash, wrappedVk, generation: 1, code };
    const path = `/vaults/${s.vaultId}/keys/join-wraps`;

    expect((await call(s.owner, "PUT", path, body)).status).toBe(409);
    expect((await call(s.member, "PUT", path, body, s.vk)).status).toBe(403);
    const stale = await call(s.owner, "PUT", path, { ...body, code: "ZZZZZZZZ" }, s.vk);
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("stale_code");
    expect((await call(s.owner, "PUT", path, body, s.vk)).status).toBe(201);

    // A newcomer joins with `<code>-<J>` and fetches the wrap.
    const joiner = await signUp("joiner@seamless.test");
    const joined = await call(joiner, "POST", "/orgs/join", { code: `${code}-${J}` });
    expect(joined.status).toBe(200);
    const got = await call(joiner, "GET", `/vaults/${s.vaultId}/keys/join-wrap?h=${secretHash}`);
    expect(await got.json()).toEqual({ wrap: { generation: 1, wrappedVk } });
    expect(await (await call(joiner, "GET", `/vaults/${s.vaultId}/keys/join-wrap?h=${"0".repeat(64)}`)).json()).toEqual({
      wrap: null,
    });
    const outsider = await signUp("outsider@seamless.test");
    expect((await call(outsider, "GET", `/vaults/${s.vaultId}/keys/join-wrap?h=${secretHash}`)).status).toBe(404);

    // At most 20 per vault, oldest dropped.
    for (let i = 0; i < 21; i++) {
      const h = createHash("sha256").update(`x${i}`).digest("hex");
      await call(s.owner, "PUT", path, { ...body, secretHash: h }, s.vk);
    }
    const { rows: n } = await pool.query("SELECT count(*)::int AS n FROM vault_join_wraps WHERE vault_id = $1", [s.vaultId]);
    expect(n[0].n).toBe(20);

    // Regenerating or deleting the code deletes its wraps.
    await pool.query("UPDATE org_join_codes SET code = 'NEWCODE2' WHERE organization_id = $1", [s.orgId]);
    const { rows: gone } = await pool.query("SELECT 1 FROM vault_join_wraps WHERE vault_id = $1", [s.vaultId]);
    expect(gone).toHaveLength(0);
  });

  it("B5: the invite page carries the fragment's secret onto the deep link in the browser only", async () => {
    const s = await setup();
    const res = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, { emails: ["page@seamless.test"] });
    const invitationId = ((await res.json()) as { results: Array<{ invitationId: string }> }).results[0].invitationId;
    const page = await app.request(`/invite/${invitationId}`, { headers: { host: "notes.example.com" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html.slice(html.indexOf('id="open-invite"')))![1];

    const run = (hash: string) => {
      const anchor = { href: "", setAttribute(_: string, v: string) { this.href = v; } };
      const loc = { hash, pathname: `/invite/${invitationId}`, search: "", href: "" };
      let replaced: string | null = null;
      new Function("location", "document", "history", script)(
        loc,
        { getElementById: () => anchor },
        { replaceState: (_a: unknown, _b: unknown, url: string) => { replaced = url; } },
      );
      return { href: loc.href, button: anchor.href, replaced };
    };
    const base = `baalda://invite/${invitationId}?server=${encodeURIComponent("http://notes.example.com")}`;
    const S = secret();
    expect(run(`#k=${S}`)).toEqual({ href: `${base}&k=${S}`, button: `${base}&k=${S}`, replaced: `/invite/${invitationId}` });
    // No or malformed secret: the plain link, nothing rewritten.
    expect(run("")).toEqual({ href: base, button: "", replaced: null });
    expect(run("#k=<script>")).toEqual({ href: base, button: "", replaced: null });
  });

  it("flag off: vaultKeys is ignored and the new routes are not there", async () => {
    const s = await setup();
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    const res = await call(s.owner, "POST", `/orgs/${s.orgId}/invitations`, {
      emails: ["off@seamless.test"],
      vaultKeys: { vaultId: s.vaultId, generation: 1, items: [{ email: "off@seamless.test", wrappedVk: b64(randomBytes(72)), secret: secret() }] },
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(results[0]).not.toHaveProperty("publicKey");
    const { rows } = await pool.query("SELECT 1 FROM invitation_vault_keys");
    expect(rows).toHaveLength(0);
    expect((await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/invite-wrap`)).status).toBe(404);
    expect((await call(s.owner, "GET", `/vaults/${s.vaultId}/keys/join-wrap?h=${"0".repeat(64)}`)).status).toBe(404);
  });
});
