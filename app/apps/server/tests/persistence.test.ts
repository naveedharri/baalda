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
import {
  seedFile,
  seedMember,
  seedNote,
  seedOrg,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";

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

  it("compacts on exactly the append that crosses the threshold, without counting every write", async () => {
    const threshold = 10;
    const docId = `doc-threshold-${Math.random().toString(36).slice(2)}`;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const seq: Uint8Array[] = [];
    doc.on("update", (u) => seq.push(u));
    for (let i = 0; i < 12; i++) text.insert(text.length, "z");
    doc.destroy();

    let counts = 0;
    const counting: Queryable = {
      query: ((sql: string, params?: unknown[]) => {
        if (typeof sql === "string" && sql.includes("count(*)")) counts++;
        return pool.query(sql, params as unknown[]);
      }) as Queryable["query"],
    };
    const compactedAt: number[] = [];
    for (let i = 0; i < seq.length; i++) {
      const r = await appendUpdate(docId, seq[i], counting, threshold);
      if (r.compacted) compactedAt.push(i + 1);
    }
    // Same trigger as a count on every write: the 11th row (> 10) compacts.
    expect(compactedAt).toEqual([11]);
    // ...but far fewer counts than the 12 writes.
    expect(counts).toBeLessThan(seq.length);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, (await loadDocState(docId))!);
    expect(rebuilt.getText("content").toString()).toBe("z".repeat(12));
  });

  it("still compacts when rows arrive from outside this process (another instance)", async () => {
    const threshold = 10;
    const docId = `doc-foreign-${Math.random().toString(36).slice(2)}`;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const seq: Uint8Array[] = [];
    doc.on("update", (u) => seq.push(u));
    for (let i = 0; i < 40; i++) text.insert(text.length, "w");
    doc.destroy();

    // Seed this process's estimate with one append, then let "another
    // instance" write 15 rows straight to the table.
    await appendUpdate(docId, seq[0], pool, threshold);
    for (let i = 1; i <= 15; i++) {
      await pool.query("INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)", [
        docId,
        Buffer.from(seq[i]),
      ]);
    }
    let compacted = false;
    for (let i = 16; i < 24 && !compacted; i++) {
      compacted = (await appendUpdate(docId, seq[i], pool, threshold)).compacted;
    }
    expect(compacted).toBe(true);
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

const SNAPSHOT_READ = "SELECT snapshot, snapshot_enc FROM doc_snapshots";

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

  it("a client that is AHEAD of the server is up to date, not behind — and is named as ahead", async () => {
    // One vault re-downloaded "40 notes" on every reload: each held an edit the
    // server had never received, so the vectors were unequal, so the diff was
    // computed — and it was EMPTY (2 bytes), applied to nothing, and computed
    // again on the next connect. Unequal is not behind; covered is up to date.
    const doc = await seedDoc("shared");
    await compact(DOC, pool); // probe path: state_vector present, log empty

    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
    client.getText("content").insert(6, " + local only"); // never reached the server
    const aheadSv = Y.encodeStateVector(client);

    const { db, sql } = countingDb();
    const diff = await loadDocDiff(DOC, aheadSv, db);
    expect(diff!.upToDate).toBe(true);
    expect(diff!.update.length).toBe(0);
    expect(diff!.clientAhead).toBe(true);
    // Answered by the probe: the snapshot BYTEA was never read for it.
    expect(sql.some((q) => q.includes(SNAPSHOT_READ))).toBe(false);

    // The slow path (a pending logged update) reaches the same verdict, and a
    // client that is BOTH ahead and behind gets the ops it lacks plus the flag.
    const later: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => later.push(u));
    doc.getText("content").insert(0, "# ");
    for (const u of later) await appendUpdate(DOC, u, pool, 1000);
    const both = await loadDocDiff(DOC, aheadSv);
    expect(both!.upToDate).toBe(false);
    expect(both!.clientAhead).toBe(true);
    Y.applyUpdate(client, both!.update);
    expect(client.getText("content").toString()).toBe("# shared + local only");
  });

  it("caches a doc's state vector so an unchanged doc costs one query and no merge", async () => {
    // The point of migration 025. A note edited fewer than COMPACTION_THRESHOLD
    // times has no `doc_snapshots` row, so before the cache EVERY connect read its
    // whole update log and ran `Y.mergeUpdates` over it, only to conclude the
    // client was already current — thousands of queries and hundreds of
    // single-threaded merges standing in front of one `ready` frame.
    const doc = await seedDoc("cached");
    const sv = Y.encodeStateVector(doc);

    // First read pays the slow path and populates the cache.
    const cold = await loadDocDiff(DOC, sv);
    expect(cold!.upToDate).toBe(true);

    const { db, sql } = countingDb();
    const warm = await loadDocDiff(DOC, sv, db);
    expect(warm!.upToDate).toBe(true);
    expect(warm!.update.length).toBe(0);
    // Neither the log nor the snapshot was touched.
    expect(sql.some((q) => q.includes(SNAPSHOT_READ))).toBe(false);
    expect(sql.some((q) => q.includes("SELECT id, update, update_enc FROM doc_updates"))).toBe(false);
    expect(sql).toHaveLength(1);
  });

  it("a new update invalidates the cached vector instead of being missed by it", async () => {
    // The hazard the watermark exists for: a cached vector that is TRUSTED and
    // stale would report a client up to date while ops it has never seen sit in
    // the log — withholding content silently, the one failure this must not have.
    const doc = await seedDoc("before");
    const sv = Y.encodeStateVector(doc);
    // A snapshot of the client as it stands now, before the server moves on.
    const before = new Y.Doc();
    Y.applyUpdate(before, Y.encodeStateAsUpdate(doc));
    await loadDocDiff(DOC, sv); // populate the cache

    const later: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => later.push(u));
    doc.getText("content").insert(6, " and after");
    for (const u of later) await appendUpdate(DOC, u, pool, 1000);

    const diff = await loadDocDiff(DOC, sv);
    expect(diff!.upToDate).toBe(false);
    // `update` is a DIFF against `sv`, so it only means anything applied to a doc
    // already at that state — which is exactly the client the server is answering.
    const behind = new Y.Doc();
    Y.applyUpdate(behind, Y.encodeStateAsUpdate(before));
    Y.applyUpdate(behind, diff!.update);
    expect(behind.getText("content").toString()).toBe("before and after");
  });

  it("an equal or merely behind client is not `clientAhead`", async () => {
    const doc = await seedDoc("base");
    const equal = await loadDocDiff(DOC, Y.encodeStateVector(doc));
    expect(equal!.upToDate).toBe(true);
    expect(equal!.clientAhead).toBe(false);
    const behind = await loadDocDiff(DOC, Y.encodeStateVector(new Y.Doc()));
    expect(behind!.upToDate).toBe(false);
    expect(behind!.clientAhead).toBe(false);
    expect((await loadDocDiff(DOC, null))!.clientAhead).toBe(false);
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
  let vault: string;
  /** Live `notes` rows for `ids` — only notes can be named on `ready.empty`. */
  const notes = async (ids: string[]) => {
    for (const id of ids) await seedNote(vault, null, `${id}.md`, null, id);
    return ids;
  };

  beforeEach(async () => {
    await resetDb();
    vault = await seedVault(await seedOrg("Empty Probe", "empty-probe"));
  });

  it("names docs with no updates and no snapshot, and only those", async () => {
    await notes(["doc-with-updates", "doc-compacted", "doc-empty-1", "doc-empty-2"]);
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
    await notes(["doc-empty-1", "doc-unasked"]);
    const res = await listEmptyDocs(["doc-empty-1"]);
    expect(res.empty).toEqual(["doc-empty-1"]);
    expect(res.empty).not.toContain("doc-unasked");
  });

  it("never names a tree file, a deleted note or an unknown id — only live notes", async () => {
    // Production: ~5.2k `files` ids in the readable set filled the 2,000 cap on
    // every connect while only ~146 notes really lacked content.
    await notes(["note-empty", "note-deleted"]);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = 'note-deleted'");
    const fileIds = [];
    for (let i = 0; i < 5; i++) fileIds.push(await seedFile(vault, null, `img-${i}.png`));

    const res = await listEmptyDocs(["note-empty", "note-deleted", "no-such-row", ...fileIds]);
    expect(res).toEqual({ empty: ["note-empty"], truncated: false });
  });

  it("over the channel's real readable set (notes + files) names only the empty notes", async () => {
    const orgId = await seedOrg("Mixed Vault", "mixed-vault");
    const owner = await seedUser("owner@empty-probe.test");
    await seedMember(orgId, owner, "owner");
    await seedVaultGrant(orgId, "edit");
    const v = await seedVault(orgId);
    const full = await seedNote(v, null, "Full.md", owner);
    const emptyA = await seedNote(v, null, "A.md", owner);
    const emptyB = await seedNote(v, null, "B.md", owner);
    await seedDoc("body", full);
    const files = [
      await seedFile(v, null, "photo.png"),
      await seedFile(v, null, "deck.pdf"),
      await seedFile(v, null, "sheet.xlsx"),
    ];

    const readable = await listReadableDocsInVault(owner, v);
    // The premise: the set the vault channel probes really does carry file ids.
    for (const f of files) expect(readable.has(f)).toBe(true);

    const res = await listEmptyDocs([...readable]);
    expect(res).toEqual({ empty: [emptyA, emptyB].sort(), truncated: false });
    for (const f of files) expect(res.empty).not.toContain(f);
  });

  it("caps the list and reports truncation", async () => {
    const ids = await notes(Array.from({ length: 10 }, (_, i) => `empty-${i}`));
    const res = await listEmptyDocs(ids, pool, 4);
    expect(res.truncated).toBe(true);
    expect(res.empty.length).toBe(4);
    // Sorted, so the answer is deterministic across chunks and runs.
    expect(res.empty).toEqual([...res.empty].sort());
  });

  it("past the cap names the SAME set on every connect, whatever the input order", async () => {
    // A random sample named a different 2,000 on each connect, so clients
    // re-seeded notes the server had already settled (88–98% `covered`).
    const ids = await notes(Array.from({ length: 30 }, (_, i) => `empty-${String(i).padStart(2, "0")}`));
    const first = await listEmptyDocs(ids, pool, 7, "2026-10-14");
    expect(first.truncated).toBe(true);
    expect(first.empty.length).toBe(7);
    for (let i = 0; i < 5; i++) {
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      expect(await listEmptyDocs(shuffled, pool, 7, "2026-10-14")).toEqual(first);
    }
  });

  it("rotates the window over days, so no empty note is starved forever", async () => {
    // The old `ORDER BY id LIMIT cap` answered the same lowest ids on every
    // connect forever; a doc above that window was never named.
    const ids = await notes(Array.from({ length: 12 }, (_, i) => `empty-${String(i).padStart(2, "0")}`));
    const seen = new Set<string>();
    for (let d = 1; d <= 60 && seen.size < ids.length; d++) {
      for (const id of (await listEmptyDocs(ids, pool, 3, `day-${d}`)).empty) seen.add(id);
    }
    expect(seen.size).toBe(ids.length);
  });

  it("is a no-op on an empty input", async () => {
    expect(await listEmptyDocs([])).toEqual({ empty: [], truncated: false });
  });
});

