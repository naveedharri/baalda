import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { memoryDocWriter } from "./helpers/app.js";
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
 * see only what's shared; tokens can't reach outside their workspace).
 */

const mem = memoryDocWriter();
let disconnected: Array<{ vaultId: string; docId: string }> = [];
const app = createApp({
  docWriter: mem,
  disconnectDoc: (vaultId, docId) => disconnected.push({ vaultId, docId }),
});

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
    mem.store.clear();
    disconnected = [];
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

  it("a token cannot reach a vault in another workspace", async () => {
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
    expect(res.text).toMatch(/not in this token's workspace/i);
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
});
