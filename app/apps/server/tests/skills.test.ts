import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault } from "./helpers/seed.js";
import { setSkillsChangedPublisher } from "../src/sync/member-events.js";
import { bundleSha256, parseSkillFrontmatter, skillPathProblem, isValidSkillName } from "../src/skills/validate.js";

/** Team skills HTTP surface (docs/SKILLS.md §3.3) against a real Postgres. */
const app = createApp(testAppDeps());

let published: Array<{ vaultId: string; orgId: string }> = [];

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const sha = (s: string | Buffer) => createHash("sha256").update(Buffer.from(s)).digest("hex");
const skillMd = (name: string, description = "Use it.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const file = (path: string, content: string | Buffer, executable?: boolean) => ({
  path,
  contentBase64: b64(content),
  ...(executable === undefined ? {} : { executable }),
});

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
let member: TestUser;
let outsider: TestUser;
let orgId: string;
let vaultId: string;

async function create(name: string, files?: unknown) {
  return json(req(admin, "POST", `/orgs/${orgId}/skills`, { name, ...(files ? { files } : {}) }));
}
async function draftOf(skillId: string) {
  return (await json(req(admin, "GET", `/orgs/${orgId}/skills/${skillId}/draft`))).body;
}
async function publish(skillId: string, notes?: string) {
  const d = await draftOf(skillId);
  return json(req(admin, "POST", `/orgs/${orgId}/skills/${skillId}/publish`, { baseRevision: d.revision, notes }));
}
async function patchDraft(skillId: string, body: Record<string, unknown>) {
  const d = await draftOf(skillId);
  return json(req(admin, "PATCH", `/orgs/${orgId}/skills/${skillId}/draft`, { baseRevision: d.revision, ...body }));
}

