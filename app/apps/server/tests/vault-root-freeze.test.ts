import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { freezeVaultRoot, seedMember, seedVault } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";

/**
 * "Freeze vault root" — the General-settings latch that closes a vault's top
 * level to new folders and notes.
 *
 * The two rules that make it usable rather than annoying:
 *   - it applies to EVERYONE, owners included, because the accidental root
 *     folder is nearly always created by someone who does have permission;
 *   - it refuses only NEW rows, so a device re-registering a root note that
 *     predates the latch still syncs.
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

describe("frozen vault root", () => {
  let owner: TestUser;
  let member: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@freeze.test");
    member = await signUp("member@freeze.test");
    org = (await createOrg(owner, "Freeze Co", "freeze-co")).id;
    await seedMember(org, member.userId, "member");
    vault = await seedVault(org);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("owner/admin can flip the latch; a member can only read it", async () => {
    const on = await req(owner, "PATCH", `/api/vaults/${vault}`, { rootFrozen: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ rootFrozen: true });

    const refused = await req(member, "PATCH", `/api/vaults/${vault}`, { rootFrozen: false });
    expect(refused.status).toBe(403);

    // …but they can SEE it, which is what makes the disabled toggle honest.
    const list = await req(member, "GET", "/api/vaults");
    const vaults = (await list.json()).vaults as Array<{ id: string; root_frozen: boolean }>;
    expect(vaults.find((v) => v.id === vault)?.root_frozen).toBe(true);
  });

  it("refuses new root folders and root notes — even for the owner", async () => {
    await freezeVaultRoot(vault);

    const folder = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Stray",
      path: "Stray",
    });
    expect(folder.status).toBe(403);
    expect((await folder.json()).code).toBe("root_frozen");

    const note = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "stray.md",
    });
    expect(note.status).toBe(403);
    expect((await note.json()).code).toBe("root_frozen");
  });

  it("leaves creation INSIDE a folder alone", async () => {
    const folder = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Docs",
      path: "Docs",
    });
    const folderId = (await folder.json()).id as string;
    await freezeVaultRoot(vault);

    const nested = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Specs",
      path: "Docs/Specs",
      parentId: folderId,
    });
    expect(nested.status).toBe(201);

    const note = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "Docs/note.md",
      folderId,
    });
    expect(note.status).toBe(201);
  });

  it("still adopts a root note/folder that already exists (reconcile keeps working)", async () => {
    const folder = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Inbox",
      path: "Inbox",
    });
    expect(folder.status).toBe(201);
    const docId = crypto.randomUUID();
    const note = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "readme.md",
      docId,
    });
    expect(note.status).toBe(201);

    await freezeVaultRoot(vault);

    // Second device / repeat reconcile: same path, same doc_id.
    const readopt = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Inbox",
      path: "Inbox",
    });
    expect(readopt.status).toBe(200);
    const renote = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "readme.md",
      docId,
    });
    expect(renote.status).toBe(201);
  });

  it("refuses a move OUT to the root, but allows a rename in place", async () => {
    const folderRes = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Docs",
      path: "Docs",
    });
    const folderId = (await folderRes.json()).id as string;
    const nestedRes = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Specs",
      path: "Docs/Specs",
      parentId: folderId,
    });
    const nestedId = (await nestedRes.json()).id as string;
    const noteRes = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "Docs/n.md",
      folderId,
    });
    const noteId = (await noteRes.json()).id as string;
    const rootNoteRes = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "top.md",
    });
    const rootNoteId = (await rootNoteRes.json()).id as string;

    await freezeVaultRoot(vault);

    const moveFolder = await req(owner, "PATCH", `/api/folders/${nestedId}`, {
      path: "Specs",
      parentId: null,
    });
    expect(moveFolder.status).toBe(403);

    const moveNote = await req(owner, "PATCH", `/api/notes/${noteId}`, {
      relPath: "n.md",
      folderId: null,
    });
    expect(moveNote.status).toBe(403);

    // A note ALREADY at the root is being renamed, not moved out — allowed.
    const rename = await req(owner, "PATCH", `/api/notes/${rootNoteId}`, {
      relPath: "top-renamed.md",
      folderId: null,
    });
    expect(rename.status).toBe(200);
  });
});
