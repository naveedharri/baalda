import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { recordingAppDeps } from "./helpers/app.js";
import { seedFolder, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * A desktop that sees a folder vanish from disk deletes its notes and files one
 * by one, then the folder row with `?ifEmpty=1`: the server removes it only
 * when nothing live is left, never cascading over items that device did not
 * delete (or cannot see).
 */
const rec = recordingAppDeps();
const app = createApp(rec.deps);

const del = (user: TestUser, id: string, q = "?ifEmpty=1") =>
  app.fetch(new Request(`http://local/api/folders/${id}${q}`, { method: "DELETE", headers: authHeaders(user) }));
const folderExists = async (id: string) =>
  (await pool.query("SELECT 1 FROM folders WHERE id = $1", [id])).rowCount === 1;
const live = async (id: string) =>
  (await pool.query("SELECT 1 FROM notes WHERE id = $1 AND deleted_at IS NULL", [id])).rowCount === 1;

describe("DELETE /api/folders/:id?ifEmpty=1", () => {
  let owner: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp(`owner+${randomUUID().slice(0, 6)}@ifempty.test`);
    const org = (await createOrg(owner, "If Empty", `if-empty-${randomUUID().slice(0, 6)}`)).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("is advertised in /health", async () => {
    const res = await app.fetch(new Request("http://local/health"));
    const body = (await res.json()) as { features: string[] };
    expect(body.features).toContain("folder-delete-if-empty");
  });

  it("removes an empty folder", async () => {
    const f = await seedFolder(vault, null, "Gone", "Gone", owner.userId);
    const res = await del(owner, f);
    expect(res.status).toBe(200);
    expect(await folderExists(f)).toBe(false);
  });

  it("refuses a folder that still holds a live note, and deletes nothing", async () => {
    const f = await seedFolder(vault, null, "Kept", "Kept", owner.userId);
    const n = await seedNote(vault, f, "Kept/still here.md", owner.userId);
    const res = await del(owner, f);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("folder_not_empty");
    expect(await folderExists(f)).toBe(true);
    expect(await live(n)).toBe(true);
  });

  it("refuses a parent until its sub folder is gone, then removes it", async () => {
    const parent = await seedFolder(vault, null, "P", "P", owner.userId);
    const child = await seedFolder(vault, parent, "C", "P/C", owner.userId);
    expect((await del(owner, parent)).status).toBe(409);
    expect((await del(owner, child)).status).toBe(200);
    expect((await del(owner, parent)).status).toBe(200);
    expect(await folderExists(parent)).toBe(false);
  });

  it("ignores soft-deleted notes", async () => {
    const f = await seedFolder(vault, null, "Old", "Old", owner.userId);
    const n = await seedNote(vault, f, "Old/deleted.md", owner.userId);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [n]);
    expect((await del(owner, f)).status).toBe(200);
  });

  it("still cascades without the flag (the sidebar's Delete)", async () => {
    const f = await seedFolder(vault, null, "All", "All", owner.userId);
    const n = await seedNote(vault, f, "All/a.md", owner.userId);
    expect((await del(owner, f, "")).status).toBe(200);
    expect(await folderExists(f)).toBe(false);
    expect(await live(n)).toBe(false);
  });
});
