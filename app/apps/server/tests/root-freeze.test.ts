import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  freezeVaultRoot,
  seedFolder,
  seedMember,
  seedNote,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * "Freeze vault root", part two: the cases `vault-root-freeze.test.ts` does not
 * reach.
 *
 * That suite proves the latch on the HTTP registry for an owner. These are the
 * ways round it that a second surface or a disagreeing pair of inputs could
 * open:
 *   - the MCP tools, which have their OWN copy of the latch
 *     (`mcp/service.ts assertRootNotFrozen`) rather than sharing the registry
 *     route's — so parity has to be asserted, not assumed;
 *   - `rel_path` vs `folder_id`, the two halves of a location that must agree:
 *     the latch judges the RESOLVED parent, so neither half alone may talk it
 *     into seeing a folder that isn't there;
 *   - a member rather than the owner, because the latch is deliberately
 *     role-blind while the TOGGLE is owner/admin-only;
 *   - and lifting the latch, which has to restore creation with no other trace.
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
/** `tools/call` against the MCP surface → parsed tool result. */
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
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
    result?: {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text: string }>;
    };
  };
  return {
    isError: body.result?.isError ?? false,
    data: (body.result?.structuredContent ?? {}) as Record<string, unknown>,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

/** Live (non-deleted) note rows at the vault ROOT. */
async function rootNotes(vaultId: string): Promise<string[]> {
  const { rows } = await pool.query<{ rel_path: string }>(
    `SELECT rel_path FROM notes
      WHERE vault_id = $1 AND folder_id IS NULL AND deleted_at IS NULL
      ORDER BY rel_path`,
    [vaultId],
  );
  return rows.map((r) => r.rel_path);
}

/** Folder rows at the vault ROOT. */
async function rootFolders(vaultId: string): Promise<string[]> {
  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM folders WHERE vault_id = $1 AND parent_id IS NULL ORDER BY path",
    [vaultId],
  );
  return rows.map((r) => r.path);
}

describe("root freeze — toggle authorization", () => {
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@rootfreeze.test");
    admin = await signUp("admin@rootfreeze.test");
    member = await signUp("member@rootfreeze.test");
    org = (await createOrg(owner, "Freeze Two", "freeze-two")).id;
    await seedMember(org, admin.userId, "admin");
    await seedMember(org, member.userId, "member");
    vault = await seedVault(org);
  });

  it("an admin can flip it too; a member cannot, and a non-member cannot see the vault", async () => {
    const byAdmin = await req(admin, "PATCH", `/api/vaults/${vault}`, { rootFrozen: true });
    expect(byAdmin.status).toBe(200);
    expect(await byAdmin.json()).toMatchObject({ rootFrozen: true });

    expect((await req(member, "PATCH", `/api/vaults/${vault}`, { rootFrozen: false })).status).toBe(
      403,
    );

    const outsider = await signUp("outsider@rootfreeze.test");
    expect(
      (await req(outsider, "PATCH", `/api/vaults/${vault}`, { rootFrozen: false })).status,
    ).toBe(403);
  });

  it("needs a boolean and a real vault", async () => {
    expect((await req(owner, "PATCH", `/api/vaults/${vault}`, {})).status).toBe(400);
    expect((await req(owner, "PATCH", `/api/vaults/${vault}`, { rootFrozen: "yes" })).status).toBe(
      400,
    );
    expect((await req(owner, "PATCH", "/api/vaults/no-such-vault", { rootFrozen: true })).status).toBe(
      404,
    );
  });

  it("broadcasts registry-changed so every open app learns the latch moved", async () => {
    rec.registryBroadcasts.length = 0;
    expect((await req(owner, "PATCH", `/api/vaults/${vault}`, { rootFrozen: true })).status).toBe(
      200,
    );
    // The desktop re-reads `rootFrozen` on this frame (store.refreshVaultSettings);
    // without it a teammate's freeze would only reach other apps on a restart.
    expect(rec.registryBroadcasts.some((b) => b.vaultId === vault)).toBe(true);
  });

  it("lifting the latch restores creation, and leaves nothing else behind", async () => {
    await freezeVaultRoot(vault);
    expect((await req(owner, "POST", "/api/notes", { vaultId: vault, relPath: "a.md" })).status).toBe(
      403,
    );

    const off = await req(owner, "PATCH", `/api/vaults/${vault}`, { rootFrozen: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ rootFrozen: false });

    expect((await req(owner, "POST", "/api/notes", { vaultId: vault, relPath: "a.md" })).status).toBe(
      201,
    );
    expect(
      (await req(owner, "POST", "/api/folders", { vaultId: vault, name: "New", path: "New" }))
        .status,
    ).toBe(201);
    expect(await rootNotes(vault)).toEqual(["a.md"]);
    expect(await rootFolders(vault)).toEqual(["New"]);
  });
});

