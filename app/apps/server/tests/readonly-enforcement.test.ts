import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createApp } from "../src/http/app.js";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { loadDocState } from "../src/yjs/persistence.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  freezeVaultRoot,
  seedFolder,
  seedLock,
  seedMember,
  seedNote,
  seedShare,
  seedVault,
  seedVaultGrant,
  seedUserVaultGrant,
  sealVault,
} from "./helpers/seed.js";

/**
 * ONE place that proves the read-only contract end to end.
 *
 *   "Whenever a note is read-only for someone, the server must not accept any
 *    change to that note from them, nor let anything overwrite it."
 *
 * Read-only arises three ways, and every write surface below is exercised
 * against all three that can reach it:
 *
 *   (1) LOCK      — a `shares.permission = 'locked'` row on the item or an
 *                   ancestor folder, for one user or the whole team.
 *   (2) VIEW      — a `view` grant (per-user or org, item or vault level) with
 *                   nothing higher.
 *   (3) READ-ONLY — the vault-wide posture (`resource_type = 'vault'`,
 *       VAULT       `permission = 'view'`), which `resolver.ts vaultBaseline`
 *                   applies to EVERYONE: owners, admins and a note's creator
 *                   included. Every (3) case here is also run for the OWNER,
 *                   because the person who set the posture is the one most
 *                   likely to be exempt from it by accident.
 *
 * "Private" (no access at all) is a different contract and lives in
 * `access-deny.test.ts` / `http-authz-gates.test.ts`: those users get no sync
 * token (403 at mint) and the readable-set dual hides the doc entirely.
 */

const PORT = 3993;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const rec = recordingAppDeps();
const app = createApp(rec.deps);

let syncServer: Server<SyncContext>;

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function waitFor(cond: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

// ── sync-token + socket helpers ──────────────────────────────────────────────

interface MintedToken {
  status: number;
  token?: string;
  readOnly?: boolean;
  permission?: string;
}

/** POST /api/sync-token as `user`, returning the status and the claims the
 *  route reports (the `readOnly` field is the claim the sync server reads). */
async function mint(user: TestUser, docId: string): Promise<MintedToken> {
  const res = await req(user, "POST", "/api/sync-token", { docId });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { token: string; readOnly: boolean; permission: string };
  return { status: 200, token: body.token, readOnly: body.readOnly, permission: body.permission };
}

interface Client {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  text: Y.Text;
  close(): void;
}

/** Every socket this test opened, so a FAILED assertion cannot leave one live:
 *  an orphan provider keeps syncing into the next test's freshly-truncated
 *  tables and turns one failure into a whole file of them. */
const openClients: Client[] = [];

async function open(vaultId: string, docId: string, token: string): Promise<Client> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: WS_URL,
    name: formatDocName(vaultId, docId),
    token,
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  let closed = false;
  const client: Client = {
    provider,
    doc,
    text: doc.getText("content"),
    close: () => {
      if (closed) return;
      closed = true;
      provider.destroy();
      doc.destroy();
      const i = openClients.indexOf(client);
      if (i >= 0) openClients.splice(i, 1);
    },
  };
  openClients.push(client);
  await waitFor(() => provider.isSynced, 8000, `provider synced (${docId})`);
  return client;
}

/**
 * Assert that the sync server REFUSES a connection outright (rather than
 * admitting it read-only). Resolves on `onAuthenticationFailed`, rejects if the
 * socket syncs or if nothing happens.
 */
function expectAuthRejected(vaultId: string, docId: string, token: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const doc = new Y.Doc();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      provider.destroy();
      doc.destroy();
      if (err) reject(err);
      else resolve();
    };
    const provider = new HocuspocusProvider({
      url: WS_URL,
      name: formatDocName(vaultId, docId),
      token,
      document: doc,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      onAuthenticationFailed: () => finish(),
      onSynced: () => finish(new Error("the connection was accepted, but should have been refused")),
    });
    const timer = setTimeout(
      () => finish(new Error("no authentication failure within 8s")),
      8000,
    );
  });
}

function closeAllClients(): void {
  for (const c of [...openClients]) c.close();
  openClients.length = 0;
}

