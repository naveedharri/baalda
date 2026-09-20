import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedFolder,
  seedLock,
  seedMember,
  seedNote,
  seedShare,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import { setDocBatchRuntime } from "../src/sync/doc-batch.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { loadDocState } from "../src/yjs/persistence.js";
import { config } from "../src/config.js";
import { flushIndexQueue } from "../src/index/indexer.js";
import type { DocPushResult } from "../src/http/routes/bulk-types.js";

/**
 * `POST /api/vaults/:id/docs/batch` — the content push.
 *
 * Three things are being protected here, in order of how badly they fail:
 *  1. `expectEmpty` — a client that seeded an update from its local FILE because
 *     the server said the doc was empty must NOT be allowed to paste it over
 *     text that arrived in the meantime. Re-checked under the per-doc lock.
 *  2. Per-item permission is the real `effectivePermission`, not a second
 *     algebra. A disagreement would not be a 403, it would be a healing loop.
 *  3. `skipped` — a re-sent identical update appends NO row. That is the
 *     idempotency proof the whole retry story rides on.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** A Yjs V1 update that sets a note's body to `text`, base64'd like the wire. */
function updateFor(text: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const update = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return update.toString("base64");
}

function updateForClient(text: string, clientId: number): string {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  doc.getText("content").insert(0, text);
  const update = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return update.toString("base64");
}

function beforeAndAfterDelete(): { before: string; after: string } {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "abc");
  const before = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.getText("content").delete(1, 1);
  const after = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return { before, after };
}

async function contentOf(docId: string): Promise<string | null> {
  const state = await loadDocState(docId);
  if (!state) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const out = doc.getText("content").toString();
  doc.destroy();
  return out;
}

const updateRows = async (docId: string) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [docId]))
    .rows[0].n;

