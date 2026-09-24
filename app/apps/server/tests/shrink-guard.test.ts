import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { applyDetached } from "../src/sync/doc-batch.js";
import { createVersionCapture } from "../src/versions/capture.js";
import { isSharpShrink, setShrinkHook } from "../src/versions/shrink-guard.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedVault } from "./helpers/seed.js";
import { memoryDocWriter } from "./helpers/app.js";

/**
 * Issue #200: one update that wipes most of a note keeps the text it replaced
 * as a `pre-shrink` version, on the live (Hocuspocus) path and the detached
 * (batch / doc-writer) path alike.
 */

const PORT = 3993;
const URL = `ws://127.0.0.1:${PORT}`;
const BODY = "# Meeting notes\n\n" + "A paragraph somebody wrote and wants to keep. ".repeat(12);

type Shrink = { vaultId: string; docId: string; previousText: string; userId: string | null };
let shrinks: Shrink[] = [];

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

describe("isSharpShrink", () => {
  it("fires when one update leaves a fifth or less of a real note", () => {
    expect(isSharpShrink(BODY, "")).toBe(true);
    expect(isSharpShrink(BODY, "---\ntitle: x\n---\n#/")).toBe(true);
    expect(isSharpShrink(BODY, BODY.slice(0, Math.floor(BODY.length * 0.15)))).toBe(true);
  });

  it("ignores ordinary edits and tiny notes", () => {
    expect(isSharpShrink(BODY, BODY.slice(0, BODY.length - 40))).toBe(false);
    expect(isSharpShrink(BODY, BODY.slice(0, Math.floor(BODY.length * 0.5)))).toBe(false);
    expect(isSharpShrink("short note", "")).toBe(false);
    expect(isSharpShrink("", BODY)).toBe(false);
  });
});

describe("sharp-shrink reporting", () => {
  let server: Server<SyncContext>;

  beforeAll(async () => {
    server = createSyncServer(PORT);
    await server.listen();
  });
  afterAll(async () => {
    await server.destroy();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDb();
    shrinks = [];
    setShrinkHook((vaultId, docId, previousText, userId) =>
      shrinks.push({ vaultId, docId, previousText, userId }),
    );
  });
  afterEach(() => setShrinkHook(null));

  it("live path: a client deleting almost the whole note is reported with the prior text", async () => {
    const vaultId = "vault-shrink-live";
    const docId = "shrink-live";
    const token = await mintSyncToken({ docId, vaultId, readOnly: false });
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: URL,
      name: formatDocName(vaultId, docId),
      token,
      document: doc,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    try {
      await waitFor(() => provider.isSynced, 8000, "provider synced");
      const text = doc.getText("content");
      text.insert(0, BODY);
      // A few ordinary edits: none of these is a shrink.
      text.delete(text.length - 10, 10);
      text.insert(text.length, " more");
      await new Promise((r) => setTimeout(r, 300));
      expect(shrinks).toEqual([]);

      const before = text.toString();
      text.delete(0, text.length);
      text.insert(0, "/");
      await waitFor(() => shrinks.length > 0, 4000, "shrink reported");
      expect(shrinks[0]).toMatchObject({ vaultId, docId, previousText: before });
    } finally {
      provider.destroy();
      doc.destroy();
    }
  });

  it("detached path: a batch/doc-writer wipe records a pre-shrink version of the old text", async () => {
    const user = await signUp("shrink@t.com");
    const org = await seedOrg("Acme", "acme-shrink");
    await seedMember(org, user.userId, "owner");
    const vaultId = await seedVault(org);
    const docId = await seedNote(vaultId, null, "n.md", user.userId);

    const capture = createVersionCapture({ docWriter: memoryDocWriter(), idleMs: 60_000 });
    const pending: Promise<void>[] = [];
    setShrinkHook((v, d, previousText) => {
      pending.push(capture.preShrink(v, d, previousText));
    });
    try {
      const actor = { userId: user.userId };
      await applyDetached(vaultId, docId, (d) => d.getText("content").insert(0, BODY), actor);
      capture.touch(vaultId, docId, user.userId);
      await applyDetached(vaultId, docId, (d) => {
        const t = d.getText("content");
        t.delete(0, t.length);
      }, actor);
      await Promise.all(pending);

      const { rows } = await pool.query<{ content: string; cause: string; author_id: string | null }>(
        "SELECT content, cause, author_id FROM note_versions WHERE doc_id = $1 ORDER BY id",
        [docId],
      );
      expect(rows).toEqual([{ content: BODY, cause: "pre-shrink", author_id: user.userId }]);

      // Idempotent: the same prior text is not stored twice.
      await capture.preShrink(vaultId, docId, BODY);
      const { rows: again } = await pool.query("SELECT 1 FROM note_versions WHERE doc_id = $1", [docId]);
      expect(again).toHaveLength(1);
    } finally {
      capture.stop();
    }
  });
});
