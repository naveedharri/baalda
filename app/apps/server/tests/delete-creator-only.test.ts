import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { recordingAppDeps } from "./helpers/app.js";
import { seedFolder, seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import type { NoteDeleteResult } from "../src/http/routes/bulk-types.js";

/**
 * Members delete only what they created; owners and admins delete anything.
 * One gate (`permissions/http-gates.ts canDeleteItem`) behind every delete
 * surface: the single note/file/folder routes, the note batch and MCP.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

let rpcId = 0;
async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as {
    result?: { isError?: boolean; structuredContent?: { code?: string } };
  };
  return { isError: body.result?.isError ?? false, code: body.result?.structuredContent?.code };
}

async function seedFileBy(vault: string, folder: string | null, path: string, by: string | null) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO files (id, vault_id, folder_id, path, created_by) VALUES ($1, $2, $3, $4, $5)",
    [id, vault, folder, path, by],
  );
  return id;
}

const live = async (id: string) =>
  (await pool.query("SELECT 1 FROM notes WHERE id = $1 AND deleted_at IS NULL", [id])).rowCount === 1;
const fileExists = async (id: string) =>
  (await pool.query("SELECT 1 FROM files WHERE id = $1", [id])).rowCount === 1;
const folderExists = async (id: string) =>
  (await pool.query("SELECT 1 FROM folders WHERE id = $1", [id])).rowCount === 1;

describe("members delete only what they created", () => {
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let other: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp(`owner+${randomUUID().slice(0, 6)}@delown.test`);
    org = (await createOrg(owner, "Del Own", `del-own-${randomUUID().slice(0, 6)}`)).id;
    admin = await signUp(`admin+${randomUUID().slice(0, 6)}@delown.test`);
    member = await signUp(`member+${randomUUID().slice(0, 6)}@delown.test`);
    other = await signUp(`other+${randomUUID().slice(0, 6)}@delown.test`);
    await seedMember(org, admin.userId, "admin");
    await seedMember(org, member.userId, "member");
    await seedMember(org, other.userId, "member");
    vault = await seedVault(org);
    // Everyone can edit everything, so only the creator rule can refuse.
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("notes", () => {
    it("a member deletes their own note", async () => {
      const id = await seedNote(vault, null, "mine.md", member.userId);
      expect((await req(member, "DELETE", `/api/notes/${id}`)).status).toBe(200);
      expect(await live(id)).toBe(false);
    });

    it("a member cannot delete a teammate's note, which stays untouched", async () => {
      const id = await seedNote(vault, null, "theirs.md", other.userId);
      const res = await req(member, "DELETE", `/api/notes/${id}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("delete_not_creator");
      expect(await live(id)).toBe(true);
    });

    it("admin and owner delete a teammate's note", async () => {
      const a = await seedNote(vault, null, "a.md", other.userId);
      const b = await seedNote(vault, null, "b.md", other.userId);
      expect((await req(admin, "DELETE", `/api/notes/${a}`)).status).toBe(200);
      expect((await req(owner, "DELETE", `/api/notes/${b}`)).status).toBe(200);
      expect(await live(a)).toBe(false);
      expect(await live(b)).toBe(false);
    });

    it("a note with no creator is refused for a member and allowed for an admin", async () => {
      const id = await seedNote(vault, null, "orphan.md", null);
      const res = await req(member, "DELETE", `/api/notes/${id}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("delete_not_creator");
      expect((await req(admin, "DELETE", `/api/notes/${id}`)).status).toBe(200);
    });

    it("a mixed batch deletes the member's own notes and reports the others", async () => {
      const mine = await seedNote(vault, null, "mine.md", member.userId);
      const theirs = await seedNote(vault, null, "theirs.md", other.userId);
      const orphan = await seedNote(vault, null, "orphan.md", null);
      const res = await req(member, "POST", `/api/vaults/${vault}/notes/delete-batch`, {
        docIds: [mine, theirs, orphan],
      });
      expect(res.status).toBe(200);
      const { results } = (await res.json()) as { results: NoteDeleteResult[] };
      expect(results.map((r) => [r.status, r.code])).toEqual([
        ["deleted", null],
        ["denied", "delete_not_creator"],
        ["denied", "delete_not_creator"],
      ]);
      expect(await live(mine)).toBe(false);
      expect(await live(theirs)).toBe(true);
      expect(await live(orphan)).toBe(true);
    });

    it("an admin's batch deletes everyone's notes", async () => {
      const a = await seedNote(vault, null, "a.md", other.userId);
      const b = await seedNote(vault, null, "b.md", null);
      const res = await req(admin, "POST", `/api/vaults/${vault}/notes/delete-batch`, { docIds: [a, b] });
      const { results } = (await res.json()) as { results: NoteDeleteResult[] };
      expect(results.every((r) => r.status === "deleted")).toBe(true);
    });

    it("restore is unchanged: a member restores a teammate's note an admin deleted", async () => {
      const id = await seedNote(vault, null, "theirs.md", other.userId);
      expect((await req(admin, "DELETE", `/api/notes/${id}`)).status).toBe(200);
      expect((await req(member, "POST", `/api/notes/${id}/restore`)).status).toBe(200);
      expect(await live(id)).toBe(true);
    });
  });

  describe("folders", () => {
    it("a member deletes a folder holding only their own items", async () => {
      const f = await seedFolder(vault, null, "Mine", "Mine", member.userId);
      const sub = await seedFolder(vault, f, "Sub", "Mine/Sub", member.userId);
      const n = await seedNote(vault, sub, "Mine/Sub/a.md", member.userId);
      const file = await seedFileBy(vault, f, "Mine/x.pdf", member.userId);
      expect((await req(member, "DELETE", `/api/folders/${f}`)).status).toBe(200);
      expect(await folderExists(f)).toBe(false);
      expect(await live(n)).toBe(false);
      expect(await fileExists(file)).toBe(false);
    });

    it("one foreign note refuses the whole folder delete and deletes nothing", async () => {
      const f = await seedFolder(vault, null, "Mine", "Mine", member.userId);
      const n = await seedNote(vault, f, "Mine/a.md", member.userId);
      const foreign = await seedNote(vault, f, "Mine/b.md", other.userId);
      const res = await req(member, "DELETE", `/api/folders/${f}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("folder_has_others_items");
      expect(await folderExists(f)).toBe(true);
      expect(await live(n)).toBe(true);
      expect(await live(foreign)).toBe(true);
    });

    it("a creator-less file or a foreign sub-folder also refuses it", async () => {
      const f = await seedFolder(vault, null, "Mine", "Mine", member.userId);
      await seedFileBy(vault, f, "Mine/x.pdf", null);
      const r1 = await req(member, "DELETE", `/api/folders/${f}`);
      expect(((await r1.json()) as { code: string }).code).toBe("folder_has_others_items");

      const g = await seedFolder(vault, null, "Two", "Two", member.userId);
      await seedFolder(vault, g, "Sub", "Two/Sub", other.userId);
      const r2 = await req(member, "DELETE", `/api/folders/${g}`);
      expect(r2.status).toBe(403);
      expect(((await r2.json()) as { code: string }).code).toBe("folder_has_others_items");
    });

    it("a member cannot delete a folder someone else created", async () => {
      const f = await seedFolder(vault, null, "Theirs", "Theirs", other.userId);
      const res = await req(member, "DELETE", `/api/folders/${f}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("delete_not_creator");
      expect(await folderExists(f)).toBe(true);
    });

    it("an admin deletes a folder with anyone's items", async () => {
      const f = await seedFolder(vault, null, "Mixed", "Mixed", member.userId);
      await seedNote(vault, f, "Mixed/b.md", other.userId);
      await seedFileBy(vault, f, "Mixed/x.pdf", null);
      expect((await req(admin, "DELETE", `/api/folders/${f}`)).status).toBe(200);
      expect(await folderExists(f)).toBe(false);
    });
  });

  describe("files", () => {
    it("member own OK, teammate's and creator-less refused, admin and owner OK", async () => {
      const mine = await seedFileBy(vault, null, "mine.pdf", member.userId);
      const theirs = await seedFileBy(vault, null, "theirs.pdf", other.userId);
      const orphan = await seedFileBy(vault, null, "orphan.pdf", null);
      expect((await req(member, "DELETE", `/api/files/${mine}`)).status).toBe(204);
      expect(await fileExists(mine)).toBe(false);
      for (const id of [theirs, orphan]) {
        const res = await req(member, "DELETE", `/api/files/${id}`);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe("delete_not_creator");
        expect(await fileExists(id)).toBe(true);
      }
      expect((await req(admin, "DELETE", `/api/files/${theirs}`)).status).toBe(204);
      expect((await req(owner, "DELETE", `/api/files/${orphan}`)).status).toBe(204);
      expect(await fileExists(theirs)).toBe(false);
      expect(await fileExists(orphan)).toBe(false);
    });

    it("POST /api/files stamps the registering user as the creator and the listing exposes it", async () => {
      const res = await req(member, "POST", "/api/files", { vaultId: vault, path: "up.pdf" });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const { rows } = await pool.query("SELECT created_by FROM files WHERE id = $1", [id]);
      expect(rows[0].created_by).toBe(member.userId);
      const list = (await (await req(member, "GET", `/api/files?vaultId=${vault}`)).json()) as {
        files: Array<{ id: string; created_by: string | null }>;
      };
      expect(list.files.find((f) => f.id === id)?.created_by).toBe(member.userId);
    });
  });

  describe("MCP", () => {
    let memberToken: string;
    let adminToken: string;
    beforeEach(async () => {
      memberToken = (await createMcpToken({ userId: member.userId, organizationId: org }, "t")).token;
      adminToken = (await createMcpToken({ userId: admin.userId, organizationId: org }, "t")).token;
    });

    it("delete_note: own OK, teammate's and creator-less refused, admin OK", async () => {
      const mine = await seedNote(vault, null, "mine.md", member.userId);
      const theirs = await seedNote(vault, null, "theirs.md", other.userId);
      const orphan = await seedNote(vault, null, "orphan.md", null);
      expect((await mcp(memberToken, "delete_note", { docId: mine })).isError).toBe(false);
      expect(await live(mine)).toBe(false);
      for (const id of [theirs, orphan]) {
        const r = await mcp(memberToken, "delete_note", { docId: id });
        expect(r).toEqual({ isError: true, code: "delete_not_creator" });
        expect(await live(id)).toBe(true);
      }
      expect((await mcp(adminToken, "delete_note", { docId: theirs })).isError).toBe(false);
      expect(await live(theirs)).toBe(false);
    });

    it("delete_file: own OK, teammate's refused, admin OK", async () => {
      const mine = await seedFileBy(vault, null, "mine.pdf", member.userId);
      const theirs = await seedFileBy(vault, null, "theirs.pdf", other.userId);
      expect((await mcp(memberToken, "delete_file", { fileId: mine })).isError).toBe(false);
      expect(await mcp(memberToken, "delete_file", { fileId: theirs })).toEqual({
        isError: true,
        code: "delete_not_creator",
      });
      expect(await fileExists(theirs)).toBe(true);
      expect((await mcp(adminToken, "delete_file", { fileId: theirs })).isError).toBe(false);
      expect(await fileExists(theirs)).toBe(false);
    });

    it("delete_folder: own OK, one foreign note refuses all, admin OK", async () => {
      const own = await seedFolder(vault, null, "Own", "Own", member.userId);
      await seedNote(vault, own, "Own/a.md", member.userId);
      expect((await mcp(memberToken, "delete_folder", { folderId: own, recursive: true })).isError).toBe(false);
      expect(await folderExists(own)).toBe(false);

      const mixed = await seedFolder(vault, null, "Mixed", "Mixed", member.userId);
      const a = await seedNote(vault, mixed, "Mixed/a.md", member.userId);
      await seedNote(vault, mixed, "Mixed/b.md", other.userId);
      expect(await mcp(memberToken, "delete_folder", { folderId: mixed, recursive: true })).toEqual({
        isError: true,
        code: "folder_has_others_items",
      });
      expect(await folderExists(mixed)).toBe(true);
      expect(await live(a)).toBe(true);
      expect((await mcp(adminToken, "delete_folder", { folderId: mixed, recursive: true })).isError).toBe(false);
      expect(await folderExists(mixed)).toBe(false);
    });
  });
});
