import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { seedMember, seedOrg, seedUser } from "./helpers/seed.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import { createSkill, patchSkill, publishSkill, writeDraft } from "../src/skills/store.js";
import { decodeSkillFiles } from "../src/skills/validate.js";

/**
 * MCP `list_skills` / `get_skill` / `read_skill_file` (docs/SKILLS.md §3.5):
 * scoped to the token's vault, published versions only.
 */
const app = createApp(testAppDeps());

let rpcId = 0;
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: body.result?.isError ?? false, data: body.result?.structuredContent as any };
}

const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const files = (list: Array<[string, string | Buffer]>) =>
  decodeSkillFiles(list.map(([path, c]) => ({ path, contentBase64: Buffer.from(c).toString("base64") })));

/** Create a skill and publish each given file set as the next version. */
async function seedSkill(orgId: string, userId: string, name: string, versions: Array<Array<[string, string | Buffer]>>) {
  const s = await createSkill(orgId, userId, name, undefined);
  let rev = s.draftRevision;
  for (const v of versions) {
    rev = (await writeDraft(orgId, s.id, userId, rev, { kind: "replace", files: files(v) })).revision;
    await publishSkill(orgId, s.id, userId, rev, `notes for ${name}`);
  }
  return s.id;
}

describe("MCP skill tools", () => {
  let orgA: string;
  let orgB: string;
  let memberToken: string;
  let ownerA: string;

  beforeEach(async () => {
    await resetDb();
    orgA = await seedOrg("A", `a-${randomUUID().slice(0, 8)}`);
    orgB = await seedOrg("B", `b-${randomUUID().slice(0, 8)}`);
    ownerA = await seedUser(`owner+${randomUUID()}@skills-mcp.test`);
    const ownerB = await seedUser(`ownerb+${randomUUID()}@skills-mcp.test`);
    const member = await seedUser(`member+${randomUUID()}@skills-mcp.test`);
    await seedMember(orgA, ownerA, "owner");
    await seedMember(orgB, ownerB, "owner");
    await seedMember(orgA, member, "member");
    await seedMember(orgB, member, "member");
    memberToken = (await createMcpToken({ userId: member, organizationId: orgA }, "t")).token;

    const docs = await seedSkill(orgA, ownerA, "docs-helper", [
      [["SKILL.md", md("docs-helper", "Version one.")]],
      [["SKILL.md", md("docs-helper", "Version two.")], ["ref/long.md", "x".repeat(60_000)], ["bin/tool", Buffer.from([0xff, 0xfe, 0x00, 0x80])]],
    ]);
    await patchSkill(orgA, docs, { delivery: "required" });
    await createSkill(orgA, ownerA, "draft-only", undefined);
    await seedSkill(orgB, ownerB, "b-secret", [[["SKILL.md", md("b-secret", "Org B only.")]]]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("lists only this vault's published skills", async () => {
    const r = await call(memberToken, "list_skills");
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      skills: [{ name: "docs-helper", description: "Version two.", version: 2, required: true, latestVersion: 2, pinned: false }],
    });
  });

  it("reports a pinned effective version", async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM skills WHERE name = 'docs-helper'");
    await patchSkill(orgA, rows[0].id, { pinnedVersion: 1 });
    const r = await call(memberToken, "list_skills");
    expect(r.data.skills[0]).toMatchObject({ version: 1, latestVersion: 2, pinned: true, description: "Version one." });
    expect((await call(memberToken, "get_skill", { name: "docs-helper" })).data.version).toBe(1);
  });

  it("gets a skill with its SKILL.md and file list", async () => {
    const r = await call(memberToken, "get_skill", { name: "docs-helper" });
    expect(r.data).toMatchObject({
      name: "docs-helper", description: "Version two.", version: 2, notes: "notes for docs-helper",
      skillMd: md("docs-helper", "Version two."),
    });
    expect(typeof r.data.publishedAt).toBe("string");
    expect(r.data.files).toEqual([
      { path: "SKILL.md", size: expect.any(Number), text: true },
      { path: "bin/tool", size: 4, text: false },
      { path: "ref/long.md", size: 60_000, text: true },
    ]);
    const v1 = await call(memberToken, "get_skill", { name: "docs-helper", version: 1 });
    expect(v1.data.description).toBe("Version one.");
    expect(v1.data.files).toHaveLength(1);
  });

  it("refuses other vaults' skills, drafts, unknown versions and files", async () => {
    for (const name of ["b-secret", "draft-only", "nope"]) {
      const r = await call(memberToken, "get_skill", { name });
      expect(r.isError, name).toBe(true);
      expect(r.data.code).toBe("skill_not_found");
      expect((await call(memberToken, "read_skill_file", { name, path: "SKILL.md" })).data.code).toBe("skill_not_found");
    }
    expect((await call(memberToken, "get_skill", { name: "docs-helper", version: 3 })).data.code).toBe("version_not_found");
    expect((await call(memberToken, "read_skill_file", { name: "docs-helper", path: "missing.md" })).data.code).toBe("file_not_found");
  });

  it("reads text with truncation and flags binary files", async () => {
    const bin = await call(memberToken, "read_skill_file", { name: "docs-helper", path: "bin/tool" });
    expect(bin.data).toEqual({ path: "bin/tool", version: 2, text: null, binary: true, truncated: false });
    const long = await call(memberToken, "read_skill_file", { name: "docs-helper", path: "ref/long.md" });
    expect(long.data.text).toHaveLength(50_000);
    expect(long.data.truncated).toBe(true);
    const short = await call(memberToken, "read_skill_file", { name: "docs-helper", path: "ref/long.md", maxChars: 10 });
    expect(short.data).toMatchObject({ text: "x".repeat(10), truncated: true, binary: false });
    const all = await call(memberToken, "read_skill_file", { name: "docs-helper", path: "ref/long.md", maxChars: 1_000_000 });
    expect(all.data).toMatchObject({ truncated: false });
    expect(all.data.text).toHaveLength(60_000);
  });
});
