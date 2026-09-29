import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, evictDoc, disconnectDoc, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { loadDocState } from "../src/yjs/persistence.js";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedVault } from "./helpers/seed.js";
import { resetDb } from "./helpers/db.js";

/**
 * Live sockets and the Trash: a client whose note was deleted keeps pushing
 * into it until `purge_after` (its offline edits must reach the server), and an
 * HTTP delete kicks live editors so they re-authenticate.
 */

const PORT = 3991;
const URL = `ws://127.0.0.1:${PORT}`;
let server: Server<SyncContext>;

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

async function textOf(docId: string): Promise<string> {
  const state = await loadDocState(docId);
  if (!state) return "";
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const out = doc.getText("content").toString();
  doc.destroy();
  return out;
}

function open(vaultId: string, docId: string, userId: string) {
  const doc = new Y.Doc();
  const state = { failed: false, closed: 0 };
  const provider = new HocuspocusProvider({
    url: URL,
    name: formatDocName(vaultId, docId),
    token: () => mintSyncToken({ docId, vaultId, readOnly: false, userId }),
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    onAuthenticationFailed: () => {
      state.failed = true;
    },
    onClose: () => {
      state.closed++;
    },
  });
  return { provider, doc, text: doc.getText("content"), state };
}

describe("trash over live sync", () => {
  let owner: TestUser;
  let vaultId: string;

  beforeAll(async () => {
    await resetDb();
    server = createSyncServer(PORT);
    await server.listen();
  });
  afterAll(async () => {
    await server.destroy();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@trash-e2e.test");
    const org = await seedOrg("Trash E2E", "trash-e2e");
    await seedMember(org, owner.userId, "owner");
    vaultId = await seedVault(org);
  });

  it("accepts a push into a deleted doc before purge_after; the note stays deleted", async () => {
    const docId = await seedNote(vaultId, null, "a.md", owner.userId);
    await pool.query(
      "UPDATE notes SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1",
      [docId],
    );
    const c = open(vaultId, docId, owner.userId);
    await waitFor(() => c.provider.isSynced, 8000, "synced");
    c.text.insert(0, "edited offline");
    const start = Date.now();
    while ((await textOf(docId)) !== "edited offline") {
      if (Date.now() - start > 8000) throw new Error("push never persisted");
      await new Promise((r) => setTimeout(r, 50));
    }
    const { rows } = await pool.query("SELECT deleted_at FROM notes WHERE id = $1", [docId]);
    expect(rows[0].deleted_at).not.toBeNull();
    c.provider.destroy();
  });

  it("refuses the connection once purge_after has passed", async () => {
    const docId = await seedNote(vaultId, null, "a.md", owner.userId);
    await pool.query(
      "UPDATE notes SET deleted_at = now(), purge_after = now() - interval '1 minute' WHERE id = $1",
      [docId],
    );
    const c = open(vaultId, docId, owner.userId);
    await waitFor(() => c.state.failed, 8000, "authentication failed");
    expect(c.provider.isSynced).toBe(false);
    c.provider.destroy();
  });

  it("HTTP DELETE kicks a live editor off the doc", async () => {
    const app = createApp(
      testAppDeps({
        disconnectDoc: (v, d) => disconnectDoc(server, v, d),
        evictDoc: (v, d) => evictDoc(server, v, d),
      }),
    );
    const docId = await seedNote(vaultId, null, "a.md", owner.userId);
    const c = open(vaultId, docId, owner.userId);
    await waitFor(() => c.provider.isSynced, 8000, "synced");
    const closedBefore = c.state.closed;
    const res = await app.fetch(
      new Request(`http://local/api/notes/${docId}`, { method: "DELETE", headers: authHeaders(owner) }),
    );
    expect(res.status).toBe(200);
    await waitFor(() => c.state.closed > closedBefore, 8000, "socket closed");
    c.provider.destroy();
  });
});
