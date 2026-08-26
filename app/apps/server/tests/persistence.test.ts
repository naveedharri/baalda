import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendUpdate,
  compact,
  countUpdates,
  listEmptyDocs,
  loadDocDiff,
  loadDocState,
  type Queryable,
} from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";

const DOC = "doc-persist-1";

// File-scoped: this used to live in the first describe's afterAll, which closed
// the pool before any later describe ran.
afterAll(async () => {
  await pool.end();
});

describe("binary Yjs persistence + compaction (spec 02 §5A / 03 §3)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("round-trips: appended updates rebuild the exact text", async () => {
    // Build a doc incrementally and log each update.
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const updates: Uint8Array[] = [];
    doc.on("update", (u) => updates.push(u));
    text.insert(0, "Hello");
    text.insert(5, ", world");
    text.insert(0, "# ");
    doc.destroy();

    for (const u of updates) await appendUpdate(DOC, u, pool, 1000);

    const state = await loadDocState(DOC);
    expect(state).not.toBeNull();
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, state!);
    expect(rebuilt.getText("content").toString()).toBe("# Hello, world");
  });

  it("compaction merges the log into one snapshot and truncates", async () => {
    const threshold = 10;
    let compactedAtLeastOnce = false;

    // Build 15 sequential updates from ONE doc, then append; exceeding the
    // threshold makes compaction fire inside appendUpdate.
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const seq: Uint8Array[] = [];
    doc.on("update", (u) => seq.push(u));
    for (let i = 0; i < 15; i++) text.insert(text.length, "y");
    doc.destroy();

    for (const u of seq) {
      const r = await appendUpdate(DOC, u, pool, threshold);
      if (r.compacted) compactedAtLeastOnce = true;
    }

    expect(compactedAtLeastOnce).toBe(true);

    // A snapshot row exists...
    const snap = await pool.query("SELECT doc_id, seq FROM doc_snapshots WHERE doc_id = $1", [DOC]);
    expect(snap.rows.length).toBe(1);

    // ...and the update log was truncated below the threshold.
    expect(await countUpdates(DOC, pool)).toBeLessThanOrEqual(threshold);

    // State still reconstructs the full text (15 y's).
    const state = await loadDocState(DOC);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, state!);
    expect(rebuilt.getText("content").toString()).toBe("y".repeat(15));
  });

  it("explicit compact() is idempotent and preserves state", async () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const seq: Uint8Array[] = [];
    doc.on("update", (u) => seq.push(u));
    text.insert(0, "abc");
    text.insert(3, "def");
    doc.destroy();
    for (const u of seq) await appendUpdate(DOC, u, pool, 1000);

    await compact(DOC, pool);
    await compact(DOC, pool); // second call: nothing left to compact
    expect(await countUpdates(DOC, pool)).toBe(0);

    const state = await loadDocState(DOC);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, state!);
    expect(rebuilt.getText("content").toString()).toBe("abcdef");
  });
});


// ── Y-level equivalence: the merge path must equal the old rebuild path ──────
//
// `loadDocState`/`loadDocDiff` stopped replaying the snapshot + log into a
// throwaway Y.Doc and now compute over the raw bytes. That swap is only safe if
// three things are byte-identical to what the doc produced, so prove it directly
// against real multi-client histories rather than trusting the docs:
//
//   encodeStateVectorFromUpdate(mergeUpdates(parts)) == encodeStateVector(doc)
//   diffUpdate(merged, clientSv)                     == encodeStateAsUpdate(doc, clientSv)
//
// V1 throughout, deliberately: yjs#687 (open) reports corruption in the V2 merge
// functions, so nothing here may drift to a *V2 variant.

/** Build a realistic history: N clients, a shared base, concurrent inserts and
 *  deletes, everything exchanged. Returns every update in emission order. */
function multiClientHistory(clientIds: number[]): Uint8Array[] {
  const docs = clientIds.map((id) => {
    const d = new Y.Doc();
    d.clientID = id;
    return d;
  });
  const updates: Uint8Array[] = [];
  for (const d of docs) d.on("update", (u: Uint8Array) => updates.push(u));

  docs[0].getText("content").insert(0, "# Title\n");
  const seed = Y.encodeStateAsUpdate(docs[0]);
  for (const d of docs.slice(1)) Y.applyUpdate(d, seed);

  // Concurrent inserts, then a full exchange.
  docs.forEach((d, i) => {
    const t = d.getText("content");
    t.insert(t.length, `line ${i}\n`);
  });
  for (const u of updates.slice()) for (const d of docs) Y.applyUpdate(d, u);

  // Deletes matter: a Y.Doc with gc on drops deleted content while
  // `mergeUpdates` keeps the tombstones, so this is where the two paths are most
  // likely to diverge.
  docs[0].getText("content").delete(0, 2);
  if (docs[2]) docs[2].getText("content").delete(3, 4);
  for (const u of updates.slice()) for (const d of docs) Y.applyUpdate(d, u);

  for (const d of docs) d.destroy();
  return updates;
}

