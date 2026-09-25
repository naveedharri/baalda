// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { memoryDocWriter } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import {
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

type ToolReply = {
  status: number;
  isError: boolean;
  text: string;
  data: any;
};

const writer = memoryDocWriter();
const app = createApp({
  docWriter: writer,
  disconnectDoc: () => {},
  evictDoc: () => {},
  onRegistryChanged: () => {},
  onAclChanged: () => {},
});

let server: Server;
let baseUrl: string;
let rpcId = 0;

async function rpc(token: string, method: string, params?: unknown) {
  return fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "baalda-mcp-access-integration-test",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}

async function call(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolReply> {
  const response = await rpc(token, "tools/call", { name, arguments: args });
  const body = (await response.json()) as {
    result?: {
      structuredContent?: unknown;
      isError?: boolean;
      content?: Array<{ text: string }>;
    };
  };
  return {
    status: response.status,
    isError: body.result?.isError ?? false,
    text: body.result?.content?.[0]?.text ?? "",
    data: body.result?.structuredContent,
  };
}

async function tokenFor(userId: string, organizationId: string): Promise<string> {
  return (await createMcpToken({ userId, organizationId }, "access-surface-test")).token;
}

function resources(...items: Array<["folder" | "file" | "vault", string]>) {
  return items.map(([resourceType, resourceId]) => ({ resourceType, resourceId }));
}

describe("MCP access-management HTTP surface", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await resetDb();
    writer.store.clear();
    writer.writes.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  });

  it("discovers the exact access tools and their wire schema", async () => {
    const owner = await seedUser(`owner-${randomUUID()}@mcp.test`);
    const org = await seedOrg("MCP discovery", `mcp-discovery-${randomUUID()}`);
    await seedMember(org, owner, "owner");
    const token = await tokenFor(owner, org);

    const response = await rpc(token, "tools/list");
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    const tools = new Map(body.result.tools.map((tool: any) => [tool.name, tool]));
    expect([...tools.keys()]).toEqual([
      "list_vaults",
      "get_access_default",
      "set_access_default",
      "list_resource_access",
      "manage_access",
      "list_folders",
      "list_notes",
      "read_note",
      "search_notes",
      "list_attachments",
      "read_attachment_text",
      "create_note",
      "update_note",
      "append_note",
      "edit_note",
      "delete_note",
      "create_folder",
      "delete_folder",
      "move_note",
      "move_folder",
    ]);
    expect(tools.get("manage_access").inputSchema).toMatchObject({
      required: ["resources", "audience", "mode"],
      properties: {
        resources: {
          items: { properties: { resourceType: { enum: ["folder", "file", "vault"] } } },
        },
        audience: { properties: { type: { enum: ["org", "users"] } } },
        mode: { enum: ["private", "readonly", "open"] },
      },
    });
    expect(tools.get("set_access_default").inputSchema.properties.mode.enum).toEqual([
      "private",
      "readonly",
      "open",
    ]);
  });

  it("applies bulk folder/file, Everyone/member, whole-vault, lock, and future-member rules", async () => {
    const org = await seedOrg("MCP access", `mcp-access-${randomUUID()}`);
    const owner = await seedUser(`owner-${randomUUID()}@mcp.test`);
    const admin = await seedUser(`admin-${randomUUID()}@mcp.test`);
    const member = await seedUser(`member-${randomUUID()}@mcp.test`);
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    const folder = await seedFolder(vault, null, "Docs", "Docs");
    const nestedDoc = await seedNote(vault, folder, "Docs/nested.md");
    const rootDoc = await seedNote(vault, null, "root.md");
    writer.store.set(nestedDoc, "nested v1");
    writer.store.set(rootDoc, "root v1");

    const ownerToken = await tokenFor(owner, org);
    const adminToken = await tokenFor(admin, org);
    const memberToken = await tokenFor(member, org);
    const selected = resources(["folder", folder], ["file", rootDoc]);

    const initial = await call(memberToken, "list_notes", { vaultId: vault });
    expect(initial.data.results.map((note: any) => [note.docId, note.permission])).toEqual([
      [nestedDoc, "edit"],
      [rootDoc, "edit"],
    ]);

    const readonly = await call(adminToken, "manage_access", {
      resources: selected,
      audience: { type: "org" },
      mode: "readonly",
    });
    expect(readonly).toMatchObject({ status: 200, isError: false });
    expect(readonly.data).toMatchObject({
      mode: "readonly",
      resourcesChanged: 2,
      membersAffected: 3,
    });
    for (const userId of [owner, admin, member]) {
      expect(await effectivePermission(userId, nestedDoc)).toBe("view");
      expect(await effectivePermission(userId, rootDoc)).toBe("view");
    }
    expect((await call(ownerToken, "read_note", { docId: nestedDoc })).data.permission).toBe(
      "view",
    );
    const lockedWrite = await call(memberToken, "update_note", {
      docId: nestedDoc,
      content: "must not land",
    });
    expect(lockedWrite.isError).toBe(true);
    expect(lockedWrite.text).toMatch(/read-only|locked/i);
    expect(writer.store.get(nestedDoc)).toBe("nested v1");

    const memberCannotManage = await call(memberToken, "manage_access", {
      resources: selected,
      audience: { type: "org" },
      mode: "open",
    });
    expect(memberCannotManage.isError).toBe(true);
    expect(memberCannotManage.text).toMatch(/owner or an admin/i);
    expect(await effectivePermission(member, nestedDoc)).toBe("view");

    expect(
      (
        await call(ownerToken, "manage_access", {
          resources: selected,
          audience: { type: "org" },
          mode: "open",
        })
      ).isError,
    ).toBe(false);
    expect(await effectivePermission(member, nestedDoc)).toBe("edit");

    expect(
      (
        await call(adminToken, "manage_access", {
          resources: resources(["file", rootDoc]),
          audience: { type: "users", userIds: [member] },
          mode: "private",
        })
      ).isError,
    ).toBe(false);
    expect(await effectivePermission(member, rootDoc)).toBe("none");
    expect(await effectivePermission(owner, rootDoc)).toBe("edit");
    expect(await effectivePermission(admin, rootDoc)).toBe("edit");
    expect((await call(memberToken, "read_note", { docId: rootDoc })).isError).toBe(true);

    expect(
      (
        await call(ownerToken, "manage_access", {
          resources: resources(["file", rootDoc]),
          audience: { type: "users", userIds: [member] },
          mode: "open",
        })
      ).isError,
    ).toBe(false);
    expect(await effectivePermission(member, rootDoc)).toBe("edit");

    expect(
      (
        await call(adminToken, "manage_access", {
          resources: resources(["vault", org]),
          audience: { type: "org" },
          mode: "private",
        })
      ).isError,
    ).toBe(false);
    for (const userId of [owner, admin, member]) {
      expect(await effectivePermission(userId, nestedDoc)).toBe("none");
      expect(await listReadableDocsInVault(userId, vault)).toEqual(new Set());
    }
    expect((await call(ownerToken, "list_notes", { vaultId: vault })).data.results).toEqual([]);

    // Management is role-based, so an admin can undo Private even while the
    // sealed vault gives that admin no content access.
    const reopened = await call(adminToken, "manage_access", {
      resources: resources(["vault", org]),
      audience: { type: "org" },
      mode: "open",
    });
    expect(reopened.isError).toBe(false);
    expect(await effectivePermission(member, nestedDoc)).toBe("edit");

    expect((await call(ownerToken, "get_access_default")).data).toEqual({ mode: "private" });
    expect(
      (await call(adminToken, "set_access_default", { mode: "readonly" })).data,
    ).toEqual({ mode: "readonly" });
    const future = await seedUser(`future-${randomUUID()}@mcp.test`);
    await seedMember(org, future, "member");
    const futureToken = await tokenFor(future, org);
    expect(await effectivePermission(future, nestedDoc)).toBe("view");
    expect((await call(futureToken, "read_note", { docId: nestedDoc })).data.permission).toBe(
      "view",
    );
    expect(
      (
        await call(futureToken, "update_note", {
          docId: nestedDoc,
          content: "future member cannot rewrite pre-join content",
        })
      ).isError,
    ).toBe(true);

    const postJoinDoc = await seedNote(vault, folder, "Docs/post-join.md");
    writer.store.set(postJoinDoc, "post join v1");
    expect(await effectivePermission(future, postJoinDoc)).toBe("edit");
    expect(
      (
        await call(futureToken, "update_note", {
          docId: postJoinDoc,
          content: "post join v2",
        })
      ).isError,
    ).toBe(false);
    expect(writer.store.get(postJoinDoc)).toBe("post join v2");

    expect(
      (await call(ownerToken, "set_access_default", { mode: "private" })).data,
    ).toEqual({ mode: "private" });
    const privateFuture = await seedUser(`private-future-${randomUUID()}@mcp.test`);
    await seedMember(org, privateFuture, "member");
    const privateFutureToken = await tokenFor(privateFuture, org);
    expect(await effectivePermission(privateFuture, nestedDoc)).toBe("none");
    expect((await call(privateFutureToken, "list_notes", { vaultId: vault })).data.results).toEqual(
      [],
    );

    const privatePostJoinDoc = await seedNote(vault, folder, "Docs/private-post-join.md");
    writer.store.set(privatePostJoinDoc, "private post join v1");
    expect(await effectivePermission(privateFuture, privatePostJoinDoc)).toBe("edit");

    expect((await call(adminToken, "set_access_default", { mode: "open" })).data).toEqual({
      mode: "open",
    });
    const openFuture = await seedUser(`open-future-${randomUUID()}@mcp.test`);
    await seedMember(org, openFuture, "member");
    expect(await effectivePermission(openFuture, nestedDoc)).toBe("edit");

    const accessList = await call(ownerToken, "list_resource_access", {
      resourceType: "file",
      resourceId: nestedDoc,
    });
    expect(accessList.isError).toBe(false);
    expect(
      accessList.data.results.find((row: any) => row.userId === future),
    ).toMatchObject({ role: "member", permission: "view", capped: false });
    expect((await call(memberToken, "list_resource_access", {
      resourceType: "file",
      resourceId: nestedDoc,
    })).isError).toBe(true);

    // Exercise the complete vault posture cycle independently through each
    // privileged identity. Private removes the caller's own read access, but
    // the following role-gated management call must still be able to undo it.
    for (const managerToken of [ownerToken, adminToken]) {
      for (const [mode, permission] of [
        ["readonly", "view"],
        ["private", "none"],
        ["open", "edit"],
      ] as const) {
        const changed = await call(managerToken, "manage_access", {
          resources: resources(["vault", org]),
          audience: { type: "org" },
          mode,
        });
        expect(changed.isError).toBe(false);
        expect(await effectivePermission(member, nestedDoc)).toBe(permission);
      }
    }
  });
});
