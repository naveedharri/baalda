// SPDX-License-Identifier: Apache-2.0
//
// The attachment reference rule for keyed vaults (W3). Today's rule: a scoped
// member may read an `attachments/` blob iff some note they can read has the
// blob's rel_path as a case-sensitive substring of its indexed body
// (`note_index.content`; the `ref_text` excerpt is an optimisation giving the
// same answer). A sealed row is judged in memory with the REQUEST's key and the
// identical predicate (`String.includes`), so nobody gains or loses access:
// from its sealed excerpt (`ref_enc`, migration 104) when that covers the
// paths asked about, else from its decrypted body. Plaintext rows keep the SQL
// path unchanged; sealed rows are excluded from it (their plaintext columns
// may be stale).
import { createHash } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocCrypto } from "../crypto/doc-crypto.js";
import { KeyRequiredError, loadVkCheck } from "../crypto/transport.js";
import { openRefText, openSearchRow, sealRefText } from "../index/sealed-index.js";
import { cachedRefHeads, REF_WINDOW_CHARS, refText } from "../blobs/ref-windows.js";

type Queryable = Pick<pg.Pool, "query">;

/** Is this vault keyed? One primary-key lookup; unkeyed = today's SQL exactly. */
export async function vaultIsKeyed(vaultId: string, db: Queryable = defaultPool): Promise<boolean> {
  return (await loadVkCheck(vaultId, db)) !== null;
}

/** Notes whose body one query reads: a handful of MB at most, far inside the
 *  statement timeout (the old single query read every body at once). */
const BODY_CHUNK = 50;

/**
 * Answers for paths with no `/` (no anchor, so no excerpt can hold them),
 * per note and per state of its row. A doc-less blob at the vault root that no
 * note mentions would otherwise send every list back to every body, every
 * time. Booleans about paths, in process memory only, keyed by the row's
 * index stamp so an edit asks again; bounded, cleared whole when full.
 */
const BARE_MEMO_MAX = 200_000;
const bareMemo = new Map<string, { stamp: string; found: Map<string, boolean> }>();
function bareAnswer(vaultId: string, docId: string, stamp: string, path: string): boolean | undefined {
  const m = bareMemo.get(`${vaultId}|${docId}`);
  return m && m.stamp === stamp ? m.found.get(path) : undefined;
}
function rememberBare(vaultId: string, docId: string, stamp: string, answers: Array<[string, boolean]>): void {
  const key = `${vaultId}|${docId}`;
  let m = bareMemo.get(key);
  if (!m || m.stamp !== stamp) {
    if (!m && bareMemo.size >= BARE_MEMO_MAX) bareMemo.clear();
    m = { stamp, found: new Map() };
    bareMemo.set(key, m);
  }
  for (const [p, v] of answers) m.found.set(p, v);
}
/** Test hook. */
export function clearBarePathMemo(): void {
  bareMemo.clear();
}

/** A list slower than this logs its counts (ids and counts only). */
const SLOW_LIST_MS = 1_000;

function anchorOf(path: string): string | null {
  const slash = path.indexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : null;
}

/**
 * The paths (of `paths`) that some readable SEALED note body contains.
 * Throws {@link KeyRequiredError} when sealed readable rows exist and no key
 * was presented: refusing is the only answer that cannot change access.
 *
 * Every sealed row's whole search row used to be read and opened per call: a
 * 14k-note vault's attachment list read ~400 MB and hit the statement timeout
 * on every try (2026-11-20 →). A row's excerpt holds every occurrence of each
 * of its heads with the next {@link REF_WINDOW_CHARS} characters, so for a path
 * whose anchor is a head and whose rest fits the window the excerpt gives the
 * body's answer; a longer path is looked for in the body only where the
 * excerpt holds its start. Rows with no current excerpt are read in chunks and
 * given one (healed) while their body is still the one read.
 */
