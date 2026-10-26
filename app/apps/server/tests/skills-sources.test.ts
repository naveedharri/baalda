import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault } from "./helpers/seed.js";
import { setSkillsChangedPublisher } from "../src/sync/member-events.js";

/**
 * Marketplace import (docs/SKILLS.md "Addendum — Marketplace import (server)"):
 * the per-vault list of GitHub marketplaces and a skill's recorded `source`.
 */
const app = createApp(testAppDeps());

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

const origin = (over: Record<string, unknown> = {}) => ({
  repo: "anthropics/skills",
  ref: null,
  path: ".claude/skills/pdf",
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  pluginName: "document-skills",
  ...over,
});
const skillMd = (name: string) => `---\nname: ${name}\ndescription: Imported.\n---\n`;
const files = (name: string) => [{ path: "SKILL.md", contentBase64: Buffer.from(skillMd(name)).toString("base64") }];

let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let orgId: string;
let otherOrg: string;
let published: string[];

describe("skill marketplace sources", () => {
  beforeEach(async () => {
    await resetDb();
    published = [];
    setSkillsChangedPublisher((_v, o) => published.push(o));
    admin = await signUp("admin@sources.test");
    member = await signUp("member@sources.test");
    outsider = await signUp("outsider@sources.test");
    orgId = await seedOrg("Sources", "sources");
    otherOrg = await seedOrg("Other", "other");
    await seedMember(orgId, admin.userId, "admin");
    await seedMember(orgId, member.userId, "member");
    await seedMember(otherOrg, outsider.userId, "owner");
    await seedVault(orgId);
  });
  afterEach(() => setSkillsChangedPublisher(null));
  afterAll(async () => {
    await pool.end();
  });

  it("adds, lists and removes sources with owner/admin gates", async () => {
    const added = await json(req(admin, "POST", `/orgs/${orgId}/skill-sources`, { repo: "anthropics/skills", label: " Official " }));
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      orgId, repo: "anthropics/skills", ref: null, label: "Official", addedBy: { id: admin.userId, name: "admin" },
    });
    expect(typeof added.body.addedAt).toBe("string");
    const listed = await json(req(member, "GET", `/orgs/${orgId}/skill-sources`));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ sources: [added.body] });

    expect((await json(req(member, "POST", `/orgs/${orgId}/skill-sources`, { repo: "a/b" }))).body).toEqual({ error: "skills_admin_required" });
    expect((await json(req(member, "DELETE", `/orgs/${orgId}/skill-sources/${added.body.id}`))).status).toBe(403);
    expect((await json(req(outsider, "GET", `/orgs/${orgId}/skill-sources`))).body).toEqual({ error: "not_member" });
    expect((await json(req(outsider, "POST", `/orgs/${orgId}/skill-sources`, { repo: "a/b" }))).status).toBe(404);
    // Another org's owner cannot delete this org's source through their own org.
    expect((await json(req(outsider, "DELETE", `/orgs/${otherOrg}/skill-sources/${added.body.id}`))).body).toEqual({ error: "skill_source_not_found" });

    expect((await json(req(admin, "DELETE", `/orgs/${orgId}/skill-sources/${added.body.id}`))).body).toEqual({ ok: true });
    expect((await json(req(admin, "DELETE", `/orgs/${orgId}/skill-sources/${added.body.id}`))).status).toBe(404);
    expect((await json(req(member, "GET", `/orgs/${orgId}/skill-sources`))).body).toEqual({ sources: [] });
    expect(published).toEqual([]);
  });

  it("validates repo, ref and label", async () => {
    const post = (body: unknown) => json(req(admin, "POST", `/orgs/${orgId}/skill-sources`, body));
    for (const repo of ["noslash", "a/b/c", "a b/c", "https://github.com/a/b", "", 7]) {
      expect((await post({ repo })).body, String(repo)).toEqual({ error: "invalid_repo" });
    }
    expect((await post({ repo: "my_org/repo.name-1" })).status).toBe(201);
    expect((await post({ repo: "a/b", ref: "bad ref" })).body).toEqual({ error: "invalid_ref" });
    expect((await post({ repo: "a/b", ref: 3 })).body).toEqual({ error: "invalid_ref" });
    expect((await post({ repo: "a/b", label: "x".repeat(101) })).body).toEqual({ error: "invalid_label" });
    expect((await post({ repo: "a/b", ref: "release/v1", label: null })).body).toMatchObject({ ref: "release/v1", label: null });
  });

  it("treats the same repo (any case) and ref as one source", async () => {
    const post = (body: unknown) => json(req(admin, "POST", `/orgs/${orgId}/skill-sources`, body));
    expect((await post({ repo: "Acme/Skills" })).status).toBe(201);
    const clash = await post({ repo: "acme/skills" });
    expect(clash.status).toBe(409);
    expect(clash.body).toEqual({ error: "skill_source_exists" });
    expect((await post({ repo: "acme/skills", ref: "" })).body).toEqual({ error: "skill_source_exists" });
    expect((await post({ repo: "acme/skills", ref: "main" })).status).toBe(201);
    expect((await post({ repo: "ACME/skills", ref: "main" })).status).toBe(409);
    // Another vault may list the same repo.
    expect((await json(req(outsider, "POST", `/orgs/${otherOrg}/skill-sources`, { repo: "acme/skills" }))).status).toBe(201);
  });

  it("round-trips a skill's source through create, list, detail, manifest, PATCH and draft PUT", async () => {
    const created = await json(req(admin, "POST", `/orgs/${orgId}/skills`, { name: "pdf", files: files("pdf"), source: origin() }));
    expect(created.status).toBe(201);
    expect(created.body.source).toEqual(origin());
    const id = created.body.id;
    const plain = await json(req(admin, "POST", `/orgs/${orgId}/skills`, { name: "local" }));
    expect(plain.body.source).toBeNull();

    const draft = (await json(req(admin, "GET", `/orgs/${orgId}/skills/${id}/draft`))).body;
    await json(req(admin, "POST", `/orgs/${orgId}/skills/${id}/publish`, { baseRevision: draft.revision }));
    expect((await json(req(member, "GET", `/orgs/${orgId}/skills`))).body.skills[0].source).toEqual(origin());
    expect((await json(req(member, "GET", `/orgs/${orgId}/skills/${id}`))).body.source).toEqual(origin());
    const manifest = (await json(req(member, "GET", "/skills/manifest"))).body;
    expect(manifest.orgs.find((o: any) => o.orgId === orgId).skills[0].source).toEqual(origin());

    // Pull update: content and the new shas land together under one revision.
    const pulled = origin({ commitSha: "c".repeat(64), treeSha: "d".repeat(40), ref: "main" });
    const put = await json(req(admin, "PUT", `/orgs/${orgId}/skills/${id}/draft`, {
      baseRevision: draft.revision, files: files("pdf"), source: pulled,
    }));
    expect(put.status).toBe(200);
    expect((await json(req(admin, "GET", `/orgs/${orgId}/skills/${id}`))).body.source).toEqual(pulled);
    // A draft PUT without `source` keeps it; a PATCH draft never touches it.
    await json(req(admin, "PUT", `/orgs/${orgId}/skills/${id}/draft`, { baseRevision: put.body.revision, files: files("pdf") }));
    expect((await json(req(admin, "GET", `/orgs/${orgId}/skills/${id}`))).body.source).toEqual(pulled);

    const withoutPlugin = { ...origin(), pluginName: undefined };
    delete (withoutPlugin as Record<string, unknown>).pluginName;
    const patched = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${id}`, { source: withoutPlugin }));
    expect(patched.body.source).toEqual(withoutPlugin);
    const unlinked = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${id}`, { source: null }));
    expect(unlinked.body.source).toBeNull();
    expect((await json(req(member, "PATCH", `/orgs/${orgId}/skills/${id}`, { source: origin() }))).status).toBe(403);
  });

  it("refuses a malformed source", async () => {
    const post = (source: unknown, name = "bad") =>
      json(req(admin, "POST", `/orgs/${orgId}/skills`, { name, source }));
    const cases: Array<[unknown, string]> = [
      ["anthropics/skills", "source"],
      [[origin()], "source"],
      [{ ...origin(), extra: 1 }, "extra"],
      [origin({ repo: "nope" }), "repo"],
      [origin({ ref: "has space" }), "ref"],
      [origin({ path: "../escape" }), "path"],
      [origin({ path: "a//b" }), "path"],
      [origin({ path: 5 }), "path"],
      [origin({ commitSha: "A".repeat(40) }), "commitSha"],
      [origin({ commitSha: "a".repeat(39) }), "commitSha"],
      [origin({ treeSha: undefined }), "treeSha"],
      [origin({ pluginName: "" }), "pluginName"],
    ];
    for (const [source, key] of cases) {
      const r = await post(source);
      expect(r.status, JSON.stringify(source)).toBe(400);
      expect(r.body).toEqual({ error: "invalid_source", key });
    }
    expect((await post(origin({ path: "" }), "root-skill")).status).toBe(201);
    expect((await post(origin({ pluginName: null }), "no-plugin")).body.source.pluginName).toBeNull();
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM skills WHERE name = 'bad'");
    expect(rows[0].n).toBe(0);
  });
});
