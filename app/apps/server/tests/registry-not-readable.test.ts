import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedFile,
  seedFolder,
  seedItemPrivate,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * Registering a path that already exists but that the caller cannot see.
 *
 * Prod 2026-09-23: a member whose disk still held ~3,900 folders from before
 * their parents went Private re-registered all of them every ~10 s. The adopt
 * answered with each folder's id (naming private folders to anyone who sent the
 * path); the next pull's listing hid them again, the client pruned the mapping,
 * and registered them all over again. The adopt must agree with the listing.
 */
const app = createApp(testAppDeps());

let owner: TestUser;
let member: TestUser;
let org = "";
let vault = "";
let privateFolder = "";
let openFolder = "";

function post(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: { ...authHeaders(user), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

afterAll(async () => {
  await pool.end();
});

describe("adopting a path the caller cannot read", () => {
  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@not-readable.test");
    member = await signUp("member@not-readable.test");
    org = await seedOrg("Hidden Co", "hidden-co");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, member.userId, "member");
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    privateFolder = await seedFolder(vault, null, "Restricted", "Restricted", owner.userId);
    await seedItemPrivate(org, "folder", privateFolder);
    openFolder = await seedFolder(vault, null, "Team", "Team", owner.userId);
    // Shared by name, so it is in this member's listing whatever their join snapshot says.
    await seedShare(org, "folder", openFolder, member.userId, "edit");
  });

  it("refuses a hidden folder without naming it, and still adopts a visible one", async () => {
    const res = await post(member, `/api/vaults/${vault}/folders/batch`, {
      items: [
        { path: "Restricted", name: "Restricted" },
        { path: "restricted", name: "restricted" },
        { path: "Team", name: "Team" },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: Array<{ path: string; id: string | null; status: string; code: string | null }>;
    };
    for (const hidden of results.slice(0, 2)) {
      expect(hidden).toMatchObject({ status: "error", code: "not_readable", id: null });
      expect(JSON.stringify(hidden)).not.toContain(privateFolder);
    }
    expect(results[2]).toMatchObject({ status: "adopted", id: openFolder });

    // The invariant, for every caller: a folder is adopted exactly when that
    // caller's own listing shows it. Anything else loops.
    for (const user of [owner, member]) {
      const listed = await app.fetch(
        new Request(`http://local/api/folders?vaultId=${vault}`, { headers: authHeaders(user) }),
      );
      const visible = new Set(
        ((await listed.json()) as { folders: Array<{ id: string }> }).folders.map((f) => f.id),
      );
      const out = await post(user, `/api/vaults/${vault}/folders/batch`, {
        items: [
          { path: "Restricted", name: "Restricted" },
          { path: "Team", name: "Team" },
        ],
      });
      const body = (await out.json()) as { results: Array<{ id: string | null; status: string }> };
      expect(body.results[0].status === "adopted").toBe(visible.has(privateFolder));
      expect(body.results[1].status === "adopted").toBe(visible.has(openFolder));
    }
  });

  it("refuses a hidden note and a hidden file at an existing path", async () => {
    const noteId = await seedNote(vault, privateFolder, "Restricted/plan.md", owner.userId);
    const fileId = await seedFile(vault, privateFolder, "Restricted/deck.pdf");

    const notes = await post(member, `/api/vaults/${vault}/notes/batch`, {
      items: [{ relPath: "Restricted/plan.md", folderPath: "Restricted" }],
    });
    const noteBody = (await notes.json()) as {
      results: Array<{ docId: string | null; status: string; code: string | null }>;
    };
    expect(noteBody.results[0]).toMatchObject({ status: "error", code: "not_readable", docId: null });
    expect(JSON.stringify(noteBody)).not.toContain(noteId);

    const files = await post(member, `/api/vaults/${vault}/files/batch`, {
      items: [{ relPath: "Restricted/deck.pdf", folderPath: "Restricted", sha256: "a".repeat(64), size: 3, mime: null }],
    });
    const fileBody = (await files.json()) as {
      results: Array<{ fileId: string | null; status: string; code: string | null }>;
    };
    expect(fileBody.results[0]).toMatchObject({ status: "error", code: "not_readable", fileId: null });
    expect(JSON.stringify(fileBody)).not.toContain(fileId);

    // The single-item route answers the same refusal with a code the client can key on.
    const single = await post(member, "/api/files", { vaultId: vault, path: "Restricted/deck.pdf" });
    expect(single.status).toBe(409);
    expect(await single.json()).toMatchObject({ code: "not_readable" });
  });
});