// ── concurrency: compact vs compact, and compact vs a backfill read ─────────
//
// Both of these reproduced real data loss before the per-doc advisory lock:
//   · two `compact()` calls racing (Hocuspocus does not await `onChange`, so two
//     typists past COMPACTION_THRESHOLD is enough) — the older merge upserted
//     over the newer one and a committed update existed nowhere afterwards;
//   · `loadDocDiff` reading the snapshot and the log as two statements with a
//     compact committing in between — a truncated doc served AND cached with a
//     NULL watermark, which reads as fresh forever after.

/**
 * A `Queryable` whose checked-out clients block on `gate` just before running
 * the first statement containing `match`. Everything else behaves like the pool,
 * so the code under test takes its real transaction and its real lock.
 */
function gatedPool(match: string, gate: Promise<void>): Queryable {
  return {
    query: (t: unknown, p?: unknown) =>
      (pool.query as (t: unknown, p?: unknown) => Promise<unknown>)(t, p),
    connect: async () => {
      const client = await pool.connect();
      const patched = client as unknown as {
        query: (...args: unknown[]) => unknown;
        release: (...args: unknown[]) => unknown;
      };
      const orig = client.query.bind(client) as (...args: unknown[]) => unknown;
      const origRelease = client.release.bind(client) as (...args: unknown[]) => unknown;
      let held = false;
      // Rest args, not (text, values): `pool.query` calls the client
      // CALLBACK-style, and a wrapper that drops the third argument leaves it
      // waiting forever on a callback nobody will run.
      patched.query = async (...args: unknown[]) => {
        if (!held && typeof args[0] === "string" && (args[0] as string).includes(match)) {
          held = true;
          await gate;
        }
        return orig(...args);
      };
      // The pool hands the same physical client out again, so the patch has to
      // come off with the release or it outlives the test that installed it.
      patched.release = (...args: unknown[]) => {
        patched.query = orig;
        patched.release = origRelease;
        return origRelease(...args);
      };
      return client;
    },
  } as unknown as Queryable;
}

