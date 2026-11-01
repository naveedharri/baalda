// SPDX-License-Identifier: Apache-2.0
//
// Red team (W3): a per-doc socket opened BEFORE its vault was keyed keeps
// typing after `keys/init`. Its doc was loaded without a key, so every later
// append is refused (key_required) while the update already sits in the
// in-memory doc and was broadcast. Without a reset, a keyed teammate attaching
// to that loaded doc would see text the database never stored, and the author
// would believe it was saved. The server must drop the stale doc so every
// client re-syncs against storage and re-pushes what storage lacks.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { loadDocState } from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

const PORT = 3987;
const WS_URL = `ws://127.0.0.1:${PORT}`;
let server: Server<SyncContext>;

function provider(vaultId: string, docId: string, token: string, doc: Y.Doc) {
  const events = { synced: false, closed: 0, authFailed: "" };
  const p = new HocuspocusProvider({
    url: WS_URL,
    name: formatDocName(vaultId, docId),
    token,
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    onSynced: () => (events.synced = true),
    onClose: () => (events.closed += 1),
    onAuthenticationFailed: ({ reason }) => (events.authFailed = reason),
  });
  return { p, events };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function textOf(state: Uint8Array | null): string {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, state);
  const t = d.getText("content").toString();
  d.destroy();
  return t;
}

describe("live socket across keys/init", () => {
  beforeAll(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    server = createSyncServer(PORT);
    await server.listen();
  });
  afterAll(async () => {
    await server.destroy();
    vi.unstubAllEnvs();
    await pool.end();
  });

  it("an edit refused after keying is not left only in memory: the doc is reset and the author's re-sync stores it sealed", async () => {
    const org = await seedOrg("Live", `live-${Date.now()}`);
    const user = await seedUser("live@keys.test");
    await seedMember(org, user, "owner");
    const vaultId = await seedVault(org);
    const docId = await seedNote(vaultId, null, "n.md", user);
    const jwt = await mintSyncToken({ docId, vaultId, readOnly: false, userId: user });

    // 1. Unkeyed vault: the author connects and types.
    const authorDoc = new Y.Doc();
    const a = provider(vaultId, docId, jwt, authorDoc);
    expect(await until(() => a.events.synced)).toBe(true);
    authorDoc.getText("content").insert(0, "before keying\n");
    expect(await until(async () => textOf(await loadDocState(docId, pool)).includes("before keying"))).toBe(true);

    // 2. The vault is keyed (what keys/init commits) while the socket stays open.
    const vk = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(vk, vaultId)]);
    await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)", [vaultId]);
    const crypto = { vaultId, key: vk, generation: 1 };

    // 3. The author keeps typing on the unkeyed socket.
    const closesBefore = a.events.closed;
    authorDoc.getText("content").insert(authorDoc.getText("content").length, "typed during conversion\n");
    // The server must not keep that edit only in memory: it drops the socket.
    expect(await until(() => a.events.closed > closesBefore)).toBe(true);
    a.p.destroy();

    // 4. A keyed teammate attaching now must not see unstored text as if saved:
    // it gets exactly what storage has (the doc was reset).
    const mateDoc = new Y.Doc();
    const b = provider(vaultId, docId, `${jwt}.${vk.toString("base64")}`, mateDoc);
    expect(await until(() => b.events.synced)).toBe(true);
    expect(mateDoc.getText("content").toString()).toBe(textOf(await loadDocState(docId, pool, crypto)));

    // 5. The author's device reconnects with the key (its key_required path):
    // its sync re-sends the refused edit, which is now stored sealed.
    const a2 = provider(vaultId, docId, `${jwt}.${vk.toString("base64")}`, authorDoc);
    expect(await until(() => a2.events.synced)).toBe(true);
    expect(
      await until(async () => textOf(await loadDocState(docId, pool, crypto)).includes("typed during conversion")),
    ).toBe(true);
    expect(await until(() => mateDoc.getText("content").toString().includes("typed during conversion"))).toBe(true);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1 AND update_enc IS NULL AND id > (SELECT min(id) FROM doc_updates WHERE doc_id = $1)",
      [docId],
    );
    // Nothing new was written as plaintext after keying.
    expect(rows[0].n).toBe(0);
    a2.p.destroy();
    b.p.destroy();
  });
});
