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
      "user-agent": "baalda-mcp-groups-test",
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
  return (await createMcpToken({ userId, organizationId }, "groups-test")).token;
}

function resources(...items: Array<["folder" | "file" | "vault", string]>) {
  return items.map(([resourceType, resourceId]) => ({ resourceType, resourceId }));
}


async function sealVault(org: string) {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, 'org', $2, 'denied')`,
    [randomUUID(), org],
  );
}

describe("MCP access groups (2026-11-28)", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        baseUrl = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });
  beforeEach(async () => { await resetDb(); writer.store.clear(); });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await pool.end();
  });

  it("owners and admins manage groups through the same rules as the app; members cannot", async () => {
    const org = await seedOrg("MCP groups", `mcp-groups-${randomUUID()}`);
    const owner = await seedUser(`owner-${randomUUID()}@mcp.test`);
    const admin = await seedUser(`admin-${randomUUID()}@mcp.test`);
    const member = await seedUser(`member-${randomUUID()}@mcp.test`);
    await seedMember(org, owner, "owner");
    await seedMember(org, admin, "admin");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    await sealVault(org);
    const note = await seedNote(vault, null, "Plan.md", owner);
    const adminToken = await tokenFor(admin, org);
    const memberToken = await tokenFor(member, org);

    const refused = await call(memberToken, "manage_group", { action: "create", name: "Mine" });
    expect(refused.isError).toBe(true);
    expect((await pool.query("SELECT 1 FROM access_groups WHERE organization_id = $1", [org])).rowCount).toBe(0);

    const made = await call(adminToken, "manage_group", { action: "create", name: "Sales", userIds: [member] });
    expect(made.isError).toBe(false);
    const groupId = made.data.id as string;
    expect(groupId).toBeTruthy();

    // An admin cannot change the owner's groups.
    const ownerAdd = await call(adminToken, "manage_group", { action: "add_members", groupId, userIds: [owner] });
    expect(ownerAdd.isError).toBe(true);

    expect(await effectivePermission(member, note)).toBe("none");
    const grant = await call(adminToken, "manage_access", {
      resources: [{ resourceType: "vault", resourceId: org }],
      audience: { type: "group", groupId },
      mode: "readonly",
    });
    expect(grant.isError).toBe(false);
    expect(await effectivePermission(member, note)).toBe("view");
    expect([...(await listReadableDocsInVault(member, vault))]).toEqual([note]);

    // Members see the roster read-only.
    const listed = await call(memberToken, "list_groups", {});
    expect(listed.isError).toBe(false);

    const gone = await call(adminToken, "manage_group", { action: "delete", groupId });
    expect(gone.isError).toBe(false);
    expect(await effectivePermission(member, note)).toBe("none");
    expect((await pool.query("SELECT 1 FROM shares WHERE principal_type = 'group' AND principal_id = $1", [groupId])).rowCount).toBe(0);
  });

  it("an AI tool never removes a person's own setting: a group change leaves it deciding", async () => {
    const org = await seedOrg("MCP own", `mcp-own-${randomUUID()}`);
    const owner = await seedUser(`owner-${randomUUID()}@mcp.test`);
    const member = await seedUser(`member-${randomUUID()}@mcp.test`);
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    await sealVault(org);
    const note = await seedNote(vault, null, "Plan.md", owner);
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'vault', $2, 'user', $3, 'view')`,
      [randomUUID(), org, member],
    );
    const ownerToken = await tokenFor(owner, org);
    const made = await call(ownerToken, "manage_group", { action: "create", name: "Editors", userIds: [member] });
    await call(ownerToken, "manage_access", {
      resources: [{ resourceType: "vault", resourceId: org }],
      audience: { type: "group", groupId: made.data.id },
      mode: "open",
    });
    expect(await effectivePermission(member, note)).toBe("view");
    expect((await pool.query("SELECT permission FROM shares WHERE principal_type = 'user' AND principal_id = $1", [member])).rows).toEqual([{ permission: "view" }]);
  });
});
