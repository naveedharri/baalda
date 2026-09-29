import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { resetDb } from "./helpers/db.js";

/**
 * Phase 4: a read-only connection's edit is dropped by Hocuspocus with only a
 * bare `syncStatus: false`. The server now reports it (`onRejected`) and the
 * vault channel delivers `{t:"rejected", docId, reason:"read_only"}` to that
 * user alone, so the desktop can park the edit.
 */

const PORT = 3993;
let server: Server<SyncContext>;
let rejections: Array<{ vaultId: string; docId: string; userId: string }>;

async function until(fn: () => boolean, ms = 8000, label = "condition") {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`Timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (!opts?.binary) this.sent.push(JSON.parse(data as string));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

describe("rejected frame for read-only edits", () => {
  let owner: TestUser;
  let viewer: TestUser;
  let vault: string;

  beforeAll(async () => {
    await resetDb();
    server = createSyncServer(PORT, undefined, undefined, (vaultId, docId, userId) =>
      rejections.push({ vaultId, docId, userId }),
    );
    await server.listen();
  });
  afterAll(async () => {
    await server.destroy();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDb();
    rejections = [];
    owner = await signUp("owner@rejected.test");
    const org = (await createOrg(owner, "Rejected Co", "rejected-co")).id;
    viewer = await signUp("viewer@rejected.test");
    await seedMember(org, viewer.userId, "member");
    vault = await seedVault(org);
    await seedVaultGrant(org, "view");
  });

  it("reports a viewer's dropped edit, not a viewer who only syncs", async () => {
    const docId = await seedNote(vault, null, "a.md", owner.userId);
    const seed = new Y.Doc();
    seed.getText("content").insert(0, "server text");
    await appendUpdate(docId, Y.encodeStateAsUpdate(seed));

    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${PORT}`,
      name: formatDocName(vault, docId),
      token: () => mintSyncToken({ docId, vaultId: vault, readOnly: true, userId: viewer.userId }),
      document: doc,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    await until(() => provider.isSynced, 8000, "synced");
    await new Promise((r) => setTimeout(r, 200));
    // Syncing down alone is not a rejection.
    expect(rejections).toEqual([]);

    doc.getText("content").insert(0, "viewer typed ");
    await until(() => rejections.length > 0, 8000, "rejection reported");
    expect(rejections[0]).toEqual({ vaultId: vault, docId, userId: viewer.userId });
    // Throttled: a burst of keystrokes is one report.
    doc.getText("content").insert(0, "more ");
    await new Promise((r) => setTimeout(r, 300));
    expect(rejections).toHaveLength(1);
    provider.destroy();
  });

  it("the vault channel delivers `rejected` to that user only", async () => {
    const docId = await seedNote(vault, null, "a.md", owner.userId);
    const pubsub = new InMemoryPubSub();
    const channel = new VaultChannel({ pubsub });
    const connect = async (userId: string) => {
      const ws = new FakeWs();
      channel.handleConnection(ws as never);
      ws.emit(
        "message",
        Buffer.from(JSON.stringify({ t: "hello", token: await mintVaultToken({ userId, vaultId: vault }), manifest: {} })),
        false,
      );
      await until(() => ws.sent.some((c) => c.t === "ready"), 4000, "ready");
      return ws;
    };
    const mine = await connect(viewer.userId);
    const theirs = await connect(owner.userId);
    await channel.publishRejected(vault, viewer.userId, docId);
    await until(() => mine.sent.some((c) => c.t === "rejected"), 4000, "rejected delivered");
    expect(mine.sent.find((c) => c.t === "rejected")).toEqual({ t: "rejected", docId, reason: "read_only" });
    expect(theirs.sent.some((c) => c.t === "rejected")).toBe(false);
  });
});
