import { EventEmitter } from "node:events";
import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";

/**
 * `ready.covered`: manifest docs whose hello state vector the server's stored
 * state covers (equal, or server ahead). The client holds nothing the server
 * lacks, so it may record a server-acknowledged base for them.
 */

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

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

afterAll(async () => {
  await pool.end();
});

describe("vault channel — ready.covered", () => {
  let owner: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@covered.test");
    const org = (await createOrg(owner, "Covered Co", "covered-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });

  async function ready(manifest: Record<string, string>, mode?: "live-only") {
    const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    const token = await mintVaultToken({ userId: owner.userId, vaultId: vault });
    ws.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest, ...(mode ? { mode } : {}) })), false);
    const start = Date.now();
    while (!ws.sent.some((c) => c.t === "ready")) {
      if (Date.now() - start > 4000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 15));
    }
    return ws.sent.find((c) => c.t === "ready")!;
  }

  it("covers a stale and an equal client, not a client that is ahead", async () => {
    const stale = await seedNote(vault, null, "stale.md", owner.userId);
    const equal = await seedNote(vault, null, "equal.md", owner.userId);
    const ahead = await seedNote(vault, null, "ahead.md", owner.userId);

    const server = new Y.Doc();
    server.getText("content").insert(0, "server text");
    const serverUpdate = Y.encodeStateAsUpdate(server);
    for (const d of [stale, equal, ahead]) await appendUpdate(d, serverUpdate);

    const empty = new Y.Doc();
    const clientAhead = new Y.Doc();
    Y.applyUpdate(clientAhead, serverUpdate);
    clientAhead.getText("content").insert(0, "unpushed ");

    const frame = await ready({
      [stale]: b64(Y.encodeStateVector(empty)),
      [equal]: b64(Y.encodeStateVector(server)),
      [ahead]: b64(Y.encodeStateVector(clientAhead)),
    });
    expect(new Set(frame.covered as string[])).toEqual(new Set([stale, equal]));
    expect(frame.behind).toEqual([ahead]);
    expect(frame.coveredTruncated).toBeUndefined();
  });

  it("is omitted in live-only mode", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    const server = new Y.Doc();
    server.getText("content").insert(0, "x");
    await appendUpdate(doc, Y.encodeStateAsUpdate(server));
    const frame = await ready({ [doc]: b64(Y.encodeStateVector(server)) }, "live-only");
    expect(frame.covered).toBeUndefined();
  });

  it("never names a deleted (tombstoned) doc", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    const server = new Y.Doc();
    server.getText("content").insert(0, "x");
    await appendUpdate(doc, Y.encodeStateAsUpdate(server));
    await pool.query("UPDATE notes SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1", [doc]);
    const frame = await ready({ [doc]: b64(Y.encodeStateVector(server)) });
    expect(frame.covered).toBeUndefined();
    expect(frame.tombstones).toEqual([doc]);
  });
});