describe("merge-path equivalence (no Y.Doc on the read path)", () => {
  // Client-id order is the specific hazard: `encodeStateVector(doc)` sorts its
  // entries, while `encodeStateVectorFromUpdate` writes them in the order the
  // merged update happens to carry. Shuffled ids prove the two agree anyway.
  for (const ids of [
    [10, 20, 30],
    [30, 20, 10],
    [20, 30, 10],
    [7, 999_999, 42],
  ]) {
    it(`state vector from a merged update matches the rebuilt doc (clients ${ids.join()})`, () => {
      const updates = multiClientHistory(ids);

      const rebuilt = new Y.Doc();
      for (const u of updates) Y.applyUpdate(rebuilt, u);

      const merged = Y.mergeUpdates(updates);
      expect(Y.encodeStateVectorFromUpdate(merged)).toEqual(Y.encodeStateVector(rebuilt));

      // ...and the merged bytes still reconstruct the same text.
      const fromMerged = new Y.Doc();
      Y.applyUpdate(fromMerged, merged);
      expect(fromMerged.getText("content").toString()).toBe(
        rebuilt.getText("content").toString(),
      );
    });
  }

  it("diffUpdate equals encodeStateAsUpdate(doc, sv) and converges the client", () => {
    const updates = multiClientHistory([101, 202, 303]);
    const rebuilt = new Y.Doc();
    for (const u of updates) Y.applyUpdate(rebuilt, u);

    // A client that saw only the first two updates — i.e. genuinely behind.
    const client = new Y.Doc();
    for (const u of updates.slice(0, 2)) Y.applyUpdate(client, u);
    const clientSv = Y.encodeStateVector(client);

    const merged = Y.mergeUpdates(updates);
    const oldDiff = Y.encodeStateAsUpdate(rebuilt, clientSv);
    const newDiff = Y.diffUpdate(merged, clientSv);
    expect(newDiff).toEqual(oldDiff);

    Y.applyUpdate(client, newDiff);
    expect(client.getText("content").toString()).toBe(rebuilt.getText("content").toString());
  });
});

// ── loadDocDiff: the state-vector probe ─────────────────────────────────────

/** A Queryable that records the SQL it runs, so a test can assert what was NOT
 *  read. The point of the probe is skipping the snapshot BYTEA, and only the
 *  query log can show that. */
function countingDb(): { db: Queryable; sql: string[] } {
  const sql: string[] = [];
  const db = {
    query: (text: unknown, params?: unknown) => {
      sql.push(String(text));
      return (pool.query as (t: unknown, p?: unknown) => Promise<unknown>)(text, params);
    },
  };
  return { db: db as unknown as Queryable, sql };
}

const SNAPSHOT_READ = "SELECT snapshot FROM doc_snapshots";

/** Seed DOC from a fresh single-client history; returns the authoritative doc. */
async function seedDoc(text: string, docId = DOC): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  doc.getText("content").insert(0, text);
  for (const u of updates) await appendUpdate(docId, u, pool, 1000);
  return doc;
}