describe("root freeze — HTTP registry writes", () => {
  let owner: TestUser;
  let member: TestUser;
  let org: string;
  let vault: string;
  let docsFolder: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@rf-http.test");
    member = await signUp("member@rf-http.test");
    org = (await createOrg(owner, "Freeze HTTP", "freeze-http")).id;
    await seedMember(org, member.userId, "member");
    // Shared-with-team, the default posture for a new vault: the member has
    // write access everywhere, so a refusal below is the LATCH talking and not
    // the ACL (`canCreateIn` runs just ahead of it).
    await seedVaultGrant(org, "edit");
    vault = await seedVault(org);
    docsFolder = await seedFolder(vault, null, "Docs", "Docs");
  });

  it("refuses a member's root note and root folder, and writes nothing", async () => {
    await freezeVaultRoot(vault);

    const note = await req(member, "POST", "/api/notes", { vaultId: vault, relPath: "stray.md" });
    expect(note.status).toBe(403);
    expect((await note.json()).code).toBe("root_frozen");

    const folder = await req(member, "POST", "/api/folders", {
      vaultId: vault,
      name: "Stray",
      path: "Stray",
    });
    expect(folder.status).toBe(403);
    expect((await folder.json()).code).toBe("root_frozen");

    expect(await rootNotes(vault)).toEqual([]);
    expect(await rootFolders(vault)).toEqual(["Docs"]);
  });

  it("leaves creation inside an existing root folder alone, for a member too", async () => {
    await freezeVaultRoot(vault);

    const nested = await req(member, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "Docs/note.md",
      folderId: docsFolder,
    });
    expect(nested.status).toBe(201);
    expect((await nested.json()).folderId).toBe(docsFolder);

    const sub = await req(member, "POST", "/api/folders", {
      vaultId: vault,
      name: "Specs",
      path: "Docs/Specs",
      parentId: docsFolder,
    });
    expect(sub.status).toBe(201);
    expect(await rootFolders(vault)).toEqual(["Docs"]);
  });

  it("a relPath at the root cannot be dressed up as nested with a folderId", async () => {
    await freezeVaultRoot(vault);
    // The pair disagrees, so it is refused as a mismatch BEFORE the latch is
    // consulted — either way nothing lands at the root.
    const res = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "stray.md", // root…
      folderId: docsFolder, // …claiming a folder
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("path_folder_mismatch");
    expect(await rootNotes(vault)).toEqual([]);

    const folder = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Stray",
      path: "Stray",
      parentId: docsFolder,
    });
    expect(folder.status).toBe(400);
    expect((await folder.json()).code).toBe("path_folder_mismatch");
    expect(await rootFolders(vault)).toEqual(["Docs"]);
  });

  it("a nested relPath with no folderId still resolves to its folder, not the root", async () => {
    await freezeVaultRoot(vault);
    const res = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "Docs/resolved.md",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).folderId).toBe(docsFolder);
    expect(await rootNotes(vault)).toEqual([]);
  });

  it("refuses a move to the root whichever half of the location says so", async () => {
    const deep = await seedFolder(vault, docsFolder, "Specs", "Docs/Specs");
    const byFolderId = await seedNote(vault, docsFolder, "Docs/a.md", owner.userId);
    const byRelPath = await seedNote(vault, docsFolder, "Docs/b.md", owner.userId);
    await freezeVaultRoot(vault);

    // Note, `folderId: null` alone.
    const a = await req(owner, "PATCH", `/api/notes/${byFolderId}`, { folderId: null });
    expect(a.status).toBe(403);
    expect((await a.json()).code).toBe("root_frozen");

    // Note, `relPath` alone — the plan resolves the parent, so this is the same move.
    const b = await req(owner, "PATCH", `/api/notes/${byRelPath}`, { relPath: "b.md" });
    expect(b.status).toBe(403);
    expect((await b.json()).code).toBe("root_frozen");

    // Folder, `parentId: null` alone, and by path alone.
    const c = await req(owner, "PATCH", `/api/folders/${deep}`, { parentId: null });
    expect(c.status).toBe(403);
    expect((await c.json()).code).toBe("root_frozen");

    const d = await req(owner, "PATCH", `/api/folders/${deep}`, { path: "Specs" });
    expect(d.status).toBe(403);
    expect((await d.json()).code).toBe("root_frozen");

    expect(await rootNotes(vault)).toEqual([]);
    expect(await rootFolders(vault)).toEqual(["Docs"]);
  });

  it("still allows renaming and deleting what is already at the root", async () => {
    const rootNote = await seedNote(vault, null, "top.md", owner.userId);
    const rootFolder = await seedFolder(vault, null, "Inbox", "Inbox");
    await freezeVaultRoot(vault);

    // "Nothing already at the root is moved, renamed, or hidden" — the latch
    // closes the root to NEW items, it does not make the existing ones read-only.
    expect(
      (await req(owner, "PATCH", `/api/notes/${rootNote}`, { relPath: "top-2.md" })).status,
    ).toBe(200);
    expect((await req(owner, "PATCH", `/api/folders/${rootFolder}`, { name: "Inbox 2" })).status).toBe(
      200,
    );
    expect((await req(owner, "DELETE", `/api/notes/${rootNote}`)).status).toBe(200);
    expect(await rootNotes(vault)).toEqual([]);
    expect(await rootFolders(vault)).toEqual(["Docs", "Inbox 2"]);
  });

  it("does not let a soft-deleted root note come back under a new doc_id", async () => {
    const gone = await seedNote(vault, null, "archived.md", owner.userId);
    expect((await req(owner, "DELETE", `/api/notes/${gone}`)).status).toBe(200);
    await freezeVaultRoot(vault);

    // A device that still has the file and has lost its mapping registers it
    // afresh: a brand-new row at the root, which is exactly what the latch is for.
    const res = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "archived.md",
      docId: crypto.randomUUID(),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("root_frozen");
    expect(await rootNotes(vault)).toEqual([]);
  });

  it("a re-register that names an EXISTING doc_id never creates a root row", async () => {
    // The latch's create gate asks "does a note with this id exist?", so a
    // request pairing an already-known doc_id with a NEW root path walks past
    // it. What saves the vault is the insert: `ON CONFLICT (id) DO NOTHING`
    // writes nothing, so the note stays where it is.
    //
    // The response is nonetheless a 201 describing the root path the caller
    // asked for, which is a lie the client then persists in its path map. This
    // asserts the part that matters and must hold either way — no root row —
    // rather than the status quo of the status code.
    const inFolder = await seedNote(vault, docsFolder, "Docs/known.md", owner.userId);
    await freezeVaultRoot(vault);

    await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "known.md",
      docId: inFolder,
    });

    expect(await rootNotes(vault)).toEqual([]);
    const { rows } = await pool.query<{ rel_path: string; folder_id: string | null }>(
      "SELECT rel_path, folder_id FROM notes WHERE id = $1",
      [inFolder],
    );
    expect(rows[0]).toEqual({ rel_path: "Docs/known.md", folder_id: docsFolder });
  });
});

