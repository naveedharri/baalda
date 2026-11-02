// SPDX-License-Identifier: Apache-2.0
//
// Search pages for keyed vaults: the ranking data of up to PAGE_ROWS notes (or
// files) packed into ONE sealed blob, so a whole-vault search opens a few dozen
// pages instead of one score blob per row. A page holds, per row, the exact
// 256-number vector and the token set as ids into the page's own vocabulary:
// shared words are stored once, and a query token is matched against the
// vocabulary once per page rather than against every row's token string.
//
// Pages are derived and disposable. Each row records the `updated_at` it was
// built from; search scores a row from its page only while that still matches,
// and from the row's own score blob otherwise (edited since, never paged,
// unopenable page). So a page can be stale, missing or damaged and the results
// are the same, only slower. Same key, same envelope; the plaintext row ids and
// timestamps beside it are the ones note_index already holds in the clear.
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { aadFor, open, seal } from "../crypto/envelope.js";
import type { DocCrypto } from "../crypto/doc-crypto.js";
import { EMBED_DIM } from "./embedder.js";
import { openBlobScoreRow, openScoreRow, type SealedScoreRow } from "./sealed-index.js";

type Queryable = Pick<pg.Pool, "query">;
type Connectable = Queryable & { connect: () => Promise<pg.PoolClient> };

export type PageKind = "note" | "file";

/** Rows per page. A page of 500 notes is a few hundred KB sealed. */
export const PAGE_ROWS = 500;
/** Vaults smaller than this search fast enough row by row; no pages. */
export const SEARCH_PAGES_MIN_ROWS = 1000;
/** Rebuild when this many rows (or this share of them) are not on a fresh page. */
export const SEARCH_PAGES_STALE_ROWS = 100;
export const SEARCH_PAGES_STALE_SHARE = 0.05;
/** A vault's pages are rebuilt at most this often, and checked at most this often. */
export const SEARCH_PAGES_REBUILD_GAP_MS = 10 * 60_000;
export const SEARCH_PAGES_CHECK_GAP_MS = 2 * 60_000;
/** Decoded page bound: far above any real page, only bounds a bug. */
const PAGE_MAX_BYTES = 256 * 1024 * 1024;
const PAGE_FORMAT = 1;
const HEADER_BYTES = 48; // u32 format, u32 rows, u32 vocab bytes, u32 id width, 32-byte digest

const TABLES: Record<PageKind, { table: string; key: string }> = {
  note: { table: "note_index", key: "doc_id" },
  file: { table: "blob_text", key: "blob_id" },
};

export interface PageRowSource {
  id: string;
  /** `updated_at::text` of the row read. */
  stamp: string;
  vector: number[];
  tokens: string;
}

/** One opened page. Row `r`'s vector is `vectors[r*256 .. r*256+256)`, its
 *  token ids `tokIds[tokStart[r] .. tokStart[r+1])`. */
export interface SearchPage {
  ids: string[];
  stamps: string[];
  vectors: Float64Array;
  vocab: string[];
  tokStart: Uint32Array;
  tokIds: Uint16Array | Uint32Array;
}

function pageAad(kind: PageKind, vaultId: string, pageNo: number): Buffer {
  return aadFor("search_pages", kind, vaultId, String(pageNo));
}

/** Binds a page's sealed content to the plaintext ids and stamps stored beside it. */
function rowsDigest(ids: string[], stamps: string[]): Buffer {
  return createHash("sha256").update(ids.join("\n")).update("\0").update(stamps.join("\n")).digest();
}

