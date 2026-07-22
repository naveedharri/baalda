import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { cosineSimilarity, embed, tokenize } from "../../index/embedder.js";

/**
 * Read-only views over the note index (spec: links + vectors).
 *
 *  - GET /api/vaults/:vaultId/graph  → nodes + wikilink edges for a graph view.
 *  - GET /api/vaults/:vaultId/search → semantic + keyword search over notes.
 *
 * Both are gated like GET /vaults/:vaultId/locks: any member of the vault
 * may read.
 */
export const graphRoutes = new Hono();

/** Filename stem of a rel_path (drop directories + extension). */
function relPathStem(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}

/** Gate: caller must be a member of the vault. 404/403 otherwise. */
async function gateVaultMember(
  vaultId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
  const org = await vaultOrg(vaultId);
  if (!org) return { ok: false, status: 404, error: "Unknown vault" };
  if (!(await orgRole(org, userId))) {
    return { ok: false, status: 403, error: "Not a member of this vault" };
  }
  return { ok: true };
}

// Graph: every note in the vault plus its outgoing wikilink edges. `toDocId` is
// resolved by matching a link's raw title against note titles / rel_path stems
// (case-insensitive) in the same vault; unresolved links keep toDocId = null.
graphRoutes.get("/vaults/:vaultId/graph", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const vaultId = c.req.param("vaultId");

  const gate = await gateVaultMember(vaultId, session.userId);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);

  const { rows: noteRows } = await pool.query<{
    id: string;
    title: string | null;
    rel_path: string;
  }>(
    `SELECT id, title, rel_path FROM notes
      WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path`,
    [vaultId],
  );

  const nodes = noteRows.map((n) => ({
    docId: n.id,
    title: n.title ?? relPathStem(n.rel_path),
    relPath: n.rel_path,
  }));

  // Resolve targets by lowercased title AND rel_path stem.
  const byTitle = new Map<string, string>();
  for (const n of noteRows) {
    const title = (n.title ?? relPathStem(n.rel_path)).toLowerCase();
    if (!byTitle.has(title)) byTitle.set(title, n.id);
    const stem = relPathStem(n.rel_path).toLowerCase();
    if (!byTitle.has(stem)) byTitle.set(stem, n.id);
  }

  const { rows: linkRows } = await pool.query<{ from_doc: string; to_title: string }>(
    "SELECT from_doc, to_title FROM note_links WHERE vault_id = $1",
    [vaultId],
  );
  const links = linkRows.map((l) => ({
    fromDoc: l.from_doc,
    toTitle: l.to_title,
    toDocId: byTitle.get(l.to_title.toLowerCase()) ?? null,
  }));

  return c.json({ nodes, links });
});

// Search: cosine similarity between embed(q) and each note's stored vector,
// plus a small keyword-match boost. Sorted by score desc, capped at k.
graphRoutes.get("/vaults/:vaultId/search", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const vaultId = c.req.param("vaultId");

  const gate = await gateVaultMember(vaultId, session.userId);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);

  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "q query param required" }, 400);
  const kRaw = Number.parseInt(c.req.query("k") ?? "10", 10);
  const k = Number.isNaN(kRaw) || kRaw <= 0 ? 10 : Math.min(kRaw, 100);

  const { rows } = await pool.query<{
    doc_id: string;
    title: string | null;
    rel_path: string;
    content: string;
    vector: number[] | null;
  }>(
    `SELECT ni.doc_id, ni.title, n.rel_path, ni.content, ni.vector
       FROM note_index ni
       JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
      WHERE ni.vault_id = $1`,
    [vaultId],
  );

  const qVec = embed(q);
  const qTokens = Array.from(new Set(tokenize(q)));

  const results = rows
    .map((r) => {
      const sim = r.vector ? cosineSimilarity(qVec, r.vector) : 0;
      // Keyword boost: fraction of distinct query tokens present in the
      // title/body, scaled small so it only breaks near-ties.
      const haystack = `${r.title ?? ""} ${r.content}`.toLowerCase();
      const matched = qTokens.filter((t) => haystack.includes(t)).length;
      const boost = qTokens.length > 0 ? 0.1 * (matched / qTokens.length) : 0;
      return {
        docId: r.doc_id,
        title: r.title ?? relPathStem(r.rel_path),
        relPath: r.rel_path,
        score: sim + boost,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return c.json({ results });
});