describe("loadDocDiff (vault-channel backfill)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns null for a doc with no snapshot and no updates", async () => {
    expect(await loadDocDiff(DOC, null)).toBeNull();
    expect(await loadDocDiff(DOC, new Uint8Array([0]))).toBeNull();
  });

  it("probe answers an up-to-date client WITHOUT reading the snapshot", async () => {
    const doc = await seedDoc("hello probe");
    await compact(DOC, pool); // writes state_vector, empties the log
    const sv = Y.encodeStateVector(doc);

    const { db, sql } = countingDb();
    const diff = await loadDocDiff(DOC, sv, db);

    expect(diff).not.toBeNull();
    expect(diff!.upToDate).toBe(true);
    expect(diff!.update.length).toBe(0);
    expect(diff!.serverStateVector).toEqual(sv);
    // The whole point: the snapshot BYTEA was never fetched.
    expect(sql.some((q) => q.includes(SNAPSHOT_READ))).toBe(false);
  });

  it("a NULL state_vector falls through to the merge path", async () => {
    const doc = await seedDoc("null sv");
    await compact(DOC, pool);
    // Snapshot rows written before the column existed have it NULL; the probe
    // must not treat that as "no state" or as a match.
    await pool.query("UPDATE doc_snapshots SET state_vector = NULL WHERE doc_id = $1", [DOC]);

    const { db, sql } = countingDb();
    const diff = await loadDocDiff(DOC, Y.encodeStateVector(doc), db);

    expect(diff!.upToDate).toBe(true); // same answer, computed the slow way
    expect(sql.some((q) => q.includes(SNAPSHOT_READ))).toBe(true);
  });

  it("a pending logged update defeats the probe and ships the diff", async () => {
    const doc = await seedDoc("base");
    await compact(DOC, pool);

    // A client that was fully caught up as of the compaction.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
    const staleSv = Y.encodeStateVector(client);

    // One more edit lands after compaction, so the log is non-empty. The stored
    // state_vector is now stale, which is exactly what `pending` guards against.
    const later: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => later.push(u));
    doc.getText("content").insert(4, " + more");
    for (const u of later) await appendUpdate(DOC, u, pool, 1000);

    const { db, sql } = countingDb();
    const diff = await loadDocDiff(DOC, staleSv, db);

    expect(diff!.upToDate).toBe(false);
    expect(sql.some((q) => q.includes(SNAPSHOT_READ))).toBe(true);

    Y.applyUpdate(client, diff!.update);
    expect(client.getText("content").toString()).toBe("base + more");
    expect(diff!.serverStateVector).toEqual(Y.encodeStateVector(doc));
  });

  it("a client with no state vector gets the full state", async () => {
    const doc = await seedDoc("# Full\nbody");
    const diff = await loadDocDiff(DOC, null);
    expect(diff!.upToDate).toBe(false);

    const client = new Y.Doc();
    Y.applyUpdate(client, diff!.update);
    expect(client.getText("content").toString()).toBe(doc.getText("content").toString());
    expect(diff!.serverStateVector).toEqual(Y.encodeStateVector(doc));
  });

  it("a partially-caught-up client converges on the diff alone", async () => {
    // Two clients, so the diff has to carry ops from a client the receiver has
    // never heard from.
    const a = new Y.Doc();
    a.clientID = 501;
    const b = new Y.Doc();
    b.clientID = 502;
    const updates: Uint8Array[] = [];
    a.on("update", (u: Uint8Array) => updates.push(u));
    b.on("update", (u: Uint8Array) => updates.push(u));

    a.getText("content").insert(0, "shared base\n");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const clientSv = Y.encodeStateVector(b); // the client stops listening here
    a.getText("content").insert(12, "from a\n");
    b.getText("content").insert(0, "from b\n");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    for (const u of updates) await appendUpdate(DOC, u, pool, 1000);

    // The client's own doc, frozen at clientSv.
    const client = new Y.Doc();
    for (const u of updates.slice(0, 2)) Y.applyUpdate(client, u);

    const diff = await loadDocDiff(DOC, Y.encodeStateVector(client));
    expect(diff!.upToDate).toBe(false);
    Y.applyUpdate(client, diff!.update);

    const server = new Y.Doc();
    Y.applyUpdate(server, (await loadDocState(DOC))!);
    expect(client.getText("content").toString()).toBe(server.getText("content").toString());
    // Sanity: the client really was behind, so the diff did the work.
    expect(clientSv).not.toEqual(diff!.serverStateVector);
  });
});

// ── listEmptyDocs: the `ready.empty` hint ───────────────────────────────────

describe("listEmptyDocs", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("names docs with no updates and no snapshot, and only those", async () => {
    await seedDoc("has content", "doc-with-updates");

    const compacted = await seedDoc("compacted", "doc-compacted");
    await compact("doc-compacted", pool); // snapshot only, log empty
    compacted.destroy();

    const res = await listEmptyDocs([
      "doc-with-updates",
      "doc-compacted",
      "doc-empty-1",
      "doc-empty-2",
    ]);
    expect(res).toEqual({ empty: ["doc-empty-1", "doc-empty-2"], truncated: false });
  });

  it("never names a doc that wasn't asked about", async () => {
    // "doc-unasked" is empty too, but it is outside the caller's readable set.
    const res = await listEmptyDocs(["doc-empty-1"]);
    expect(res.empty).toEqual(["doc-empty-1"]);
    expect(res.empty).not.toContain("doc-unasked");
  });

  it("caps the list and reports truncation", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `empty-${i}`);
    const res = await listEmptyDocs(ids, pool, 4);
    expect(res.truncated).toBe(true);
    expect(res.empty.length).toBe(4);
    // Sorted, so the answer is deterministic across chunks and runs.
    expect(res.empty).toEqual([...res.empty].sort());
  });

  it("is a no-op on an empty input", async () => {
    expect(await listEmptyDocs([])).toEqual({ empty: [], truncated: false });
  });
});
