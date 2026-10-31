// SPDX-License-Identifier: Apache-2.0
import { pool as defaultPool } from "../db/pool.js";
import type { Queryable } from "../yjs/persistence.js";

/**
 * Reference excerpts for the scoped attachment list (#343, migration 063).
 *
 * `filterByNoteReference` asks whether a readable note's text contains a blob
 * path verbatim, finding each path by its anchor (everything up to its first
 * `/`). Reading the full text of every readable note made the question cost
 * the vault's text, not its references. A note's `ref_text` keeps, for every
 * occurrence of each head in `ref_heads`, the head plus the next
 * {@link REF_WINDOW_CHARS} characters verbatim, the excerpts joined by "\n"
 * (no path contains one, so no match can straddle two excerpts). For a path
 * whose anchor is one of the heads and whose remainder fits the window, every
 * occurrence lies whole inside its own excerpt: the answer from `ref_text` is
 * the answer from `content`.
 *
 * Heads are what a blob path can start with in this vault: `attachments/`,
 * each top-level folder, and the anchor of each stored blob path. A request
 * whose anchors a note's heads do not cover reads that note's full text (always
 * correct) and asks for a background refresh of the vault.
 */

/** Characters kept after a head. Longer paths are matched on the full text. */
export const REF_WINDOW_CHARS = 512;

const ATTACHMENTS_HEAD = "attachments/";

/** The excerpts of `content` after every occurrence of every head. */
export function refText(content: string, heads: readonly string[]): string {
  const out = new Set<string>();
  for (const head of heads) {
    if (!head) continue;
    for (let at = content.indexOf(head); at !== -1; at = content.indexOf(head, at + 1)) {
      out.add(content.slice(at, at + head.length + REF_WINDOW_CHARS));
    }
  }
  return [...out].join("\n");
}

/** The heads a blob path in this vault can start with, sorted and distinct. */
export async function vaultRefHeads(vaultId: string, db: Queryable = defaultPool): Promise<string[]> {
  const { rows } = await db.query<{ head: string }>(
    `SELECT DISTINCT head FROM (
       SELECT $2::text AS head
       UNION ALL
       SELECT split_part(path, '/', 1) || '/' FROM folders WHERE vault_id = $1 AND position('/' IN path) = 0
       UNION ALL
       SELECT left(rel_path, position('/' IN rel_path)) FROM blobs
        WHERE vault_id = $1 AND position('/' IN rel_path) > 0
     ) h WHERE head <> '/'
     ORDER BY head`,
    [vaultId, ATTACHMENTS_HEAD],
  );
  return rows.map((r) => r.head);
}

/**
 * {@link vaultRefHeads}, remembered briefly for the indexer, which writes a
 * note's excerpts on every edit. A head added inside the window is only a
 * missed shortcut: the note's `ref_heads` then lack it, and the list reads that
 * note in full and schedules a refresh.
 */
const HEADS_TTL_MS = 30_000;
const headsCache = new Map<string, { at: number; heads: Promise<string[]> }>();
export function cachedRefHeads(vaultId: string, db: Queryable = defaultPool): Promise<string[]> {
  const hit = headsCache.get(vaultId);
  if (hit && Date.now() - hit.at < HEADS_TTL_MS) return hit.heads;
  const heads = vaultRefHeads(vaultId, db);
  headsCache.set(vaultId, { at: Date.now(), heads });
  heads.catch(() => headsCache.delete(vaultId));
  return heads;
}

// ── keeping them fresh ────────────────────────────────────────────────────

const BATCH = 20;
const queued = new Set<string>();
let running: Promise<void> | null = null;

/**
 * Recompute `ref_text` for every note of the vault whose heads are missing or
 * no longer the vault's. Reads each stale note's full text once, ONE note at a
 * time (a note can be a multi-megabyte HTML app, and a small server must not
 * hold a batch of them at once); a no-op when everything is current.
 */
export async function refreshVaultRefWindows(vaultId: string, db: Queryable = defaultPool): Promise<number> {
  const heads = await vaultRefHeads(vaultId, db);
  const seen = new Set<string>();
  let done = 0;
  for (;;) {
    const { rows } = await db.query<{ doc_id: string }>(
      `SELECT doc_id FROM note_index
        WHERE vault_id = $1 AND (ref_heads IS NULL OR NOT (ref_heads @> $2::text[]))
          AND NOT (doc_id = ANY($4::text[]))
          -- W3: a sealed row has no plaintext excerpt; the rule reads its body in memory.
          AND search_enc IS NULL
        ORDER BY doc_id LIMIT $3`,
      [vaultId, heads, BATCH, [...seen]],
    );
    if (rows.length === 0) return done;
    for (const { doc_id } of rows) {
      // Never ask for the same note twice in one pass, whatever happens to it.
      seen.add(doc_id);
      const { rows: text } = await db.query<{ content: string }>(
        "SELECT content FROM note_index WHERE doc_id = $1",
        [doc_id],
      );
      if (!text[0]) continue;
      await db.query("UPDATE note_index SET ref_text = $2, ref_heads = $3::text[] WHERE doc_id = $1", [
        doc_id,
        refText(text[0].content, heads),
        heads,
      ]);
      done += 1;
    }
  }
}

/** Queue a background refresh; repeated asks for one vault collapse. */
export function scheduleRefWindowRefresh(vaultId: string): void {
  queued.add(vaultId);
  if (!running) running = drain().finally(() => (running = null));
}

async function drain(): Promise<void> {
  while (queued.size > 0) {
    const vaultId = queued.values().next().value as string;
    queued.delete(vaultId);
    try {
      const n = await refreshVaultRefWindows(vaultId);
      if (n > 0) console.info(`[ref-windows] vault=${vaultId} refreshed=${n}`);
    } catch (err) {
      console.warn(`[ref-windows] vault=${vaultId} refresh failed:`, err);
    }
  }
}

/** Test hook: wait for queued refreshes. */
export async function flushRefWindowRefreshes(): Promise<void> {
  while (running) await running;
}

/** At startup: every vault with a note not yet excerpted (migration 063 backfill). */
export async function backfillRefWindows(db: Queryable = defaultPool): Promise<void> {
  const { rows } = await db.query<{ vault_id: string }>(
    "SELECT DISTINCT vault_id FROM note_index WHERE ref_heads IS NULL",
  );
  for (const r of rows) scheduleRefWindowRefresh(r.vault_id);
}
