// SPDX-License-Identifier: Apache-2.0
//
// Pre-shrink versions on a keyed vault (W3, zero data loss). Every write path
// that can shrink a note seals the `pre-shrink` text with the key the WRITE
// itself carried (connection, request or MCP call key), never the process
// cache: the cache is empty throughout these tests.
//
// The seed path (`expectEmpty`) is not here: it only ever writes into an empty
// doc, so it cannot shrink one.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { applyDocPush } from "../src/sync/doc-batch.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import { createVersionCapture, type VersionCapture } from "../src/versions/capture.js";
import { setShrinkHook } from "../src/versions/shrink-guard.js";
import { resolveText } from "../src/versions/texts.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

const PORT = 3992;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const BODY = "# Board minutes\n\n" + "A confidential paragraph that must survive a wipe. ".repeat(10);

function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, label = "condition") {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      if (await cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(() => void tick(), 25);
    };
    void tick();
  });
}

describe("pre-shrink versions on a keyed vault seal with the writer's key", () => {
  let server: Server<SyncContext>;
  let docWriter: ReturnType<typeof createDocWriter>;
  let capture: VersionCapture;
  let userId: string;
  let vaultId: string;
  let docId: string;
  let vk: Buffer;
  const crypto = (): DocCrypto => ({ vaultId, key: Buffer.from(vk), generation: 1 });
  let errors: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    server = createSyncServer(PORT);
    await server.listen();
    docWriter = createDocWriter(server);
  });
  afterAll(async () => {
    setShrinkHook(null);
    await server.destroy();
    vi.unstubAllEnvs();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDb();
    vaultKeyCache.clear();
    const org = await seedOrg("Shrink", `shrink-${Date.now()}`);
    userId = await seedUser(`shrink-${Date.now()}@keys.test`);
    await seedMember(org, userId, "owner");
    vaultId = await seedVault(org);
    docId = await seedNote(vaultId, null, "minutes.md", userId);
    vk = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      vaultId,
      makeVkCheck(vk, vaultId),
    ]);
    capture = createVersionCapture({ docWriter, idleMs: 60_000 });
    setShrinkHook((v, d, previousText, _user, c) => void capture.preShrink(v, d, previousText, c));
    errors = vi.spyOn(console, "error");
  });
  afterEach(() => {
    capture.stop();
    // Never the cache: nothing in these tests acquires a key.
    expect(vaultKeyCache.has(vaultId)).toBe(false);
    expect(
      errors.mock.calls.filter((c) => /pre-shrink|key_required/.test(String(c[0]) + String(c[1] ?? ""))),
    ).toEqual([]);
    errors.mockRestore();
  });

  async function preShrinkTexts(): Promise<string[]> {
    const { rows } = await pool.query<{ sha256: string; content: string | null; content_enc: Buffer | null }>(
      `SELECT v.sha256, t.content, t.content_enc FROM note_versions v
         JOIN note_texts t ON t.doc_id = v.doc_id AND t.sha256 = v.sha256
        WHERE v.doc_id = $1 AND v.cause = 'pre-shrink' ORDER BY v.id`,
      [docId],
    );
    return rows.map((r) => {
      // Sealed at rest: no plaintext column, ciphertext without the words.
      expect(r.content).toBe("");
      expect(r.content_enc).not.toBeNull();
      expect(r.content_enc!.includes(Buffer.from("confidential"))).toBe(false);
      return resolveText(r, { vaultId, docId, sha: r.sha256 }, crypto())!;
    });
  }

  async function connect(): Promise<{ provider: HocuspocusProvider; doc: Y.Doc }> {
    const jwt = await mintSyncToken({ docId, vaultId, readOnly: false, userId });
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: WS_URL,
      name: formatDocName(vaultId, docId),
      token: `${jwt}.${vk.toString("base64")}`,
      document: doc,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    await waitFor(() => provider.isSynced, 8000, "provider synced");
    return { provider, doc };
  }

  async function persisted(): Promise<boolean> {
    return (await docWriter.peekContent(vaultId, docId, crypto())) === BODY;
  }

  async function withLiveBody<T>(fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    const { provider, doc } = await connect();
    try {
      doc.getText("content").insert(0, BODY);
      await waitFor(persisted, 5000, "body persisted");
      return await fn(doc);
    } finally {
      provider.destroy();
      doc.destroy();
    }
  }

  it("live socket: the connection's key seals the pre-shrink text", async () => {
    await withLiveBody(async (doc) => {
      const t = doc.getText("content");
      t.delete(0, t.length);
      t.insert(0, "/");
      await waitFor(async () => (await preShrinkTexts()).length > 0, 5000, "pre-shrink row");
    });
    expect(await preShrinkTexts()).toEqual([BODY]);
  });

  it("MCP doc writer, live doc: the call's key seals the pre-shrink text", async () => {
    await withLiveBody(async () => {
      await docWriter.setContent(vaultId, docId, "gone", { userId, crypto: crypto() });
      await waitFor(async () => (await preShrinkTexts()).length > 0, 5000, "pre-shrink row");
    });
    expect(await preShrinkTexts()).toEqual([BODY]);
  });

  it("docs/batch, live doc: the request's key seals the pre-shrink text", async () => {
    await withLiveBody(async (doc) => {
      const client = new Y.Doc();
      Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
      const updates: Uint8Array[] = [];
      client.on("update", (u: Uint8Array) => updates.push(u));
      const t = client.getText("content");
      t.delete(0, t.length);
      const out = await applyDocPush(vaultId, { docId, update: Y.mergeUpdates(updates) }, { userId, crypto: crypto() });
      expect(out.outcome).toBe("applied");
      await waitFor(async () => (await preShrinkTexts()).length > 0, 5000, "pre-shrink row");
      client.destroy();
    });
    expect(await preShrinkTexts()).toEqual([BODY]);
  });

  it("MCP doc writer, detached doc: the call's key seals the pre-shrink text", async () => {
    await docWriter.setContent(vaultId, docId, BODY, { userId, crypto: crypto() });
    await docWriter.setContent(vaultId, docId, "gone", { userId, crypto: crypto() });
    await waitFor(async () => (await preShrinkTexts()).length > 0, 5000, "pre-shrink row");
    expect(await preShrinkTexts()).toEqual([BODY]);
  });

  it("docs/batch, detached doc: the request's key seals the pre-shrink text", async () => {
    const client = new Y.Doc();
    const updates: Uint8Array[] = [];
    client.on("update", (u: Uint8Array) => updates.push(u));
    client.getText("content").insert(0, BODY);
    expect(
      (await applyDocPush(vaultId, { docId, update: updates[0] }, { userId, crypto: crypto() })).outcome,
    ).toBe("applied");
    const t = client.getText("content");
    t.delete(0, t.length);
    expect(
      (await applyDocPush(vaultId, { docId, update: updates[1] }, { userId, crypto: crypto() })).outcome,
    ).toBe("applied");
    client.destroy();
    await waitFor(async () => (await preShrinkTexts()).length > 0, 5000, "pre-shrink row");
    expect(await preShrinkTexts()).toEqual([BODY]);
  });

  it("a keyless detached write to a keyed vault is refused: nothing applied, prior text intact", async () => {
    await docWriter.setContent(vaultId, docId, BODY, { userId, crypto: crypto() });
    await expect(docWriter.setContent(vaultId, docId, "gone", { userId })).rejects.toMatchObject({
      name: "KeyRequiredError",
    });
    expect(await docWriter.peekContent(vaultId, docId, crypto())).toBe(BODY);
    expect(await preShrinkTexts()).toEqual([]);
  });
});
