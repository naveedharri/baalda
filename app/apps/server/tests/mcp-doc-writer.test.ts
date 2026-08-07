import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { loadDocState } from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";

/**
 * The MCP doc writer's DETACHED path — the one taken when no client has the
 * note open, which is the normal case for an assistant writing into a vault.
 *
 * It deliberately never touches Hocuspocus (there is no live document to
 * touch), and Hocuspocus's `onChange` is what normally fans an update out to
 * background subscribers. So this path has to publish for itself. When it
 * didn't, an MCP edit was persisted perfectly and announced to nobody: every
 * running app kept the stale text on disk until its next full reconcile, i.e.
 * until someone restarted it.
 *
 * The live path is covered end to end by the sync suites; what needs pinning
 * here is that the detached one both persists AND announces.
 */

interface Published {
  vaultId: string;
  docId: string;
  update: Uint8Array;
}

/** A sync server with no live documents, which forces the detached path. */
function serverWithNoLiveDocs(): Server<SyncContext> {
  return { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
}

/** Read a doc's `content` text back out of the persisted CRDT state. */
async function persistedText(docId: string): Promise<string> {
  const state = await loadDocState(docId);
  if (!state) return "";
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getText("content").toString();
  } finally {
    doc.destroy();
  }
}

describe("MCP doc writer (no client connected)", () => {
  let published: Published[];

  beforeEach(async () => {
    await resetDb();
    published = [];
  });
  afterAll(async () => {
    await pool.end();
  });

  const writerThatRecords = () =>
    createDocWriter(serverWithNoLiveDocs(), (vaultId, docId, update) =>
      published.push({ vaultId, docId, update }),
    );

  it("publishes the update it just persisted", async () => {
    const writer = writerThatRecords();
    await writer.setContent("vault-1", "doc-1", "hello world");

    expect(await persistedText("doc-1")).toBe("hello world");
    expect(published).toHaveLength(1);
    expect(published[0].vaultId).toBe("vault-1");
    expect(published[0].docId).toBe("doc-1");

    // The published bytes must be the real update, not a placeholder — a
    // subscriber applies them directly to its own copy of the doc.
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, published[0].update);
    expect(mirror.getText("content").toString()).toBe("hello world");
    mirror.destroy();
  });

  it("publishes appends too", async () => {
    const writer = writerThatRecords();
    await writer.setContent("vault-1", "doc-2", "first");
    await writer.appendContent("vault-1", "doc-2", " second");

    expect(await persistedText("doc-2")).toBe("first second");
    expect(published).toHaveLength(2);

    // Replaying both updates in order reconstructs the note, which is exactly
    // what a background subscriber does.
    const mirror = new Y.Doc();
    for (const p of published) Y.applyUpdate(mirror, p.update);
    expect(mirror.getText("content").toString()).toBe("first second");
    mirror.destroy();
  });

  it("announces a rewrite even when the text is unchanged", async () => {
    // `setContent` is a wholesale replace — delete the whole Y.Text, insert the
    // new one — so re-setting identical content is still a real CRDT change and
    // is published as one. Worth pinning because it's easy to assume otherwise:
    // the DOCUMENT is unchanged, but the doc's history isn't, and a subscriber
    // that skipped this update would diverge from the server.
    const writer = writerThatRecords();
    await writer.setContent("vault-1", "doc-3", "same");
    published = [];
    await writer.setContent("vault-1", "doc-3", "same");

    expect(published).toHaveLength(1);
    expect(await persistedText("doc-3")).toBe("same");
  });

  it("still persists when publishing throws", async () => {
    // Delivery is best-effort; the write is already durable by then. Losing an
    // edit because a socket fan-out failed would be a far worse trade.
    const writer = createDocWriter(serverWithNoLiveDocs(), () => {
      throw new Error("channel down");
    });

    await expect(writer.setContent("vault-1", "doc-4", "survives")).resolves.toBeUndefined();
    expect(await persistedText("doc-4")).toBe("survives");
  });

  it("still persists when publishing REJECTS, and leaves no unhandled rejection", async () => {
    // The failure that actually happens. The real publisher fans out over
    // pub/sub and returns a promise, so a Redis blip is a rejection, not a
    // throw — and an unhandled rejection is fatal on Node 22, meaning one
    // flaky publish would take the whole server down with it.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const writer = createDocWriter(serverWithNoLiveDocs(), () =>
        Promise.reject(new Error("redis down")),
      );
      await expect(writer.setContent("vault-1", "doc-4b", "survives")).resolves.toBeUndefined();
      expect(await persistedText("doc-4b")).toBe("survives");
      // Give the microtask queue a turn so a stray rejection would have surfaced.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("works without a publisher at all", async () => {
    // The parameter is optional so existing callers (and tests) keep working.
    const writer = createDocWriter(serverWithNoLiveDocs());
    await expect(writer.setContent("vault-1", "doc-5", "ok")).resolves.toBeUndefined();
    expect(await persistedText("doc-5")).toBe("ok");
  });

  it("reads back what it wrote", async () => {
    const writer = writerThatRecords();
    await writer.setContent("vault-1", "doc-6", "round trip");
    expect(await writer.readContent("vault-1", "doc-6")).toBe("round trip");
  });
});