/** The canonical server-side text of a doc, read straight out of Postgres. */
async function serverText(docId: string): Promise<string> {
  const state = await loadDocState(docId);
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

/** Poll Postgres until a doc's persisted text matches — the writes are awaited
 *  inside `onChange`, so this is a handshake, not a hopeful sleep. */
async function waitForServerText(docId: string, expected: string, label: string): Promise<void> {
  const start = Date.now();
  while ((await serverText(docId)) !== expected) {
    if (Date.now() - start > 8000) {
      throw new Error(`Timeout: ${label} (server text = ${JSON.stringify(await serverText(docId))})`);
    }
    await settle(50);
  }
}

/** Seed a doc's server-side CRDT state through a real editor socket, so the
 *  read-only attempt below has something it could overwrite. */
async function seedDocText(vaultId: string, docId: string, text: string): Promise<void> {
  const token = await mintSyncToken({ docId, vaultId, readOnly: false });
  const editor = await open(vaultId, docId, token);
  editor.text.insert(0, text);
  await waitForServerText(docId, text, "seed persisted");
  editor.close();
}

/**
 * The whole live-sync assertion in one place: a read-only socket's edit must
 * never reach Postgres, and an editor's must.
 */
async function expectSocketIsReadOnly(
  vaultId: string,
  docId: string,
  readOnlyToken: string,
  canonical: string,
): Promise<void> {
  const viewer = await open(vaultId, docId, readOnlyToken);
  await waitFor(() => viewer.text.toString() === canonical, 8000, "viewer synced");
  viewer.text.insert(0, "HACK ");
  await settle();
  expect(await serverText(docId)).toBe(canonical);
  viewer.close();

  // Control: the same doc still accepts a real editor, so the assertion above
  // is about the connection's permission and not about a wedged doc.
  const editorToken = await mintSyncToken({ docId, vaultId, readOnly: false });
  const editor = await open(vaultId, docId, editorToken);
  await waitFor(() => editor.text.toString() === canonical, 8000, "editor synced");
  editor.text.insert(editor.text.length, " EDITED");
  await waitForServerText(docId, `${canonical} EDITED`, "editor update persisted");
  editor.close();
}

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Fixture {
  owner: TestUser;
  member: TestUser;
  orgId: string;
  vault: string;
  folder: string;
  /** `folder`'s vault-relative path — the ops below derive their paths from it,
   *  so a fresh target folder can be swapped in without rewriting them. */
  folderPath: string;
  /** A note inside `folder`, created by the owner. */
  note: string;
  /** A note at the vault root, created by the owner. */
  rootNote: string;
  /** A note inside `folder` created by the MEMBER — the creator escape hatch. */
  memberNote: string;
}

let fixtureSeq = 0;

async function fixture(): Promise<Fixture> {
  const tag = `ro${++fixtureSeq}`;
  const owner = await signUp(`owner-${tag}@readonly.test`);
  const orgId = (await createOrg(owner, `Readonly ${tag}`, `readonly-${tag}`)).id;
  const member = await signUp(`member-${tag}@readonly.test`);
  await seedMember(orgId, member.userId, "member");
  const vault = await seedVault(orgId);
  const folder = await seedFolder(vault, null, "Docs", "Docs");
  return {
    owner,
    member,
    orgId,
    vault,
    folder,
    folderPath: "Docs",
    note: await seedNote(vault, folder, "Docs/Note.md", owner.userId),
    rootNote: await seedNote(vault, null, "Root.md", owner.userId),
    memberNote: await seedNote(vault, folder, "Docs/Mine.md", member.userId),
  };
}

/** (1) Lock: an open (org `edit`) vault with a team lock on the folder. */
async function withLock(f: Fixture): Promise<void> {
  await seedVaultGrant(f.orgId, "edit");
  await seedLock(f.orgId, "folder", f.folder, { type: "org" });
}

/** (2) View grant: a private vault where the member is given `view` on the
 *  folder and nothing more. */
async function withViewGrant(f: Fixture): Promise<void> {
  await seedShare(f.orgId, "folder", f.folder, f.member.userId, "view");
}

/** (3) The vault-wide Read-only posture. */
async function withReadOnlyVault(f: Fixture): Promise<void> {
  await seedVaultGrant(f.orgId, "view");
}

// ── MCP helper ───────────────────────────────────────────────────────────────

let rpcId = 0;

async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}) {
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
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  };
  return {
    isError: body.result?.isError ?? false,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

const mcpTokenFor = async (userId: string, orgId: string) =>
  (await createMcpToken({ userId, organizationId: orgId }, "readonly-test")).token;

/** Every MCP write tool, aimed at one note / folder / vault. */
async function mcpWriteAttempts(
  token: string,
  f: Fixture,
): Promise<Array<{ tool: string; isError: boolean; text: string }>> {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["update_note", { docId: f.note, content: "overwritten" }],
    ["append_note", { docId: f.note, text: "\nappended" }],
    ["edit_note", { docId: f.note, edits: [{ type: "insert_before", anchor: "x", text: "y" }] }],
    ["move_note", { docId: f.note, relPath: "Docs/Moved.md" }],
    ["delete_note", { docId: f.note }],
    ["create_note", { vaultId: f.vault, relPath: "Docs/New.md" }],
    ["create_folder", { vaultId: f.vault, name: "Sub", path: "Docs/Sub" }],
    ["move_folder", { folderId: f.folder, path: "Renamed" }],
    ["delete_folder", { folderId: f.folder, recursive: true }],
  ];
  const out = [];
  for (const [tool, args] of calls) {
    const r = await mcpCall(token, tool, args);
    out.push({ tool, ...r });
  }
  return out;
}

