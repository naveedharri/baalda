import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedVault } from "./helpers/seed.js";
import {
  setAppearanceChangedPublisher,
  type AppearanceChangedFields,
} from "../src/sync/member-events.js";
import { decodePubsub, encodePubsubAppearanceChanged } from "../src/sync/vault-protocol.js";

/** GET/PUT /api/orgs/:orgId/appearance — vault-level appearance. */
const rec = recordingAppDeps();
const app = createApp(rec.deps);

let published: Array<{ vaultId: string; change: AppearanceChangedFields }> = [];

function get(caller: TestUser, orgId: string) {
  return app.request(`/api/orgs/${orgId}/appearance`, { headers: authHeaders(caller) });
}
function put(caller: TestUser, orgId: string, settings: unknown) {
  return app.request(`/api/orgs/${orgId}/appearance`, {
    method: "PUT",
    headers: { ...authHeaders(caller), "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

async function setup() {
  const owner = await signUp("owner@appearance.test");
  const org = await createOrg(owner, "Look", `look-${Date.now()}`);
  const vaultId = await seedVault(org.id);
  const member = await signUp("member@appearance.test");
  await seedMember(org.id, member.userId, "member");
  const admin = await signUp("admin@appearance.test");
  await seedMember(org.id, admin.userId, "admin");
  return { owner, member, admin, orgId: org.id, vaultId };
}

describe("vault appearance", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    published = [];
    setAppearanceChangedPublisher((vaultId, change) => published.push({ vaultId, change }));
  });
  afterEach(() => setAppearanceChangedPublisher(null));
  afterAll(async () => {
    await pool.end();
  });

  it("member GET with no row returns empty settings and nulls", async () => {
    const { member, orgId } = await setup();
    const res = await get(member, orgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: {}, updatedAt: null, updatedBy: null });
  });

  it("owner PUT round-trips and members read it back", async () => {
    const { owner, member, orgId } = await setup();
    const settings = { theme: "dark", contentWidth: 72, textSize: 16, lineNumbers: true };
    const res = await put(owner, orgId, settings);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: unknown; updatedAt: string; updatedBy: string };
    expect(body.settings).toEqual(settings);
    expect(body.updatedBy).toBe(owner.userId);
    expect(typeof body.updatedAt).toBe("string");
    expect(await (await get(member, orgId)).json()).toEqual(body);
  });

  it("admin may PUT; member gets 403 access_manager_required", async () => {
    const { admin, member, orgId } = await setup();
    expect((await put(admin, orgId, { autoColors: false })).status).toBe(200);
    const res = await put(member, orgId, { theme: "light" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "access_manager_required" });
    expect((await (await get(member, orgId)).json()) as { settings: unknown }).toMatchObject({
      settings: { autoColors: false },
    });
  });

  it("non-member gets 404 not_member on GET and PUT", async () => {
    const { orgId } = await setup();
    const outsider = await signUp("x@appearance.test");
    for (const res of [await get(outsider, orgId), await put(outsider, orgId, {})]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not_member" });
    }
  });

  it("invalid key or value is 400 invalid_appearance and stores nothing", async () => {
    const { owner, orgId } = await setup();
    for (const bad of [{ font: "serif" }, { textSize: 30 }, { theme: "blue" }, { contentWidth: 900 }, { contentWidth: 59 }, { contentWidth: 80.5 }, "x", null]) {
      const res = await put(owner, orgId, bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_appearance" });
    }
    expect(await (await get(owner, orgId)).json()).toMatchObject({ settings: {}, updatedAt: null });
    expect(published).toEqual([]);
  });

  it("PUT replaces the whole object rather than merging", async () => {
    const { owner, orgId } = await setup();
    await put(owner, orgId, { theme: "dark", textSize: 18, contentWidth: "full" });
    await put(owner, orgId, { properties: "source" });
    expect(await (await get(owner, orgId)).json()).toMatchObject({ settings: { properties: "source" } });
    const res = await put(owner, orgId, {});
    expect(((await res.json()) as { settings: unknown }).settings).toEqual({});
  });

  it("PUT broadcasts appearance-changed to the vault's collections with settings inline", async () => {
    const { owner, orgId, vaultId } = await setup();
    const res = await put(owner, orgId, { theme: "light", lineNumbers: false });
    const body = (await res.json()) as { updatedAt: string };
    expect(published).toEqual([
      {
        vaultId,
        change: { orgId, settings: { theme: "light", lineNumbers: false }, updatedAt: body.updatedAt },
      },
    ]);
  });

  it("the pubsub frame round-trips", () => {
    const change = { orgId: "o1", settings: { theme: "dark" }, updatedAt: "2026-10-07T00:00:00.000Z" };
    expect(decodePubsub(encodePubsubAppearanceChanged(change))).toEqual({
      type: "appearance-changed",
      change,
    });
  });
});