/** A page's plaintext (before deflate). */
export function encodePage(rows: PageRowSource[]): Buffer {
  const vocabIndex = new Map<string, number>();
  const rowTokens: number[][] = [];
  for (const r of rows) {
    const ids: number[] = [];
    if (r.tokens !== "") {
      for (const t of r.tokens.split(" ")) {
        let id = vocabIndex.get(t);
        if (id === undefined) {
          id = vocabIndex.size;
          vocabIndex.set(t, id);
        }
        ids.push(id);
      }
    }
    rowTokens.push(ids);
  }
  const vocab = Buffer.from(Array.from(vocabIndex.keys()).join("\n"), "utf8");
  const idWidth = vocabIndex.size > 0xffff ? 4 : 2;
  const totalIds = rowTokens.reduce((n, ids) => n + ids.length, 0);
  const vecBytes = rows.length * EMBED_DIM * 8;
  const startsBytes = (rows.length + 1) * 4;
  const buf = Buffer.alloc(HEADER_BYTES + vecBytes + vocab.length + startsBytes + totalIds * idWidth);
  buf.writeUInt32LE(PAGE_FORMAT, 0);
  buf.writeUInt32LE(rows.length, 4);
  buf.writeUInt32LE(vocab.length, 8);
  buf.writeUInt32LE(idWidth, 12);
  rowsDigest(rows.map((r) => r.id), rows.map((r) => r.stamp)).copy(buf, 16);
  let off = HEADER_BYTES;
  for (const r of rows) {
    for (let i = 0; i < EMBED_DIM; i++) buf.writeDoubleLE(r.vector[i], off + i * 8);
    off += EMBED_DIM * 8;
  }
  vocab.copy(buf, off);
  off += vocab.length;
  let start = 0;
  for (const ids of rowTokens) {
    buf.writeUInt32LE(start, off);
    off += 4;
    start += ids.length;
  }
  buf.writeUInt32LE(start, off);
  off += 4;
  for (const ids of rowTokens) {
    for (const id of ids) {
      if (idWidth === 2) buf.writeUInt16LE(id, off);
      else buf.writeUInt32LE(id, off);
      off += idWidth;
    }
  }
  return buf;
}

/** The inverse of {@link encodePage}; throws on anything malformed. */
export function decodePage(plain: Buffer, ids: string[], stamps: string[]): SearchPage {
  if (plain.length < HEADER_BYTES || plain.readUInt32LE(0) !== PAGE_FORMAT) throw new Error("search page: bad format");
  const n = plain.readUInt32LE(4);
  const vocabBytes = plain.readUInt32LE(8);
  const idWidth = plain.readUInt32LE(12);
  if (n !== ids.length || n !== stamps.length || (idWidth !== 2 && idWidth !== 4)) throw new Error("search page: bad header");
  if (!plain.subarray(16, 48).equals(rowsDigest(ids, stamps))) throw new Error("search page: rows do not match");
  const vecBytes = n * EMBED_DIM * 8;
  let off = HEADER_BYTES;
  // Copied into its own buffer: a Float64Array needs 8-byte alignment.
  const vectors = new Float64Array(n * EMBED_DIM);
  Buffer.from(vectors.buffer).set(plain.subarray(off, off + vecBytes));
  off += vecBytes;
  const vocabText = plain.subarray(off, off + vocabBytes).toString("utf8");
  const vocab = vocabBytes === 0 ? [] : vocabText.split("\n");
  off += vocabBytes;
  const tokStart = new Uint32Array(n + 1);
  for (let i = 0; i <= n; i++) tokStart[i] = plain.readUInt32LE(off + i * 4);
  off += (n + 1) * 4;
  const total = tokStart[n];
  if (off + total * idWidth !== plain.length) throw new Error("search page: bad length");
  const tokIds = idWidth === 2 ? new Uint16Array(total) : new Uint32Array(total);
  for (let i = 0; i < total; i++) {
    const id = idWidth === 2 ? plain.readUInt16LE(off + i * 2) : plain.readUInt32LE(off + i * 4);
    if (id >= vocab.length) throw new Error("search page: bad token id");
    tokIds[i] = id;
  }
  return { ids, stamps, vectors, vocab, tokStart, tokIds };
}

export function sealPage(c: DocCrypto, kind: PageKind, pageNo: number, rows: PageRowSource[]): Buffer {
  return seal(c.key, pageAad(kind, c.vaultId, pageNo), deflateRawSync(encodePage(rows)), c.generation);
}

export function openPage(c: DocCrypto, kind: PageKind, pageNo: number, sealed: Buffer, ids: string[], stamps: string[]): SearchPage {
  const plain = inflateRawSync(open(c.key, pageAad(kind, c.vaultId, pageNo), sealed), { maxOutputLength: PAGE_MAX_BYTES });
  return decodePage(plain, ids, stamps);
}

/** Row `r`'s token set as {@link searchTokenSet} wrote it. */
export function pageRowTokens(p: SearchPage, r: number): string {
  const out: string[] = [];
  for (let i = p.tokStart[r]; i < p.tokStart[r + 1]; i++) out.push(p.vocab[p.tokIds[i]]);
  return out.join(" ");
}

/** Where each paged row lives, by row id. */
export interface PageIndex {
  pages: SearchPage[];
  rows: Map<string, { page: number; row: number; stamp: string }>;
}

/**
 * Every readable page of a vault, opened with the REQUEST's key. A page that
 * does not open or does not match its stored rows is skipped: its rows are
 * scored from their own blobs.
 */