/** Append one update carrying `line` to DOC, built on top of `doc`. */
async function appendLine(doc: Y.Doc, line: string): Promise<void> {
  const out: Uint8Array[] = [];
  const on = (u: Uint8Array) => out.push(u);
  doc.on("update", on);
  doc.getText("content").insert(doc.getText("content").length, line);
  doc.off("update", on);
  for (const u of out) await appendUpdate(DOC, u, pool, 1_000_000);
}

async function serverText(): Promise<string> {
  const state = await loadDocState(DOC);
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, state);
  const out = d.getText("content").toString();
  d.destroy();
  return out;
}

describe("per-doc serialisation of compact + reads", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a second compact waits for the first, so no committed update is lost", async () => {
    const doc = await seedDoc("AAA");
    await compact(DOC, pool); // snapshot at seq N, log empty
    await appendLine(doc, "\nBBB");

    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // A reads snapshot + log, then parks with the doc's EXCLUSIVE lock held.
    const first = compact(DOC, gatedPool("INSERT INTO doc_snapshots", gate));
    await new Promise((r) => setTimeout(r, 150));

    // An update lands while A is parked, and a second compact starts. Before the
    // lock, B read the same pre-A world and stamped its older merge over A's.
    await appendLine(doc, "\nCCC");
    let secondDone = false;
    const second = compact(DOC, pool).then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(secondDone).toBe(false); // B is queued behind A's lock, not racing it

    open();
    await first;
    await second;

    expect(await serverText()).toBe("AAA\nBBB\nCCC");
    doc.destroy();
  });

  it("refuses to move a snapshot backwards even without the lock (seq belt)", async () => {
    const doc = await seedDoc("AAA");
    await compact(DOC, pool);
    const stale = await pool.query<{ snapshot: Buffer; state_vector: Buffer; seq: string }>(
      "SELECT snapshot, state_vector, seq FROM doc_snapshots WHERE doc_id = $1",
      [DOC],
    );
    await appendLine(doc, "\nBBB");
    await compact(DOC, pool); // snapshot now covers BBB at a higher seq

    // Replay the older compact's upsert verbatim — the shape that used to win.
    const replay = await pool.query(
      `INSERT INTO doc_snapshots (doc_id, snapshot, state_vector, seq, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (doc_id) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             state_vector = EXCLUDED.state_vector,
             seq = EXCLUDED.seq,
             updated_at = now()
       WHERE doc_snapshots.seq IS NULL OR doc_snapshots.seq < EXCLUDED.seq
       RETURNING doc_id`,
      [DOC, stale.rows[0]!.snapshot, stale.rows[0]!.state_vector, stale.rows[0]!.seq],
    );
    expect(replay.rowCount).toBe(0);
    expect(await serverText()).toBe("AAA\nBBB");
    doc.destroy();
  });

  it("loadDocDiff never serves — or caches — a doc a concurrent compact truncated", async () => {
    const doc = await seedDoc("BASE");
    await compact(DOC, pool);
    await appendLine(doc, "\nLATER");

    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // Park the reader between its snapshot SELECT and its log SELECT — the exact
    // window a compact used to slip through.
    const clientSv = Y.encodeStateVector(new Y.Doc());
    const reading = loadDocDiff(DOC, clientSv, gatedPool("SELECT id, update, update_enc FROM doc_updates", gate));
    await new Promise((r) => setTimeout(r, 150));

    let compacted = false;
    const compacting = compact(DOC, pool).then(() => {
      compacted = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(compacted).toBe(false); // the compact queues behind the reader's shared lock

    open();
    const diff = await reading;
    await compacting;

    // The served diff carries the whole doc, not the pre-compact prefix.
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, diff!.update);
    expect(rebuilt.getText("content").toString()).toBe("BASE\nLATER");
    rebuilt.destroy();

    // And the cache it wrote describes the log it actually read: a NULL
    // watermark here would read as fresh (the log is empty post-compact) and
    // withhold LATER from every later connect.
    const cached = await pool.query<{ upto: string | null }>(
      "SELECT upto_update_id::text AS upto FROM doc_state_vectors WHERE doc_id = $1",
      [DOC],
    );
    expect(cached.rows[0]?.upto).not.toBeNull();
    doc.destroy();
  });
});
