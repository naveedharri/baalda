import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault } from "./helpers/seed.js";
import { setSkillsChangedPublisher } from "../src/sync/member-events.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/** Who gets a team skill (migration 062): the Everyone row and per-person rows. */
const app = createApp(testAppDeps());

const b64 = (s: string) => Buffer.from(s).toString("base64");
const skillMd = (name: string) => `---\nname: ${name}\ndescription: Use it.\n---\n\n# ${name}\n`;

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json<T = any>(res: Response | Promise<Response>): Promise<{ status: number; body: T }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as T };
}

let owner: TestUser;
let admin: TestUser;
let sara: TestUser;
let ali: TestUser;
let orgId: string;
let published = 0;

/** A published skill, Required for everyone (today's default). */
async function publishedSkill(name: string): Promise<string> {
  const created = await json(req(admin, "POST", `/orgs/${orgId}/skills`, { name, files: [{ path: "SKILL.md", contentBase64: b64(skillMd(name)) }] }));
  const id = created.body.id as string;
  await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${id}`, { delivery: "required" }));
  const draft = (await json(req(admin, "GET", `/orgs/${orgId}/skills/${id}/draft`))).body;
  await json(req(admin, "POST", `/orgs/${orgId}/skills/${id}/publish`, { baseRevision: draft.revision }));
  return id;
}
const setAccess = (id: string, body: unknown, as: TestUser = admin) => json(req(as, "PUT", `/orgs/${orgId}/skills/${id}/access`, body));
async function manifestFor(user: TestUser) {
  const m = (await json(req(user, "GET", "/skills/manifest"))).body;
  return (m.orgs.find((o: any) => o.orgId === orgId)?.skills ?? []) as Array<{ skillId: string; delivery: string }>;
}
const listFor = async (user: TestUser) => (await json(req(user, "GET", `/orgs/${orgId}/skills`))).body.skills as any[];

describe("skill access", () => {
  beforeEach(async () => {
    await resetDb();
    published = 0;
    setSkillsChangedPublisher(() => {
      published++;
    });
    owner = await signUp("owner@skill-access.test");
    admin = await signUp("admin@skill-access.test");
    sara = await signUp("sara@skill-access.test");
    ali = await signUp("ali@skill-access.test");
    orgId = await seedOrg("Access Team", "access-team");
    await seedMember(orgId, owner.userId, "owner");
    await seedMember(orgId, admin.userId, "admin");
    await seedMember(orgId, sara.userId, "member");
    await seedMember(orgId, ali.userId, "member");
    await seedVault(orgId);
  });
  afterEach(() => setSkillsChangedPublisher(null));
  afterAll(async () => {
    await pool.end();
  });

  it("a new skill reaches everyone, and says so", async () => {
    const id = await publishedSkill("for-all");
    const access = await json(req(admin, "GET", `/orgs/${orgId}/skills/${id}/access`));
    expect(access.body.everyone).toBe("required");
    expect(access.body.people.every((p: any) => p.level === "required" && !p.own)).toBe(true);
    const card = (await listFor(sara)).find((s) => s.id === id);
    expect(card.myAccess).toBe("required");
    expect(card.everyone).toBeNull();
    expect(card.sharedWith).toMatchObject({ everyone: true, count: 4, total: 4 });
    expect((await manifestFor(sara)).map((s) => s.skillId)).toEqual([id]);
  });

  it("Everyone: No access plus one person hides it from everyone else, name included", async () => {
    const id = await publishedSkill("sales-prep");
    const before = published;
    const out = await setAccess(id, { everyone: "none", people: [{ userId: sara.userId, level: "required" }] });
    expect(out.status).toBe(200);
    expect(published).toBeGreaterThan(before);

    // Sara gets it, at her own level.
    expect(await manifestFor(sara)).toEqual([expect.objectContaining({ skillId: id, delivery: "required" })]);
    const mine = (await listFor(sara)).find((s) => s.id === id);
    expect(mine).toMatchObject({ myAccess: "required", delivery: "required" });
    expect(mine.sharedWith).toMatchObject({ everyone: false, count: 1 });

    // Ali can't see it anywhere: list, page, versions, manifest.
    expect((await listFor(ali)).some((s) => s.id === id)).toBe(false);
    expect((await json(req(ali, "GET", `/orgs/${orgId}/skills/${id}`))).status).toBe(404);
    expect((await json(req(ali, "GET", `/orgs/${orgId}/skills/${id}/versions/1`))).status).toBe(404);
    expect(await manifestFor(ali)).toEqual([]);

    // Admins still see it to manage it, but it doesn't install for them.
    const adminCard = (await listFor(admin)).find((s) => s.id === id);
    expect(adminCard).toMatchObject({ myAccess: "none", everyone: "none" });
    expect(await manifestFor(admin)).toEqual([]);
  });

  it("a person's row beats the Everyone row in both directions, and resets", async () => {
    const id = await publishedSkill("finance");
    await setAccess(id, { people: [{ userId: ali.userId, level: "none" }, { userId: sara.userId, level: "optional" }] });
    expect(await manifestFor(ali)).toEqual([]);
    expect(await manifestFor(sara)).toEqual([expect.objectContaining({ delivery: "optional" })]);
    expect(await manifestFor(owner)).toEqual([expect.objectContaining({ delivery: "required" })]);

    const access = (await setAccess(id, { people: [{ userId: ali.userId, level: null }] })).body;
    const row = access.people.find((p: any) => p.userId === ali.userId);
    expect(row).toMatchObject({ level: "required", own: false });
    expect(await manifestFor(ali)).toEqual([expect.objectContaining({ delivery: "required" })]);
  });

  it("Everyone back to Optional reopens it and sets the delivery", async () => {
    const id = await publishedSkill("reopen");
    await setAccess(id, { everyone: "none" });
    expect(await manifestFor(sara)).toEqual([]);
    await setAccess(id, { everyone: "optional" });
    expect(await manifestFor(sara)).toEqual([expect.objectContaining({ delivery: "optional" })]);
  });

  it("only owners and admins change access, only for members", async () => {
    const id = await publishedSkill("guarded");
    expect((await setAccess(id, { everyone: "none" }, sara)).status).toBe(403);
    expect((await json(req(sara, "GET", `/orgs/${orgId}/skills/${id}/access`))).status).toBe(403);
    const outsider = await signUp("outsider@skill-access.test");
    expect((await setAccess(id, { people: [{ userId: outsider.userId, level: "required" }] })).status).toBe(400);
    expect((await setAccess(id, { everyone: "maybe" })).status).toBe(400);
  });

  it("a person's Skills tab lists their level per skill", async () => {
    const shown = await publishedSkill("shown");
    const hidden = await publishedSkill("hidden");
    await setAccess(hidden, { people: [{ userId: sara.userId, level: "none" }] });

    const asAdmin = (await json(req(admin, "GET", `/orgs/${orgId}/members/${sara.userId}/skills`))).body.skills;
    expect(asAdmin.map((s: any) => [s.name, s.level, s.own])).toEqual([
      ["hidden", "none", true],
      ["shown", "required", false],
    ]);
    // Her own view leaves out what's hidden from her; nobody else's is open to her.
    const asSelf = (await json(req(sara, "GET", `/orgs/${orgId}/members/${sara.userId}/skills`))).body.skills;
    expect(asSelf.map((s: any) => s.skillId)).toEqual([shown]);
    expect((await json(req(sara, "GET", `/orgs/${orgId}/members/${ali.userId}/skills`))).status).toBe(403);
  });

  it("MCP leaves out a skill hidden from the token's person", async () => {
    const id = await publishedSkill("mcp-hidden");
    await setAccess(id, { people: [{ userId: ali.userId, level: "none" }] });
    const token = (await createMcpToken({ userId: ali.userId, organizationId: orgId }, "t")).token;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await app.fetch(
        new Request("http://local/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
      );
      return ((await res.json()) as any).result;
    };
    expect((await call("list_skills")).structuredContent.skills).toEqual([]);
    expect((await call("get_skill", { name: "mcp-hidden" })).isError).toBe(true);
  });
});