export async function sealedReferencedPaths(
  vaultId: string,
  readableIds: string[],
  paths: string[],
  crypto: DocCrypto | undefined,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  const hit = new Set<string>();
  if (readableIds.length === 0 || paths.length === 0) return hit;
  const needed = [...new Set(paths.map(anchorOf).filter((a): a is string => a !== null))];
  const started = Date.now();
  const bare = paths.filter((p) => anchorOf(p) === null);
  const { rows } = await db.query<{ doc_id: string; ref_enc: Buffer | null; stamp: string }>(
    // The stamp names the row's state without reading the body
    // (`octet_length` of a stored value reads its header, not its bytes).
    `SELECT doc_id, CASE WHEN ref_enc IS NOT NULL AND ref_heads @> $3::text[] THEN ref_enc END AS ref_enc,
            updated_at::text || ':' || octet_length(search_enc) AS stamp
       FROM note_index
      WHERE vault_id = $1 AND doc_id = ANY($2::text[]) AND search_enc IS NOT NULL`,
    [vaultId, readableIds, needed],
  );
  if (rows.length === 0) return hit;
  if (!crypto) throw new KeyRequiredError();

  const bodyFor: string[] = [];
  const unreadable = new Set<string>();
  const stampOf = new Map<string, string>();
  let fromExcerpt = 0;
  for (const r of rows) {
    stampOf.set(r.doc_id, r.stamp);
    // Bare paths this note was already read for, in this state of its row.
    for (const p of bare) if (!hit.has(p) && bareAnswer(vaultId, r.doc_id, r.stamp, p) === true) hit.add(p);
    if (!r.ref_enc) {
      bodyFor.push(r.doc_id);
      continue;
    }
    let excerpt: string;
    try {
      excerpt = openRefText(crypto, r.doc_id, r.ref_enc);
    } catch {
      unreadable.add(r.doc_id);
      bodyFor.push(r.doc_id);
      continue;
    }
    fromExcerpt++;
    let needsBody = false;
    for (const p of paths) {
      if (hit.has(p)) continue;
      const anchor = anchorOf(p);
      // No anchor: only the body can say, unless this note was read for it already.
      if (anchor === null) {
        if (bareAnswer(vaultId, r.doc_id, r.stamp, p) === undefined) needsBody = true;
      } else if (p.length - anchor.length <= REF_WINDOW_CHARS) {
        if (excerpt.includes(p)) hit.add(p);
      } else if (excerpt.includes(p.slice(0, anchor.length + REF_WINDOW_CHARS))) needsBody = true;
    }
    if (needsBody) bodyFor.push(r.doc_id);
  }
  let bodies = 0;
  let healed = 0;
  const done = () => {
    const ms = Date.now() - started;
    if (ms > SLOW_LIST_MS) {
      console.warn(
        `[sealed-refs] vault=${vaultId} rows=${rows.length} paths=${paths.length} bare=${bare.length} fromExcerpt=${fromExcerpt} ` +
          `bodies=${bodies} healed=${healed} hits=${hit.size} ms=${ms}`,
      );
    }
    return hit;
  };
  if (bodyFor.length === 0 || hit.size === paths.length) return done();

  const heads = await cachedRefHeads(vaultId, db);
  for (let i = 0; i < bodyFor.length && hit.size < paths.length; i += BODY_CHUNK) {
    const { rows: chunk } = await db.query<{ doc_id: string; search_enc: Buffer; covered: boolean }>(
      `SELECT doc_id, search_enc, (ref_enc IS NOT NULL AND ref_heads @> $3::text[]) AS covered
         FROM note_index
        WHERE vault_id = $1 AND doc_id = ANY($2::text[]) AND search_enc IS NOT NULL`,
      [vaultId, bodyFor.slice(i, i + BODY_CHUNK), heads],
    );
    const heal: Array<{ id: string; enc: Buffer; sum: string }> = [];
    for (const b of chunk) {
      bodies++;
      const body = openSearchRow(crypto, b.doc_id, b.search_enc).body;
      const stamp = stampOf.get(b.doc_id);
      if (stamp && bare.length > 0) rememberBare(vaultId, b.doc_id, stamp, bare.map((p) => [p, body.includes(p)]));
      // The excerpt answers for every path it can (scanning a few KB, not the
      // whole body once per path); the body only for the rest.
      const excerpt = refText(body, heads);
      for (const p of paths) {
        if (hit.has(p)) continue;
        const anchor = anchorOf(p);
        const useExcerpt = anchor !== null && heads.includes(anchor) && p.length - anchor.length <= REF_WINDOW_CHARS;
        if (useExcerpt ? excerpt.includes(p) : body.includes(p)) hit.add(p);
      }
      if (b.covered && !unreadable.has(b.doc_id)) continue;
      const enc = sealRefText(crypto, b.doc_id, excerpt);
      if (enc) heal.push({ id: b.doc_id, enc, sum: createHash("md5").update(b.search_enc).digest("hex") });
    }
    if (heal.length > 0) {
      await healExcerpts(vaultId, heads, heal, db);
      healed += heal.length;
    }
  }
  return done();
}

/**
 * Store excerpts cut from bodies just read, each only while its row still
 * holds that body (an edit since rewrote `search_enc` and its own excerpt).
 * A failed write only means the next list reads those bodies again.
 */
async function healExcerpts(
  vaultId: string,
  heads: string[],
  heal: Array<{ id: string; enc: Buffer; sum: string }>,
  db: Queryable,
): Promise<void> {
  try {
    await db.query(
      `UPDATE note_index n SET ref_enc = u.enc, ref_heads = $2::text[]
         FROM unnest($3::text[], $4::bytea[], $5::text[]) AS u(id, enc, sum)
        WHERE n.vault_id = $1 AND n.doc_id = u.id
          -- IS TRUE keeps this out of the join keys: as a plain equality the
          -- planner hashed md5() of every body in the vault, per chunk.
          AND (md5(n.search_enc) = u.sum) IS TRUE`,
      [vaultId, heads, heal.map((h) => h.id), heal.map((h) => h.enc), heal.map((h) => h.sum)],
    );
  } catch (err) {
    console.warn(`[sealed-refs] vault=${vaultId} storing ${heal.length} excerpts failed:`, (err as Error).message);
  }
}
