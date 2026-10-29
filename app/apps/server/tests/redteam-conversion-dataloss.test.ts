// SPDX-License-Identifier: Apache-2.0
//
// Red team (W3 vault keys): interleavings around converting an existing vault
// that must never lose, revert, duplicate or make unreadable any note,
// version, checkpoint text or key. Each race is made deterministic with the
// production test seams (`backfillHooks`, `nullOutHooks`,
// `convertingCompactHooks`): the competing operation runs inside the window
// between a worker's read/verify and its guarded write.
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import {
  appendUpdate,
  compact,
  convertingCompactHooks,
  loadDocState,
} from "../src/yjs/persistence.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { aadFor, open, seal } from "../src/crypto/envelope.js";
import { openDocBytes, sealDocBytes, type DocCrypto } from "../src/crypto/doc-crypto.js";
import { backfillHooks, backfillVault, catchUpIndex, encryptionStatus } from "../src/crypto/backfill.js";
import { nullOutHooks, nullOutVault, plaintextStatus } from "../src/crypto/null-out.js";
import { indexDoc } from "../src/index/indexer.js";
import { applyDocPushBatch } from "../src/sync/doc-batch.js";
import { createDocWriter } from "../src/mcp/doc-writer.js";
import type { SyncContext } from "../src/sync/hocuspocus.js";
import { captureCheckpoint } from "../src/versions/checkpoints.js";
import { revertVaultToCheckpoint } from "../src/versions/revert.js";
import { recordVersion, sha256Hex } from "../src/versions/capture.js";
import { resolveText, VERSION_CONTENT, VERSION_CONTENT_ENC, VERSION_TEXT_JOIN } from "../src/versions/texts.js";
import { purgeExpiredTrash, restoreNote } from "../src/trash/service.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

const RUN = { throttleMs: 0, force: true };
const server = { hocuspocus: { documents: new Map() } } as unknown as Server<SyncContext>;
const docWriter = createDocWriter(server);

function edit(doc: Y.Doc, text: string): Uint8Array {
  let u: Uint8Array | null = null;
  const h = (x: Uint8Array) => (u = x);
  doc.on("update", h);
  doc.getText("content").insert(doc.getText("content").length, text);
  doc.off("update", h);
  return u!;
}

function textOf(state: Uint8Array | Buffer | null): string {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, new Uint8Array(state));
  const t = d.getText("content").toString();
  d.destroy();
  return t;
}

/** Every op of `writer` is in the stored state (nothing lost, nothing reverted). */
function covers(state: Uint8Array | null, writer: Y.Doc): boolean {
  if (!state) return false;
  const d = new Y.Doc();
  Y.applyUpdate(d, state);
  const before = Y.encodeStateVector(d);
  Y.applyUpdate(d, Y.encodeStateAsUpdate(writer));
  const after = Y.encodeStateVector(d);
  d.destroy();
  return Buffer.from(before).equals(Buffer.from(after));
}

let SECRET = "";

/** An unkeyed vault: compacted plaintext snapshot + plaintext log per note. */
async function legacyVault(notes = 2) {
  const orgId = await seedOrg("Legacy", `rt-${Date.now()}-${Math.random()}`);
  const userId = await seedUser(`rt-${Math.random().toString(36).slice(2)}@rt.test`);
  await seedMember(orgId, userId, "owner");
  const vaultId = await seedVault(orgId);
  const docIds: string[] = [];
  const live: Y.Doc[] = [];
  for (let i = 0; i < notes; i++) {
    const docId = await seedNote(vaultId, null, `note-${i}.md`, userId);
    const doc = new Y.Doc();
    for (let j = 0; j < 3; j++) await appendUpdate(docId, edit(doc, `n${i} pre ${j} ${SECRET}\n`), pool, 1000);
    await compact(docId, pool);
    for (let j = 3; j < 5; j++) await appendUpdate(docId, edit(doc, `n${i} pre ${j}\n`), pool, 1000);
    await indexDoc(docId, pool);
    docIds.push(docId);
    live.push(doc);
  }
  return { orgId, userId, vaultId, docIds, live };
}

async function keyVault(vaultId: string, hold = true): Promise<DocCrypto> {
  const key = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(key, vaultId)]);
  await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)", [vaultId]);
  if (hold) vaultKeyCache.acquire(vaultId, key, 1);
  return { vaultId, key: Buffer.from(key), generation: 1 };
}