// ── HTTP structural helper ───────────────────────────────────────────────────

/** Every structural registry mutation, as an independently runnable op. */
interface StructuralOp {
  what: string;
  run: (user: TestUser, f: Fixture) => Promise<Response>;
}

const STRUCTURAL_OPS: StructuralOp[] = [
  {
    what: "rename note",
    run: (u, f) => req(u, "PATCH", `/api/notes/${f.note}`, { title: "hijacked" }),
  },
  {
    what: "move note",
    run: (u, f) =>
      req(u, "PATCH", `/api/notes/${f.note}`, {
        relPath: `Moved-${f.folderPath}.md`,
        folderId: null,
      }),
  },
  { what: "delete note", run: (u, f) => req(u, "DELETE", `/api/notes/${f.note}`) },
  {
    what: "rename folder",
    run: (u, f) => req(u, "PATCH", `/api/folders/${f.folder}`, { name: `${f.folderPath}Renamed` }),
  },
  {
    what: "move folder",
    run: (u, f) =>
      req(u, "PATCH", `/api/folders/${f.folder}`, {
        path: `${f.folderPath}Moved`,
        name: `${f.folderPath}Moved`,
      }),
  },
  { what: "delete folder", run: (u, f) => req(u, "DELETE", `/api/folders/${f.folder}`) },
  {
    what: "create note in folder",
    run: (u, f) =>
      req(u, "POST", "/api/notes", {
        vaultId: f.vault,
        relPath: `${f.folderPath}/Injected.md`,
        folderId: f.folder,
      }),
  },
  {
    what: "create subfolder",
    run: (u, f) =>
      req(u, "POST", "/api/folders", {
        vaultId: f.vault,
        name: "Injected",
        path: `${f.folderPath}/Injected`,
        parentId: f.folder,
      }),
  },
  {
    what: "create file in folder",
    run: (u, f) =>
      req(u, "POST", "/api/files", {
        vaultId: f.vault,
        path: `${f.folderPath}/injected.png`,
        folderId: f.folder,
      }),
  },
];

/** Run every structural op against ONE fixture. Safe for the refusal tests,
 *  where by definition nothing changes underneath the next op. */
async function structuralAttempts(
  user: TestUser,
  f: Fixture,
): Promise<Array<{ what: string; status: number }>> {
  const out = [];
  for (const op of STRUCTURAL_OPS) out.push({ what: op.what, status: (await op.run(user, f)).status });
  return out;
}

/** A fresh folder + note inside the same vault, so a SUCCEEDING op cannot pull
 *  the target out from under the next one (a rename makes the following
 *  create's path a 400, which would read as a permission pass/fail). */
async function freshTarget(f: Fixture, tag: string): Promise<Fixture> {
  const folder = await seedFolder(f.vault, null, tag, tag);
  return {
    ...f,
    folder,
    folderPath: tag,
    note: await seedNote(f.vault, folder, `${tag}/Note.md`, f.owner.userId),
  };
}

/** The same list, but at the vault ROOT — the one place with no folder row for
 *  a share to hang on, so only the vault posture can gate it. */