describe("root freeze — MCP parity", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let docsFolder: string;
  let token: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@rf-mcp.test");
    org = (await createOrg(owner, "Freeze MCP", "freeze-mcp")).id;
    vault = await seedVault(org);
    docsFolder = await seedFolder(vault, null, "Docs", "Docs");
    token = (await createMcpToken({ userId: owner.userId, organizationId: org }, "test")).token;
  });

  it("refuses create_note and create_folder at a frozen root", async () => {
    await freezeVaultRoot(vault);

    const note = await call(token, "create_note", {
      vaultId: vault,
      relPath: "stray.md",
      title: "Stray",
      content: "hello",
    });
    expect(note.isError).toBe(true);
    expect(note.text).toContain("root is frozen");

    const folder = await call(token, "create_folder", {
      vaultId: vault,
      name: "Stray",
      path: "Stray",
    });
    expect(folder.isError).toBe(true);
    expect(folder.text).toContain("root is frozen");

    expect(await rootNotes(vault)).toEqual([]);
    expect(await rootFolders(vault)).toEqual(["Docs"]);
  });

  it("still creates inside an existing folder, and adopts a pre-freeze root note", async () => {
    const before = await call(token, "create_note", {
      vaultId: vault,
      relPath: "readme.md",
      title: "Readme",
    });
    expect(before.isError).toBe(false);
    await freezeVaultRoot(vault);

    const nested = await call(token, "create_note", {
      vaultId: vault,
      relPath: "Docs/n.md",
      title: "N",
      folderId: docsFolder,
    });
    expect(nested.isError).toBe(false);
    expect(nested.data.folderId).toBe(docsFolder);

    const sub = await call(token, "create_folder", {
      vaultId: vault,
      name: "Specs",
      path: "Docs/Specs",
      parentId: docsFolder,
    });
    expect(sub.isError).toBe(false);

    // The adopt path runs BEFORE the latch, so an assistant re-creating a root
    // note that already exists gets the existing one instead of a refusal.
    const readopt = await call(token, "create_note", {
      vaultId: vault,
      relPath: "readme.md",
      title: "Readme",
    });
    expect(readopt.isError).toBe(false);
    expect(readopt.data.adopted).toBe(true);
    expect(readopt.data.docId).toBe(before.data.docId);
    expect(await rootNotes(vault)).toEqual(["readme.md"]);
  });

  it("refuses a root create whose path and parent disagree, rather than resolving it to the root", async () => {
    await freezeVaultRoot(vault);
    const note = await call(token, "create_note", {
      vaultId: vault,
      relPath: "stray.md",
      title: "Stray",
      folderId: docsFolder,
    });
    expect(note.isError).toBe(true);
    expect(note.text).toContain("not inside folder");
    expect(await rootNotes(vault)).toEqual([]);
  });

  it("unfreezing lets the same assistant call through", async () => {
    await freezeVaultRoot(vault);
    expect(
      (await call(token, "create_note", { vaultId: vault, relPath: "later.md", title: "Later" }))
        .isError,
    ).toBe(true);

    await freezeVaultRoot(vault, false);
    const ok = await call(token, "create_note", {
      vaultId: vault,
      relPath: "later.md",
      title: "Later",
    });
    expect(ok.isError).toBe(false);
    expect(await rootNotes(vault)).toEqual(["later.md"]);
  });
});
