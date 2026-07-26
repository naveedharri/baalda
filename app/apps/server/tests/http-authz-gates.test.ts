import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedMember, seedNote, seedVault } from "./helpers/seed.js";

/**
 * Regression tests for the security fix that moved the session-authenticated
 * HTTP registry/graph routes off bare vault-membership onto the per-doc/folder
 * ACL (findings F2, F3, F6, F11). A plain member of a private-by-default vault
 * must NOT be able to read, mutate, or destroy content they were never granted
 * — while owner/admin and a note's own creator keep their access.
 */

const app = createApp({
  disconnectDoc: () => {},
  docWriter: {
    async setContent() {},
    async appendContent() {},
    async readContent() {
      return "";
    },
  },
});

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("HTTP authz gates (per-doc ACL, not bare membership)", () => {
  let owner: TestUser;
  let member: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@authz.test");
    const org = (await createOrg(owner, "Authz Co", "authz-co")).id;
    // A plain member with NO shares — the vault is private by default.
    member = await signUp("member@authz.test");
    await seedMember(org, member.userId, "member");
    vault = await seedVault(org);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("F2: member cannot delete a note they have no access to; owner can", async () => {
    const note = await seedNote(vault, null, "Secret.md", owner.userId);
    expect((await req(member, "DELETE", `/api/notes/${note}`)).status).toBe(403);
    // Still present, and the owner can delete it.
    expect((await req(owner, "DELETE", `/api/notes/${note}`)).status).toBe(200);
  });

  it("F3: member cannot rename/move a note they have no access to", async () => {
    const note = await seedNote(vault, null, "Secret.md", owner.userId);
    const res = await req(member, "PATCH", `/api/notes/${note}`, { title: "hijacked" });
    expect(res.status).toBe(403);
  });

  it("creator (a plain member) keeps edit on their own note", async () => {
    const mine = await seedNote(vault, null, "Mine.md", member.userId);
    const res = await req(member, "PATCH", `/api/notes/${mine}`, { title: "renamed" });
    expect(res.status).toBe(200);
  });

  it("F6: graph excludes notes the member cannot read, includes their own", async () => {
    const secret = await seedNote(vault, null, "Secret.md", owner.userId);
    const mine = await seedNote(vault, null, "Mine.md", member.userId);
    const res = await req(member, "GET", `/api/vaults/${vault}/graph`);
    expect(res.status).toBe(200);
    const { nodes } = (await res.json()) as { nodes: Array<{ docId: string }> };
    const ids = nodes.map((n) => n.docId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(secret);
  });

  it("F11: member cannot delete a folder they don't own; owner can", async () => {
    const folder = await seedFolder(vault, null, "Docs", "Docs");
    expect((await req(member, "DELETE", `/api/folders/${folder}`)).status).toBe(403);
    expect((await req(owner, "DELETE", `/api/folders/${folder}`)).status).toBe(200);
  });
});
