import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createApp } from "../src/http/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { CLOSE_NOTE_TOO_LARGE } from "../src/sync/hocuspocus.js";
import { appendUpdate, docStoredBytes, loadDocState, resetDocCrdt } from "../src/yjs/persistence.js";
import { recordingAppDeps, type RecordingAppDeps } from "./helpers/app.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedShare, seedVault } from "./helpers/seed.js";

/**
 * Repairing a doc that has grown past `MAX_NOTE_MB`.
 *
 * Such a doc is stuck in a way nothing else can undo: `beforeHandleMessage`
 * refuses it before a single update is applied, so no client can edit it back
 * down, and its bulk is edit HISTORY rather than text, so compaction cannot
 * shrink it either. A production vault had four (10–17 MB each, behind 0-byte
 * files), and each one cost a rejected socket on every reconnect of every
 * member — about one a second.
 */

let rec: RecordingAppDeps;
let app: ReturnType<typeof createApp>;

function api(user: TestUser | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = `Bearer ${user.token}`;
  return app.fetch(new Request(`http://local${path}`, { ...init, headers }));
}

/** A doc carrying `chars` of text, persisted the way a client's updates arrive. */
async function seedDocContent(docId: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  await appendUpdate(docId, Buffer.from(Y.encodeStateAsUpdate(doc)));
  doc.destroy();
}

describe("oversized-doc repair", () => {
  beforeEach(async () => {
    await resetDb();
    rec = recordingAppDeps();
    app = createApp(rec.deps);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("pins the close code the desktop client keys its terminal state on", () => {
    // Mirrored as `CLOSE_NOTE_TOO_LARGE` in
    // apps/desktop/src/lib/sync/syncManager.ts. Separate packages, no shared
    // module — this literal is the only thing holding them in lockstep, and a
    // drift silently restores the infinite reconnect loop.
    expect(CLOSE_NOTE_TOO_LARGE).toBe(4413);
  });

  it("resets a doc's history and re-seeds it from the supplied text", async () => {
    const user = await signUp("reset@t.com");
    const org = await seedOrg("Acme", "acme-r1");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "fat.md", user.userId);

    await seedDocContent(docId, "x".repeat(200_000));
    const before = await docStoredBytes(docId);
    expect(before).toBeGreaterThan(100_000);

    const res = await api(user, `/api/notes/${docId}/reset-crdt`, {
      method: "POST",
      body: JSON.stringify({ content: "# Recovered\n" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bytesBefore: number; bytesAfter: number };
    expect(body.bytesBefore).toBe(before);
    expect(body.bytesAfter).toBeLessThan(1_000);

    // The text survives, the history does not — that is the whole trade.
    const state = await loadDocState(docId);
    const doc = new Y.Doc();
    if (state) Y.applyUpdate(doc, state);
    expect(doc.getText("content").toString()).toBe("# Recovered\n");
    expect(await docStoredBytes(docId)).toBeLessThan(1_000);
  });

  it("EVICTS the doc, not merely disconnecting it", async () => {
    // `disconnectDoc` closes sockets but leaves Hocuspocus holding the loaded
    // Y.Doc, which it would then serve to the next client — re-materialising
    // the exact state the reset just deleted.
    const user = await signUp("evict@t.com");
    const org = await seedOrg("Acme", "acme-r2");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    await seedDocContent(docId, "hello");

    const res = await api(user, `/api/notes/${docId}/reset-crdt`, {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(rec.evicted).toEqual([{ vaultId: vault, docId }]);
  });

  it("refuses a replacement that is itself over the cap", async () => {
    // Otherwise the repair hands back a doc stuck in exactly the same way.
    const user = await signUp("big@t.com");
    const org = await seedOrg("Acme", "acme-r3");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);

    const res = await api(user, `/api/notes/${docId}/reset-crdt`, {
      method: "POST",
      body: JSON.stringify({ content: "z".repeat(config.maxNoteMb * 1024 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
  });

  it("is gated by the same per-doc ACL as every other write", async () => {
    const owner = await signUp("owner-r@t.com");
    const viewer = await signUp("viewer-r@t.com");
    const stranger = await signUp("stranger-r@t.com");
    const org = await seedOrg("Acme", "acme-r4");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, viewer.userId, "member");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    await seedDocContent(docId, "secret");
    await seedShare(org, "file", docId, viewer.userId, "view");

    // A view grant may not reset history...
    const asViewer = await api(viewer, `/api/notes/${docId}/reset-crdt`, {
      method: "POST",
      body: JSON.stringify({ content: "" }),
    });
    expect(asViewer.status).toBe(403);
    // ...nor may a non-member, and size is an edit-level fact too.
    expect((await api(stranger, `/api/notes/${docId}/crdt-size`)).status).toBe(403);
    expect((await api(null, `/api/notes/${docId}/crdt-size`)).status).toBe(401);

    // The content is untouched by the refusals.
    expect(await docStoredBytes(docId)).toBeGreaterThan(0);
  });

  it("reports whether a doc is over the cap", async () => {
    const user = await signUp("size@t.com");
    const org = await seedOrg("Acme", "acme-r5");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    await seedDocContent(docId, "small");

    const res = await api(user, `/api/notes/${docId}/crdt-size`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bytes: number; capBytes: number; overCap: boolean };
    expect(body.overCap).toBe(false);
    expect(body.capBytes).toBe(config.maxNoteMb * 1024 * 1024);
    expect(body.bytes).toBeGreaterThan(0);
  });

  it("resetDocCrdt drops the update log, not just the snapshot", async () => {
    // Compaction merges updates INTO a snapshot and keeps every tombstone,
    // which is why a 44 MB doc stays 44 MB however often it compacts. Discarding
    // is the point here, so both halves must go.
    const docId = "00000000-0000-4000-8000-00000000dead";
    await seedDocContent(docId, "a".repeat(50_000));
    await seedDocContent(docId, "b".repeat(50_000));
    expect(await docStoredBytes(docId)).toBeGreaterThan(50_000);

    await resetDocCrdt(docId, "tiny");

    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM doc_updates WHERE doc_id = $1",
      [docId],
    );
    expect(Number(rows[0].n)).toBe(0);
    expect(await docStoredBytes(docId)).toBeLessThan(1_000);
  });
});