export async function loadPages(db: Queryable, kind: PageKind, c: DocCrypto): Promise<PageIndex> {
  const { rows } = await db.query<{ page_no: number; doc_ids: string[]; stamps: string[]; page_enc: Buffer; generation: number }>(
    `SELECT page_no, doc_ids, stamps, page_enc, generation FROM search_pages
      WHERE vault_id = $1 AND kind = $2 ORDER BY page_no`,
    [c.vaultId, kind],
  );
  const index: PageIndex = { pages: [], rows: new Map() };
  for (const r of rows) {
    if (r.generation !== c.generation) continue;
    let page: SearchPage;
    try {
      page = openPage(c, kind, r.page_no, r.page_enc, r.doc_ids, r.stamps);
    } catch {
      console.error(`[search-pages] vault=${c.vaultId} kind=${kind} page=${r.page_no} did not open; scoring its rows one by one`);
      continue;
    }
    const p = index.pages.push(page) - 1;
    page.ids.forEach((id, row) => index.rows.set(id, { page: p, row, stamp: page.stamps[row] }));
  }
  return index;
}

/**
 * For each query token, which of a page's vocabulary entries contain it: bit
 * `j` of word `w` at `masks[v * words + w]` says vocabulary entry `v` holds
 * token `32*w + j` as a substring — exactly what `tokenSet.includes(q)` tests,
 * since a query token never contains the space that separates stored tokens.
 */
export function vocabMasks(page: SearchPage, qTokens: string[]): { masks: Uint32Array; words: number } {
  const words = Math.max(1, Math.ceil(qTokens.length / 32));
  const masks = new Uint32Array(page.vocab.length * words);
  if (qTokens.length === 0) return { masks, words };
  for (let v = 0; v < page.vocab.length; v++) {
    const term = page.vocab[v];
    for (let j = 0; j < qTokens.length; j++) {
      if (term.includes(qTokens[j])) masks[v * words + (j >>> 5)] |= 1 << (j & 31);
    }
  }
  return { masks, words };
}

