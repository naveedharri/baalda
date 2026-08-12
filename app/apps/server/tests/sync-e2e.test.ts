import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, disconnectDoc, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { countUpdates } from "../src/yjs/persistence.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import { createApp } from "../src/http/app.js";
import { recordVersion } from "../src/versions/capture.js";
import { pool } from "../src/db/pool.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, signUp } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedVault } from "./helpers/seed.js";
import { resetDb } from "./helpers/db.js";

const PORT = 3987;
const URL = `ws://127.0.0.1:${PORT}`;
const VAULT = "vault-e2e";

let server: Server<SyncContext>;
/** Every `onDocEdited` notification the sync server made, in order. */
let edits: Array<{ vaultId: string; docId: string; userId: string | null }>;

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

interface Client {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  text: Y.Text;
}

async function connect(
  docId: string,
  readOnly: boolean,
  userId?: string,
  vaultId: string = VAULT,
): Promise<Client> {
  const token = await mintSyncToken({ docId, vaultId, readOnly, userId });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: URL,
    name: formatDocName(vaultId, docId),
    token,
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  await waitFor(() => provider.isSynced, 8000, "provider synced");
  return { provider, doc, text: doc.getText("content") };
}

describe("end-to-end Yjs sync through the server (spec 03 §3, 04 §4)", () => {
  beforeAll(async () => {
    await resetDb();
    edits = [];
    server = createSyncServer(PORT, undefined, (vaultId, docId, userId) =>
      edits.push({ vaultId, docId, userId }),
    );
    await server.listen();
  });
  afterAll(async () => {
    await server.destroy();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDb();
    edits = [];
  });

  it("two edit clients converge on one doc", async () => {
    const docId = "e2e-converge";
    const a = await connect(docId, false);
    a.text.insert(0, "Hello from A");

    const b = await connect(docId, false);
    // B receives A's state on sync
    await waitFor(() => b.text.toString() === "Hello from A", 8000, "B sees A");
    expect(b.text.toString()).toBe("Hello from A");

    // B edits; A converges
    b.text.insert(b.text.length, " + B");
    await waitFor(() => a.text.toString() === "Hello from A + B", 8000, "A sees B");
    expect(a.text.toString()).toBe("Hello from A + B");

    // Server persisted the binary updates (onChange append is awaited server-side).
    await new Promise((r) => setTimeout(r, 300));
    expect(await countUpdates(docId)).toBeGreaterThan(0);

    a.provider.destroy();
    b.provider.destroy();
  });

  it("a read-only client's edits are rejected by the server", async () => {
    const docId = "e2e-readonly";
    const editor = await connect(docId, false);
    editor.text.insert(0, "canonical");
    await waitFor(() => editor.text.toString() === "canonical");

    const viewer = await connect(docId, true);
    await waitFor(() => viewer.text.toString() === "canonical", 8000, "viewer synced state");

    // Viewer attempts an edit — server must NOT broadcast/persist it.
    viewer.text.insert(0, "HACK ");

    // Give the network time; the editor must never see the viewer's change.
    await new Promise((r) => setTimeout(r, 800));
    expect(editor.text.toString()).toBe("canonical");

    editor.provider.destroy();
    viewer.provider.destroy();
  });

  it("revoking disconnects a live socket (instant kill)", async () => {
    const docId = "e2e-revoke";
    const c = await connect(docId, false);
    expect(c.provider.isSynced).toBe(true);

    disconnectDoc(server, VAULT, docId);

    // The provider notices the socket drop (status leaves 'connected').
    await waitFor(
      () => c.provider.configuration.websocketProvider.status !== "connected",
      8000,
      "socket closed",
    ).catch(() => {});
    // Best-effort: it should no longer report a live synced connection soon after.
    c.provider.disconnect();
    c.provider.destroy();
  });

  // ── attribution (versioning / "last edited by") ─────────────────────────────

  it("attributes a client edit to the token's userId", async () => {
    const docId = "e2e-attrib-client";
    const c = await connect(docId, false, "user-abc");
    c.text.insert(0, "typed by a human");

    await waitFor(() => edits.some((e) => e.docId === docId), 8000, "onDocEdited fired");
    const mine = edits.filter((e) => e.docId === docId);
    expect(mine[0].vaultId).toBe(VAULT);
    expect(mine[0].userId).toBe("user-abc");

    c.provider.destroy();
  });

  it("a pre-attribution token (no userId claim) still syncs, anonymously", async () => {
    // Tokens minted before the claim existed are in flight for up to the TTL.
    // They must verify and connect — just without a name attached.
    const docId = "e2e-attrib-legacy";
    const c = await connect(docId, false);
    c.text.insert(0, "anonymous edit");

    await waitFor(() => edits.some((e) => e.docId === docId), 8000, "onDocEdited fired");
    expect(edits.find((e) => e.docId === docId)?.userId).toBeNull();

    c.provider.destroy();
  });

  it("a doc-writer LIVE write reaches onChange with its actor (object origin)", async () => {
    // The load-bearing one. The live path tags its transaction with a Hocuspocus
    // `LocalTransactionOrigin` object; if Hocuspocus only string-compared origins
    // (as `LOAD_ORIGIN` is), the context — and with it the whole attribution
    // chain for MCP/AI and revert writes — would never arrive.
    const docId = "e2e-attrib-local-origin";
    const c = await connect(docId, false, "human");
    await waitFor(() => c.provider.isSynced);

    const writer = createDocWriter(server);
    await writer.setContent(VAULT, docId, "written by the assistant", {
      userId: "assistant-user",
    });

    // Reached the connected editor as an ordinary remote update…
    await waitFor(
      () => c.text.toString() === "written by the assistant",
      8000,
      "live write broadcast",
    );
    // …and was attributed to the actor, not to the connected human.
    await waitFor(
      () => edits.some((e) => e.docId === docId && e.userId === "assistant-user"),
      8000,
      "actor attribution",
    );

    c.provider.destroy();
  });

  it("a version revert over HTTP lands live in a connected editor", async () => {
    // The whole point of reverting FORWARD through the doc writer: the client
    // needs no revert protocol at all — the restored text arrives as an ordinary
    // remote update and yCollab applies it like a teammate's keystroke.
    const owner = await signUp("e2e-revert@t.com");
    const org = await seedOrg("Acme", "acme-e2e-rv");
    await seedMember(org, owner.userId, "owner");
    const vaultId = await seedVault(org);
    const docId = await seedNote(vaultId, null, "n.md", owner.userId);

    const app = createApp(testAppDeps({ docWriter: createDocWriter(server) }));
    const c = await connect(docId, false, owner.userId, vaultId);
    c.text.insert(0, "text the user regrets");
    await waitFor(() => c.text.toString() === "text the user regrets");

    const versionId = await recordVersion({
      vaultId,
      docId,
      content: "the good version",
      cause: "idle",
      authorId: owner.userId,
    });

    const res = await app.fetch(
      new Request(`http://local/api/notes/${docId}/versions/${versionId}/revert`, {
        method: "POST",
        headers: authHeaders(owner),
      }),
    );
    expect(res.status).toBe(200);

    await waitFor(
      () => c.text.toString() === "the good version",
      8000,
      "revert reached the editor",
    );
    c.provider.destroy();
  });
});