describe("docs batch push", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    setDocBatchRuntime(null);
    owner = await signUp("owner@docs.test");
    org = (await createOrg(owner, "Docs Co", "docs-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterEach(() => setDocBatchRuntime(null));
  afterAll(async () => {
    await pool.end();
  });

  const push = async (user: TestUser, items: unknown[]) => {
    const res = await req(user, "POST", `/api/vaults/${vault}/docs/batch`, { items });
    return { status: res.status, body: (await res.json()) as { results: DocPushResult[]; code?: string } };
  };

  it("applies each item to the detached store", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    const { body } = await push(owner, [
      { docId: a, update: updateFor("hello a") },
      { docId: b, update: updateFor("hello b") },
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(await contentOf(a)).toBe("hello a");
    expect(await contentOf(b)).toBe("hello b");
  });

  it("an identical re-send is `skipped` and appends NO new doc_updates row", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const update = updateFor("same bytes");
    await push(owner, [{ docId: a, update }]);
    const before = await updateRows(a);
    const { body } = await push(owner, [{ docId: a, update }]);
    expect(body.results[0].status).toBe("skipped");
    expect(await updateRows(a)).toBe(before);
    expect(await contentOf(a)).toBe("same bytes");
  });

  it("expectEmpty on a doc that is no longer empty is a conflict, and applies nothing", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    await push(owner, [{ docId: a, update: updateFor("a teammate got here first") }]);
    const rowsBefore = await updateRows(a);
    const { body } = await push(owner, [
      { docId: a, update: updateFor("my stale local file"), expectEmpty: true },
    ]);
    expect(body.results[0].status).toBe("conflict");
    expect(await contentOf(a)).toBe("a teammate got here first");
    expect(await updateRows(a)).toBe(rowsBefore);
  });

  it("expectEmpty on a genuinely empty doc applies", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const { body } = await push(owner, [
      { docId: a, update: updateFor("seeded from disk"), expectEmpty: true },
    ]);
    expect(body.results[0].status).toBe("applied");
    expect(await contentOf(a)).toBe("seeded from disk");
  });

  it("takes the LIVE document when one is open, so the push fans out like a keystroke", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const live = new Y.Doc();
    const documents = new Map([[formatDocName(vault, a), live]]);
    setDocBatchRuntime({
      server: { hocuspocus: { documents } } as never,
      hooks: {},
    });
    const { body } = await push(owner, [{ docId: a, update: updateFor("live text") }]);
    expect(body.results[0].status).toBe("applied");
    // Applied into the OPEN doc — which is what makes Hocuspocus persist,
    // re-index and broadcast it, exactly as it does for a human edit.
    expect(live.getText("content").toString()).toBe("live text");
    // …and NOT written behind its back through the detached path, which would
    // hand the next reader a doc the live copy has never seen.
    expect(await updateRows(a)).toBe(0);
    live.destroy();
  });

  it("a live doc that is not empty refuses an expectEmpty push too", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const live = new Y.Doc();
    live.getText("content").insert(0, "typed just now");
    setDocBatchRuntime({
      server: { hocuspocus: { documents: new Map([[formatDocName(vault, a), live]]) } } as never,
      hooks: {},
    });
    const { body } = await push(owner, [
      { docId: a, update: updateFor("stale"), expectEmpty: true },
    ]);
    expect(body.results[0].status).toBe("conflict");
    expect(live.getText("content").toString()).toBe("typed just now");
    live.destroy();
  });

  it("denies a doc the caller may only VIEW, and one a lock caps at view", async () => {
    const reader = await signUp("reader@docs.test");
    await seedMember(org, reader.userId, "member");
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const viewable = await seedNote(vault, folder, "Shared/v.md", owner.userId);
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedShare(org, "folder", folder, reader.userId, "view");
    const { body } = await push(reader, [{ docId: viewable, update: updateFor("nope") }]);
    expect(body.results[0]).toMatchObject({ status: "denied", code: "no_edit_permission" });
    expect(await contentOf(viewable)).toBeNull();

    // A `locked` share caps at view even for an owner.
    const locked = await seedNote(vault, folder, "Shared/l.md", owner.userId);
    await seedLock(org, "folder", folder, { type: "org" });
    const asOwner = await push(owner, [{ docId: locked, update: updateFor("nope") }]);
    expect(asOwner.body.results[0]).toMatchObject({ status: "denied", code: "no_edit_permission" });
  });

  it("lets a read-only re-download confirm state the server already covers", async () => {
    const reader = await signUp("reader-covered@docs.test");
    await seedMember(org, reader.userId, "member");
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const note = await seedNote(vault, folder, "Shared/same.md", owner.userId);
    const update = updateFor("canonical server text");
    await push(owner, [{ docId: note, update }]);
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedShare(org, "folder", folder, reader.userId, "view");

    const same = await push(reader, [{ docId: note, update }]);
    expect(same.body.results[0]).toMatchObject({ status: "skipped", code: null });

    const localEdit = await push(reader, [{ docId: note, update: updateFor("local-only edit") }]);
    expect(localEdit.body.results[0]).toMatchObject({
      status: "denied",
      code: "no_edit_permission",
    });
    expect(await contentOf(note)).toBe("canonical server text");
  });

  it("requires an equal-text but unrelated CRDT history to rebase pull-first", async () => {
    const reader = await signUp("reader-rebase@docs.test");
    await seedMember(org, reader.userId, "member");
    const note = await seedNote(vault, null, "Shared/rebase.md", owner.userId);
    const canonical = updateForClient("same Markdown", 1);
    const recreated = updateForClient("same Markdown", 2);
    await push(owner, [{ docId: note, update: canonical }]);
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedShare(org, "file", note, reader.userId, "view");

    // Text equality is not enough to mark the client's CRDT durable: keeping
    // these unrelated insert histories would duplicate the body when Edit
    // access later reconnects them. `denied` sends the desktop through its
    // discard-local-history → pull-canonical rebase path.
    const sameText = await push(reader, [{ docId: note, update: recreated }]);
    expect(sameText.body.results[0]).toMatchObject({
      status: "denied",
      code: "no_edit_permission",
    });
    expect(await contentOf(note)).toBe("same Markdown");
  });

  it("does not call equal state vectors covered when the server has a deletion", async () => {
    const reader = await signUp("reader-delete@docs.test");
    await seedMember(org, reader.userId, "member");
    const note = await seedNote(vault, null, "deleted-text.md", owner.userId);
    const { before, after } = beforeAndAfterDelete();
    await push(owner, [{ docId: note, update: after }]);
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedShare(org, "file", note, reader.userId, "view");

    // Deletes do not advance a Yjs state vector, so these two updates have the
    // same vector even though one renders `abc` and the canonical one renders
    // `ac`. The read-only acknowledgement must compare the actual content too.
    expect(
      Buffer.from(Y.encodeStateVectorFromUpdate(Buffer.from(before, "base64"))).equals(
        Buffer.from(Y.encodeStateVectorFromUpdate(Buffer.from(after, "base64"))),
      ),
    ).toBe(true);
    const stale = await push(reader, [{ docId: note, update: before }]);
    expect(stale.body.results[0]).toMatchObject({
      status: "denied",
      code: "no_edit_permission",
    });
    expect(await contentOf(note)).toBe("ac");
  });

  it("checks the live canonical document instead of stale detached persistence", async () => {
    const reader = await signUp("reader-live-covered@docs.test");
    await seedMember(org, reader.userId, "member");
    const note = await seedNote(vault, null, "live-canonical.md", owner.userId);
    const before = updateFor("abc");
    await push(owner, [{ docId: note, update: before }]);

    // Model an open Hocuspocus doc whose latest deletion has not reached the
    // detached update log yet. Looking only at persistence would falsely call
    // the reader's stale `abc` covered; the live source of truth says `ac`.
    const live = new Y.Doc();
    Y.applyUpdate(live, Buffer.from(before, "base64"));
    live.getText("content").delete(1, 1);
    setDocBatchRuntime({
      server: {
        hocuspocus: { documents: new Map([[formatDocName(vault, note), live]]) },
      } as never,
      hooks: {},
    });
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedShare(org, "file", note, reader.userId, "view");

    const stale = await push(reader, [{ docId: note, update: before }]);
    expect(stale.body.results[0]).toMatchObject({
      status: "denied",
      code: "no_edit_permission",
    });
    expect(live.getText("content").toString()).toBe("ac");
    // A read-only comparison never mutates detached persistence either.
    expect(await contentOf(note)).toBe("abc");
    live.destroy();
  });

  it("denies a malformed read-only update without changing canonical content", async () => {
    const reader = await signUp("reader-malformed@docs.test");
    await seedMember(org, reader.userId, "member");
    const note = await seedNote(vault, null, "malformed.md", owner.userId);
    await push(owner, [{ docId: note, update: updateFor("canonical") }]);
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedShare(org, "file", note, reader.userId, "view");

    const malformed = await push(reader, [
      { docId: note, update: Buffer.from([1, 2, 3]).toString("base64") },
    ]);
    expect(malformed.body.results[0]).toMatchObject({
      status: "denied",
      code: "no_edit_permission",
    });
    expect(await contentOf(note)).toBe("canonical");
  });

  it("denies a doc id that has no live row in THIS vault", async () => {
    const other = await seedVault(org, "Other");
    const elsewhere = await seedNote(other, null, "x.md", owner.userId);
    const { body } = await push(owner, [
      { docId: elsewhere, update: updateFor("wrong vault") },
      { docId: randomUUID(), update: updateFor("nonexistent") },
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["denied", "denied"]);
    expect(await contentOf(elsewhere)).toBeNull();
  });

  it("answers `too_large` per item, in BYTES, without failing the batch", async () => {
    const big = await seedNote(vault, null, "big.md", owner.userId);
    const ok = await seedNote(vault, null, "ok.md", owner.userId);
    // Past the MAX_NOTE_MB ceiling, measured on the DECODED update.
    const oversized = Buffer.alloc(config.maxNoteMb * 1024 * 1024 + 1).toString("base64");
    const { body } = await push(owner, [
      { docId: big, update: oversized },
      { docId: ok, update: updateFor("fine") },
    ]);
    expect(body.results[0]).toMatchObject({ status: "too_large", code: "note_too_large" });
    expect(body.results[1].status).toBe("applied");
    expect(await contentOf(ok)).toBe("fine");
  });

  it("refuses a batch over the item cap and over the decoded-byte cap", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const tooMany = await push(
      owner,
      Array.from({ length: config.batchMaxDocs + 1 }, () => ({ docId: a, update: updateFor("x") })),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe("batch_too_large");

    // Two items that are each fine and together are not.
    const half = Buffer.alloc(Math.ceil(config.batchMaxDecodedBytes / 2) + 16).toString("base64");
    const b = await seedNote(vault, null, "b.md", owner.userId);
    const tooBig = await push(owner, [
      { docId: a, update: half },
      { docId: b, update: half },
    ]);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe("batch_too_large");
    expect(await contentOf(a)).toBeNull();
  });

  /**
   * Search is EVENTUALLY consistent on this path, on purpose.
   *
   * `applyDetached` used to `await indexDoc(docId)` per item, which is a SECOND
   * full `loadDocState` (another pool checkout, another REPEATABLE READ
   * transaction, another `Y.mergeUpdates`, another `Y.Doc`) plus a synchronous
   * `embed()` and one INSERT per wikilink — on the request's event loop, which
   * the HTTP and WebSocket listeners share, which is why everyone ELSE's sync
   * stalled during an import. The live Hocuspocus path has always used the
   * debounced `scheduleIndex`; this is the same queue.
   *
   * `flushIndexQueue()` is the test hook that exists so this can be asserted
   * without putting the cost back on the request.
   */
  it("indexes a batch push through the debounced queue, not inline", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    const { body } = await push(owner, [
      { docId: a, update: updateFor("alpha [[beta]]") },
      { docId: b, update: updateFor("beta body") },
    ]);
    expect(body.results.every((r) => r.status === "applied")).toBe(true);
    // The bytes are durable immediately…
    expect(await contentOf(a)).toBe("alpha [[beta]]");
    // …and the derived rows land once the queue drains.
    await flushIndexQueue();
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM note_index WHERE doc_id = ANY($1::text[])",
      [[a, b]],
    );
    expect(rows[0].n).toBe(2);
    const links = await pool.query<{ to_title: string }>(
      "SELECT to_title FROM note_links WHERE from_doc = $1",
      [a],
    );
    expect(links.rows.map((r) => r.to_title)).toEqual(["beta"]);
  });

  it("reports a malformed update per item and keeps going", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    const { body } = await push(owner, [
      { docId: a, update: Buffer.from([1, 2, 3, 4, 5]).toString("base64") },
      { docId: b, update: updateFor("still lands") },
    ]);
    expect(body.results[0].status).toBe("error");
    expect(body.results[1].status).toBe("applied");
    expect(await contentOf(b)).toBe("still lands");
  });
});
