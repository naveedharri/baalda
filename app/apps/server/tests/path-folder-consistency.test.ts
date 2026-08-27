import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { freezeVaultRoot, seedFolder, seedNote, seedVault } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * `rel_path` and `folder_id` must agree — on every surface that creates or
 * moves a note or folder (HTTP registry + MCP), and retroactively for the rows
 * written before the rule existed (migration 022).
 *
 * The 2026-08-27 incident: an assistant created a note with `folderId` of
 * `Team/BenAI/Profiles/Vault-Operator/Daily` and a `relPath` that dropped the
 * `Team/` prefix. The root-freeze latch saw a parent and let it through; every
 * desktop rendered a phantom root-level `BenAI/` folder, materialized an empty
 * placeholder, and re-created it after every local delete. 104 more notes had
 * `folder_id NULL` with a nested path — invisible to folder shares.
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

let rpcId = 0;
async function call(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
  };
  return {
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

async function noteRow(docId: string) {
  const { rows } = await pool.query<{ rel_path: string; folder_id: string | null }>(
    "SELECT rel_path, folder_id FROM notes WHERE id = $1",
    [docId],
  );
  return rows[0];
}

describe("rel_path ↔ folder_id consistency", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let team: string;
  let daily: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@paths.test");
    org = (await createOrg(owner, "Paths Co", "paths-co")).id;
    vault = await seedVault(org);
    team = await seedFolder(vault, null, "Team", "Team");
    daily = await seedFolder(vault, team, "Daily", "Team/Daily");
  });

  describe("HTTP registry", () => {
    it("refuses a note whose relPath is not inside the folderId it names (the incident)", async () => {
      await freezeVaultRoot(vault);
      const res = await req(owner, "POST", "/api/notes", {
        vaultId: vault,
        relPath: "BenAI/Daily/2026-08-27-daily.md", // dropped the `Team/` prefix
        folderId: daily,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("path_folder_mismatch");
      expect(body.error).toContain("Team/Daily");
      // Nothing was written — no phantom root folder for every client to render.
      const { rows } = await pool.query("SELECT 1 FROM notes WHERE vault_id = $1", [vault]);
      expect(rows).toHaveLength(0);
    });

    it("resolves the folder from the path when the client sends no folderId", async () => {
      await freezeVaultRoot(vault);
      const res = await req(owner, "POST", "/api/notes", {
        vaultId: vault,
        relPath: "Team/Daily/note.md",
      });
      // Not a root creation, so the frozen root does not apply…
      expect(res.status).toBe(201);
      const body = await res.json();
      // …and the row is parented where its path says, so folder shares reach it.
      expect(body.folderId).toBe(daily);
      expect((await noteRow(body.docId)).folder_id).toBe(daily);
    });

    it("refuses a nested path whose folder does not exist (create the folder first)", async () => {
      const res = await req(owner, "POST", "/api/notes", {
        vaultId: vault,
        relPath: "Nowhere/note.md",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("path_folder_mismatch");
    });

    it("a folder's parentId must be the folder at its path's directory", async () => {
      const wrong = await req(owner, "POST", "/api/folders", {
        vaultId: vault,
        name: "Specs",
        path: "Specs", // root-level path…
        parentId: team, // …claiming a nested parent
      });
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).code).toBe("path_folder_mismatch");

      const resolved = await req(owner, "POST", "/api/folders", {
        vaultId: vault,
        name: "Specs",
        path: "Team/Specs", // no parentId: resolved from the path
      });
      expect(resolved.status).toBe(201);
      expect((await resolved.json()).parentId).toBe(team);
    });

    it("moving a note by relPath alone re-parents it, and out to a frozen root is refused", async () => {
      const docId = await seedNote(vault, daily, "Team/Daily/a.md", owner.userId);
      const moved = await req(owner, "PATCH", `/api/notes/${docId}`, { relPath: "Team/a.md" });
      expect(moved.status).toBe(200);
      expect((await moved.json()).folderId).toBe(team);
      expect(await noteRow(docId)).toEqual({ rel_path: "Team/a.md", folder_id: team });

      await freezeVaultRoot(vault);
      // A relPath-only move to the root used to slip past the latch, which only
      // looked at an explicit `folderId: null`.
      const toRoot = await req(owner, "PATCH", `/api/notes/${docId}`, { relPath: "a.md" });
      expect(toRoot.status).toBe(403);
      expect((await toRoot.json()).code).toBe("root_frozen");
      expect(await noteRow(docId)).toEqual({ rel_path: "Team/a.md", folder_id: team });
    });

    it("moving a note by folderId alone rewrites its path under that folder", async () => {
      const docId = await seedNote(vault, team, "Team/b.md", owner.userId);
      const moved = await req(owner, "PATCH", `/api/notes/${docId}`, { folderId: daily });
      expect(moved.status).toBe(200);
      expect(await noteRow(docId)).toEqual({ rel_path: "Team/Daily/b.md", folder_id: daily });
    });

    it("moving a folder by path alone re-parents it and its subtree", async () => {
      const docId = await seedNote(vault, daily, "Team/Daily/c.md", owner.userId);
      const archive = await seedFolder(vault, null, "Archive", "Archive");
      const moved = await req(owner, "PATCH", `/api/folders/${daily}`, { path: "Archive/Daily" });
      expect(moved.status).toBe(200);
      const { rows } = await pool.query<{ parent_id: string; path: string }>(
        "SELECT parent_id, path FROM folders WHERE id = $1",
        [daily],
      );
      expect(rows[0]).toEqual({ parent_id: archive, path: "Archive/Daily" });
      expect(await noteRow(docId)).toEqual({ rel_path: "Archive/Daily/c.md", folder_id: daily });
    });
  });

  describe("MCP tools", () => {
    let token: string;
    beforeEach(async () => {
      token = (await createMcpToken({ userId: owner.userId, organizationId: org }, "t")).token;
    });

    it("create_note refuses the incident's mismatched folderId/relPath pair", async () => {
      await freezeVaultRoot(vault);
      const out = await call(token, "create_note", {
        vaultId: vault,
        relPath: "BenAI/Daily/2026-08-27-daily.md",
        folderId: daily,
        content: "# Daily",
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Team/Daily");
      const { rows } = await pool.query("SELECT 1 FROM notes WHERE vault_id = $1", [vault]);
      expect(rows).toHaveLength(0);
    });

    it("create_note without folderId lands in the folder its path names", async () => {
      await freezeVaultRoot(vault);
      const out = await call(token, "create_note", {
        vaultId: vault,
        relPath: "Team/Daily/2026-08-27-daily.md",
        content: "# Daily",
      });
      expect(out.isError).toBe(false);
      expect(out.data.folderId).toBe(daily);
      expect((await noteRow(out.data.docId)).folder_id).toBe(daily);
    });

    it("move_note by relPath re-parents; folderId alone rewrites the path", async () => {
      const docId = await seedNote(vault, daily, "Team/Daily/m.md", owner.userId);
      const byPath = await call(token, "move_note", { docId, relPath: "Team/m.md" });
      expect(byPath.isError).toBe(false);
      expect(await noteRow(docId)).toEqual({ rel_path: "Team/m.md", folder_id: team });

      const byFolder = await call(token, "move_note", { docId, folderId: daily });
      expect(byFolder.isError).toBe(false);
      expect(await noteRow(docId)).toEqual({ rel_path: "Team/Daily/m.md", folder_id: daily });
    });

    it("create_folder resolves the parent from the path", async () => {
      const out = await call(token, "create_folder", { vaultId: vault, name: "Specs", path: "Team/Specs" });
      expect(out.isError).toBe(false);
      expect(out.data.parentId).toBe(team);
    });
  });

  describe("migration 022 repairs pre-existing drift", () => {
    const sql = readFileSync(new URL("../migrations/022_note_folder_consistency.sql", import.meta.url), "utf8");

    it("collapses duplicate folder rows at one path onto the oldest, re-pointing notes and children", async () => {
      // The unique index already exists in the test DB (migrations ran), so the
      // twins are seeded with it dropped and the migration puts it back.
      await pool.query("DROP INDEX IF EXISTS folders_vault_path_uq");
      const twin = await seedFolder(vault, team, "Daily", "Team/Daily"); // newer twin of `daily`
      const inTwin = await seedNote(vault, twin, "Team/Daily/twin.md", owner.userId);
      const child = await seedFolder(vault, twin, "Sub", "Team/Daily/Sub");

      await pool.query(sql);

      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM folders WHERE vault_id = $1 AND path = 'Team/Daily'",
        [vault],
      );
      expect(rows.map((r) => r.id)).toEqual([daily]); // oldest survives
      expect(await noteRow(inTwin)).toEqual({ rel_path: "Team/Daily/twin.md", folder_id: daily });
      const { rows: kid } = await pool.query<{ parent_id: string }>(
        "SELECT parent_id FROM folders WHERE id = $1",
        [child],
      );
      expect(kid[0].parent_id).toBe(daily); // child followed, not cascaded away
      // …and the backstop is back: a second row at the same path is refused.
      await expect(seedFolder(vault, team, "Daily", "Team/Daily")).rejects.toMatchObject({ code: "23505" });
    });

    it("re-points folder_id from the path, and moves a path under its folder when no folder exists there", async () => {
      // (a) folder_id NULL, nested path → parented where the path says.
      const orphan = await seedNote(vault, null, "Team/Daily/orphan.md", owner.userId);
      // (b) the incident row: folder_id = Team/Daily, path at a root folder that
      //     has no row; the correct name is already taken by a legitimate note.
      await seedNote(vault, daily, "Team/Daily/2026-08-27-daily.md", owner.userId);
      const stray = await seedNote(vault, daily, "BenAI/Daily/2026-08-27-daily.md", owner.userId);
      // (c) folder_id points at Team, path under Team/Daily (a folder exists there) → path wins.
      const mis = await seedNote(vault, team, "Team/Daily/mis.md", owner.userId);
      // (d) a consistent note is untouched.
      const fine = await seedNote(vault, team, "Team/fine.md", owner.userId);

      await pool.query(sql);

      expect(await noteRow(orphan)).toEqual({ rel_path: "Team/Daily/orphan.md", folder_id: daily });
      expect(await noteRow(stray)).toEqual({
        rel_path: `Team/Daily/2026-08-27-daily-${stray.slice(0, 8)}.md`,
        folder_id: daily,
      });
      expect(await noteRow(mis)).toEqual({ rel_path: "Team/Daily/mis.md", folder_id: daily });
      expect(await noteRow(fine)).toEqual({ rel_path: "Team/fine.md", folder_id: team });
      // Idempotent: a second run changes nothing.
      await pool.query(sql);
      expect(await noteRow(stray)).toEqual({
        rel_path: `Team/Daily/2026-08-27-daily-${stray.slice(0, 8)}.md`,
        folder_id: daily,
      });
    });
  });
});
