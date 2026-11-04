// SPDX-License-Identifier: Apache-2.0
//
// Fills `search_tokens` (migration 068) for the plaintext rows of UNKEYED
// vaults. 068 added the column "NULL until the row is re-indexed" and nothing
// ever re-indexed old rows, so most rows of large unkeyed vaults kept the SQL
// substring count over their whole content on every search: three AI searches
// on a 422 MB vault hit the 15 s statement timeout (2026-11-03).
//
// The value written is exactly what the indexer writes for the same row
// (`searchTokenSet` of the stored title + content, or of a file's stored text),
// so search results do not change, only where the count is computed. A row is
// written only while it is still unsealed, still holds the content just read
// (`updated_at`), still has no token set, and its vault is still unkeyed: a
// re-index or a conversion in between always wins. Keyed vaults are never
// touched; their rows are scored from sealed blobs.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { searchTokenSet } from "./search-tokens.js";

type Queryable = Pick<pg.Pool, "query">;
export type TokenFillTable = "note_index" | "blob_text";

const TABLES: Record<TokenFillTable, { key: string; title: string }> = {
  note_index: { key: "doc_id", title: "t.title" },
  blob_text: { key: "blob_id", title: "NULL::text" },
};

/** Rows scanned per batch, and the stored (compressed) bytes one batch may read. */
const BATCH_ROWS = 500;
const BATCH_BYTES = 16 * 1024 * 1024;
/** Rows stored larger than this are skipped: a body that size almost always has
 *  more than 64 KB of distinct words, so its set would be NULL anyway. */
const MAX_STORED_BYTES = 512 * 1024;
const PAUSE_MS = 250;
/** A finished pass is repeated this often (only rows still NULL are read again). */
export const TOKEN_FILL_PASS_MS = 24 * 60 * 60_000;
const START_DELAY_MS = 2 * 60_000;

const ELIGIBLE = `t.search_tokens IS NULL AND t.search_enc IS NULL AND t.search_score_enc IS NULL AND t.content <> ''
   AND EXISTS (SELECT 1 FROM vaults v WHERE v.id = t.vault_id AND v.vk_check IS NULL)`;

interface Row {
  id: string;
  title: string | null;
  content: string;
  stamp: string;
}

/** The token set the indexer writes for this row (NULL past the bound or with unsafe characters). */
function tokensFor(table: TokenFillTable, r: Row): string | null {
  return table === "note_index" ? searchTokenSet(`${r.title ?? ""} ${r.content}`) : searchTokenSet(r.content);
}

/** Write `rows`' token sets where each row is still exactly what was read. Returns rows written. */
export async function writeTokens(
  table: TokenFillTable,
  rows: Array<{ id: string; stamp: string; tokens: string }>,
  db: Queryable = defaultPool,
): Promise<number> {
  if (rows.length === 0) return 0;
  const { key } = TABLES[table];
  const { rowCount } = await db.query(
    `UPDATE ${table} t SET search_tokens = u.tokens
       FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, stamp, tokens)
      WHERE t.${key} = u.id AND t.updated_at::text = u.stamp AND ${ELIGIBLE}`,
    [rows.map((r) => r.id), rows.map((r) => r.stamp), rows.map((r) => r.tokens)],
  );
  return rowCount ?? 0;
}

/**
 * One pass over every eligible row of `table`, in key order. Rows that stay
 * NULL (past the bound, unsafe characters, too large to read) are passed over
 * by the cursor, so a pass reads each row at most once.
 */
export async function fillSearchTokensPass(
  table: TokenFillTable,
  db: Queryable = defaultPool,
  opts: { pauseMs?: number; shouldStop?: () => boolean } = {},
): Promise<{ scanned: number; filled: number }> {
  const { key, title } = TABLES[table];
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  let after = "";
  let scanned = 0;
  let filled = 0;
  for (;;) {
    if (opts.shouldStop?.()) break;
    const { rows: ids } = await db.query<{ id: string; size: number }>(
      `SELECT t.${key} AS id, pg_column_size(t.content) AS size
         FROM ${table} t
        WHERE t.${key} > $1 AND ${ELIGIBLE}
        ORDER BY t.${key}
        LIMIT $2`,
      [after, BATCH_ROWS],
    );
    if (ids.length === 0) break;
    // Bodies within the byte budget (a row over it goes alone); the cursor
    // moves only past the rows handled here.
    const take: string[] = [];
    let bytes = 0;
    let handled = 0;
    for (const r of ids) {
      if (r.size <= MAX_STORED_BYTES) {
        if (take.length > 0 && bytes + r.size > BATCH_BYTES) break;
        take.push(r.id);
        bytes += r.size;
      }
      handled++;
    }
    after = ids[handled - 1].id;
    scanned += handled;
    const more = ids.length === BATCH_ROWS || handled < ids.length;
    if (take.length > 0) {
      const { rows } = await db.query<Row>(
        `SELECT t.${key} AS id, ${title} AS title, t.content, t.updated_at::text AS stamp
           FROM ${table} t
          WHERE t.${key} = ANY($1::text[]) AND ${ELIGIBLE}`,
        [take],
      );
      const out: Array<{ id: string; stamp: string; tokens: string }> = [];
      for (const r of rows) {
        const tokens = tokensFor(table, r);
        if (tokens !== null) out.push({ id: r.id, stamp: r.stamp, tokens });
      }
      filled += await writeTokens(table, out, db);
    }
    if (!more) break;
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return { scanned, filled };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let stopped = false;

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const table of ["note_index", "blob_text"] as const) {
      const started = Date.now();
      const r = await fillSearchTokensPass(table, defaultPool, { shouldStop: () => stopped });
      if (r.scanned > 0) {
        console.log(`[token-fill] table=${table} scanned=${r.scanned} filled=${r.filled} ms=${Date.now() - started}`);
      }
    }
  } catch (err) {
    console.error("[token-fill] pass failed:", err);
  } finally {
    running = false;
  }
}

/** Started only from `index.ts`: a pass shortly after boot, then daily. */
export function startTokenFill(): void {
  if (timer) return;
  stopped = false;
  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      void run().finally(() => {
        if (!stopped) schedule(TOKEN_FILL_PASS_MS);
      });
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  };
  schedule(START_DELAY_MS);
}

export function stopTokenFill(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
