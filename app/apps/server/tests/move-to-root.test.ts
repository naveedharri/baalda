// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { sealVault, seedFolder, seedMember, seedNote, seedUserVaultGrant, seedVault } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";

/**
 * Moving a note or a folder OUT to the top of the vault is a root creation by
 * another name, so it needs the same right as creating there (files already
 * judge their destination with `canCreateIn`). Found in the five-app test
 * (2026-11-28): a member who could edit one folder through a group moved their
 * note out to the root, where only people with a whole-vault level read it, and
 * could then no longer move it back.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

afterAll(async () => {
  await pool.end();
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

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  return { isError: body.result?.isError ?? false, text: body.result?.content?.[0]?.text ?? "" };
}

async function groupGrant(org: string, member: string, type: "folder" | "vault", id: string, permission: "view" | "edit") {
  const g = randomUUID();
  await pool.query("INSERT INTO access_groups (id, organization_id, name, auto_join) VALUES ($1, $2, $3, false)", [g, org, "Team " + g.slice(0, 4)]);
  await pool.query("INSERT INTO access_group_members (group_id, organization_id, user_id) VALUES ($1, $2, $3)", [g, org, member]);
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, access_revision)
     VALUES ($1, $2, $3, $4, 'group', $5, $6, 1)`,
    [randomUUID(), org, type, type === "vault" ? org : id, g, permission],
  );
}

describe("moving out to the top of the vault", () => {
  let owner: TestUser;
  let member: TestUser;
  let org: string;
  let vault: string;
  let folder: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@to-root.test");
    member = await signUp("member@to-root.test");
    org = (await createOrg(owner, "Root Co", "root-co")).id;
    await seedMember(org, member.userId, "member");
    vault = await seedVault(org);
    await sealVault(org);
    // Like every new vault: the creator's own Can edit everything. The member
    // has no setting of their own; a group gives Can view on everything.
    await seedUserVaultGrant(org, owner.userId, "edit");
    await groupGrant(org, member.userId, "vault", org, "view");
    folder = await seedFolder(vault, null, "Projects", "Projects", owner.userId);
  });

  it("refuses a member who can edit only the folder, over HTTP and the AI tools; the note stays put", async () => {
    await groupGrant(org, member.userId, "folder", folder, "edit");
    const note = await seedNote(vault, folder, "Projects/mine.md", member.userId);
    const sub = await seedFolder(vault, folder, "Sub", "Projects/Sub", member.userId);

    const moveNote = await req(member, "PATCH", `/api/notes/${note}`, { relPath: "mine.md" });
    expect(moveNote.status).toBe(403);
    const moveFolder = await req(member, "PATCH", `/api/folders/${sub}`, { path: "Sub", parentId: null });
    expect(moveFolder.status).toBe(403);

    const token = (await createMcpToken({ userId: member.userId, organizationId: org }, "to-root")).token;
    expect((await mcp(token, "move_note", { docId: note, relPath: "mine.md" })).isError).toBe(true);
    expect((await mcp(token, "move_folder", { folderId: sub, path: "Sub", parentId: null })).isError).toBe(true);

    const rows = await pool.query("SELECT rel_path, folder_id FROM notes WHERE id = $1", [note]);
    expect(rows.rows[0]).toEqual({ rel_path: "Projects/mine.md", folder_id: folder });
    const f = await pool.query("SELECT path, parent_id FROM folders WHERE id = $1", [sub]);
    expect(f.rows[0]).toEqual({ path: "Projects/Sub", parent_id: folder });

    // A rename inside the folder is untouched.
    const rename = await req(member, "PATCH", `/api/notes/${note}`, { relPath: "Projects/renamed.md" });
    expect(rename.status).toBe(200);
  });

  it("allows it for whoever may create at the top: their own Can edit everything, a group's, the owner", async () => {
    const own = await seedNote(vault, folder, "Projects/a.md", owner.userId);
    expect((await req(owner, "PATCH", `/api/notes/${own}`, { relPath: "a.md" })).status).toBe(200);

    await groupGrant(org, member.userId, "vault", org, "edit");
    const note = await seedNote(vault, folder, "Projects/b.md", member.userId);
    expect((await req(member, "PATCH", `/api/notes/${note}`, { relPath: "b.md" })).status).toBe(200);
    const sub = await seedFolder(vault, folder, "Sub", "Projects/Sub", member.userId);
    expect((await req(member, "PATCH", `/api/folders/${sub}`, { path: "Sub", parentId: null })).status).toBe(200);
  });
});
