// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A teammate deletes a note or folder while someone's move of it is between its
 * gates and its write (found in the five-app test, 2026-11-28: a member moved
 * their note as the owner deleted its folder). The second lookup found nothing
 * and the route answered 500. It must answer like an item already gone.
 */
const race = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));
vi.mock("../src/permissions/http-gates.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/permissions/http-gates.js")>();
  return {
    ...real,
    canRenameItem: async (...args: Parameters<typeof real.canRenameItem>) => {
      const out = await real.canRenameItem(...args);
      const hook = race.before;
      race.before = null;
      if (hook) await hook();
      return out;
    },
  };
});

import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedNote, seedUserVaultGrant, seedVault } from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";

const app = createApp(testAppDeps());

afterAll(async () => {
  await pool.end();
});

function patch(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, { method: "PATCH", headers: authHeaders(user), body: JSON.stringify(body) }),
  );
}

describe("a move racing a delete", () => {
  let owner: TestUser;
  let vault: string;
  let folder: string;
  let note: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@move-race.test");
    const org = (await createOrg(owner, "Race Co", "race-co")).id;
    vault = await seedVault(org);
    await seedUserVaultGrant(org, owner.userId, "edit");
    folder = await seedFolder(vault, null, "Old", "Old", owner.userId);
    await seedFolder(vault, null, "New", "New", owner.userId);
    note = await seedNote(vault, folder, "Old/a.md", owner.userId);
  });

  it("a note deleted mid-move answers 404, not 500", async () => {
    race.before = async () => {
      await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [note]);
    };
    const res = await patch(owner, `/api/notes/${note}`, { relPath: "New/a.md" });
    expect(res.status).toBe(404);
  });

  it("a folder deleted mid-move answers 404, not 500", async () => {
    race.before = async () => {
      await pool.query("UPDATE notes SET folder_id = NULL, rel_path = 'a.md' WHERE id = $1", [note]);
      await pool.query("DELETE FROM folders WHERE id = $1", [folder]);
    };
    const res = await patch(owner, `/api/folders/${folder}`, { path: "Renamed", name: "Renamed" });
    expect(res.status).toBe(404);
  });
});
