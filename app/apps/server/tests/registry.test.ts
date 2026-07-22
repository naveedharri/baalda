import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedMember, seedNote, seedVault } from "./helpers/seed.js";
import { pool as pgPool } from "../src/db/pool.js";

/**
 * Registry structure API: create/rename/move/delete of folders + notes must
 * update the relational rows correctly (preserving doc_ids on rename/move) AND
 * fire onRegistryChanged so the vault channel can broadcast a live tree refresh.
 */

let changed: string[] = [];
const app = createApp({
  disconnectDoc: () => {},
  docWriter: {
    async setContent() {},
    async appendContent() {},
    async readContent() {
      return "";
    },
  },
  onRegistryChanged: (vaultId) => changed.push(vaultId),
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

describe("registry structure sync", () => {
  let owner: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    changed = [];
    owner = await signUp("owner@registry.test");
    const org = (await createOrg(owner, "Reg Co", "reg-co")).id;
    vault = await seedVault(org);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("creating a folder and a note broadcasts a registry change", async () => {
    const f = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Docs",
      path: "Docs",
    });
    expect(f.status).toBe(201);
    const n = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "Docs/note.md",
      title: "Note",
    });
    expect(n.status).toBe(201);
    expect(changed).toEqual([vault, vault]);
  });

  it("renaming a folder rewrites its own + descendant paths, keeping doc_ids", async () => {
    const folderId = await seedFolder(vault, null, "Docs", "Docs");
    await seedFolder(vault, folderId, "Sub", "Docs/Sub");
    const noteId = await seedNote(vault, folderId, "Docs/Sub/deep.md", owner.userId);

    const res = await req(owner, "PATCH", `/api/folders/${folderId}`, {
      name: "Handbook",
      path: "Handbook",
    });
    expect(res.status).toBe(200);

    const folders = await pool.query(
      "SELECT path FROM folders WHERE vault_id = $1 ORDER BY path",
      [vault],
    );
    expect(folders.rows.map((r) => r.path)).toEqual(["Handbook", "Handbook/Sub"]);
    const note = await pool.query("SELECT id, rel_path FROM notes WHERE id = $1", [noteId]);
    expect(note.rows[0].rel_path).toBe("Handbook/Sub/deep.md"); // descendant moved
    expect(note.rows[0].id).toBe(noteId); // doc_id preserved
    expect(changed).toContain(vault);
  });

  it("renaming a note moves only that note and preserves its doc_id", async () => {
    const noteId = await seedNote(vault, null, "old.md", owner.userId);
    const res = await req(owner, "PATCH", `/api/notes/${noteId}`, {
      relPath: "new.md",
      title: "New",
    });
    expect(res.status).toBe(200);
    const row = await pool.query("SELECT id, rel_path, title FROM notes WHERE id = $1", [noteId]);
    expect(row.rows[0]).toMatchObject({ id: noteId, rel_path: "new.md", title: "New" });
  });

  it("deleting a folder soft-deletes its notes and removes the folder rows", async () => {
    const folderId = await seedFolder(vault, null, "Trash", "Trash");
    const noteId = await seedNote(vault, folderId, "Trash/gone.md", owner.userId);

    const res = await req(owner, "DELETE", `/api/folders/${folderId}`);
    expect(res.status).toBe(200);

    const folders = await pool.query("SELECT id FROM folders WHERE id = $1", [folderId]);
    expect(folders.rowCount).toBe(0);
    const note = await pool.query("SELECT deleted_at FROM notes WHERE id = $1", [noteId]);
    expect(note.rows[0].deleted_at).not.toBeNull(); // soft-deleted, doc_id kept
    // GET /notes must exclude the soft-deleted note.
    const list = await req(owner, "GET", `/api/notes?vaultId=${vault}`);
    const body = (await list.json()) as { notes: Array<{ id: string }> };
    expect(body.notes.find((x) => x.id === noteId)).toBeUndefined();
  });

  it("soft-deleting a note drops it from the listing", async () => {
    const noteId = await seedNote(vault, null, "bye.md", owner.userId);
    const res = await req(owner, "DELETE", `/api/notes/${noteId}`);
    expect(res.status).toBe(200);
    const list = await req(owner, "GET", `/api/notes?vaultId=${vault}`);
    const body = (await list.json()) as { notes: Array<{ id: string }> };
    expect(body.notes.find((x) => x.id === noteId)).toBeUndefined();
  });

  it("private-by-default: GET /notes and /folders hide another member's private items", async () => {
    // A second member of the same vault.
    const member = await signUp("member@registry.test");
    const org = (await pgPool.query(`SELECT organization_id FROM vaults WHERE id = $1`, [vault]))
      .rows[0].organization_id as string;
    await seedMember(org, member.userId, "member");

    // Owner's private folder + note (owner created them).
    const ownerFolder = await seedFolder(vault, null, "Owner", "Owner");
    const ownerNote = await seedNote(vault, ownerFolder, "Owner/secret.md", owner.userId);
    // The member's own folder + note, plus a folder shared with the team.
    const memberFolder = await seedFolder(vault, null, "Mine", "Mine");
    const memberNote = await seedNote(vault, memberFolder, "Mine/todo.md", member.userId);
    const teamFolder = await seedFolder(vault, null, "Team", "Team");
    const teamNote = await seedNote(vault, teamFolder, "Team/plan.md", owner.userId);
    await pgPool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES (gen_random_uuid()::text, $1, 'folder', $2, 'org', $1, 'edit')`,
      [org, teamFolder],
    );

    const notes = (await (await req(member, "GET", `/api/notes?vaultId=${vault}`)).json()) as {
      notes: Array<{ id: string }>;
    };
    const ids = notes.notes.map((n) => n.id);
    expect(ids).toContain(memberNote); // own note
    expect(ids).toContain(teamNote); // shared with team
    expect(ids).not.toContain(ownerNote); // owner's private note hidden

    const folders = (await (await req(member, "GET", `/api/folders?vaultId=${vault}`)).json()) as {
      folders: Array<{ id: string }>;
    };
    const fids = folders.folders.map((f) => f.id);
    expect(fids).toContain(memberFolder);
    expect(fids).toContain(teamFolder);
    expect(fids).not.toContain(ownerFolder); // owner's private folder hidden

    // The owner still sees everything.
    const ownerNotes = (await (await req(owner, "GET", `/api/notes?vaultId=${vault}`)).json()) as {
      notes: Array<{ id: string }>;
    };
    expect(ownerNotes.notes.map((n) => n.id)).toEqual(
      expect.arrayContaining([ownerNote, memberNote, teamNote]),
    );
  });
});
