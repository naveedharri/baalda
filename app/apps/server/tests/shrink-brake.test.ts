import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { createSyncServer, disconnectUserInVault, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { applyDocPush, SHRINK_HELD_CODE } from "../src/sync/doc-batch.js";
import { loadDocState } from "../src/yjs/persistence.js";
import {
  isShrinkHeld,
  reportShrink,
  setShrinkBrakeHook,
  ShrinkBrake,
  shrinkBrake,
} from "../src/versions/shrink-guard.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { seedMember, seedNote, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Issue #252: a burst of updates that empty populated notes, from one user in
 * one vault, engages a brake that HOLDS that user's further content writes —
 * without refusing an op in a way that loops, and without touching the
 * client's own copy. Normal editing, including clearing one note, is unaffected.
 */

const PORT = 3994;
const URL = `ws://127.0.0.1:${PORT}`;
const BODY = "# Notes\n\n" + "A paragraph somebody wrote and wants to keep. ".repeat(12);

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

describe("ShrinkBrake (pure)", () => {
  it("engages on the Nth DISTINCT note inside the window, once", () => {
    let t = 0;
    const b = new ShrinkBrake(3, 60_000, 600_000, () => t);
    expect(b.record("u", "v", "a")).toBe(false);
    expect(b.record("u", "v", "a")).toBe(false); // same note twice is one note
    expect(b.record("u", "v", "b")).toBe(false);
    expect(b.isHeld("u", "v")).toBe(false);
    expect(b.record("u", "v", "c")).toBe(true);
    expect(b.isHeld("u", "v")).toBe(true);
    // Scoped per (user, vault).
    expect(b.isHeld("u", "other")).toBe(false);
    expect(b.isHeld("someone-else", "v")).toBe(false);
    // Already held: does not re-engage.
    expect(b.record("u", "v", "d")).toBe(false);
    // The hold lapses.
    t += 600_000;
    expect(b.isHeld("u", "v")).toBe(false);
  });

  it("forgets shrinks older than the window, and 0 disables it", () => {
    let t = 0;
    const b = new ShrinkBrake(3, 60_000, 600_000, () => t);
    b.record("u", "v", "a");
    b.record("u", "v", "b");
    t += 61_000;
    expect(b.record("u", "v", "c")).toBe(false);
    const off = new ShrinkBrake(0, 60_000, 600_000, () => t);
    for (const d of ["a", "b", "c", "d"]) expect(off.record("u", "v", d)).toBe(false);
    expect(off.isHeld("u", "v")).toBe(false);
  });

  it("does not count MCP tool writes", () => {
    shrinkBrake.configure({ threshold: 2, windowMs: 60_000, holdMs: 60_000 });
    try {
      reportShrink("v-mcp", "a", BODY, "", "u-mcp", "mcp");
      reportShrink("v-mcp", "b", BODY, "", "u-mcp", "mcp");
      expect(isShrinkHeld("u-mcp", "v-mcp")).toBe(false);
      // An ordinary client edit (no source) does count.
      reportShrink("v-mcp", "a", BODY, "", "u-mcp");
      reportShrink("v-mcp", "b", BODY, "", "u-mcp");
      expect(isShrinkHeld("u-mcp", "v-mcp")).toBe(true);
    } finally {
      shrinkBrake.configure({ threshold: 0 });
    }
  });
});

describe("shrink brake on the write paths", () => {
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
    shrinkBrake.configure({ threshold: 3, windowMs: 60_000, holdMs: 60_000 });
    setShrinkBrakeHook((vaultId, userId) => disconnectUserInVault(server, vaultId, userId));
  });
  afterEach(() => {
    setShrinkBrakeHook(null);
    shrinkBrake.configure({ threshold: 0 });
  });

  async function seed() {
    const user = await signUp("brake@t.com");
    const org = await seedOrg("Acme", "acme-brake");
    await seedMember(org, user.userId, "owner");
    const vaultId = await seedVault(org);
    await seedVaultGrant(org, "edit");
    const docs: string[] = [];
    for (let i = 0; i < 5; i++) docs.push(await seedNote(vaultId, null, `n${i}.md`, user.userId));
    return { user, vaultId, docs };
  }

  /** Full-state update for a doc holding `text`, and the delete-all on top of it. */
  function fill(text: string): { doc: Y.Doc; update: Uint8Array } {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, text);
    return { doc, update: Y.encodeStateAsUpdate(doc) };
  }
  function wipe(doc: Y.Doc): Uint8Array {
    const sv = Y.encodeStateVector(doc);
    const t = doc.getText("content");
    t.delete(0, t.length);
    return Y.encodeStateAsUpdate(doc, sv);
  }

  async function serverText(docId: string): Promise<string> {
    const state = await loadDocState(docId);
    const d = new Y.Doc();
    if (state) Y.applyUpdate(d, state);
    const s = d.getText("content").toString();
    d.destroy();
    return s;
  }

  it("detached path: after the threshold, further pushes are held (retryable error) and applied nothing", async () => {
    const { user, vaultId, docs } = await seed();
    const actor = { userId: user.userId };
    const locals = [];
    for (const docId of docs) {
      const { doc, update } = fill(BODY);
      locals.push(doc);
      expect((await applyDocPush(vaultId, { docId, update }, actor)).outcome).toBe("applied");
    }
    // Clearing ONE note is ordinary editing.
    expect((await applyDocPush(vaultId, { docId: docs[0], update: wipe(locals[0]) }, actor)).outcome).toBe("applied");
    expect(isShrinkHeld(user.userId, vaultId)).toBe(false);

    await applyDocPush(vaultId, { docId: docs[1], update: wipe(locals[1]) }, actor);
    await applyDocPush(vaultId, { docId: docs[2], update: wipe(locals[2]) }, actor);
    expect(isShrinkHeld(user.userId, vaultId)).toBe(true);

    const held = await applyDocPush(vaultId, { docId: docs[3], update: wipe(locals[3]) }, actor);
    expect(held).toMatchObject({ outcome: "error", code: SHRINK_HELD_CODE });
    // The fourth note kept its text on the server.
    expect(await serverText(docs[3])).toBe(BODY);
    // Another user in the same vault is not held.
    expect(isShrinkHeld("someone-else", vaultId)).toBe(false);
    for (const d of locals) d.destroy();
  });

  it("live path: the burst kicks the user's sockets and re-admits them read-only", async () => {
    const { user, vaultId, docs } = await seed();
    const providers: HocuspocusProvider[] = [];
    const ydocs: Y.Doc[] = [];
    try {
      for (const docId of docs.slice(0, 4)) {
        const token = await mintSyncToken({ docId, vaultId, readOnly: false, userId: user.userId });
        const doc = new Y.Doc();
        const provider = new HocuspocusProvider({
          url: URL,
          name: formatDocName(vaultId, docId),
          token,
          document: doc,
          WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        });
        providers.push(provider);
        ydocs.push(doc);
        await waitFor(() => provider.isSynced, 8000, "provider synced");
        doc.getText("content").insert(0, BODY);
      }
      await waitFor(
        () => docs.slice(0, 4).every((d) => server.hocuspocus.documents.get(formatDocName(vaultId, d))?.getText("content").length === BODY.length),
        8000,
        "bodies reached the server",
      );

      for (const doc of ydocs.slice(0, 3)) {
        const t = doc.getText("content");
        t.delete(0, t.length);
      }
      await waitFor(() => isShrinkHeld(user.userId, vaultId), 8000, "brake engaged");

      // Re-admitted read-only: wait for the fourth provider to reconnect and
      // sync, then its wipe must not reach the server.
      await waitFor(() => providers[3].isSynced, 8000, "provider re-synced");
      const t = ydocs[3].getText("content");
      t.delete(0, t.length);
      await new Promise((r) => setTimeout(r, 500));
      const live = server.hocuspocus.documents.get(formatDocName(vaultId, docs[3]));
      expect(live?.getText("content").toString()).toBe(BODY);
      // The client keeps its own op — nothing on the device was rewritten.
      expect(ydocs[3].getText("content").toString()).toBe("");
    } finally {
      for (const p of providers) p.destroy();
      for (const d of ydocs) d.destroy();
    }
  });
});
