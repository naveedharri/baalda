import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  CLIENT_VERSION_HEADER,
  CLIENT_VERSION_PARAM,
  clientVersionPolicy,
  judgeClientVersion,
  parseClientVersion,
} from "../src/http/client-version.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Issue #251: a build older than the floor (or one that sends no version at
 * all) must not be able to obtain the means to push CRDT state, while a
 * current build is unaffected and reads stay open.
 */

const app = createApp(testAppDeps());

/** POST as the desktop does: the version rides as a query parameter. */
function post(path: string, token: string | null, body: unknown, version?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const url = new URL(`http://local${path}`);
  if (version !== undefined) url.searchParams.set(CLIENT_VERSION_PARAM, version);
  return app.fetch(
    new Request(url.toString(), { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

describe("client version policy (pure)", () => {
  it("parses x.y.z and ignores a pre-release suffix", () => {
    expect(parseClientVersion("0.1.49")).toEqual([0, 1, 49]);
    expect(parseClientVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseClientVersion("0.1.49-staging.3")).toEqual([0, 1, 49]);
    expect(parseClientVersion("garbage")).toBeNull();
    expect(parseClientVersion("")).toBeNull();
    expect(parseClientVersion(undefined)).toBeNull();
  });

  it("allows header-less clients by default, so installed builds keep syncing", () => {
    const policy = clientVersionPolicy({});
    expect(policy.allowUnversioned).toBe(true);
    expect(judgeClientVersion(undefined, policy)).toEqual({ ok: true });
    // ...while a build that reports itself is still held to the floor.
    expect(judgeClientVersion("0.1.48", policy)).toMatchObject({ ok: false, reason: "below_minimum" });
  });

  it("refuses below the floor and missing headers under UNVERSIONED_CLIENTS=refuse", () => {
    const policy = clientVersionPolicy({ UNVERSIONED_CLIENTS: "refuse" });
    expect(policy.minRaw).toBe("0.1.49");
    expect(judgeClientVersion("0.1.48", policy)).toMatchObject({ ok: false, reason: "below_minimum" });
    expect(judgeClientVersion("0.1.49", policy)).toEqual({ ok: true });
    expect(judgeClientVersion("0.2.0", policy)).toEqual({ ok: true });
    // Staging cut from the floor's own base carries the same guards.
    expect(judgeClientVersion("0.1.49-staging.7", policy)).toEqual({ ok: true });
    expect(judgeClientVersion(undefined, policy)).toMatchObject({ ok: false, reason: "missing" });
    expect(judgeClientVersion("not-a-version", policy)).toMatchObject({ ok: false, reason: "missing" });
  });

  it("is configurable: a custom floor, `off`, and UNVERSIONED_CLIENTS=allow", () => {
    const custom = clientVersionPolicy({ MIN_CLIENT_VERSION: "0.2.0" });
    expect(judgeClientVersion("0.1.99", custom)).toMatchObject({ ok: false });
    const off = clientVersionPolicy({ MIN_CLIENT_VERSION: "off" });
    expect(judgeClientVersion("0.0.1", off)).toEqual({ ok: true });
    const allow = clientVersionPolicy({ UNVERSIONED_CLIENTS: "allow" });
    expect(() => clientVersionPolicy({ UNVERSIONED_CLIENTS: "maybe" })).toThrow();
    expect(judgeClientVersion(undefined, allow)).toEqual({ ok: true });
    // A present-but-old header is still judged against the floor.
    expect(judgeClientVersion("0.1.10", allow)).toMatchObject({ ok: false });
    expect(() => clientVersionPolicy({ MIN_CLIENT_VERSION: "latest" })).toThrow();
  });
});

describe("content-write routes refuse outdated clients (426 client_outdated)", () => {
  const saved = { ...process.env };
  beforeEach(async () => {
    await resetDb();
    // The strict posture an operator enables once the header has rolled out.
    process.env.UNVERSIONED_CLIENTS = "refuse";
    delete process.env.MIN_CLIENT_VERSION;
  });
  afterEach(() => {
    for (const key of ["UNVERSIONED_CLIENTS", "MIN_CLIENT_VERSION"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  async function seed() {
    const owner = await signUp("owner@cv.com");
    const org = await seedOrg("Acme", "acme-cv");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    const doc = await seedNote(vault, null, "n.md");
    return { owner, vault, doc };
  }

  it("a simulated old client (no header) is refused a sync token; a current client is not", async () => {
    const { owner, doc } = await seed();

    const old = await post("/api/sync-token", owner.token, { docId: doc });
    expect(old.status).toBe(426);
    expect(await old.json()).toMatchObject({ code: "client_outdated", reason: "missing" });

    const stale = await post("/api/sync-token", owner.token, { docId: doc }, "0.1.40");
    expect(stale.status).toBe(426);
    expect(await stale.json()).toMatchObject({ code: "client_outdated", reason: "below_minimum" });

    const current = await post("/api/sync-token", owner.token, { docId: doc }, "0.1.74");
    expect(current.status).toBe(200);

    // The header form is accepted too (non-browser clients).
    const viaHeader = await app.fetch(
      new Request("http://local/api/sync-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${owner.token}`,
          [CLIENT_VERSION_HEADER]: "0.1.74",
        },
        body: JSON.stringify({ docId: doc }),
      }),
    );
    expect(viaHeader.status).toBe(200);
  });

  it("refuses the vault-channel token and the batch push too", async () => {
    const { owner, vault } = await seed();

    expect((await post("/api/vault-sync-token", owner.token, { vaultId: vault })).status).toBe(426);
    expect(
      (await post("/api/vault-sync-token", owner.token, { vaultId: vault }, "0.1.73")).status,
    ).toBe(200);

    const batch = await post(`/api/vaults/${vault}/docs/batch`, owner.token, { items: [] }, "0.1.2");
    expect(batch.status).toBe(426);
  });

  it("leaves reads open so an old build can still sign in and list", async () => {
    const { owner } = await seed();
    const res = await app.fetch(
      new Request("http://local/api/vaults", {
        headers: { authorization: `Bearer ${owner.token}` },
      }),
    );
    expect(res.status).not.toBe(426);
  });

  it("the default (unset) lets a header-less client through, so installed builds keep working", async () => {
    const { owner, doc } = await seed();
    delete process.env.UNVERSIONED_CLIENTS;
    expect((await post("/api/sync-token", owner.token, { docId: doc })).status).toBe(200);
    // A reporting build below the floor is still refused under the default.
    expect((await post("/api/sync-token", owner.token, { docId: doc }, "0.1.40")).status).toBe(426);
  });
});