describe("team skills", () => {
  beforeEach(async () => {
    await resetDb();
    published = [];
    setSkillsChangedPublisher((v, o) => published.push({ vaultId: v, orgId: o }));
    owner = await signUp("owner@skills.test");
    admin = await signUp("admin@skills.test");
    member = await signUp("member@skills.test");
    outsider = await signUp("outsider@skills.test");
    orgId = await seedOrg("Skills Team", "skills-team");
    await seedMember(orgId, owner.userId, "owner");
    await seedMember(orgId, admin.userId, "admin");
    await seedMember(orgId, member.userId, "member");
    vaultId = await seedVault(orgId);
  });
  afterEach(() => setSkillsChangedPublisher(null));
  afterAll(async () => {
    await pool.end();
  });

  it("shares the bundle hash vector with the desktop", () => {
    const s = sha("---\nname: a\ndescription: b\n---\n");
    expect(bundleSha256([{ path: "SKILL.md", sha256: s, executable: false }])).toBe(
      "e31c3545cce6aa9d32d280b0348168b086082496410f08b32c7b2b5f0bb434b6",
    );
  });

  it("validates names and paths per the spec tables", () => {
    for (const ok of ["a", "my-skill", "a1-b2", "x".repeat(64), "console", "con-tool"]) expect(isValidSkillName(ok), ok).toBe(true);
    for (const bad of ["", "A", "-a", "a-", "a--b", "a_b", "x".repeat(65), "con", "COM1", "lpt9", "nul"]) {
      expect(isValidSkillName(bad), bad).toBe(false);
    }
    for (const ok of ["SKILL.md", "scripts/run.sh", "a/b/c.txt", "con-notes.txt"]) expect(skillPathProblem(ok), ok).toBeNull();
    for (const bad of ["", "/abs", "a//b", "a/", "..", "a/../b", "./a", ".env", "a/.git/x", "a\\b", "a:b", "a?", "a\u0001",
      "dir./x", "x ", "con.txt", "a/aux", "x".repeat(241), `${"y".repeat(101)}/z`]) {
      expect(skillPathProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(parseSkillFrontmatter("---\nname: a\ndescription: b\n---\n", "a")).toEqual({ ok: true, name: "a", description: "b" });
    expect(parseSkillFrontmatter("# no fm", "a")).toEqual({ ok: false, reason: "no_frontmatter" });
    expect(parseSkillFrontmatter("---\n: : [\n---\n", "a")).toEqual({ ok: false, reason: "bad_yaml" });
    expect(parseSkillFrontmatter("---\n- a\n---\n", "a")).toEqual({ ok: false, reason: "bad_yaml" });
    expect(parseSkillFrontmatter("---\nname: a\ndescription: \"\"\n---\n", "a")).toEqual({ ok: false, reason: "description" });
    expect(parseSkillFrontmatter(`---\nname: a\ndescription: ${"d".repeat(1025)}\n---\n`, "a")).toEqual({ ok: false, reason: "description" });
  });

  it("creates with a seeded SKILL.md; refuses bad and duplicate names; frees the name on delete", async () => {
    const res = await create("deploy-notes");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "deploy-notes", orgId, delivery: "optional", latestVersion: null, effectiveVersion: null,
      latestPublishedBy: null, latestPublishedAt: null,
      pinnedVersion: null, draftRevision: 1, draftDiffers: true, versions: [],
      description: "Describe when to use this skill.",
    });
    const d = await draftOf(res.body.id);
    expect(d.files).toHaveLength(1);
    expect(Buffer.from(d.files[0].contentBase64, "base64").toString()).toBe(
      "---\nname: deploy-notes\ndescription: Describe when to use this skill.\n---\n\n# deploy-notes\n",
    );
    // A new (unpublished) skill still refreshes open Skills pages.
    expect(published).toEqual([{ vaultId, orgId }]);
    published = [];

    expect((await create("Bad_Name")).body).toEqual({ error: "invalid_name" });
    expect((await create("con")).status).toBe(400);
    const dup = await create("deploy-notes");
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "skill_name_taken" });

    expect((await json(req(admin, "DELETE", `/orgs/${orgId}/skills/${res.body.id}`))).body).toEqual({ ok: true });
    expect(published).toEqual([{ vaultId, orgId }]);
    expect((await create("deploy-notes")).status).toBe(201);
    expect((await json(req(admin, "GET", `/orgs/${orgId}/skills/${res.body.id}`))).status).toBe(404);
  });

  it("gates admin routes for members and hides orgs from non-members", async () => {
    const { body: s } = await create("gated");
    const id = s.id;
    const adminRoutes: Array<[string, string, unknown?]> = [
      ["POST", `/orgs/${orgId}/skills`, { name: "x" }],
      ["PATCH", `/orgs/${orgId}/skills/${id}`, { delivery: "required" }],
      ["DELETE", `/orgs/${orgId}/skills/${id}`],
      ["GET", `/orgs/${orgId}/skills/${id}/draft`],
      ["PUT", `/orgs/${orgId}/skills/${id}/draft`, { baseRevision: 1, files: [] }],
      ["PATCH", `/orgs/${orgId}/skills/${id}/draft`, { baseRevision: 1 }],
      ["POST", `/orgs/${orgId}/skills/${id}/draft/reset`, { baseRevision: 1, version: 1 }],
      ["POST", `/orgs/${orgId}/skills/${id}/publish`, { baseRevision: 1 }],
    ];
    for (const [method, path, body] of adminRoutes) {
      const r = await json(req(member, method, path, body));
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body).toEqual({ error: "skills_admin_required" });
      const o = await json(req(outsider, method, path, body));
      expect(o.status, `${method} ${path}`).toBe(404);
      expect(o.body).toEqual({ error: "not_member" });
    }
    for (const path of [`/orgs/${orgId}/skills`, `/orgs/${orgId}/skills/${id}`]) {
      expect((await req(outsider, "GET", path)).status).toBe(404);
    }
    const anon = await app.request(`/api/orgs/${orgId}/skills`);
    expect(anon.status).toBe(401);
    // Owner counts as admin.
    expect((await json(req(owner, "GET", `/orgs/${orgId}/skills/${id}/draft`))).status).toBe(200);
  });

  it("bumps the draft revision on PUT/PATCH and refuses a stale base", async () => {
    const { body: s } = await create("drafty");
    published = [];
    const put = await json(req(admin, "PUT", `/orgs/${orgId}/skills/${s.id}/draft`, {
      baseRevision: 1,
      files: [file("SKILL.md", skillMd("drafty", "Put body.")), file("scripts/run.sh", "echo hi", true)],
    }));
    expect(put.status).toBe(200);
    expect(put.body.revision).toBe(2);
    expect(put.body.updatedBy).toEqual({ id: admin.userId, name: "admin" });
    expect(put.body.files.map((f: any) => [f.path, f.executable, f.size])).toEqual([
      ["SKILL.md", false, Buffer.byteLength(skillMd("drafty", "Put body."))],
      ["scripts/run.sh", true, 7],
    ]);
    const stale = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${s.id}/draft`, { baseRevision: 1, remove: ["x"] }));
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: "stale_draft", revision: 2 });

    const patched = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${s.id}/draft`, {
      baseRevision: 2,
      upsert: [file("notes.md", "hello")],
      remove: ["scripts/run.sh", "missing.txt"],
    }));
    expect(patched.body.revision).toBe(3);
    expect(patched.body.files.map((f: any) => f.path)).toEqual(["SKILL.md", "notes.md"]);
    // A case-only upsert replaces the existing file rather than duplicating it.
    const ci = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${s.id}/draft`, {
      baseRevision: 3, upsert: [file("NOTES.md", "again")],
    }));
    expect(ci.body.files.map((f: any) => f.path)).toEqual(["NOTES.md", "SKILL.md"]);
    const detail = (await json(req(admin, "GET", `/orgs/${orgId}/skills/${s.id}`))).body;
    expect(detail.description).toBe("Put body.");
    expect(detail.draftRevision).toBe(4);
    expect(published).toEqual([]);
  });

  it("refuses bad paths, base64 and shas", async () => {
    const { body: s } = await create("paths");
    const put = (files: unknown) =>
      json(req(admin, "PUT", `/orgs/${orgId}/skills/${s.id}/draft`, { baseRevision: 1, files }));
    for (const path of ["../x", ".env", "a/.hidden/b", "a:b"]) {
      const r = await put([file(path, "x")]);
      expect(r.status, path).toBe(400);
      expect(r.body).toMatchObject({ error: "invalid_path", path });
    }
    const dup = await put([file("SKILL.md", "a"), file("skill.md", "b")]);
    expect(dup.body).toMatchObject({ error: "invalid_path", path: "skill.md", reason: "duplicate" });
    expect((await put([{ path: "a.txt", contentBase64: "!!notbase64" }])).body).toMatchObject({ error: "invalid_base64" });
    expect((await put([{ path: "a.txt", contentBase64: b64("x"), sha256: sha("y") }])).body).toMatchObject({ error: "sha_mismatch" });
    expect((await put([{ path: "a.txt", contentBase64: b64("x"), sha256: sha("x") }])).status).toBe(200);
  });

  it("enforces file count, per-file and total caps at their exact boundaries", async () => {
    const { body: s } = await create("caps");
    let rev = 1;
    const put = async (files: unknown) => {
      const r = await json(req(admin, "PUT", `/orgs/${orgId}/skills/${s.id}/draft`, { baseRevision: rev, files }));
      if (r.status === 200) rev = r.body.revision;
      return r;
    };
    const MiB = 1024 * 1024;
    const tooMany = await put(Array.from({ length: 1001 }, (_, i) => file(`f${i}.txt`, "x")));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toEqual({ error: "skill_too_many_files", limit: 1000, message: "A skill can have at most 1,000 files." });
    expect((await put(Array.from({ length: 1000 }, (_, i) => file(`f${i}.txt`, "x")))).status).toBe(200);

    const bigFile = await put([file("big.bin", Buffer.alloc(5 * MiB + 1))]);
    expect(bigFile.status).toBe(413);
    expect(bigFile.body).toEqual({
      error: "skill_file_too_large", limit: 5 * MiB, message: "Each file in a skill can be at most 5 MB.", path: "big.bin",
    });
    expect((await put([file("edge.bin", Buffer.alloc(5 * MiB))])).status).toBe(200);

    const full = Array.from({ length: 5 }, (_, i) => file(`p${i}.bin`, Buffer.alloc(5 * MiB, i)));
    const over = await put([...full, file("one.bin", Buffer.alloc(1))]);
    expect(over.status).toBe(413);
    expect(over.body).toEqual({ error: "skill_too_large", limit: 25 * MiB, message: "A skill can be at most 25 MB in total." });
    expect((await put(full)).status).toBe(200);
    // A PATCH that would cross the total cap is judged on the resulting set.
    const crossing = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${s.id}/draft`, {
      baseRevision: rev, upsert: [file("one.bin", Buffer.alloc(1))],
    }));
    expect(crossing.status).toBe(413);
    expect(crossing.body.error).toBe("skill_too_large");
  });

  it("publishes and serves a full 25 MiB version intact, compressed or not", async () => {
    const MiB = 1024 * 1024;
    const blobs = Array.from({ length: 5 }, (_, i) => {
      const b = Buffer.alloc(5 * MiB - (i === 0 ? 64 : 0));
      for (let j = 0; j < b.length; j += 4096) b[j] = (i * 31 + j) & 0xff;
      return b;
    });
    const md = skillMd("big-skill");
    const created = await create("big-skill", [file("SKILL.md", md), ...blobs.map((b, i) => file(`data/${i}.bin`, b))]);
    expect(created.status).toBe(201);
    expect((await publish(created.body.id)).status).toBe(201);
    const path = `/api/orgs/${orgId}/skills/${created.body.id}/versions/1`;
    const plain = await app.request(path, { headers: authHeaders(member) });
    const gz = await app.request(path, { headers: { ...authHeaders(member), "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    const { gunzipSync } = await import("node:zlib");
    for (const body of [
      JSON.parse(await plain.text()),
      JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString("utf8")),
    ]) {
      expect(body.files).toHaveLength(6);
      for (const f of body.files) {
        const bytes = Buffer.from(f.contentBase64, "base64");
        expect(bytes.length).toBe(f.size);
        expect(sha(bytes)).toBe(f.sha256);
      }
      expect(body.totalBytes).toBe(blobs.reduce((n, b) => n + b.length, 0) + Buffer.byteLength(md));
    }
  });

  it("publishes numbered immutable versions and validates SKILL.md", async () => {
    const { body: s } = await create("pub");
    published = [];
    const v1 = await publish(s.id, "first");
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, notes: "first", fileCount: 1, description: "Describe when to use this skill.",
      publishedBy: { id: admin.userId, name: "admin" } });
    expect(published).toEqual([{ vaultId, orgId }]);
    expect((await publish(s.id)).body).toEqual({ error: "nothing_to_publish" });

    await patchDraft(s.id, { upsert: [file("SKILL.md", skillMd("other"))] });
    expect((await publish(s.id)).body).toEqual({ error: "invalid_skill", reason: "name_mismatch" });
    await patchDraft(s.id, { upsert: [file("SKILL.md", "no frontmatter")] });
    expect((await publish(s.id)).body).toEqual({ error: "invalid_skill", reason: "no_frontmatter" });
    await patchDraft(s.id, { remove: ["SKILL.md"] });
    expect((await publish(s.id)).body).toEqual({ error: "invalid_skill", reason: "missing_skill_md" });

    await patchDraft(s.id, { upsert: [file("SKILL.md", skillMd("pub", "Second.")), file("x.txt", "x")] });
    const v2 = await publish(s.id, "second");
    expect(v2.body).toMatchObject({ version: 2, description: "Second.", fileCount: 2 });
    const tooLong = await json(req(admin, "POST", `/orgs/${orgId}/skills/${s.id}/publish`, {
      baseRevision: (await draftOf(s.id)).revision, notes: "n".repeat(2001),
    }));
    expect(tooLong.body).toEqual({ error: "invalid_notes" });

    // Later draft edits never touch a published version.
    await patchDraft(s.id, { upsert: [file("x.txt", "changed")] });
    const read1 = (await json(req(member, "GET", `/orgs/${orgId}/skills/${s.id}/versions/1`))).body;
    expect(read1.files.map((f: any) => f.path)).toEqual(["SKILL.md"]);
    const read2 = (await json(req(member, "GET", `/orgs/${orgId}/skills/${s.id}/versions/2`))).body;
    expect(Buffer.from(read2.files.find((f: any) => f.path === "x.txt").contentBase64, "base64").toString()).toBe("x");
    expect(read2.bundleSha256).toBe(bundleSha256(read2.files));
    for (const bad of ["0", "3", "01", "abc"]) {
      const r = await json(req(member, "GET", `/orgs/${orgId}/skills/${s.id}/versions/${bad}`));
      expect(r.status, bad).toBe(404);
      expect(r.body).toEqual({ error: "version_not_found" });
    }

    const detail = (await json(req(admin, "GET", `/orgs/${orgId}/skills/${s.id}`))).body;
    expect(detail.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(detail.latestVersion).toBe(2);
    expect(detail.draftDiffers).toBe(true);

    // Reset the draft to v1: it then equals v1's bundle (not the latest), so it still differs.
    const reset = await json(req(admin, "POST", `/orgs/${orgId}/skills/${s.id}/draft/reset`, {
      baseRevision: (await draftOf(s.id)).revision, version: 1,
    }));
    expect(reset.body.files.map((f: any) => f.path)).toEqual(["SKILL.md"]);
    const resetToV2 = await json(req(admin, "POST", `/orgs/${orgId}/skills/${s.id}/draft/reset`, {
      baseRevision: reset.body.revision, version: 2,
    }));
    expect(resetToV2.status).toBe(200);
    expect((await json(req(admin, "GET", `/orgs/${orgId}/skills/${s.id}`))).body.draftDiffers).toBe(false);
    const missing = await json(req(admin, "POST", `/orgs/${orgId}/skills/${s.id}/draft/reset`, {
      baseRevision: resetToV2.body.revision, version: 9,
    }));
    expect(missing.body).toEqual({ error: "version_not_found" });
  });

  it("pins and unpins, refusing an unknown version", async () => {
    const { body: s } = await create("pinny");
    await publish(s.id);
    await patchDraft(s.id, { upsert: [file("more.txt", "m")] });
    await publish(s.id);
    published = [];
    const pin = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${s.id}`, { pinnedVersion: 1, delivery: "required" }));
    expect(pin.body).toMatchObject({ pinnedVersion: 1, latestVersion: 2, effectiveVersion: 1, delivery: "required" });
    expect(published).toEqual([{ vaultId, orgId }]);
    expect((await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${s.id}`, { pinnedVersion: 7 }))).body).toEqual({ error: "unknown_version" });
    const unpin = await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${s.id}`, { pinnedVersion: null }));
    expect(unpin.body).toMatchObject({ pinnedVersion: null, effectiveVersion: 2, delivery: "required" });
  });

  it("shows members only published skills", async () => {
    const { body: draftOnly } = await create("draft-only");
    const { body: live } = await create("live");
    await publish(live.id);
    const catalog = (await json(req(member, "GET", `/orgs/${orgId}/skills`))).body;
    expect(catalog.role).toBe("member");
    expect(catalog.skills.map((s: any) => s.name)).toEqual(["live"]);
    expect(Object.keys(catalog).sort()).toEqual(["role", "skills"]);
    const adminCatalog = (await json(req(admin, "GET", `/orgs/${orgId}/skills`))).body;
    expect(adminCatalog.role).toBe("admin");
    expect(adminCatalog.skills.map((s: any) => s.name)).toEqual(["draft-only", "live"]);
    expect((await json(req(member, "GET", `/orgs/${orgId}/skills/${draftOnly.id}`))).body).toEqual({ error: "skill_not_found" });
    const card = catalog.skills[0];
    expect(card.latestPublishedBy).toEqual({ id: admin.userId, name: "admin" });
    expect(card.latestPublishedAt).toBe(
      (await json(req(member, "GET", `/orgs/${orgId}/skills/${live.id}/versions/1`))).body.publishedAt,
    );
    expect(adminCatalog.skills[0]).toMatchObject({ name: "draft-only", latestPublishedBy: null, latestPublishedAt: null });
    // A deleted publisher leaves the time but no name.
    await pool.query(`UPDATE skill_versions SET published_by = NULL WHERE skill_id = $1`, [live.id]);
    const after = (await json(req(member, "GET", `/orgs/${orgId}/skills`))).body.skills[0];
    expect(after.latestPublishedBy).toBeNull();
    expect(after.latestPublishedAt).toBe(card.latestPublishedAt);
    const memberDetail = (await json(req(member, "GET", `/orgs/${orgId}/skills/${live.id}`))).body;
    expect(memberDetail.draftFiles).toBeNull();
    expect(memberDetail.versions).toHaveLength(1);
  });

  it("builds the manifest over every membership org with effective versions", async () => {
    const otherOrg = await seedOrg("Empty Team", "empty-team");
    await seedMember(otherOrg, member.userId, "member");
    const { body: a } = await create("alpha");
    const { body: b } = await create("beta");
    const { body: c } = await create("gamma");
    await create("unpublished");
    await publish(a.id);
    await patchDraft(a.id, { upsert: [file("v2.txt", "two")] });
    await publish(a.id);
    await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${a.id}`, { pinnedVersion: 1 }));
    await publish(b.id);
    await json(req(admin, "PATCH", `/orgs/${orgId}/skills/${b.id}`, { delivery: "required" }));
    await publish(c.id);
    await json(req(admin, "DELETE", `/orgs/${orgId}/skills/${c.id}`));

    const m = (await json(req(member, "GET", "/skills/manifest"))).body;
    expect(typeof m.serverTime).toBe("string");
    expect(m.orgs.map((o: any) => [o.orgName, o.role, o.orgSlug])).toEqual([
      ["Empty Team", "member", "empty-team"],
      ["Skills Team", "member", "skills-team"],
    ]);
    expect(Object.keys(m.orgs[0]).sort()).toEqual(["orgId", "orgName", "orgSlug", "role", "skills"]);
    const skills = m.orgs[1].skills;
    expect(skills.map((s: any) => [s.name, s.version, s.delivery])).toEqual([
      ["alpha", 1, "optional"],
      ["beta", 1, "required"],
    ]);
    expect(skills[0].files).toEqual([
      { path: "SKILL.md", sha256: expect.any(String), size: expect.any(Number), executable: false },
    ]);
    expect(skills[0].bundleSha256).toBe(bundleSha256(skills[0].files));
    expect(m.orgs[0].skills).toEqual([]);
    expect((await json(req(outsider, "GET", "/skills/manifest"))).body.orgs).toEqual([]);
    expect((await app.request("/api/skills/manifest")).status).toBe(401);
  });

  it("no longer serves the dropped GitHub publish settings routes", async () => {
    expect((await req(admin, "GET", `/orgs/${orgId}/skill-settings`)).status).toBe(404);
    expect((await req(admin, "PUT", `/orgs/${orgId}/skill-settings`, { githubRepo: null })).status).toBe(404);
    expect((await req(admin, "POST", `/orgs/${orgId}/skill-settings/github-sync`, { ok: true })).status).toBe(404);
  });

  it("advertises the skills feature on /health", async () => {
    const body = (await (await app.request("/health")).json()) as { features: string[] };
    expect(body.features).toContain("skills");
  });

  it("caps skills per org", async () => {
    await pool.query(
      `INSERT INTO skills (id, organization_id, name)
       SELECT 'cap-' || g, $1, 'cap-' || g FROM generate_series(1, 500) g`,
      [orgId],
    );
    expect((await create("one-more")).body).toEqual({ error: "skill_limit_reached" });
    await pool.query("UPDATE skills SET deleted_at = now() WHERE id = 'cap-1'");
    expect((await create("one-more")).status).toBe(201);
  });

  it("answers 413 skill_too_large for a body past the route limit", async () => {
    const { body: s } = await create("huge");
    // 7 × 5 MiB decoded ≈ 46.7 MiB of base64: past the 36 MiB body limit.
    const res = await req(admin, "PUT", `/orgs/${orgId}/skills/${s.id}/draft`, {
      baseRevision: 1, files: Array.from({ length: 7 }, (_, i) => file(`a${i}.bin`, Buffer.alloc(5 * 1024 * 1024))),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "skill_too_large", limit: 25 * 1024 * 1024, message: "A skill can be at most 25 MB in total." });
  });
});