/** Every sealed row of the vault opens with `c` (no row sealed under another/zeroed key). */
async function everySealedRowOpens(vaultId: string, c: DocCrypto): Promise<number> {
  let n = 0;
  const { rows: u } = await pool.query(
    `SELECT u.doc_id, u.update_enc FROM doc_updates u
      WHERE u.doc_id IN (SELECT id FROM notes WHERE vault_id = $1) AND u.update_enc IS NOT NULL`,
    [vaultId],
  );
  for (const r of u) {
    openDocBytes(c, "doc_updates.update", r.doc_id, r.update_enc, null);
    n++;
  }
  const { rows: s } = await pool.query(
    `SELECT s.doc_id, s.snapshot_enc FROM doc_snapshots s
      WHERE s.doc_id IN (SELECT id FROM notes WHERE vault_id = $1) AND s.snapshot_enc IS NOT NULL`,
    [vaultId],
  );
  for (const r of s) {
    openDocBytes(c, "doc_snapshots.snapshot", r.doc_id, r.snapshot_enc, null);
    n++;
  }
  return n;
}

async function versionTexts(vaultId: string, c: DocCrypto | undefined): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT v.doc_id, v.sha256, ${VERSION_CONTENT} AS content, ${VERSION_CONTENT_ENC} AS content_enc
       FROM note_versions v ${VERSION_TEXT_JOIN} WHERE v.vault_id = $1 ORDER BY v.id`,
    [vaultId],
  );
  return rows.map((r) => resolveText(r, { vaultId, docId: r.doc_id, sha: r.sha256 }, c) ?? "");
}

describe("red team: no data loss across vault-key conversion", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("VAULT_PLAINTEXT_RETENTION_DAYS", "0");
    await resetDb();
    vaultKeyCache.clear();
    backfillHooks.beforeWrite = () => {};
    backfillHooks.tamper = (_t, s) => s;
    nullOutHooks.beforeWrite = () => {};
    convertingCompactHooks.beforeWrite = () => {};
    SECRET = `rtsecret${randomBytes(5).toString("hex")}`;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    backfillHooks.beforeWrite = () => {};
    nullOutHooks.beforeWrite = () => {};
    convertingCompactHooks.beforeWrite = () => {};
  });
  afterAll(async () => {
    await pool.end();
  });

  // ── 4. zeroed keys, cache eviction, generation bump ──────────────────────

  it("an all-zero (zeroed) key is refused by seal and open, so nothing is sealed under it", async () => {
    const zero = Buffer.alloc(32);
    const aad = aadFor("doc_updates", "update", "v", "d");
    expect(() => seal(zero, aad, Buffer.from("x"))).toThrow();
    // A buffer a caller zeroed in a `finally` while a write still held it.
    const real = randomBytes(32);
    const c: DocCrypto = { vaultId: "v", key: Buffer.from(real), generation: 1 };
    const sealed = seal(c.key, aad, Buffer.from("x"));
    c.key.fill(0);
    expect(() => sealDocBytes(c, "doc_updates.update", "d", new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => open(c.key, aad, sealed)).toThrow();
  });

  it("a zeroed key handed to a keyed append writes nothing; the doc stays readable", async () => {
    const { vaultId, docIds, live } = await legacyVault(1);
    const c = await keyVault(vaultId);
    const [docId] = docIds;
    const zeroed: DocCrypto = { ...c, key: Buffer.from(c.key) };
    zeroed.key.fill(0);
    await expect(appendUpdate(docId, edit(live[0], "lost?\n"), pool, 1000, zeroed)).rejects.toThrow();
    // Nothing poisoned: the stored state still opens with the real key.
    expect(textOf(await loadDocState(docId, pool, c))).toContain(`n0 pre 0 ${SECRET}`);
    await everySealedRowOpens(vaultId, c);
  });

  it("key eviction in the middle of a background converting compaction: the job's copy finishes, nothing unreadable", async () => {
    const { vaultId, docIds, live } = await legacyVault(1);
    const c = await keyVault(vaultId);
    const [docId] = docIds;
    for (let i = 0; i < 3; i++) await appendUpdate(docId, edit(live[0], `keyed ${i}\n`), pool, 1000, c);
    convertingCompactHooks.beforeWrite = () => {
      convertingCompactHooks.beforeWrite = () => {};
      vaultKeyCache.evict(vaultId); // zeroes the cache's own buffer
    };
    await compact(docId, pool); // background: no caller key, cache copy
    expect(textOf(await loadDocState(docId, pool, c))).toBe(live[0].getText("content").toString());
    expect(await everySealedRowOpens(vaultId, c)).toBeGreaterThan(0);
  });

  it("key eviction mid-backfill stops at the batch boundary; every sealed copy opens; resume completes", async () => {
    const { vaultId, docIds, live } = await legacyVault(3);
    const c = await keyVault(vaultId);
    let n = 0;
    backfillHooks.beforeWrite = () => {
      if (++n === 2) vaultKeyCache.evict(vaultId);
    };
    expect(await backfillVault(vaultId, { throttleMs: 0, batchSize: 2 })).toBe("no_key");
    await everySealedRowOpens(vaultId, c);
    backfillHooks.beforeWrite = () => {};
    vaultKeyCache.acquire(vaultId, c.key, 1);
    expect(await backfillVault(vaultId, { throttleMs: 0, batchSize: 2 })).toBe("complete");
    for (let i = 0; i < docIds.length; i++) {
      expect(textOf(await loadDocState(docIds[i], pool, c))).toBe(live[i].getText("content").toString());
    }
  });

  it("a key generation bump mid-backfill: workers stop, gen-1 rows stay readable, nothing sealed under a stale key after the bump", async () => {
    const { vaultId, docIds, live } = await legacyVault(2);
    const c = await keyVault(vaultId);
    let bumped = false;
    backfillHooks.beforeWrite = async () => {
      if (bumped) return;
      bumped = true;
      await pool.query("UPDATE vaults SET key_generation = 2 WHERE id = $1", [vaultId]);
    };
    expect(await backfillVault(vaultId, { throttleMs: 0, batchSize: 1 })).toBe("no_key");
    expect(await nullOutVault(vaultId, RUN)).not.toBe("sealed");
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM doc_updates WHERE update_enc IS NOT NULL
         AND doc_id IN (SELECT id FROM notes WHERE vault_id = $1)`,
      [vaultId],
    );
    // Only the batch already in flight when the bump landed (batch size 1).
    expect(rows[0].n).toBeLessThanOrEqual(1);
    await everySealedRowOpens(vaultId, c);
    // Background compaction with a cache key whose generation is no longer the
    // vault's must not seal anything new either.
    const before = await pool.query("SELECT count(*)::int AS n FROM doc_snapshots WHERE snapshot_enc IS NOT NULL");
    await appendUpdate(docIds[0], edit(live[0], "bump\n"), pool, 1000, c);
    await compact(docIds[0], pool);
    const after = await pool.query("SELECT count(*)::int AS n FROM doc_snapshots WHERE snapshot_enc IS NOT NULL");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    for (let i = 0; i < docIds.length; i++) {
      expect(textOf(await loadDocState(docIds[i], pool, c))).toBe(live[i].getText("content").toString());
    }
  });

  // ── 1. conversion while edits stream in ───────────────────────────────────

  it("backfill + converting compaction + socket appends + docs/batch + MCP + index catch-up concurrently lose nothing", async () => {
    const { vaultId, docIds, live, userId } = await legacyVault(3);
    const c = await keyVault(vaultId);
    // Independent writers per doc: a socket client, a docs/batch client, MCP.
    const sockets = docIds.map((_, i) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, Y.encodeStateAsUpdate(live[i]));
      return d;
    });
    const batchers = docIds.map((_, i) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, Y.encodeStateAsUpdate(live[i]));
      return d;
    });
    const mcpMarks: string[][] = docIds.map(() => []);
    let tick = 0;
    const burst = async () => {
      const k = tick++;
      await Promise.all(
        docIds.map(async (docId, i) => {
          // threshold 3: frequent compactConverting under the backfill's feet
          await appendUpdate(docId, edit(sockets[i], `sock ${k}\n`), pool, 3, c);
          const res = await applyDocPushBatch(vaultId, [{ docId, update: edit(batchers[i], `batch ${k}\n`) }], {
            userId,
            crypto: c,
          });
          expect(res[0].outcome).not.toBe("error");
          const mark = `mcp ${k} ${i}`;
          mcpMarks[i].push(mark);
          await docWriter.appendContent(vaultId, docId, `${mark}\n`, { userId, crypto: { ...c, key: Buffer.from(c.key) } });
        }),
      );
    };
    backfillHooks.beforeWrite = burst;
    nullOutHooks.beforeWrite = burst;
    const runs = await Promise.all([
      backfillVault(vaultId, { throttleMs: 0, batchSize: 2 }),
      (async () => {
        for (let r = 0; r < 4; r++) await burst();
      })(),
      catchUpIndex(vaultId, pool, { throttleMs: 0 }),
    ]);
    expect(["complete", "stalled", "budget"]).toContain(runs[0]);
    backfillHooks.beforeWrite = () => {};
    // Drive the backfill to completion, then null out while edits continue.
    for (let i = 0; i < 5 && (await backfillVault(vaultId, { throttleMs: 0 })) !== "complete"; i++);
    await nullOutVault(vaultId, RUN);
    nullOutHooks.beforeWrite = () => {};
    await burst();
    for (let i = 0; i < 5 && (await backfillVault(vaultId, { throttleMs: 0 })) !== "complete"; i++);
    await nullOutVault(vaultId, RUN);
    for (const d of docIds) await compact(d, pool, c);

    for (let i = 0; i < docIds.length; i++) {
      const state = await loadDocState(docIds[i], pool, c);
      expect(covers(state, sockets[i])).toBe(true);
      expect(covers(state, batchers[i])).toBe(true);
      const text = textOf(state);
      for (const m of mcpMarks[i]) expect(text.split(m).length - 1).toBe(1);
      expect(text).toContain(`n${i} pre 0 ${SECRET}`);
    }
    await everySealedRowOpens(vaultId, c);
  });

  // ── 3. restart mid-step ───────────────────────────────────────────────────

  it("a crash mid-backfill, mid-null-out and mid-converting-compaction leaves every row intact and resumes", async () => {
    const { vaultId, docIds, live } = await legacyVault(2);
    const c = await keyVault(vaultId);
    const crash = new Error("simulated restart");
    let n = 0;
    backfillHooks.beforeWrite = () => {
      if (++n === 3) throw crash;
    };
    await expect(backfillVault(vaultId, { throttleMs: 0, batchSize: 2 })).rejects.toThrow("simulated restart");
    backfillHooks.beforeWrite = () => {};
    // The session advisory lock was released (finally), so a restart re-runs.
    expect(await backfillVault(vaultId, { throttleMs: 0 })).toBe("complete");

    // Converting compaction dies right before its first write: rolled back.
    await appendUpdate(docIds[0], edit(live[0], "after keying\n"), pool, 1000, c);
    const logBefore = (await pool.query("SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id", [docIds[0]])).rows;
    convertingCompactHooks.beforeWrite = () => {
      throw crash;
    };
    await expect(compact(docIds[0], pool, c)).rejects.toThrow("simulated restart");
    convertingCompactHooks.beforeWrite = () => {};
    const logAfter = (await pool.query("SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id", [docIds[0]])).rows;
    expect(logAfter).toEqual(logBefore);

    let m = 0;
    nullOutHooks.beforeWrite = () => {
      if (++m === 2) throw crash;
    };
    await expect(nullOutVault(vaultId, { ...RUN, batchSize: 1 })).rejects.toThrow("simulated restart");
    nullOutHooks.beforeWrite = () => {};
    // Batch size 1 across ids 9 → 10 is exactly where a text-sorted keyset
    // skipped rows (ORDER BY the text alias); every plaintext row must clear.
    const out = await nullOutVault(vaultId, RUN);
    expect(out).toBe("sealed");
    expect((await plaintextStatus(vaultId)).total).toBe(0);
    for (let i = 0; i < docIds.length; i++) {
      expect(textOf(await loadDocState(docIds[i], pool, c))).toBe(live[i].getText("content").toString());
    }
  });

  // ── 2 + 6. versions, checkpoints, revert, trash across conversion ─────────

  it("pre- and post-conversion versions and a pre-encryption checkpoint stay readable and revertable after null-out", async () => {
    const { vaultId, docIds, live, userId } = await legacyVault(2);
    const pre = `pre version ${SECRET}`;
    await recordVersion({ vaultId, docId: docIds[0], content: pre, cause: "idle", authorId: userId }, pool);
    // A pre-038 inline version too.
    const inline = `inline pre version ${SECRET}`;
    await pool.query(
      "INSERT INTO note_versions (doc_id, vault_id, content, sha256, cause) VALUES ($1, $2, $3, $4, 'idle')",
      [docIds[0], vaultId, inline, sha256Hex(inline)],
    );
    const preTexts = live.map((d) => d.getText("content").toString());
    const cp = await captureCheckpoint({ db: pool, vaultId, docWriter, kind: "manual", userId } as Parameters<
      typeof captureCheckpoint
    >[0]);

    const c = await keyVault(vaultId);
    const post = `post version ${SECRET}`;
    await recordVersion({ vaultId, docId: docIds[0], content: post, cause: "idle", authorId: userId, crypto: c }, pool);
    for (let i = 0; i < docIds.length; i++) {
      await appendUpdate(docIds[i], edit(live[i], `edited after keying ${i}\n`), pool, 1000, c);
    }
    expect(await backfillVault(vaultId, { throttleMs: 0 })).toBe("complete");

    // Null-out races a vault-wide revert to the PRE-encryption checkpoint:
    // the revert runs inside the null-out's write window.
    let reverted: Awaited<ReturnType<typeof revertVaultToCheckpoint>> | null = null;
    nullOutHooks.beforeWrite = async (table) => {
      if (reverted || table !== "note_texts") return;
      reverted = await revertVaultToCheckpoint({ vaultId, checkpointId: cp.id, userId, docWriter, crypto: c });
    };
    await nullOutVault(vaultId, RUN);
    nullOutHooks.beforeWrite = () => {};
    expect(reverted).not.toBeNull();
    expect(reverted!.acquired).toBe(true);
    for (let i = 0; i < 5 && (await backfillVault(vaultId, { throttleMs: 0 })) !== "complete"; i++);
    await nullOutVault(vaultId, RUN);

    // The revert restored the pre-encryption text, written sealed only.
    for (let i = 0; i < docIds.length; i++) {
      expect(textOf(await loadDocState(docIds[i], pool, c))).toBe(preTexts[i]);
    }
    const plainAfter = await pool.query(
      `SELECT count(*)::int AS n FROM doc_updates u JOIN notes n ON n.id = u.doc_id
        WHERE n.vault_id = $1 AND u.update IS NOT NULL AND u.update_enc IS NULL`,
      [vaultId],
    );
    expect(plainAfter.rows[0].n).toBe(0);
    // Every version (inline pre-038, pre-keying, post-keying, the revert's own
    // pre-revert captures) resolves with the key; nothing came back empty.
    const texts = await versionTexts(vaultId, c);
    expect(texts).toContain(pre);
    expect(texts).toContain(inline);
    expect(texts).toContain(post);
    expect(texts.every((t) => typeof t === "string")).toBe(true);
    // The pre-revert checkpoint (sealed) can undo the revert.
    const preRevertId = (reverted as { acquired: true; result: { preRevertCheckpointId: string } }).result
      .preRevertCheckpointId;
    const undo = await revertVaultToCheckpoint({ vaultId, checkpointId: preRevertId, userId, docWriter, crypto: c });
    expect(undo.acquired).toBe(true);
    expect(textOf(await loadDocState(docIds[0], pool, c))).toContain("edited after keying 0");
    // Without the key, a sealed version is key_required, never "".
    expect(() => versionTexts(vaultId, undefined)).rejects.toThrow();
  });

  it("a note trashed before conversion restores readable after backfill + null-out; a purged one stays refused without a key", async () => {
    const { vaultId, docIds, live, userId } = await legacyVault(2);
    await pool.query("UPDATE notes SET deleted_at = now(), deleted_by = $2, purge_after = now() + interval '30 days' WHERE id = $1", [
      docIds[0],
      userId,
    ]);
    await pool.query("UPDATE notes SET deleted_at = now(), deleted_by = $2, purge_after = now() - interval '1 minute' WHERE id = $1", [
      docIds[1],
      userId,
    ]);
    const c = await keyVault(vaultId);
    expect(await backfillVault(vaultId, { throttleMs: 0 })).toBe("complete");
    expect((await encryptionStatus(vaultId)).total).toBe(0);
    expect(await nullOutVault(vaultId, RUN)).toBe("sealed");
    const restored = await restoreNote(userId, docIds[0]);
    expect(restored.docId).toBe(docIds[0]);
    expect(textOf(await loadDocState(docIds[0], pool, c))).toBe(live[0].getText("content").toString());
    // Edits after restore are sealed and merge with the restored text.
    await appendUpdate(docIds[0], edit(live[0], "after restore\n"), pool, 1000, c);
    expect(textOf(await loadDocState(docIds[0], pool, c))).toBe(live[0].getText("content").toString());

    await purgeExpiredTrash(new Date(), pool);
    // The tombstone keeps the vault resolvable: a keyless write is still refused.
    await expect(appendUpdate(docIds[1], edit(live[1], "late\n"), pool, 1000)).rejects.toThrow();
    const plain = await pool.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1 AND update IS NOT NULL", [
      docIds[1],
    ]);
    expect(plain.rows[0].n).toBe(0);
  });
});
