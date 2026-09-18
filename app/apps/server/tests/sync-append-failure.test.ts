import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";

/**
 * What happens when persisting an update FAILS.
 *
 * Hocuspocus calls `onChange` unawaited and uncaught
 * (`handleDocumentUpdate` → `this.hooks("onChange", …)`), so a rejection from
 * `appendUpdate` is an unhandled rejection — and Node 22's default for one is to
 * exit. A pool-exhaustion blip or a slow compact therefore used to take the
 * whole server down, dropping every in-memory doc whose updates had not been
 * appended yet.
 *
 * The two things this pins:
 *   1. the failure is contained — the server keeps serving, including the very
 *      doc that failed;
 *   2. the client is left AHEAD, so `loadDocDiff` reports `clientAhead` and the
 *      vault channel names the doc on `ready.behind` for a re-push. A crash
 *      would have lost that signal for every other doc too.
 */
let failNext = false;

vi.mock("../src/yjs/persistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/yjs/persistence.js")>();
  return {
    ...actual,
    appendUpdate: async (...args: Parameters<typeof actual.appendUpdate>) => {
      if (failNext) throw new Error("simulated: pool exhausted");
      return actual.appendUpdate(...args);
    },
  };
});

const { createSyncServer } = await import("../src/sync/hocuspocus.js");
const { formatDocName } = await import("../src/sync/doc-name.js");
const { mintSyncToken } = await import("../src/tokens/sync-token.js");
const { countUpdates, loadDocDiff } = await import("../src/yjs/persistence.js");
const { pool } = await import("../src/db/pool.js");
const { resetDb } = await import("./helpers/db.js");

const PORT = 3991;
const URL = `ws://127.0.0.1:${PORT}`;
const VAULT = "vault-append-fail";

let server: Server<import("../src/sync/hocuspocus.js").SyncContext>;
let unhandled: unknown[] = [];

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

async function connect(docId: string) {
  const token = await mintSyncToken({ docId, vaultId: VAULT, readOnly: false });
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: URL,
    name: formatDocName(VAULT, docId),
    token,
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  await waitFor(() => provider.isSynced, 8000, "provider synced");
  return { provider, doc, text: doc.getText("content") };
}

const record = (reason: unknown) => unhandled.push(reason);

describe("a failed appendUpdate in onChange", () => {
  beforeAll(async () => {
    await resetDb();
    process.on("unhandledRejection", record);
    server = createSyncServer(PORT);
    await server.listen();
  });
  afterAll(async () => {
    process.off("unhandledRejection", record);
    await server.destroy();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDb();
    failNext = false;
    unhandled = [];
  });

  it("is swallowed, leaves the client ahead, and the server keeps serving", async () => {
    const docId = "append-fails";
    const client = await connect(docId);

    failNext = true;
    client.text.insert(0, "words the server will fail to store");
    // Long enough for the hook to have run and rejected.
    await new Promise((r) => setTimeout(r, 400));

    // 1. Nothing escaped as an unhandled rejection…
    expect(unhandled).toEqual([]);
    // …and nothing was stored.
    expect(await countUpdates(docId)).toBe(0);

    // 2. The client still holds ops the server has never seen, which is exactly
    //    what makes the vault channel name this doc on `ready.behind`.
    const diff = await loadDocDiff(docId, Y.encodeStateVector(client.doc));
    expect(diff === null || diff.clientAhead).toBe(true);

    // 3. The server is alive: the very next edit on the SAME doc persists.
    failNext = false;
    client.text.insert(client.text.length, " — and this one lands");
    await waitFor(async () => true, 100);
    await new Promise((r) => setTimeout(r, 400));
    expect(await countUpdates(docId)).toBeGreaterThan(0);

    client.provider.destroy();
  });
});