async function rootCreateAttempts(
  user: TestUser,
  f: Fixture,
): Promise<Array<{ what: string; status: number }>> {
  const attempts: Array<[string, () => Promise<Response>]> = [
    [
      "create root note",
      () => req(user, "POST", "/api/notes", { vaultId: f.vault, relPath: "Injected.md" }),
    ],
    [
      "create root folder",
      () =>
        req(user, "POST", "/api/folders", { vaultId: f.vault, name: "Injected", path: "Injected" }),
    ],
    [
      "create root file",
      () => req(user, "POST", "/api/files", { vaultId: f.vault, path: "injected.png" }),
    ],
  ];
  const out = [];
  for (const [what, run] of attempts) out.push({ what, status: (await run()).status });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await resetDb();
  syncServer = createSyncServer(PORT);
  await syncServer.listen();
});

afterAll(async () => {
  await syncServer.destroy();
  await pool.end();
});

beforeEach(async () => {
  closeAllClients();
  await resetDb();
  rec.reset();
});

afterEach(() => {
  closeAllClients();
});

// ═══ 1. Live sync (Hocuspocus) ═══════════════════════════════════════════════

describe("live sync: a read-only connection cannot change a doc", () => {
  it("(1) lock → sync-token says readOnly and the socket's update is dropped", async () => {
    const f = await fixture();
    await withLock(f);

    const minted = await mint(f.member, f.note);
    expect(minted.status).toBe(200);
    expect(minted.readOnly).toBe(true);
    expect(minted.permission).toBe("view");

    await seedDocText(f.vault, f.note, "canonical");
    await expectSocketIsReadOnly(f.vault, f.note, minted.token!, "canonical");
  });

  it("(1) a lock caps the OWNER too — the point of a lock is protecting content", async () => {
    const f = await fixture();
    await withLock(f);
    const minted = await mint(f.owner, f.note);
    expect(minted.readOnly).toBe(true);

    await seedDocText(f.vault, f.note, "canonical");
    await expectSocketIsReadOnly(f.vault, f.note, minted.token!, "canonical");
  });

  it("(2) a view grant → readOnly token, dropped update", async () => {
    const f = await fixture();
    await withViewGrant(f);

    const minted = await mint(f.member, f.note);
    expect(minted.status).toBe(200);
    expect(minted.readOnly).toBe(true);

    await seedDocText(f.vault, f.note, "canonical");
    await expectSocketIsReadOnly(f.vault, f.note, minted.token!, "canonical");
  });

  it("(3) the Read-only vault posture caps a plain MEMBER", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);

    const minted = await mint(f.member, f.note);
    expect(minted.readOnly).toBe(true);

    await seedDocText(f.vault, f.note, "canonical");
    await expectSocketIsReadOnly(f.vault, f.note, minted.token!, "canonical");
  });

  it("(3) the Read-only vault posture caps the OWNER, on a note the owner wrote", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);

    const minted = await mint(f.owner, f.note);
    expect(minted.status).toBe(200);
    expect(minted.readOnly).toBe(true);
    expect(minted.permission).toBe("view");

    await seedDocText(f.vault, f.note, "canonical");
    await expectSocketIsReadOnly(f.vault, f.note, minted.token!, "canonical");
  });

  it("(3) the Read-only vault posture caps a member on their OWN note", async () => {
    // The creator escape hatch (`created_by` → edit) is one of the shortcuts
    // `vaultBaseline` has to skip, or Read-only would leave every author free.
    const f = await fixture();
    await withReadOnlyVault(f);
    const minted = await mint(f.member, f.memberNote);
    expect(minted.readOnly).toBe(true);
  });

  it("an edit grant still mints an editable token (the control)", async () => {
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");
    const minted = await mint(f.member, f.note);
    expect(minted.readOnly).toBe(false);
    expect(minted.permission).toBe("edit");

    const client = await open(f.vault, f.note, minted.token!);
    client.text.insert(0, "written by a member");
    await waitForServerText(f.note, "written by a member", "member edit persisted");
    client.close();
  });
});

// ═══ 2. Revocation ═══════════════════════════════════════════════════════════

