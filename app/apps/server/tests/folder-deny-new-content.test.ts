// SPDX-License-Identifier: Apache-2.0
// A per-user deny set through MCP manage_access after a parent readonly grant
// cleared an earlier deny: a note created afterwards in the denied folder must
// not reach the denied member by any path.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import * as Y from "yjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { memoryDocWriter } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  sealVault,
  seedFile,
  seedFolder,
  seedMember,
  seedNote,
  seedUserVaultGrant,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

const writer = memoryDocWriter();
let channel: VaultChannel;
const app = createApp({
  docWriter: writer,
  disconnectDoc: () => {},
  evictDoc: () => {},
  onRegistryChanged: (vaultId, originId) => void channel?.publishRegistryChanged(vaultId, originId),
  onAclChanged: (vaultId) => void channel?.publishAclChanged(vaultId),
});

let server: Server;
let baseUrl: string;
let rpcId = 0;

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "folder-deny-test",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as any;
  return {
    status: response.status,
    isError: body.result?.isError ?? false,
    text: body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? ""),
    data: body.result?.structuredContent,
  };
}

function http(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const EMPTY_SV = (() => {
  const doc = new Y.Doc();
  const sv = Buffer.from(Y.encodeStateVector(doc)).toString("base64");
  doc.destroy();
  return sv;
})();

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<{ text?: unknown; bytes?: Uint8Array }> = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({ bytes: data as Uint8Array });
    else this.sent.push({ text: JSON.parse(data as string) });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string, docIds: string[]): void {
    const manifest: Record<string, string> = {};
    for (const d of docIds) manifest[d] = EMPTY_SV;
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest })), false);
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.text).map((s) => s.text as Record<string, unknown>);
  }
  /** Every byte and every text frame, flattened, for a marker/id search. */
  everything(): string {
    return this.sent
      .map((s) => (s.bytes ? Buffer.from(s.bytes).toString("latin1") : JSON.stringify(s.text)))
      .join("\n");
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));
async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await tick();
  }
}
async function settle(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
}

async function connect(userId: string, vaultId: string, manifest: string[]) {
  const ws = new FakeWs();
  channel.handleConnection(ws as never);
  ws.hello(await mintVaultToken({ userId, vaultId }), manifest);
  await waitFor(() => ws.controls().some((c) => c.t === "ready"));
  return ws;
}

/** Yjs update carrying `text`, as the doc writer would fan it out. */
function updateWith(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});

