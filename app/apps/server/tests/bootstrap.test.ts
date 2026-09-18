import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedFolder,
  seedMember,
  seedNote,
  seedShare,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";
import { appendUpdate, compact } from "../src/yjs/persistence.js";
import { decodeBootstrapPage } from "../src/sync/bulk-protocol.js";
import { createBootstrapSession, loadBootstrapPage } from "../src/yjs/bootstrap.js";
import { config } from "../src/config.js";
import type { BootstrapSession } from "../src/http/routes/bulk-types.js";

/**
 * Whole-vault bootstrap: session creation, resumable pages, and the ACL.
 *
 * The session is what makes "exactly once across pages" provable — the doc list
 * is a materialised row per doc, not a query that could return a different set
 * on page 7 than it did on page 1. Most of this file is spent proving that
 * property holds under resume, under a byte budget, and under the same
 * permission rules `GET /api/notes` uses.
 */

const app = createApp(testAppDeps());

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Give a doc real CRDT state, the way a client would. */
async function writeDoc(docId: string, text: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

function textOf(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const out = doc.getText("content").toString();
  doc.destroy();
  return out;
}

/** Drain a whole session through the HTTP route, honouring the cursor header. */
async function drain(user: TestUser, vault: string, sessionId: string, maxBytes?: number) {
  const seen = new Map<string, { relPath: string; text: string }>();
  const order: string[] = [];
  let cursor: string | null = "0";
  let pages = 0;
  while (cursor !== null) {
    const qs = new URLSearchParams({ cursor });
    if (maxBytes) qs.set("maxBytes", String(maxBytes));
    const res = await req(user, "GET", `/api/vaults/${vault}/bootstrap/${sessionId}?${qs}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.baalda.bootstrap");
    pages++;
    const docs = decodeBootstrapPage(gunzipSync(Buffer.from(await res.arrayBuffer())));
    expect(Number(res.headers.get("X-Baalda-Docs"))).toBe(docs.length);
    for (const d of docs) {
      order.push(d.docId);
      seen.set(d.docId, { relPath: d.relPath, text: textOf(d.update) });
    }
    cursor = res.headers.get("X-Baalda-Cursor");
  }
  return { seen, order, pages };
}

describe("bootstrap download", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@boot.test");
    org = (await createOrg(owner, "Boot Co", "boot-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  const startSession = async (user: TestUser, have: string[] = []) => {
    const res = await req(user, "POST", `/api/vaults/${vault}/bootstrap`, { have });
    expect(res.status).toBe(200);
    return (await res.json()) as BootstrapSession;
  };

  it("splits the vault into a download set (bytes>0) and an upload set (emptyDocs)", async () => {
    const filled = await seedNote(vault, null, "filled.md", owner.userId);
    const alsoFilled = await seedNote(vault, null, "also.md", owner.userId);
    const empty = await seedNote(vault, null, "empty.md", owner.userId);
    await writeDoc(filled, "one");
    await writeDoc(alsoFilled, "two");

    const session = await startSession(owner);
    expect(session.docs).toBe(2);
    expect(session.bytes).toBeGreaterThan(0);
    // The empty one is the UPLOAD set — the client seeds it from its own disk.
    // This list is what lets a 5,000-note enable heal in one pass rather than
    // three `ready.empty` rounds at the channel's hardcoded 2,000 cap.
    expect(session.emptyDocs).toEqual([empty]);
    expect(session.emptyTruncated).toBe(false);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const { seen } = await drain(owner, vault, session.sessionId);
    expect(seen.get(filled)).toEqual({ relPath: "filled.md", text: "one" });
    expect(seen.get(alsoFilled)).toEqual({ relPath: "also.md", text: "two" });
    expect(seen.has(empty)).toBe(false);
  });

  it("delivers every doc exactly once, in path order, across many pages", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = await seedNote(vault, null, `n${String(i).padStart(2, "0")}.md`, owner.userId);
      await writeDoc(id, `body ${i} ${"x".repeat(200)}`);
      ids.push(id);
    }
    const session = await startSession(owner);
    expect(session.docs).toBe(40);
    // A tiny budget forces many pages; the packing rule must still ship every doc.
    const { seen, order, pages } = await drain(owner, vault, session.sessionId, 1024);
    expect(pages).toBeGreaterThan(1);
    expect(order.length).toBe(40); // exactly once — no repeats across the cut
    expect(new Set(order).size).toBe(40);
    expect([...seen.keys()].sort()).toEqual([...ids].sort());
    // Path order, so a folder's notes land together and the tree fills top-down.
    expect(order.map((id) => seen.get(id)!.relPath)).toEqual(
      [...order.map((id) => seen.get(id)!.relPath)].sort(),
    );
  });

  it("resuming from a cursor is byte-identical to draining in one go", async () => {
    for (let i = 0; i < 12; i++) {
      const id = await seedNote(vault, null, `r${i}.md`, owner.userId);
      await writeDoc(id, `text ${i}`);
    }
    const oneShot = await drain(owner, vault, (await startSession(owner)).sessionId);

    // Now the same session, abandoned after the first page and picked up again.
    const session = await startSession(owner);
    const first = await req(owner, "GET", `/api/vaults/${vault}/bootstrap/${session.sessionId}?cursor=0&maxBytes=200`);
    const firstDocs = decodeBootstrapPage(gunzipSync(Buffer.from(await first.arrayBuffer())));
    const cursor = first.headers.get("X-Baalda-Cursor");
    expect(cursor).not.toBeNull();
    const rest = await drain(owner, vault, session.sessionId, 200);
    // `drain` starts at 0 again, so the union — not the concatenation — is what
    // must match; a resume that dropped or doubled a doc shows up right here.
    const merged = new Map([...rest.seen]);
    for (const d of firstDocs) merged.set(d.docId, { relPath: d.relPath, text: textOf(d.update) });
    expect([...merged.entries()].sort()).toEqual([...oneShot.seen.entries()].sort());
  });

  it("`have` subtracts docs the client already holds", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    await writeDoc(a, "A");
    await writeDoc(b, "B");
    const session = await startSession(owner, [a]);
    expect(session.docs).toBe(1);
    const { seen } = await drain(owner, vault, session.sessionId);
    expect([...seen.keys()]).toEqual([b]);
  });

  it("carries only the docs the caller may READ", async () => {
    const member = await signUp("member@boot.test");
    await seedMember(org, member.userId, "member");
    const shared = await seedFolder(vault, null, "Shared", "Shared");
    const secret = await seedFolder(vault, null, "Secret", "Secret");
    const visible = await seedNote(vault, shared, "Shared/v.md", owner.userId);
    const hidden = await seedNote(vault, secret, "Secret/h.md", owner.userId);
    await writeDoc(visible, "yours");
    await writeDoc(hidden, "not yours");
    // Private vault, one folder shared by name.
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedShare(org, "folder", shared, member.userId, "view");

    const session = await startSession(member);
    expect(session.docs).toBe(1);
    const { seen } = await drain(member, vault, session.sessionId);
    expect([...seen.keys()]).toEqual([visible]);

    // The owner still sees both through authorship.
    const ownerSession = await startSession(owner);
    expect(ownerSession.docs).toBe(2);
  });

  it("a doc larger than the byte budget ships ALONE rather than never", async () => {
    const small = await seedNote(vault, null, "a-small.md", owner.userId);
    const big = await seedNote(vault, null, "b-big.md", owner.userId);
    await writeDoc(small, "tiny");
    await writeDoc(big, "L".repeat(50_000));
    const session = await startSession(owner);
    const { seen, order, pages } = await drain(owner, vault, session.sessionId, 1000);
    expect(pages).toBe(2);
    expect(order).toEqual([small, big]);
    expect(seen.get(big)!.text.length).toBe(50_000);
  });

  it("serves a compacted doc and its post-compaction tail as one merged update", async () => {
    const id = await seedNote(vault, null, "c.md", owner.userId);
    await writeDoc(id, "first ");
    await compact(id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from((await pool.query("SELECT snapshot FROM doc_snapshots WHERE doc_id = $1", [id])).rows[0].snapshot));
    doc.getText("content").insert(doc.getText("content").length, "second");
    const tail = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));
    doc.destroy();
    await appendUpdate(id, tail);

    const { seen } = await drain(owner, vault, (await startSession(owner)).sessionId);
    expect(seen.get(id)!.text).toBe("first second");
  });

  it("410s an unknown or expired session, and 404/403s the vault gate", async () => {
    const gone = await req(owner, "GET", `/api/vaults/${vault}/bootstrap/${randomUUID()}?cursor=0`);
    expect(gone.status).toBe(410);
    expect((await gone.json()).code).toBe("session_expired");

    const session = await startSession(owner);
    await pool.query("UPDATE bootstrap_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      session.sessionId,
    ]);
    const expired = await req(owner, "GET", `/api/vaults/${vault}/bootstrap/${session.sessionId}?cursor=0`);
    expect(expired.status).toBe(410);

    const stranger = await signUp("stranger@boot.test");
    const forbidden = await req(stranger, "POST", `/api/vaults/${vault}/bootstrap`, {});
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe("not_a_member");
    const unknown = await req(owner, "POST", `/api/vaults/${randomUUID()}/bootstrap`, {});
    expect(unknown.status).toBe(404);
  });

  it("another member cannot read someone else's session", async () => {
    const member = await signUp("other@boot.test");
    await seedMember(org, member.userId, "member");
    const id = await seedNote(vault, null, "a.md", owner.userId);
    await writeDoc(id, "A");
    const session = await startSession(owner);
    const res = await req(member, "GET", `/api/vaults/${vault}/bootstrap/${session.sessionId}?cursor=0`);
    // Indistinguishable from "no such session", deliberately: a different answer
    // would let a member probe for other people's session ids.
    expect(res.status).toBe(410);
  });

  it("answers 503 bootstrap_busy with a Retry-After when the gate is full", async () => {
    const id = await seedNote(vault, null, "a.md", owner.userId);
    await writeDoc(id, "A");
    const session = await startSession(owner);
    // The gate is a process-wide counter; squeezing it to zero is the
    // deterministic way to exercise the refusal a real overload produces.
    const original = config.bootstrapConcurrency;
    Object.defineProperty(config, "bootstrapConcurrency", { value: 0, configurable: true });
    try {
      const res = await req(owner, "GET", `/api/vaults/${vault}/bootstrap/${session.sessionId}?cursor=0`);
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect((await res.json()).code).toBe("bootstrap_busy");
    } finally {
      Object.defineProperty(config, "bootstrapConcurrency", { value: original, configurable: true });
    }
    // …and the session is untouched: the next call succeeds.
    const { seen } = await drain(owner, vault, session.sessionId);
    expect(seen.size).toBe(1);
  });

  it("sweeps expired sessions when a new one is created", async () => {
    const stale = await startSession(owner);
    await pool.query("UPDATE bootstrap_sessions SET expires_at = now() - interval '1 day' WHERE id = $1", [
      stale.sessionId,
    ]);
    await startSession(owner);
    const { rows } = await pool.query("SELECT id FROM bootstrap_sessions WHERE id = $1", [stale.sessionId]);
    expect(rows).toEqual([]);
  });

  it("a page costs a bounded number of queries, whatever the doc count", async () => {
    for (let i = 0; i < 60; i++) {
      const id = await seedNote(vault, null, `q${String(i).padStart(2, "0")}.md`, owner.userId);
      await writeDoc(id, `q ${i}`);
    }
    const session = await createBootstrapSession({ vaultId: vault, userId: owner.userId });
    const sql: string[] = [];
    const page = await loadBootstrapPage({
      sessionId: session.sessionId,
      vaultId: vault,
      userId: owner.userId,
      cursor: 0,
      onQuery: (s) => sql.push(s),
    });
    expect(page.docs).toBe(60);
    // Session check + keyset read + snapshots + updates + paths. Constant — the
    // moment this grows with the doc count, the page loader has gone per-doc.
    expect(sql.length).toBe(5);
  });
});
