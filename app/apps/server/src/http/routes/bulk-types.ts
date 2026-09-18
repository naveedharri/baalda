/**
 * Wire types for the bulk sync engine — the server half of a HAND-MIRRORED pair
 * with `apps/desktop/src/lib/sync/bulkTypes.ts`.
 *
 * Nothing generates one from the other on purpose: the two packages do not share
 * a build, and a shared package would drag the server's `pg` types into the
 * desktop bundle. The rule is instead that this file is the transcription of
 * CONTRACT §2 and the desktop's copy is its twin — change one, change both, in
 * the same PR.
 *
 * Every field here crosses a network between versions that auto-update at
 * different moments, so the shapes are additive-only: a new optional field is
 * fine, a renamed or re-typed one is not.
 */

/** Outcome of registering ONE structural row (folder / note / file).
 *
 *  · `created` — this request inserted the row.
 *  · `adopted` — a row was already there (same path, or the same id) and the
 *    caller should take ITS id and ITS canonical spelling. The normal case on
 *    every pass after the first; never an error.
 *  · `conflict` — the id the caller asked for belongs somewhere else (another
 *    vault). Terminal for that item; the caller must mint a new id.
 *  · `error`   — refused (`code` says why). Per item, never fatal to the batch.
 */
export type BatchStatus = "created" | "adopted" | "conflict" | "error";

/** Outcome of pushing ONE doc's CRDT update.
 *
 *  · `applied`   — the merge captured new ops and they are persisted + fanned out.
 *  · `skipped`   — the merge captured nothing: the server already held every op in
 *    the update. This is the idempotency proof — a retried push is free.
 *  · `conflict`  — `expectEmpty` was set and the server's stored state is NOT
 *    empty any more. Nothing was applied; the client must re-read before seeding.
 *  · `denied`    — the caller may not edit this doc (`no_edit_permission`).
 *  · `too_large` — the decoded update exceeds the per-note ceiling.
 *  · `error`     — anything else, per item.
 */
export type PushStatus = "applied" | "skipped" | "conflict" | "denied" | "too_large" | "error";

export interface FolderBatchItem {
  path: string;
  name: string;
  color?: string | null;
}

export interface FolderBatchResult {
  path: string;
  id: string | null;
  status: BatchStatus;
  code: string | null;
  error: string | null;
}

export interface NoteBatchItem {
  docId?: string;
  relPath: string;
  title?: string | null;
  /** The folder the note lives in, BY PATH. Deliberately not a folderId: paths
   *  need no cross-chunk ordering, so a note may be registered in the same pass
   *  as (or before the client has learned the id of) its folder. */
  folderPath?: string | null;
}

export interface NoteBatchResult {
  /** The row's CANONICAL spelling, which may differ in case from what was sent. */
  relPath: string;
  docId: string | null;
  status: BatchStatus;
  folderId: string | null;
  title: string | null;
  code: string | null;
  error: string | null;
}

export interface FileBatchItem {
  fileId?: string;
  relPath: string;
  folderPath?: string | null;
  /** Content hash + size + mime of the BYTES. Carried for the blob store's
   *  benefit; the `files` row itself is identity + path only. */
  sha256: string;
  size: number;
  mime: string | null;
}

export interface FileBatchResult {
  relPath: string;
  fileId: string | null;
  status: BatchStatus;
  folderId: string | null;
  code: string | null;
  error: string | null;
}

/**
 * One doc's CRDT push.
 *
 * `expectEmpty`: the client seeded `update` from the local FILE because the
 * server said this doc was empty. The server MUST re-check, under the per-doc
 * lock, that its stored state for the doc has no content (Y.Text "content"
 * length 0 after loading) before applying; if it now has content → status
 * "conflict", apply nothing. Without `expectEmpty` the update is a merge of
 * existing CRDT state and is applied unconditionally (Yjs is idempotent).
 */
export interface DocPushItem {
  docId: string;
  /** base64 Yjs V1 update. */
  update: string;
  expectEmpty?: boolean;
}

export interface DocPushResult {
  docId: string;
  status: PushStatus;
  code: string | null;
  error: string | null;
}

/** A bootstrap download session: a MATERIALISED, ACL-resolved doc list with a
 *  stable order, so every page is an index-only keyset read rather than a
 *  re-run of the permission CTEs. */
export interface BootstrapSession {
  sessionId: string;
  /** Docs in the DOWNLOAD set (stored bytes > 0). */
  docs: number;
  /** Uncompressed byte total of that set — an honest progress denominator. */
  bytes: number;
  /** Readable docs the server holds NO bytes for. These are the UPLOAD set:
   *  the client seeds them from its own disk. Capped (see `emptyTruncated`). */
  emptyDocs: string[];
  emptyTruncated: boolean;
  /** ISO-8601. Past it the session is swept and a GET answers 410. */
  expiresAt: string;
}

/** One decoded page of the bootstrap stream. */
export interface BootstrapPage {
  docs: Array<{ docId: string; relPath: string; update: Uint8Array }>;
  /** `null` ⇒ the session is drained. */
  nextCursor: number | null;
  bytes: number;
}

/**
 * Every error code these routes emit, exhaustively.
 *
 * `server_too_old` is client-side only — the desktop synthesises it on a 404
 * from any of these paths, which is how a new client meets an old server.
 */
export type BulkErrorCode =
  | "unknown_vault"
  | "not_a_member"
  | "batch_too_large"
  | "invalid_body"
  | "doc_id_conflict"
  | "path_folder_mismatch"
  | "root_frozen"
  | "no_write_access"
  | "no_edit_permission"
  | "note_too_large"
  | "vault_limit_reached"
  | "session_expired"
  | "bootstrap_busy"
  | "server_too_old";