describe("revocation: narrowing to read-only reaches live sockets", () => {
  it("PUT /team-access {mode:'readonly'} force-closes every doc socket", async () => {
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");

    const res = await req(f.owner, "PUT", `/api/orgs/${f.orgId}/team-access`, {
      mode: "readonly",
    });
    expect(res.status).toBe(200);

    const kicked = rec.disconnected.map((d) => d.docId);
    expect(kicked).toContain(f.note);
    expect(kicked).toContain(f.rootNote);
    expect(kicked).toContain(f.memberNote);
  });

  it("a RECONNECT after the switch mints a read-only token", async () => {
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");
    expect((await mint(f.member, f.note)).readOnly).toBe(false);

    await req(f.owner, "PUT", `/api/orgs/${f.orgId}/team-access`, { mode: "readonly" });

    const after = await mint(f.member, f.note);
    expect(after.status).toBe(200);
    expect(after.readOnly).toBe(true);
  });

  it("a pre-switch edit token is DOWNGRADED to read-only on reconnect", async () => {
    // `onAuthenticate` re-resolves the permission against the database and
    // treats the signed `readOnly` claim as a hint only, so the kick above is
    // no longer the only thing standing between a revoked editor and the doc.
    // Before that, an edit token stayed editable for the rest of its TTL
    // (`SYNC_TOKEN_TTL_SECONDS`, 600s) and a client that simply reconnected was
    // re-admitted as an editor.
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");
    const stale = await mint(f.member, f.note);
    expect(stale.readOnly).toBe(false);

    await seedDocText(f.vault, f.note, "canonical");
    await req(f.owner, "PUT", `/api/orgs/${f.orgId}/team-access`, { mode: "readonly" });

    // A fresh mint is correctly read-only…
    expect((await mint(f.member, f.note)).readOnly).toBe(true);

    // …and so is a reconnect with the OLD edit token.
    const client = await open(f.vault, f.note, stale.token!);
    await waitFor(() => client.text.toString() === "canonical", 8000, "stale client synced");
    client.text.insert(0, "replayed ");
    await settle();
    expect(await serverText(f.note)).toBe("canonical");
    client.close();
  });

  it("a pre-revocation token for a doc the user can no longer read is REJECTED", async () => {
    // Not merely downgraded: `effectivePermission` of `none` closes the socket,
    // the same answer `POST /api/sync-token` gives at mint time.
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");
    const stale = await mint(f.member, f.note);
    expect(stale.readOnly).toBe(false);

    // Access revoked entirely: the vault goes Private, so a plain member has no
    // grant left on a note they did not create.
    await req(f.owner, "PUT", `/api/orgs/${f.orgId}/team-access`, { mode: "private" });
    expect((await mint(f.member, f.note)).status).toBe(403);

    await expectAuthRejected(f.vault, f.note, stale.token!);
  });

});

// ═══ 3. MCP ══════════════════════════════════════════════════════════════════

describe("MCP write tools refuse a read-only caller", () => {
  it("(1) under a team lock, every write tool is refused", async () => {
    const f = await fixture();
    await withLock(f);
    const token = await mcpTokenFor(f.member.userId, f.orgId);
    for (const r of await mcpWriteAttempts(token, f)) {
      expect(r.isError, `${r.tool} should be refused: ${r.text}`).toBe(true);
    }
  });

  it("(1) a lock refuses the OWNER's MCP writes too", async () => {
    const f = await fixture();
    await withLock(f);
    const token = await mcpTokenFor(f.owner.userId, f.orgId);
    for (const r of await mcpWriteAttempts(token, f)) {
      expect(r.isError, `${r.tool} should be refused: ${r.text}`).toBe(true);
    }
  });

  it("(2) with only a view grant, every write tool is refused", async () => {
    const f = await fixture();
    await withViewGrant(f);
    const token = await mcpTokenFor(f.member.userId, f.orgId);
    for (const r of await mcpWriteAttempts(token, f)) {
      expect(r.isError, `${r.tool} should be refused: ${r.text}`).toBe(true);
    }
    // …while reading still works, so this is read-ONLY and not no-access.
    const read = await mcpCall(token, "read_note", { docId: f.note });
    expect(read.isError).toBe(false);
  });

  it("(3) under a Read-only vault, every write tool is refused for a member", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);
    const token = await mcpTokenFor(f.member.userId, f.orgId);
    for (const r of await mcpWriteAttempts(token, f)) {
      expect(r.isError, `${r.tool} should be refused: ${r.text}`).toBe(true);
    }
  });

  it("(3) under a Read-only vault, every write tool is refused for the OWNER", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);
    const token = await mcpTokenFor(f.owner.userId, f.orgId);
    for (const r of await mcpWriteAttempts(token, f)) {
      expect(r.isError, `${r.tool} should be refused: ${r.text}`).toBe(true);
    }
    // The root is admin-only for MCP regardless of posture, so a root create is
    // refused here for two reasons at once; assert it explicitly anyway.
    const rootCreate = await mcpCall(token, "create_note", {
      vaultId: f.vault,
      relPath: "Injected.md",
    });
    expect(rootCreate.isError).toBe(true);
  });

  it("an editor's MCP writes succeed (the control)", async () => {
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");
    const token = await mcpTokenFor(f.member.userId, f.orgId);
    expect((await mcpCall(token, "update_note", { docId: f.note, content: "ok" })).isError).toBe(
      false,
    );
    expect(
      (await mcpCall(token, "create_note", { vaultId: f.vault, relPath: "Docs/New.md" })).isError,
    ).toBe(false);
    expect(
      (await mcpCall(token, "move_note", { docId: f.note, relPath: "Docs/Renamed.md" })).isError,
    ).toBe(false);
  });
});

