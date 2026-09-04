import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedNote, seedVault } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * A path names ONE folder and ONE live note per vault, compared
 * case-insensitively — on every surface that creates or moves one.
 *
 * The 2026-09-04 incident: `Projects/Community` (2026-08-07) and
 * `Projects/community` (a teammate, 2026-08-20) both existed on the server, and
 * the duplication had spread through the subtree — 71 folders, 164 note pairs.
 * macOS/Windows cannot tell those paths apart, so every desktop mapped ONE file
 * to TWO doc_ids: doc A egested to disk, the watcher fired, doc B ingested a
 * file that disagreed with its CRDT state and wrote back, forever. 189 MB of
 * updates an hour; individual updates had grown past 3 MB. Migration 021's
 * exact-path unique index cannot see a case-only collision.
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
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
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

async function liveNotes(vaultId: string) {
  const { rows } = await pool.query<{ id: string; rel_path: string }>(
    "SELECT id, rel_path FROM notes WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path",
    [vaultId],
  );
  return rows;
}

describe("case-insensitive path identity", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let projects: string;
  let community: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@case.test");
    org = (await createOrg(owner, "Case Co", "case-co")).id;
    vault = await seedVault(org);
    projects = await seedFolder(vault, null, "Projects", "Projects");
    community = await seedFolder(vault, projects, "Community", "Projects/Community");
  });

  describe("HTTP registry", () => {
    it("adopts the existing note when a case-variant of its path is registered", async () => {
      const first = await req(owner, "POST", "/api/notes", {
        vaultId: vault,
        relPath: "Projects/Community/spec.md",
      });
      expect(first.status).toBe(201);
      const original = (await first.json()).docId as string;

      // A second device walked the same case-insensitive disk and spells it
      // differently. This is the exact call that forked the note in production.
      const second = await req(owner, "POST", "/api/notes", {
        vaultId: vault,
        relPath: "projects/community/SPEC.md",
      });
      expect(second.status).toBe(200);
      const body = await second.json();
      // Same doc_id — one file, one CRDT doc, no ping-pong…
      expect(body.docId).toBe(original);
      // …and the caller is told the canonical spelling so it converges.
      expect(body.relPath).toBe("Projects/Community/spec.md");
      expect(await liveNotes(vault)).toHaveLength(1);
    });

    it("adopts the existing folder when a case-variant of its path is registered", async () => {
      const res = await req(owner, "POST", "/api/folders", {
        vaultId: vault,
        name: "community",
        path: "Projects/community",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(community);
      expect(body.path).toBe("Projects/Community");

      const { rows } = await pool.query("SELECT 1 FROM folders WHERE vault_id = $1", [vault]);
      expect(rows).toHaveLength(2); // Projects + Community, no twin
    });

    it("stores a note under the folder's own spelling, not the caller's", async () => {
      const res = await req(owner, "POST", "/api/notes", {
        vaultId: vault,
        relPath: "Projects/community/notes.md", // lowercase folder segment
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      // Resolved to the real folder, and the stored path agrees with it exactly —
      // migration 022's dirname(rel_path) === folder.path stays true, not merely
      // true-up-to-case (a case-only mismatch would refuse the note's next move).
      expect(body.folderId).toBe(community);
      expect(body.relPath).toBe("Projects/Community/notes.md");
    });

    it("refuses a move onto a path another live note holds case-insensitively", async () => {
      const a = await seedNote(vault, community, "Projects/Community/a.md");
      await seedNote(vault, community, "Projects/Community/b.md");
      const res = await req(owner, "PATCH", `/api/notes/${a}`, {
        relPath: "Projects/Community/B.md",
      });
      // 400 is this surface's contract for a TreeOpError (same as an exact-path
      // collision), not 409.
      expect(res.status).toBe(400);
      // Still where it was: the fork was refused, not half-applied.
      const { rows } = await pool.query("SELECT rel_path FROM notes WHERE id = $1", [a]);
      expect(rows[0].rel_path).toBe("Projects/Community/a.md");
    });

    it("still allows a pure case rename of a note (nothing else claims the path)", async () => {
      const a = await seedNote(vault, community, "Projects/Community/notes.md");
      const res = await req(owner, "PATCH", `/api/notes/${a}`, {
        relPath: "Projects/Community/Notes.md",
      });
      expect(res.status).toBe(200);
      const { rows } = await pool.query("SELECT rel_path FROM notes WHERE id = $1", [a]);
      expect(rows[0].rel_path).toBe("Projects/Community/Notes.md");
    });

    it("still allows a pure case rename of a folder, rewriting descendants", async () => {
      await seedNote(vault, community, "Projects/Community/a.md");
      const res = await req(owner, "PATCH", `/api/folders/${community}`, {
        path: "Projects/community",
        name: "community",
      });
      expect(res.status).toBe(200);
      const { rows: f } = await pool.query("SELECT path FROM folders WHERE id = $1", [community]);
      expect(f[0].path).toBe("Projects/community");
      // Descendants follow, or the subtree would be split across two spellings.
      const { rows: n } = await pool.query(
        "SELECT rel_path FROM notes WHERE vault_id = $1 AND deleted_at IS NULL",
        [vault],
      );
      expect(n[0].rel_path).toBe("Projects/community/a.md");
    });

    it("refuses a folder move onto a case-variant of another folder's path", async () => {
      const other = await seedFolder(vault, projects, "Marketing", "Projects/Marketing");
      const res = await req(owner, "PATCH", `/api/folders/${other}`, {
        path: "Projects/COMMUNITY",
      });
      expect(res.status).toBe(400);
      const { rows } = await pool.query("SELECT path FROM folders WHERE id = $1", [other]);
      expect(rows[0].path).toBe("Projects/Marketing");
    });
  });

  describe("MCP tools", () => {
    let token: string;

    beforeEach(async () => {
      token = (
        await createMcpToken({ userId: owner.userId, organizationId: org }, "test")
      ).token;
    });

    it("adopts rather than forking when an assistant asks for a case-variant path", async () => {
      const first = await call(token, "create_note", {
        vaultId: vault,
        relPath: "Projects/Community/plan.md",
        content: "# Plan",
      });
      expect(first.isError).toBe(false);

      const second = await call(token, "create_note", {
        vaultId: vault,
        relPath: "projects/COMMUNITY/Plan.md",
        content: "# Different",
      });
      expect(second.isError).toBe(false);
      expect(second.data.adopted).toBe(true);
      expect(second.data.docId).toBe(first.data.docId);
      expect(second.data.relPath).toBe("Projects/Community/plan.md");
      // Adopt must never overwrite a note that already says something.
      expect(second.data.seeded).toBe(false);
      expect(await liveNotes(vault)).toHaveLength(1);
    });

    it("adopts an existing folder for a case-variant create_folder", async () => {
      const res = await call(token, "create_folder", {
        vaultId: vault,
        name: "community",
        path: "PROJECTS/community",
      });
      expect(res.isError).toBe(false);
      expect(res.data.adopted).toBe(true);
      expect(res.data.folderId).toBe(community);
      expect(res.data.path).toBe("Projects/Community");
    });

    it("refuses move_note onto a case-variant of an occupied path", async () => {
      const a = await seedNote(vault, community, "Projects/Community/a.md", owner.userId);
      await seedNote(vault, community, "Projects/Community/b.md", owner.userId);
      const res = await call(token, "move_note", { docId: a, relPath: "Projects/Community/B.MD" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("already exists");
    });
  });

  describe("the database backstop (migration 023)", () => {
    it("rejects a second folder row whose path differs only by case", async () => {
      await expect(
        pool.query(
          "INSERT INTO folders (id, vault_id, parent_id, name, path) VALUES ($1, $2, $3, $4, $5)",
          [crypto.randomUUID(), vault, projects, "community", "Projects/community"],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("rejects a second live note row whose path differs only by case", async () => {
      await seedNote(vault, community, "Projects/Community/a.md");
      await expect(
        pool.query(
          `INSERT INTO notes (id, vault_id, folder_id, rel_path, doc_id)
           VALUES ($1, $2, $3, $4, $1)`,
          [crypto.randomUUID(), vault, community, "Projects/Community/A.md"],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("allows a case-variant path once the twin is soft-deleted", async () => {
      const a = await seedNote(vault, community, "Projects/Community/a.md");
      await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [a]);
      // The partial index only covers live rows, so a tombstone frees the path.
      await expect(
        pool.query(
          `INSERT INTO notes (id, vault_id, folder_id, rel_path, doc_id)
           VALUES ($1, $2, $3, $4, $1)`,
          [crypto.randomUUID(), vault, community, "Projects/Community/A.md"],
        ),
      ).resolves.toBeTruthy();
    });
  });
});