/** `keywordMatchCount(qTokens, tokens)` for page row `r`, from {@link vocabMasks}. */
export function pageMatchCount(page: SearchPage, r: number, m: { masks: Uint32Array; words: number }, scratch: Uint32Array): number {
  scratch.fill(0, 0, m.words);
  for (let i = page.tokStart[r]; i < page.tokStart[r + 1]; i++) {
    const base = page.tokIds[i] * m.words;
    for (let w = 0; w < m.words; w++) scratch[w] |= m.masks[base + w];
  }
  let n = 0;
  for (let w = 0; w < m.words; w++) {
    let x = scratch[w];
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

/**
 * `keywordMatchCount(qTokens, \`${pathTokens} ${tokens}\`)` for a file row: a
 * query token counts once if it is in the live rel_path's tokens or the row's.
 */
export function pageMatchCountWithPath(
  page: SearchPage,
  r: number,
  m: { masks: Uint32Array; words: number },
  scratch: Uint32Array,
  qTokens: string[],
  pathTokens: string,
): number {
  scratch.fill(0, 0, m.words);
  for (let i = page.tokStart[r]; i < page.tokStart[r + 1]; i++) {
    const base = page.tokIds[i] * m.words;
    for (let w = 0; w < m.words; w++) scratch[w] |= m.masks[base + w];
  }
  let n = 0;
  for (let j = 0; j < qTokens.length; j++) {
    if ((scratch[j >>> 5] & (1 << (j & 31))) !== 0 || pathTokens.includes(qTokens[j])) n++;
  }
  return n;
}

// ── building ────────────────────────────────────────────────────────────────

const lastCheck = new Map<string, number>();

/**
 * Rebuild a keyed vault's pages of one kind when enough rows are not on a
 * fresh page. Background work only (key from the key cache, zeroed by the
 * caller). Checked at most every {@link SEARCH_PAGES_CHECK_GAP_MS}, rebuilt at
 * most every {@link SEARCH_PAGES_REBUILD_GAP_MS}.
 */
export async function refreshSearchPages(
  c: DocCrypto,
  kind: PageKind,
  db: Connectable = defaultPool,
  opts: { force?: boolean; now?: number } = {},
): Promise<"built" | "fresh" | "small" | "waiting"> {
  const now = opts.now ?? Date.now();
  const checkKey = `${c.vaultId}|${kind}`;
  if (!opts.force && now - (lastCheck.get(checkKey) ?? 0) < SEARCH_PAGES_CHECK_GAP_MS) return "waiting";
  lastCheck.set(checkKey, now);
  const { table, key } = TABLES[kind];
  const { rows } = await db.query<{ total: string; fresh: string; built_at: Date | null }>(
    `SELECT (SELECT count(*) FROM ${table} WHERE vault_id = $1 AND search_score_enc IS NOT NULL) AS total,
            (SELECT count(*) FROM search_pages p
               CROSS JOIN LATERAL unnest(p.doc_ids, p.stamps) AS u(id, stamp)
               JOIN ${table} t ON t.${key} = u.id AND t.vault_id = $1 AND t.updated_at::text = u.stamp
              WHERE p.vault_id = $1 AND p.kind = $2 AND p.generation = $3) AS fresh,
            (SELECT max(built_at) FROM search_pages WHERE vault_id = $1 AND kind = $2) AS built_at`,
    [c.vaultId, kind, c.generation],
  );
  const total = Number(rows[0]?.total ?? 0);
  const fresh = Number(rows[0]?.fresh ?? 0);
  const builtAt = rows[0]?.built_at ? rows[0].built_at.getTime() : null;
  if (!opts.force && total < SEARCH_PAGES_MIN_ROWS) return "small";
  const stale = total - fresh;
  if (!opts.force && stale < Math.max(SEARCH_PAGES_STALE_ROWS, total * SEARCH_PAGES_STALE_SHARE)) return "fresh";
  if (!opts.force && builtAt !== null && now - builtAt < SEARCH_PAGES_REBUILD_GAP_MS) return "waiting";
  await buildSearchPages(c, kind, db);
  return "built";
}

/** Read every scorable row of the vault and replace its pages of `kind`. */
export async function buildSearchPages(c: DocCrypto, kind: PageKind, db: Connectable = defaultPool): Promise<number> {
  const { table, key } = TABLES[kind];
  const open1 = (id: string, enc: Buffer): SealedScoreRow =>
    kind === "note" ? openScoreRow(c, id, enc) : openBlobScoreRow(c, id, enc);
  const sealed: Array<{ ids: string[]; stamps: string[]; enc: Buffer }> = [];
  let pending: PageRowSource[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const pageNo = sealed.length;
    const enc = sealPage(c, kind, pageNo, pending);
    // Verified before it is kept: open it back and compare every row.
    const back = openPage(c, kind, pageNo, enc, pending.map((r) => r.id), pending.map((r) => r.stamp));
    pending.forEach((r, i) => {
      const v = back.vectors.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM);
      for (let d = 0; d < EMBED_DIM; d++) if (!Object.is(v[d], r.vector[d])) throw new Error("search page: vector mismatch");
      if (pageRowTokens(back, i) !== r.tokens) throw new Error("search page: tokens mismatch");
    });
    sealed.push({ ids: pending.map((r) => r.id), stamps: pending.map((r) => r.stamp), enc });
    pending = [];
  };
  let after = "";
  for (;;) {
    const { rows } = await db.query<{ id: string; stamp: string; enc: Buffer }>(
      `SELECT ${key} AS id, updated_at::text AS stamp, search_score_enc AS enc
         FROM ${table}
        WHERE vault_id = $1 AND ${key} > $2 AND search_score_enc IS NOT NULL
        ORDER BY ${key}
        LIMIT 1000`,
      [c.vaultId, after],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      let s: SealedScoreRow;
      try {
        s = open1(r.id, r.enc);
      } catch {
        continue; // scored from its own row, as today
      }
      // Only rows whose score answers alone; the rest keep the per-row path.
      if (!Array.isArray(s.vector) || s.vector.length !== EMBED_DIM || typeof s.tokens !== "string") continue;
      if (!s.vector.every((x) => typeof x === "number" && Number.isFinite(x))) continue;
      if (s.tokens.includes("\n")) continue;
      pending.push({ id: r.id, stamp: r.stamp, vector: s.vector, tokens: s.tokens });
      if (pending.length >= PAGE_ROWS) flush();
    }
    after = rows[rows.length - 1].id;
    if (rows.length < 1000) break;
  }
  flush();

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`search-pages:${c.vaultId}:${kind}`]);
    await client.query("DELETE FROM search_pages WHERE vault_id = $1 AND kind = $2", [c.vaultId, kind]);
    for (const [pageNo, p] of sealed.entries()) {
      await client.query(
        `INSERT INTO search_pages (vault_id, kind, page_no, generation, doc_ids, stamps, page_enc)
         VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7)`,
        [c.vaultId, kind, pageNo, c.generation, p.ids, p.stamps, p.enc],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return sealed.length;
}

/** Forget the per-process check times (tests). */
export function resetSearchPageChecks(): void {
  lastCheck.clear();
}