// ═══ 4. HTTP structural routes ═══════════════════════════════════════════════

describe("HTTP registry: structural writes require edit, not membership", () => {
  it("(1) a team lock refuses every structural mutation, for member and owner", async () => {
    const f = await fixture();
    await withLock(f);
    for (const user of [f.member, f.owner]) {
      for (const r of await structuralAttempts(user, f)) {
        expect(r.status, `${r.what} must be refused`).toBe(403);
      }
    }
  });

  it("(2) a view-only member can neither rename, move, delete nor CREATE", async () => {
    const f = await fixture();
    await withViewGrant(f);
    for (const r of await structuralAttempts(f.member, f)) {
      expect(r.status, `${r.what} must be refused`).toBe(403);
    }
    // Reading the folder's notes still works — read-only, not no-access.
    const list = await req(f.member, "GET", `/api/notes?vaultId=${f.vault}`);
    expect(list.status).toBe(200);
    const { notes } = (await list.json()) as { notes: Array<{ id: string }> };
    expect(notes.map((n) => n.id)).toContain(f.note);
  });

  it("(3) a Read-only vault refuses structural mutations for a MEMBER", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);
    for (const r of await structuralAttempts(f.member, f)) {
      expect(r.status, `${r.what} must be refused`).toBe(403);
    }
    for (const r of await rootCreateAttempts(f.member, f)) {
      expect(r.status, `${r.what} must be refused`).toBe(403);
    }
  });

  it("(3) a Read-only vault refuses structural mutations for the OWNER, root included", async () => {
    // Decided deliberately: "nobody edits" includes the person who said it.
    // The way back is the Access panel, which goes through `shares.ts canManage`
    // — role-based, never effective-permission — so an owner is never locked out
    // of their own vault by this.
    const f = await fixture();
    await withReadOnlyVault(f);
    for (const r of await structuralAttempts(f.owner, f)) {
      expect(r.status, `${r.what} must be refused for the owner`).toBe(403);
    }
    for (const r of await rootCreateAttempts(f.owner, f)) {
      expect(r.status, `${r.what} must be refused for the owner`).toBe(403);
    }
    // …and the owner can still flip the vault back.
    const back = await req(f.owner, "PUT", `/api/orgs/${f.orgId}/team-access`, { mode: "open" });
    expect(back.status).toBe(200);
    expect((await rootCreateAttempts(f.owner, f))[0].status).toBe(201);
  });

  it("(3) a per-user vault-scoped edit grant lifts one person out of Read-only", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);
    await pool.query(
      `INSERT INTO shares
         (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'vault', $2, 'user', $3, 'edit')`,
      [randomUUID(), f.orgId, f.member.userId],
    );
    const created = await req(f.member, "POST", "/api/notes", {
      vaultId: f.vault,
      relPath: "Lifted.md",
    });
    expect(created.status).toBe(201);
    expect((await mint(f.member, f.note)).readOnly).toBe(false);
  });

  it("an editor member keeps every structural mutation (the control)", async () => {
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");
    for (const [i, op] of STRUCTURAL_OPS.entries()) {
      const target = await freshTarget(f, `Ctl${i}`);
      const status = (await op.run(f.member, target)).status;
      expect([200, 201], `${op.what} should have been allowed (got ${status})`).toContain(status);
    }
  });

  it("re-registering an EXISTING note still succeeds for a read-only caller", async () => {
    // The create gate must not break sync's idempotent re-registration: a note
    // already at that path is adopted, which is a read, not a write.
    const f = await fixture();
    await withReadOnlyVault(f);
    const res = await req(f.member, "POST", "/api/notes", {
      vaultId: f.vault,
      relPath: "Docs/Note.md",
      folderId: f.folder,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { docId: string }).docId).toBe(f.note);
  });
});

