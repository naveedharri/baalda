import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import {
  seedBlob,
  seedBlobText,
  seedFile,
  seedFolder,
  seedMember,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * The file half of the MCP surface: `list_attachments`, `read_attachment_text`
 * and `search_notes`' `kind`. Every one of them goes through the same ACL as
 * the HTTP routes — the assistant sees a teammate's spreadsheet exactly when
 * that teammate shared the folder it sits in, and stops seeing it when they
 * stop.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

let rpcId = 0;
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
    result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
  };
  return {
    isError: body.result?.isError ?? false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: body.result?.structuredContent as any,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

describe("MCP file tools", () => {
  let org: string;
  let owner: string;
  let member: string;
  let vault: string;
  let teamFolder: string;
  let fileDoc: string;
  let fileBlob: string;
  let memberToken: string;
  let ownerToken: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    org = await seedOrg("MCP Files", `mcpf-${randomUUID().slice(0, 8)}`);
    owner = await seedUser(`owner+${randomUUID()}@mcpfiles.test`);
    await seedMember(org, owner, "owner");
    member = await seedUser(`member+${randomUUID()}@mcpfiles.test`);
    await seedMember(org, member, "member");
    vault = await seedVault(org);
    teamFolder = await seedFolder(vault, null, "Team", "Team", owner);

    fileDoc = await seedFile(vault, teamFolder, "Team/q3.xlsx");
    fileBlob = await seedBlob(vault, org, "Team/q3.xlsx", {
      docId: fileDoc,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 4096,
    });
    await seedBlobText(fileBlob, vault, fileDoc, "quarterly pipeline forecast by region");

    memberToken = (await createMcpToken({ userId: member, organizationId: org }, "t")).token;
    ownerToken = (await createMcpToken({ userId: owner, organizationId: org }, "t")).token;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("tools/list advertises the file tools and no attach_file", async () => {
    const res = await app.fetch(
      new Request("http://local/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = ((await res.json()) as any).result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_attachments", "read_attachment_text"]));
    expect(names).not.toContain("attach_file");
  });

  it("list_attachments follows the folder share", async () => {
    await seedVaultGrant(org, "edit");
    const asOwner = await call(ownerToken, "list_attachments", { vaultId: vault });
    expect(asOwner.data.results).toHaveLength(1);
    expect(asOwner.data.results[0]).toMatchObject({
      docId: fileDoc,
      blobId: fileBlob,
      relPath: "Team/q3.xlsx",
      filename: "q3.xlsx",
      size: 4096,
      hasText: true,
    });

    // Private vault: the member sees nothing until the folder is shared.
    await pool.query("DELETE FROM shares WHERE resource_type = 'vault'");
    expect((await call(memberToken, "list_attachments", { vaultId: vault })).data.results).toEqual(
      [],
    );
    await seedShare(org, "folder", teamFolder, member, "view");
    expect(
      (await call(memberToken, "list_attachments", { vaultId: vault })).data.results,
    ).toHaveLength(1);
  });

  it("list_attachments filters by folder", async () => {
    await seedVaultGrant(org, "edit");
    const other = await seedFolder(vault, null, "Misc", "Misc", owner);
    const otherDoc = await seedFile(vault, other, "Misc/notes.csv");
    await seedBlob(vault, org, "Misc/notes.csv", { docId: otherDoc });

    const scoped = await call(ownerToken, "list_attachments", { vaultId: vault, folder: "Team" });
    expect(scoped.data.results.map((r: { relPath: string }) => r.relPath)).toEqual([
      "Team/q3.xlsx",
    ]);
  });

  it("read_attachment_text gives the text, by path or blob id, and truncates", async () => {
    await seedShare(org, "folder", teamFolder, member, "view");
    const byPath = await call(memberToken, "read_attachment_text", {
      vaultId: vault,
      relPath: "Team/q3.xlsx",
    });
    expect(byPath.data).toMatchObject({
      text: "quarterly pipeline forecast by region",
      truncated: false,
      blobId: fileBlob,
    });
    expect(byPath.data.sha256).toHaveLength(64);

    const byId = await call(memberToken, "read_attachment_text", {
      vaultId: vault,
      blobId: fileBlob,
      maxChars: 9,
    });
    expect(byId.data.text).toBe("quarterly");
    expect(byId.data.truncated).toBe(true);
  });

  it("read_attachment_text refuses a file the caller was not shared, and again after revoke", async () => {
    const denied = await call(memberToken, "read_attachment_text", {
      vaultId: vault,
      relPath: "Team/q3.xlsx",
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("access");

    const share = await seedShare(org, "folder", teamFolder, member, "view");
    expect(
      (await call(memberToken, "read_attachment_text", { vaultId: vault, relPath: "Team/q3.xlsx" }))
        .data.text,
    ).toBe("quarterly pipeline forecast by region");

    await pool.query("DELETE FROM shares WHERE id = $1", [share]);
    expect(
      (await call(memberToken, "read_attachment_text", { vaultId: vault, relPath: "Team/q3.xlsx" }))
        .isError,
    ).toBe(true);
  });

  it("read_attachment_text answers empty for a file nobody has extracted yet", async () => {
    await seedVaultGrant(org, "edit");
    const bare = await seedFile(vault, teamFolder, "Team/raw.zip");
    await seedBlob(vault, org, "Team/raw.zip", { docId: bare });
    const res = await call(ownerToken, "read_attachment_text", {
      vaultId: vault,
      relPath: "Team/raw.zip",
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ text: "", chars: 0, truncated: false });
  });

  it("search_notes tags file hits and honours includeFiles", async () => {
    await seedShare(org, "folder", teamFolder, member, "view");
    const hits = await call(memberToken, "search_notes", {
      vaultId: vault,
      query: "quarterly pipeline forecast",
    });
    expect(hits.data.results).toHaveLength(1);
    expect(hits.data.results[0]).toMatchObject({
      kind: "file",
      docId: fileDoc,
      blobId: fileBlob,
      ext: "xlsx",
    });

    const notesOnly = await call(memberToken, "search_notes", {
      vaultId: vault,
      query: "quarterly pipeline forecast",
      includeFiles: false,
    });
    expect(notesOnly.data.results).toEqual([]);
  });
});
