-- Purge derived index rows stranded by deleted notes, and index note_index for
-- the batched search scan.
--
-- note_index / note_links are a rebuildable cache derived from the canonical
-- Yjs state (see migration 005). Soft-deleting a note (notes.deleted_at) never
-- dropped them: registry.ts flipped deleted_at, the folder cascade did the same
-- for a whole subtree, and indexer.indexDoc early-returned before its own
-- DELETE because the note was already gone. So every deleted note kept a FULL
-- plain-text copy of its body in note_index forever, plus wikilink edges in
-- note_links. That is unbounded table growth and a privacy problem ("deleted"
-- content still readable server-side).
--
-- The write paths now purge on delete (src/http/routes/registry.ts,
-- src/mcp/service.ts) and indexer.indexDoc self-heals when it finds no live
-- note row. This clears the backlog. Nothing here is destructive to any source
-- of truth: every row deleted below belongs to a doc with no live `notes` row,
-- and a live note's rows can always be re-derived by re-indexing.

DELETE FROM note_index ni
 WHERE NOT EXISTS (
   SELECT 1 FROM notes n WHERE n.id = ni.doc_id AND n.deleted_at IS NULL
 );

DELETE FROM note_links nl
 WHERE NOT EXISTS (
   SELECT 1 FROM notes n WHERE n.id = nl.from_doc AND n.deleted_at IS NULL
 );

-- Semantic search now walks a vault's note_index in keyset-paginated batches
-- (WHERE vault_id = $1 AND doc_id > $2 ORDER BY doc_id LIMIT n) instead of
-- selecting every row's body + vector at once. This composite index serves that
-- scan directly, so each batch is an ordered index range rather than a sort of
-- the whole vault. The existing single-column note_index_vault_idx becomes
-- redundant with it, but is left in place — dropping it is not worth a rewrite
-- of anything that may already depend on the name.
CREATE INDEX IF NOT EXISTS note_index_vault_doc_idx ON note_index (vault_id, doc_id);