// ═══ 5. Other write surfaces ═════════════════════════════════════════════════

describe("other write surfaces", () => {
  it("version restore requires edit; reading versions only needs view", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);

    expect((await req(f.member, "GET", `/api/notes/${f.note}/versions`)).status).toBe(200);
    expect((await req(f.owner, "GET", `/api/notes/${f.note}/versions`)).status).toBe(200);
    for (const user of [f.member, f.owner]) {
      const res = await req(user, "POST", `/api/notes/${f.note}/versions/whatever/revert`);
      expect(res.status).toBe(403);
    }
  });

  it("the CRDT repair endpoints require edit", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);
    for (const user of [f.member, f.owner]) {
      expect((await req(user, "GET", `/api/notes/${f.note}/crdt-size`)).status).toBe(403);
      expect(
        (await req(user, "POST", `/api/notes/${f.note}/reset-crdt`, { content: "wiped" })).status,
      ).toBe(403);
    }

    // Control: with the posture lifted, the owner can repair.
    await pool.query("DELETE FROM shares WHERE resource_type = 'vault'");
    expect((await req(f.owner, "GET", `/api/notes/${f.note}/crdt-size`)).status).toBe(200);
  });

  it("attachment upload is refused in a Read-only vault, allowed otherwise", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);
    const upload = (user: TestUser) =>
      app.fetch(
        new Request(`http://local/api/vaults/${f.vault}/blobs`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${user.token}`,
            "content-type": "image/png",
            "x-rel-path": "attachments/shot.png",
          },
          body: Buffer.from("not really a png"),
        }),
      );
    expect((await upload(f.member)).status).toBe(403);
    expect((await upload(f.owner)).status).toBe(403);

    await pool.query("DELETE FROM shares WHERE resource_type = 'vault'");
    expect((await upload(f.owner)).status).toBe(201);
  });

  it("minting a public link is gated on share MANAGEMENT, not on edit", async () => {
    // Documented, unchanged behaviour: publishing to the open web is a sharing
    // decision (owner/admin or the note's creator), and a public page is itself
    // read-only. So a Read-only vault does not stop an owner minting one, and a
    // view-only member cannot mint one even where they could read the note.
    const f = await fixture();
    await withReadOnlyVault(f);
    expect([200, 201]).toContain(
      (await req(f.owner, "POST", `/api/notes/${f.note}/public-link`)).status,
    );

    const g = await fixture();
    await withViewGrant(g);
    expect((await req(g.member, "POST", `/api/notes/${g.note}/public-link`)).status).toBe(403);
  });

  it("the vault channel accepts no inbound write frame at all", async () => {
    // The desktop's structural sync goes over HTTP; the channel is download-only
    // by construction — post-hello the ONLY client frame it parses is presence.
    // A forged `registry`/`update` frame must therefore change nothing.
    const f = await fixture();
    await withReadOnlyVault(f);

    const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello(await mintVaultToken({ userId: f.member.userId, vaultId: f.vault }));
    await waitFor(() => ws.controls().some((c) => c.t === "ready"), 4000, "channel ready");

    const before = await pool.query("SELECT id, rel_path FROM notes WHERE vault_id = $1", [
      f.vault,
    ]);
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({ t: "registry", op: "rename", docId: f.note, relPath: "Hijacked.md" }),
      ),
      false,
    );
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "update", docId: f.note, update: "AAAA" })),
      false,
    );
    await settle(200);
    const after = await pool.query("SELECT id, rel_path FROM notes WHERE vault_id = $1", [f.vault]);
    expect(after.rows).toEqual(before.rows);
    expect(await serverText(f.note)).toBe("");
    ws.close();
  });
});

// ═══ 6. Refusal shape (what the desktop can act on) ══════════════════════════

describe("create refusals carry a code the client can act on", () => {
  it("a permission refusal answers code 'no_write_access'", async () => {
    const f = await fixture();
    await withReadOnlyVault(f);
    const res = await req(f.member, "POST", "/api/notes", {
      vaultId: f.vault,
      relPath: "Injected.md",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("no_write_access");
  });

  it("permission wins over root_frozen when both apply; an editor still sees root_frozen", async () => {
    // Deliberate precedence: "move it into a folder" is useless advice for
    // someone who may not write to that folder either.
    const f = await fixture();
    await freezeVaultRoot(f.vault);
    await withReadOnlyVault(f);
    const refused = await req(f.member, "POST", "/api/notes", {
      vaultId: f.vault,
      relPath: "Injected.md",
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("no_write_access");

    // Same request from someone who MAY write: the latch is what stops them,
    // and they get the code whose toast tells them what to do about it.
    await pool.query("DELETE FROM shares WHERE resource_type = 'vault'");
    await seedVaultGrant(f.orgId, "edit");
    const frozen = await req(f.member, "POST", "/api/notes", {
      vaultId: f.vault,
      relPath: "Injected.md",
    });
    expect(frozen.status).toBe(403);
    expect(((await frozen.json()) as { code: string }).code).toBe("root_frozen");
  });

  it("re-registering an existing doc_id at a NEW path echoes the canonical one", async () => {
    // `ON CONFLICT DO NOTHING` writes nothing, so the response must describe the
    // row that exists, not the move the caller asked for — otherwise the client
    // records a path the server never stored and re-sends it forever.
    const f = await fixture();
    await seedVaultGrant(f.orgId, "edit");
    await freezeVaultRoot(f.vault);

    const res = await req(f.member, "POST", "/api/notes", {
      vaultId: f.vault,
      docId: f.note,
      relPath: "Moved-To-Root.md",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docId: string; relPath: string; folderId: string | null };
    expect(body.docId).toBe(f.note);
    expect(body.relPath).toBe("Docs/Note.md");
    expect(body.folderId).toBe(f.folder);

    // Nothing moved, and no second row appeared at the root.
    const { rows } = await pool.query<{ rel_path: string; folder_id: string | null }>(
      "SELECT rel_path, folder_id FROM notes WHERE id = $1",
      [f.note],
    );
    expect(rows[0].rel_path).toBe("Docs/Note.md");
    expect(rows[0].folder_id).toBe(f.folder);
    const { rows: root } = await pool.query(
      "SELECT id FROM notes WHERE vault_id = $1 AND folder_id IS NULL AND rel_path = $2",
      [f.vault, "Moved-To-Root.md"],
    );
    expect(root).toHaveLength(0);
  });
});

/** Minimal socket double for the vault channel (mirrors vault-channel-e2e). */
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
  hello(token: string): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {} })), false);
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.text).map((s) => s.text as Record<string, unknown>);
  }
}


/**
 * The sealed vault's write contract — the same shape as the read-only one, for
 * the same reason: "nobody can read this" has to close the create door too, or
 * the first thing you make in a sealed vault is a note you cannot open.
 */
describe("a sealed vault refuses creation, a never-shared one does not", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@sealed-writes.test");
    org = (await createOrg(owner, "Sealed Co", "sealed-co")).id;
    vault = await seedVault(org);
  });

  const createRootNote = async (user: TestUser) =>
    app.fetch(
      new Request("http://local/api/notes", {
        method: "POST",
        headers: { ...authHeaders(user), "content-type": "application/json" },
        body: JSON.stringify({ vaultId: vault, relPath: `n-${randomUUID()}.md` }),
      }),
    );

  it("lets the owner create at the root of a never-shared vault", async () => {
    // No posture row: the private-by-default space, where what you make is
    // yours. Closing this would make the state unusable rather than private.
    expect((await createRootNote(owner)).status).toBeLessThan(300);
  });

  it("refuses once the vault is sealed, and lets a named person back in", async () => {
    await sealVault(org);
    const refused = await createRootNote(owner);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code?: string }).code).toBe("no_write_access");

    // The way back that does not involve unsealing: a vault-scoped grant for
    // one person, which is the one thing the posture branch still honours where
    // there is no folder for a share to hang on.
    await seedUserVaultGrant(org, owner.userId, "edit");
    expect((await createRootNote(owner)).status).toBeLessThan(300);
  });
});
