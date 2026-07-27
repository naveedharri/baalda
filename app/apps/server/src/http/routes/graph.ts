import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { listReadableDocsInVault } from "../../permissions/vault-docs.js";
import { getSession } from "../session.js";
import { searchNoteIndex } from "../../index/indexer.js";

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

  const { rows: allNoteRows } = await pool.query<{
    id: string;
    title: string | null;
    rel_path: string;
  }>(
    `SELECT id, title, rel_path FROM notes
      WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path`,
    [vaultId],
  );

  // Private-by-default: restrict the graph to notes the caller may read, so a
  // member can't harvest every private note's id/title/path. Owner/admin and
  // Open vaults get the full set from the resolver. Mirrors GET /notes.
  const readable = await listReadableDocsInVault(session.userId, vaultId);
  const noteRows = allNoteRows.filter((n) => readable.has(n.id));

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

  // The JOIN keeps edges of soft-deleted notes out of the graph. The delete
  // paths now purge note_links (registry.ts / indexer.ts), so this is a
  // belt-and-braces guard against any row that outlives its note — and it means
  // the rows never reach the heap in the first place.
  const { rows: linkRows } = await pool.query<{ from_doc: string; to_title: string }>(
    `SELECT l.from_doc, l.to_title
       FROM note_links l
       JOIN notes n ON n.id = l.from_doc AND n.deleted_at IS NULL
      WHERE l.vault_id = $1`,
    [vaultId],
  );
  // Only edges out of a readable note; targets already resolve within the
  // readable node set (byTitle is built from noteRows).
  const links = linkRows
    .filter((l) => readable.has(l.from_doc))
    .map((l) => ({
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

  // Restrict the candidate set to readable notes: the score is computed over
  // note content, so scoring unreadable notes would be a content oracle.
  // Mirrors the MCP search tool. Owner/admin + Open vaults see everything.
  const readable = await listReadableDocsInVault(session.userId, vaultId);

  // Scoring lives in index/indexer.ts, which walks the vault in keyset batches
  // and keeps only {docId, score} per note — note bodies and embedding vectors
  // are no longer all pulled into the heap just to slice off the top k.
  // Identical ranking + response shape.
  const results = await searchNoteIndex({
    vaultId,
    query: q,
    k,
    readableDocIds: readable,
  });

  return c.json({ results });
});
