import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import {
  seedFolder,
  seedLock,
  seedMember,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
} from "./helpers/seed.js";
import { createMcpToken, listMcpTokens } from "../src/mcp/tokens.js";

/**
 * End-to-end MCP surface: token auth, JSON-RPC dispatch, CRUD tools, and that
 * the tools honour the SAME ACL as the rest of the app (admins see all; members
 * see only what's shared; tokens can't reach outside their vault).
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);
const mem = rec.docWriter;
const disconnected = rec.disconnected;
/** Every `registry-changed` broadcast the MCP routes fire. An MCP write that
 *  doesn't land here is invisible to every running app until it restarts. */
const registryBroadcasts = rec.registryBroadcasts;

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
  return res;
}

/** tools/call helper → returns the parsed tool result (structuredContent + isError). */
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
  };
  return {
    status: res.status,
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

async function tokenFor(userId: string, orgId: string): Promise<string> {
  const { token } = await createMcpToken({ userId, organizationId: orgId }, "test");
  return token;
}

/** Poll `fn` until it returns non-null (best-effort async writes settle). */
async function waitFor<T>(fn: () => Promise<T | null>, tries = 50): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v != null) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: condition never met");
}

describe("MCP server", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("rejects missing/invalid tokens with 401", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc("mcp_not-a-real-token", "tools/list")).status).toBe(401);
  });

  it("initialize + tools/list advertise the CRUD tools", async () => {
    const owner = await seedUser("owner@mcp.com");
    const org = await seedOrg("Acme", "acme-mcp1");
    await seedMember(org, owner, "owner");
    const token = await tokenFor(owner, org);

    const init = await (await rpc(token, "initialize", {})).json();
    expect((init as any).result.serverInfo.name).toBe("context");

    const list = await (await rpc(token, "tools/list")).json();
    const names = (list as any).result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_vaults",
        "list_notes",
        "read_note",
        "create_note",
        "update_note",
        "delete_note",
        "search_notes",
      ]),
    );
  });

  it("owner: full note CRUD lifecycle", async () => {
    const owner = await seedUser("owner@mcp2.com");
    const org = await seedOrg("Acme", "acme-mcp2");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const token = await tokenFor(owner, org);

    // list_vaults sees the vault.
    const vaults = await call(token, "list_vaults");
    expect(vaults.data.results).toHaveLength(1);
    expect(vaults.data.results[0].vaultId).toBe(vault);

    // create_note with seed content.
    const created = await call(token, "create_note", {
      vaultId: vault,
      relPath: "note.md",
      title: "Note",
      content: "hello world",
    });
    expect(created.isError).toBe(false);
    const docId = created.data.docId as string;
    expect(mem.store.get(docId)).toBe("hello world");

    // read_note returns it.
    const read = await call(token, "read_note", { docId });
    expect(read.data.content).toBe("hello world");
    expect(read.data.permission).toBe("edit");

    // list_notes shows it.
    const notes = await call(token, "list_notes", { vaultId: vault });
    expect(notes.data.results.map((n: any) => n.docId)).toContain(docId);

    // update_note replaces content.
    await call(token, "update_note", { docId, content: "replaced" });
    expect(mem.store.get(docId)).toBe("replaced");

    // append_note appends.
    await call(token, "append_note", { docId, text: "!" });
    expect(mem.store.get(docId)).toBe("replaced!");

    // delete_note soft-deletes + kicks live sockets.
    const del = await call(token, "delete_note", { docId });
    expect(del.isError).toBe(false);
    expect(disconnected).toContainEqual({ vaultId: vault, docId });
    const { rows } = await pool.query("SELECT deleted_at FROM notes WHERE id = $1", [docId]);
    expect(rows[0].deleted_at).not.toBeNull();

    // read after delete → error.
    expect((await call(token, "read_note", { docId })).isError).toBe(true);
  });

  it("member: only sees/edits shared content; no root create", async () => {
    const owner = await seedUser("owner@mcp3.com");
    const member = await seedUser("member@mcp3.com");
    const org = await seedOrg("Acme", "acme-mcp3");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const sharedFolder = await seedFolder(vault, null, "Shared", "Shared");
    const ownerToken = await tokenFor(owner, org);
    const memberToken = await tokenFor(member, org);

    // Owner creates a note at the vault root (no folder) — private to admins.
    const rootNote = await call(ownerToken, "create_note", {
      vaultId: vault,
      relPath: "secret.md",
      content: "secret",
    });
    const rootDoc = rootNote.data.docId as string;

    // Member can't read the root note and can't create at the root.
    expect((await call(memberToken, "read_note", { docId: rootDoc })).isError).toBe(true);
    expect(
      (await call(memberToken, "create_note", { vaultId: vault, relPath: "x.md" })).isError,
    ).toBe(true);
    expect((await call(memberToken, "list_notes", { vaultId: vault })).data.results).toHaveLength(
      0,
    );

    // Share the folder as edit → member can now create + read inside it.
    await seedShare(org, "folder", sharedFolder, member, "edit");
    const made = await call(memberToken, "create_note", {
      vaultId: vault,
      relPath: "Shared/mine.md",
      folderId: sharedFolder,
      content: "ours",
    });
    expect(made.isError).toBe(false);
    const sharedDoc = made.data.docId as string;
    expect((await call(memberToken, "read_note", { docId: sharedDoc })).data.content).toBe(
      "ours",
    );
    // Member's list now shows exactly the shared note.
    const list = await call(memberToken, "list_notes", { vaultId: vault });
    expect(list.data.results.map((n: any) => n.docId)).toEqual([sharedDoc]);
  });

  it("a locked folder blocks create/delete for everyone, incl. admins (MCP)", async () => {
    const owner = await seedUser("owner@mcp-lock.com");
    const member = await seedUser("member@mcp-lock.com");
    const org = await seedOrg("Acme", "acme-mcp-lock");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Locked", "Locked");
    const child = await seedFolder(vault, folder, "Locked/Child", "Child");
    // Member has an explicit edit grant on the folder …
    await seedShare(org, "folder", folder, member, "edit");
    const ownerToken = await tokenFor(owner, org);
    const memberToken = await tokenFor(member, org);

    // … but an org lock on the folder makes it read-only for all.
    await seedLock(org, "folder", folder, { type: "org" });

    // create_note inside the locked folder is denied for the edit-member.
    expect(
      (
        await call(memberToken, "create_note", {
          vaultId: vault,
          relPath: "Locked/nope.md",
          folderId: folder,
        })
      ).isError,
    ).toBe(true);
    // … and for an owner/admin — a lock caps admins too.
    expect(
      (
        await call(ownerToken, "create_note", {
          vaultId: vault,
          relPath: "Locked/nope2.md",
          folderId: folder,
        })
      ).isError,
    ).toBe(true);
    // create_folder under the locked folder is denied (admin).
    expect(
      (await call(ownerToken, "create_folder", { vaultId: vault, parentId: folder, name: "x" }))
        .isError,
    ).toBe(true);
    // delete_folder of the locked folder is denied (admin).
    expect((await call(ownerToken, "delete_folder", { folderId: folder })).isError).toBe(true);
    // The lock reaches descendants: create in a child of the locked folder is denied.
    expect(
      (
        await call(ownerToken, "create_note", {
          vaultId: vault,
          relPath: "Locked/Child/nope.md",
          folderId: child,
        })
      ).isError,
    ).toBe(true);

    // A per-user lock (rather than org) also blocks that user's create: the
    // member has an inherited edit grant on the parent, but a user-scoped lock
    // on the child caps it. (Grant + lock live on different folders so they
    // don't collide on the one-row-per-(resource,principal) key.)
    const grantParent = await seedFolder(vault, null, "Grant", "Grant");
    const userLocked = await seedFolder(vault, grantParent, "Grant/Locked", "Locked");
    await seedShare(org, "folder", grantParent, member, "edit");
    await seedLock(org, "folder", userLocked, { type: "user", id: member });
    expect(
      (
        await call(memberToken, "create_note", {
          vaultId: vault,
          relPath: "Grant/Locked/nope.md",
          folderId: userLocked,
        })
      ).isError,
    ).toBe(true);
  });

  it("a token cannot reach a vault in another vault", async () => {
    const a = await seedUser("a@mcp4.com");
    const orgA = await seedOrg("A", "a-mcp4");
    await seedMember(orgA, a, "owner");
    const tokenA = await tokenFor(a, orgA);

    const b = await seedUser("b@mcp4.com");
    const orgB = await seedOrg("B", "b-mcp4");
    await seedMember(orgB, b, "owner");
    const vaultB = await seedVault(orgB);

    const res = await call(tokenA, "list_folders", { vaultId: vaultB });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/outside the scope of this token/i);
  });

  it("tracks per-connection usage: tool calls, last-used, and client", async () => {
    const owner = await seedUser("owner@mcp6.com");
    const org = await seedOrg("Acme", "acme-mcp6");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const { token, row } = await createMcpToken({ userId: owner, organizationId: org }, "conn");
    expect(row.useCount).toBe(0);
    expect(row.lastClient).toBeNull();

    // A handshake (no tools/call) must NOT count as usage, but should stamp the client.
    await app.fetch(
      new Request("http://local/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": "claude-code/1.2.3",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    // Two real tool calls → use_count should reach 2.
    await call(token, "list_vaults");
    await call(token, "list_notes", { vaultId: vault });

    // Bumps are best-effort/async — poll the listing until it settles.
    const settled = await waitFor(async () => {
      const [t] = await listMcpTokens({ userId: owner, organizationId: org });
      return t.useCount >= 2 ? t : null;
    });
    expect(settled.useCount).toBe(2);
    expect(settled.lastUsedAt).not.toBeNull();
    expect(settled.lastClient).toBe("claude-code/1.2.3");
  });

  it("revoked membership invalidates the token", async () => {
    const u = await seedUser("u@mcp5.com");
    const org = await seedOrg("Acme", "acme-mcp5");
    await seedMember(org, u, "member");
    const token = await tokenFor(u, org);

    expect((await rpc(token, "tools/list")).status).toBe(200);
    await pool.query(`DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [
      org,
      u,
    ]);
    expect((await rpc(token, "tools/list")).status).toBe(401);
  });

  // ── live propagation ────────────────────────────────────────────────────────
  //
  // An MCP write is meant to be indistinguishable from a teammate's edit. It
  // used to be indistinguishable only in Postgres: the row was correct and
  // nothing was announced, so a running app kept showing the old tree until it
  // restarted and did a full reconcile. Every structural tool must broadcast.
  describe("structural writes announce themselves", () => {
    let owner: string;
    let org: string;
    let vault: string;
    let token: string;

    beforeEach(async () => {
      owner = await seedUser("owner@mcp-live.com");
      org = await seedOrg("Acme", "acme-mcp-live");
      await seedMember(org, owner, "owner");
      vault = await seedVault(org);
      token = await tokenFor(owner, org);
      registryBroadcasts.length = 0;
    });

    it("create_note broadcasts to the vault", async () => {
      const created = await call(token, "create_note", {
        vaultId: vault,
        relPath: "Daily/today.md",
        title: "Today",
        content: "written by an assistant",
      });
      expect(created.isError).toBe(false);
      expect(registryBroadcasts).toEqual([{ vaultId: vault, originId: null }]);
    });

    it("broadcasts with a null origin, so no connected app is skipped", async () => {
      // `originId` exists to skip the client whose own write caused the change.
      // An MCP client is not a vault-channel subscriber, so skipping anyone
      // would silently starve a real app of the update.
      await call(token, "create_folder", { vaultId: vault, name: "Daily", path: "Daily" });
      expect(registryBroadcasts.every((b) => b.originId === null)).toBe(true);
    });

    it("create_folder and delete_folder both broadcast", async () => {
      const folder = await call(token, "create_folder", {
        vaultId: vault,
        name: "Scratch",
        path: "Scratch",
      });
      expect(folder.isError).toBe(false);
      expect(registryBroadcasts).toHaveLength(1);

      const removed = await call(token, "delete_folder", {
        folderId: folder.data.folderId as string,
      });
      expect(removed.isError).toBe(false);
      expect(registryBroadcasts).toHaveLength(2);
      expect(registryBroadcasts[1]).toEqual({ vaultId: vault, originId: null });
    });

    it("delete_note broadcasts, so it leaves every sidebar too", async () => {
      const created = await call(token, "create_note", {
        vaultId: vault,
        relPath: "bye.md",
        title: "Bye",
      });
      registryBroadcasts.length = 0;

      const deleted = await call(token, "delete_note", {
        docId: created.data.docId as string,
      });
      expect(deleted.isError).toBe(false);
      // Kicking live editors off the doc is not the same as removing the row
      // from everyone's tree — the delete has to do both.
      expect(disconnected).toHaveLength(1);
      expect(registryBroadcasts).toEqual([{ vaultId: vault, originId: null }]);
    });

    it("does not broadcast when the write was refused", async () => {
      const stranger = await seedUser("stranger@mcp-live.com");
      const otherOrg = await seedOrg("Other", "other-mcp-live");
      await seedMember(otherOrg, stranger, "owner");
      const strangerToken = await tokenFor(stranger, otherOrg);

      const res = await call(strangerToken, "create_note", {
        vaultId: vault,
        relPath: "intruder.md",
        title: "Nope",
      });
      expect(res.isError).toBe(true);
      expect(registryBroadcasts).toEqual([]);
    });

    it("content-only edits do not churn the tree", async () => {
      // update_note changes no structure, so it must not make every connected
      // app re-pull the registry on each keystroke an assistant writes.
      const created = await call(token, "create_note", {
        vaultId: vault,
        relPath: "essay.md",
        title: "Essay",
      });
      registryBroadcasts.length = 0;
      await call(token, "update_note", {
        docId: created.data.docId as string,
        content: "new body",
      });
      expect(registryBroadcasts).toEqual([]);
    });
  });

  // ── reorganising ────────────────────────────────────────────────────────────
  //
  // An AI could create and delete but never MOVE anything, so it couldn't tidy a
  // vault the way a teammate can. These tools have to preserve doc_ids (the whole
  // identity model rests on it) and announce themselves like any other structural
  // change.
  describe("move_note / move_folder", () => {
    let owner: string;
    let org: string;
    let vault: string;
    let token: string;

    beforeEach(async () => {
      owner = await seedUser("owner@mcp-move.com");
      org = await seedOrg("Acme", "acme-mcp-move");
      await seedMember(org, owner, "owner");
      vault = await seedVault(org);
      token = await tokenFor(owner, org);
      registryBroadcasts.length = 0;
    });

    it("renames a note in place, keeping its docId, and broadcasts", async () => {
      const created = await call(token, "create_note", {
        vaultId: vault,
        relPath: "draft.md",
        title: "Draft",
        content: "body",
      });
      const docId = created.data.docId as string;
      registryBroadcasts.length = 0;

      const moved = await call(token, "move_note", {
        docId,
        relPath: "Archive/final.md",
        title: "Final",
      });
      expect(moved.isError).toBe(false);
      expect(moved.data).toMatchObject({ docId, relPath: "Archive/final.md", title: "Final" });
      // Same docId means the CRDT history and every backlink survive the move.
      expect(mem.store.get(docId)).toBe("body");
      expect(registryBroadcasts).toEqual([{ vaultId: vault, originId: null }]);
    });

    it("moves a folder and rewrites every descendant path, preserving docIds", async () => {
      const folder = await call(token, "create_folder", {
        vaultId: vault,
        name: "Ideas",
        path: "Ideas",
      });
      const folderId = folder.data.folderId as string;
      const sub = await call(token, "create_folder", {
        vaultId: vault,
        name: "Drafts",
        path: "Ideas/Drafts",
        parentId: folderId,
      });
      const note = await call(token, "create_note", {
        vaultId: vault,
        relPath: "Ideas/Drafts/deep.md",
        title: "Deep",
        folderId: sub.data.folderId as string,
      });
      const docId = note.data.docId as string;
      registryBroadcasts.length = 0;

      const moved = await call(token, "move_folder", {
        folderId,
        path: "Archive/Ideas",
        name: "Ideas",
      });
      expect(moved.isError).toBe(false);

      const { rows: folders } = await pool.query<{ path: string }>(
        "SELECT path FROM folders WHERE vault_id = $1 ORDER BY path",
        [vault],
      );
      expect(folders.map((f) => f.path)).toEqual(["Archive/Ideas", "Archive/Ideas/Drafts"]);
      const { rows: notes } = await pool.query<{ id: string; rel_path: string }>(
        "SELECT id, rel_path FROM notes WHERE vault_id = $1",
        [vault],
      );
      expect(notes[0]).toMatchObject({ id: docId, rel_path: "Archive/Ideas/Drafts/deep.md" });
      expect(registryBroadcasts).toEqual([{ vaultId: vault, originId: null }]);
    });

    it("moves a note to the vault root when folderId is explicitly null", async () => {
      // The reason `optStrOrNull` exists: the ordinary optional-string validator
      // collapses null into undefined ("leave it alone"), which would make
      // moving anything back to the root impossible to express.
      const folder = await call(token, "create_folder", {
        vaultId: vault,
        name: "Box",
        path: "Box",
      });
      const created = await call(token, "create_note", {
        vaultId: vault,
        relPath: "Box/n.md",
        title: "N",
        folderId: folder.data.folderId as string,
      });
      const moved = await call(token, "move_note", {
        docId: created.data.docId as string,
        relPath: "n.md",
        folderId: null,
      });
      expect(moved.isError).toBe(false);
      expect(moved.data.folderId).toBeNull();
    });

    it("refuses to move a folder inside its own descendant", async () => {
      // Every ACL query walks parent_id with UNION ALL, which never dedupes — so
      // a cycle wouldn't be a wrong answer, it would hang permission checks for
      // that subtree indefinitely.
      const parent = await call(token, "create_folder", {
        vaultId: vault,
        name: "P",
        path: "P",
      });
      const parentId = parent.data.folderId as string;
      const child = await call(token, "create_folder", {
        vaultId: vault,
        name: "C",
        path: "P/C",
        parentId,
      });
      const res = await call(token, "move_folder", {
        folderId: parentId,
        parentId: child.data.folderId as string,
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("inside itself");
    });

    it("refuses a move onto an existing folder path, and broadcasts nothing", async () => {
      await call(token, "create_folder", { vaultId: vault, name: "A", path: "A" });
      const b = await call(token, "create_folder", { vaultId: vault, name: "B", path: "B" });
      registryBroadcasts.length = 0;
      const res = await call(token, "move_folder", {
        folderId: b.data.folderId as string,
        path: "A",
      });
      expect(res.isError).toBe(true);
      expect(registryBroadcasts).toEqual([]);
    });

    it("delete_folder refuses a non-empty folder unless recursive is set", async () => {
      const folder = await call(token, "create_folder", {
        vaultId: vault,
        name: "Full",
        path: "Full",
      });
      const folderId = folder.data.folderId as string;
      const note = await call(token, "create_note", {
        vaultId: vault,
        relPath: "Full/a.md",
        title: "A",
        folderId,
      });
      const docId = note.data.docId as string;

      const refused = await call(token, "delete_folder", { folderId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("recursive");

      registryBroadcasts.length = 0;
      const ok = await call(token, "delete_folder", { folderId, recursive: true });
      expect(ok.isError).toBe(false);
      expect(ok.data.deletedNotes).toBe(1);
      // Soft-deleted (history kept), editors kicked, and the tree change announced.
      const { rows } = await pool.query("SELECT deleted_at FROM notes WHERE id = $1", [docId]);
      expect(rows[0].deleted_at).not.toBeNull();
      expect(disconnected).toContainEqual({ vaultId: vault, docId });
      expect(registryBroadcasts).toEqual([{ vaultId: vault, originId: null }]);
    });
  });

  // The MCP and HTTP surfaces are two doors onto the same data, so they have to
  // enforce the same lock. These pin the places where they used to differ.
  describe("MCP/HTTP gate parity", () => {
    it("a folder a member creates over MCP is theirs to see and move", async () => {
      // `created_by` was omitted, so the creator rule in canEditFolder never
      // fired: a member could make a folder through an assistant and then not
      // find it in their own sidebar, nor rename it.
      const member = await seedUser("member@mcp-parity.com");
      const org = await seedOrg("Acme", "acme-mcp-parity");
      const ownerId = await seedUser("owner@mcp-parity.com");
      await seedMember(org, ownerId, "owner");
      await seedMember(org, member, "member");
      const vault = await seedVault(org);
      const parent = await seedFolder(vault, null, "Team", "Team");
      await seedShare(org, "folder", parent, member, "edit");
      const token = await tokenFor(member, org);

      const made = await call(token, "create_folder", {
        vaultId: vault,
        name: "Mine",
        path: "Team/Mine",
        parentId: parent,
      });
      expect(made.isError).toBe(false);
      const folderId = made.data.folderId as string;
      const { rows } = await pool.query("SELECT created_by FROM folders WHERE id = $1", [folderId]);
      expect(rows[0].created_by).toBe(member);

      // …and the creator rule now lets them move it.
      const moved = await call(token, "move_folder", { folderId, path: "Team/Ours", name: "Ours" });
      expect(moved.isError).toBe(false);
    });

    it("create_folder twice at one path adopts instead of duplicating", async () => {
      const owner = await seedUser("owner@mcp-dup.com");
      const org = await seedOrg("Acme", "acme-mcp-dup");
      await seedMember(org, owner, "owner");
      const vault = await seedVault(org);
      const token = await tokenFor(owner, org);

      const first = await call(token, "create_folder", {
        vaultId: vault,
        name: "Ideas",
        path: "Ideas",
      });
      const second = await call(token, "create_folder", {
        vaultId: vault,
        name: "Ideas",
        path: "Ideas",
      });
      expect(second.isError).toBe(false);
      expect(second.data.folderId).toBe(first.data.folderId);
      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM folders WHERE vault_id = $1 AND path = 'Ideas'",
        [vault],
      );
      expect(rows[0].n).toBe("1");
    });

    it("a member cannot move their private note into a team-shared folder", async () => {
      // Folder grants inherit down, so allowing this would let one member hand
      // the whole team edit access to a note only they could read.
      const owner = await seedUser("owner@mcp-esc.com");
      const member = await seedUser("member@mcp-esc.com");
      const org = await seedOrg("Acme", "acme-mcp-esc");
      await seedMember(org, owner, "owner");
      await seedMember(org, member, "member");
      const vault = await seedVault(org);
      const mine = await seedFolder(vault, null, "Mine", "Mine");
      await seedShare(org, "folder", mine, member, "edit");
      // A folder the member can only READ.
      const teamRead = await seedFolder(vault, null, "Team", "Team");
      await seedShare(org, "folder", teamRead, member, "view");
      const token = await tokenFor(member, org);

      const note = await call(token, "create_note", {
        vaultId: vault,
        relPath: "Mine/secret.md",
        title: "Secret",
        folderId: mine,
      });
      const res = await call(token, "move_note", {
        docId: note.data.docId as string,
        relPath: "Team/secret.md",
        folderId: teamRead,
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("destination");
    });
  });
});
