// SPDX-License-Identifier: Apache-2.0
//
// Live Hocuspocus (W3): a keyed vault's per-doc socket without its key is
// refused with the literal reason `key_required` (a generic failure says
// `permission-denied`), and the right key syncs and stores sealed bytes.
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
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

const PORT = 3994;
const WS_URL = `ws://127.0.0.1:${PORT}`;
let server: Server<SyncContext>;

function connect(vaultId: string, docId: string, token: string, text?: string) {
  return new Promise<{ outcome: "synced" | "failed"; reason?: string; provider: HocuspocusProvider }>((resolve) => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: WS_URL,
      name: formatDocName(vaultId, docId),
      token,
      document: doc,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      onAuthenticationFailed: ({ reason }) => resolve({ outcome: "failed", reason, provider }),
      onSynced: () => {
        if (text) doc.getText("content").insert(0, text);
        resolve({ outcome: "synced", provider });
      },
    });
    setTimeout(() => resolve({ outcome: "failed", reason: "timeout", provider }), 8000);
  });
}

describe("per-doc socket on a keyed vault", () => {
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

  it("refuses with reason key_required, and syncs sealed with the key", async () => {
    const org = await seedOrg("Hp", `hp-${Date.now()}`);
    const user = await seedUser("hp@keys.test");
    await seedMember(org, user, "owner");
    const vaultId = await seedVault(org);
    const docId = await seedNote(vaultId, null, "n.md", user);
    const vk = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(vk, vaultId)]);
    const jwt = await mintSyncToken({ docId, vaultId, readOnly: false, userId: user });

    const noKey = await connect(vaultId, docId, jwt);
    noKey.provider.destroy();
    expect(noKey).toMatchObject({ outcome: "failed", reason: "key_required" });

    const wrong = await connect(vaultId, docId, `${jwt}.${randomBytes(32).toString("base64")}`);
    wrong.provider.destroy();
    expect(wrong).toMatchObject({ outcome: "failed", reason: "key_required" });

    const ok = await connect(vaultId, docId, `${jwt}.${vk.toString("base64")}`, "sealed over the wire");
    expect(ok.outcome).toBe("synced");
    const deadline = Date.now() + 5000;
    let rows: Array<{ update: Buffer | null; update_enc: Buffer | null }> = [];
    while (Date.now() < deadline) {
      rows = (await pool.query("SELECT update, update_enc FROM doc_updates WHERE doc_id = $1", [docId])).rows;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    ok.provider.destroy();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.update).toBeNull();
      expect(r.update_enc?.includes(Buffer.from("sealed over"))).toBe(false);
    }
  });
});