type Setup = {
  everyone: "edit" | "view" | "none" | "sealed";
  role: "member" | "admin";
  personal?: "view" | "edit";
  /** The vault's "New members" setting when the member joins. */
  join?: "open" | "readonly";
};
describe.each<[string, Setup]>([
  ["shared vault (Everyone = Can edit)", { everyone: "edit", role: "member" }],
  ["private vault (no Everyone grant)", { everyone: "none", role: "member" }],
  ["Everyone = Can view", { everyone: "view", role: "member" }],
  ["sealed vault (Everyone = No access)", { everyone: "sealed", role: "member" }],
  ["member with personal Can view everything", { everyone: "edit", role: "member", personal: "view" }],
  ["member with personal Can edit everything", { everyone: "edit", role: "member", personal: "edit" }],
  ["private vault + personal Can view everything", { everyone: "none", role: "member", personal: "view" }],
  ["admin, shared vault", { everyone: "edit", role: "admin" }],
  ["admin, private vault", { everyone: "none", role: "admin" }],
  ["member who joined with New members = Can edit", { everyone: "edit", role: "member", join: "open" }],
  ["member who joined with New members = Can view", { everyone: "none", role: "member", join: "readonly" }],
])("MCP deny after a parent readonly grant — %s", (_label, setup) => {
  const shared = setup.everyone === "edit";
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let ownerToken: string;
  let memberToken: string;
  let xFolder: string;
  let restricted: string;
  let oldNote: string;
  let xNote: string;
  let treeFile: string;

  beforeEach(async () => {
    await resetDb();
    writer.store.clear();
    writer.writes.length = 0;
    channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
    owner = await signUp(`owner-${randomUUID()}@deny.test`);
    orgId = (await createOrg(owner, "Deny", `deny-${randomUUID()}`)).id;
    member = await signUp(`member-${randomUUID()}@deny.test`);
    vault = await seedVault(orgId, "V");
    if (setup.join) {
      await pool.query(
        `INSERT INTO organization_access_settings (organization_id, join_default)
         VALUES ($1, $2)
         ON CONFLICT (organization_id) DO UPDATE SET join_default = EXCLUDED.join_default`,
        [orgId, setup.join],
      );
    }
    if (setup.everyone === "edit" || setup.everyone === "view") {
      await seedVaultGrant(orgId, setup.everyone);
    }
    if (setup.everyone === "sealed") await sealVault(orgId);
    if (setup.personal) await seedUserVaultGrant(orgId, member.userId, setup.personal);
    xFolder = await seedFolder(vault, null, "X", "X");
    restricted = await seedFolder(vault, xFolder, "restricted", "X/restricted");
    oldNote = await seedNote(vault, restricted, "X/restricted/old.md", owner.userId);
    xNote = await seedNote(vault, xFolder, "X/open.md", owner.userId);
    treeFile = await seedFile(vault, restricted, "X/restricted/report.pdf");
    // Joins AFTER the content exists, so a join snapshot covers it.
    await seedMember(orgId, member.userId, setup.role);
    ownerToken = (await createMcpToken({ userId: owner.userId, organizationId: orgId }, "o")).token;
    memberToken = (await createMcpToken({ userId: member.userId, organizationId: orgId }, "m"))
      .token;
  });

  it("does not deliver a note created after the deny, by any path", async () => {
    const users = { type: "users", userIds: [member.userId] };
    if (!shared) {
      // Private vault: give the owner a personal Can edit so it can create.
      const own = await call(ownerToken, "manage_access", {
        resources: [{ resourceType: "vault", resourceId: orgId }],
        audience: { type: "users", userIds: [owner.userId] },
        mode: "open",
      });
      expect(own.isError, own.text).toBe(false);
    }

    // 1. A has no access to X/restricted.
    const step1 = await call(ownerToken, "manage_access", {
      resources: [{ resourceType: "folder", resourceId: restricted }],
      audience: users,
      mode: "private",
    });
    expect(step1.isError, step1.text).toBe(false);
    expect(await effectivePermission(member.userId, oldNote)).toBe("none");

    // 2. Owner grants A readonly on X/ — clears the deeper deny.
    const step2 = await call(ownerToken, "manage_access", {
      resources: [{ resourceType: "folder", resourceId: xFolder }],
      audience: users,
      mode: "readonly",
    });
    expect(step2.isError, step2.text).toBe(false);
    // 3. A can now read (and sync) X/restricted.
    expect(await effectivePermission(member.userId, oldNote)).toBe("view");

    // A's vault channel is connected BEFORE the deny and the create.
    const liveWs = await connect(member.userId, vault, [oldNote, xNote]);

    // 4. Owner denies A on X/restricted.
    const step4 = await call(ownerToken, "manage_access", {
      resources: [{ resourceType: "folder", resourceId: restricted }],
      audience: users,
      mode: "private",
    });
    expect(step4.isError, step4.text).toBe(false);



    expect(await effectivePermission(member.userId, oldNote)).toBe("none");
    await settle();

    // 5. Owner creates a NEW note in X/restricted with a unique marker.
    const marker = `DENY-MARKER-${randomUUID()}`;
    const created = await call(ownerToken, "create_note", {
      vaultId: vault,
      relPath: "X/restricted/secret.md",
      content: marker,
    });
    expect(created.isError, created.text).toBe(false);
    const newDoc: string =
      created.data?.docId ?? created.data?.id ?? created.data?.note?.docId ?? created.data?.note?.id;
    expect(newDoc, JSON.stringify(created.data)).toBeTruthy();
    // Simulate the live doc writer's fan-out of the new content.
    await channel.publishDocUpdate(vault, newDoc, updateWith(marker));
    await settle();

    // The same folder spelled with different case (macOS and Windows disks
    // treat it as one folder) must not escape the deny either.
    const marker2 = `DENY-MARKER-${randomUUID()}`;
    const created2 = await call(ownerToken, "create_note", {
      vaultId: vault,
      relPath: "x/RESTRICTED/secret2.md",
      content: marker2,
    });
    const caseDoc: string | undefined = created2.isError
      ? undefined
      : (created2.data?.docId ?? created2.data?.id ?? created2.data?.note?.docId);

    const found: string[] = [];
    if (caseDoc) {
      const p2 = await effectivePermission(member.userId, caseDoc);
      if (p2 !== "none") found.push(`case-variant path note permission=${p2}`);
      const s2 = await call(memberToken, "search_notes", { vaultId: vault, query: marker2 });
      if (s2.text.includes(marker2)) found.push("MCP search_notes returns the case-variant marker");
    }
    const pf = await effectivePermission(member.userId, treeFile);
    if (pf !== "none") found.push(`tree file permission=${pf}`);

    // effectivePermission
    const perm = await effectivePermission(member.userId, newDoc);
    if (perm !== "none") found.push(`effectivePermission(newDoc)=${perm}`);

    // listReadableDocsInVault
    const readable = await listReadableDocsInVault(member.userId, vault);
    const raw: any = readable;
    const iter: any[] = raw instanceof Map ? [...raw.keys()] : [...(raw.docIds ?? raw)];
    const readableIds = new Set(iter.map((r: any) => (typeof r === "string" ? r : (r.docId ?? r.id))));
    if (readableIds.has(newDoc)) found.push("listReadableDocsInVault includes newDoc");
    if (readableIds.has(oldNote)) found.push("listReadableDocsInVault includes oldNote");
    if (readableIds.has(treeFile)) found.push("listReadableDocsInVault includes the tree file");
    if (caseDoc && readableIds.has(caseDoc)) found.push("listReadableDocsInVault includes the case-variant note");

    // GET /api/notes
    const list = await http(member, "GET", `/api/notes?vaultId=${vault}`);
    const listText = await list.text();
    if (listText.includes(newDoc)) found.push(`GET /api/notes (${list.status}) lists newDoc`);
    if (listText.includes(oldNote)) found.push(`GET /api/notes (${list.status}) lists oldNote`);

    // POST /api/sync-token
    const mint = await http(member, "POST", "/api/sync-token", { docId: newDoc });
    if (mint.status !== 403) found.push(`sync-token mint for newDoc = ${mint.status}`);
    const mintOld = await http(member, "POST", "/api/sync-token", { docId: oldNote });
    if (mintOld.status !== 403) found.push(`sync-token mint for oldNote = ${mintOld.status}`);

    // POST /vaults/:id/bootstrap
    const boot = await http(member, "POST", `/api/vaults/${vault}/bootstrap`, {
      only: [newDoc, oldNote],
    });
    const bootText = await boot.text();
    const bootJson = boot.status === 200 ? JSON.parse(bootText) : null;
    if (bootJson && bootJson.docs > 0) found.push(`bootstrap only=[new,old] docs=${bootJson.docs}`);
    if (bootText.includes(newDoc)) found.push("bootstrap session names newDoc");

    // MCP search_notes with A's token
    const search = await call(memberToken, "search_notes", { vaultId: vault, query: marker });
    if (search.text.includes(marker) || search.text.includes(newDoc)) {
      found.push("MCP search_notes returns the marker");
    }
    const read = await call(memberToken, "read_note", { docId: newDoc });
    if (!read.isError && read.text.includes(marker)) found.push("MCP read_note returns the marker");

    // Vault channel: the already-connected socket (live fan-out).
    const liveAll = liveWs.everything();
    if (liveAll.includes(marker)) found.push("live vault channel forwarded the marker");

    // Vault channel: fresh connect, manifest holding old + new.
    const freshWs = await connect(member.userId, vault, [oldNote, xNote, newDoc]);
    await settle();
    const freshReady = freshWs.controls().find((c) => c.t === "ready")!;
    if (freshWs.everything().includes(marker)) found.push("fresh vault channel sent the marker");
    const revoked = (freshReady.revoked as string[] | undefined) ?? [];
    if (!revoked.includes(oldNote)) found.push("fresh ready.revoked does not name oldNote");
    expect(found).toEqual([]);
  });
});
