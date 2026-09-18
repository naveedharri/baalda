// Wire types for the bulk sync engine — the HAND-MIRRORED twin of the server's
// `apps/server/src/http/routes/bulk-types.ts`.
//
// The two packages cannot import from each other, so this file is a copy and
// must stay one: every field name, every status string and every error code
// below is part of an HTTP contract that a server one release older (or newer)
// also speaks. When you change a name here, change it there in the same PR —
// the same rule `ACCESS_CHECK_MAX` lives under in `api.ts`.
//
// Pure types + two tiny pure helpers: no imports, so anything may depend on it.

/** What a batch registration did with ONE item. */
export type BatchStatus = "created" | "adopted" | "conflict" | "error";

/**
 * What a batched content push did with ONE doc.
 *
 * `conflict` is the safety valve behind {@link DocPushItem.expectEmpty}: the
 * client seeded a doc from its FILE because the server said it held nothing,
 * and by the time the request landed the server held something after all.
 * Nothing is applied — see `docBatchPush.ts` for what the client then does,
 * which is emphatically not "send it anyway".
 */
export type PushStatus =
  | "applied"
  | "skipped"
  | "conflict"
  | "denied"
  | "too_large"
  | "error";

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
  /** The PARENT PATH, never a folder id: the server resolves the parent inside
   *  the same request, which is what removes the cross-chunk ordering hazard a
   *  `folderId` would reintroduce. */
  folderPath?: string | null;
}

export interface NoteBatchResult {
  /** The row's CANONICAL spelling, exactly as `POST /api/notes` echoes it — the
   *  client compares it against what it sent to detect a duplicate-path alias. */
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
 * One doc's content push.
 *
 * `expectEmpty` means: the client seeded `update` from the local FILE because
 * the server said this doc was empty. The server MUST re-check, under the
 * per-doc lock, that its stored state has no content (Y.Text "content" length 0
 * after loading) before applying; if it now has content the answer is
 * `conflict` and nothing is applied. WITHOUT the flag the update is a merge of
 * CRDT state that already exists on this device, which is applied
 * unconditionally (Yjs updates are keyed by `(clientId, clock)`, so a re-send is
 * a no-op — that is the idempotency proof).
 */
export interface DocPushItem {
  docId: string;
  /** base64 Yjs **V1** update. V2 merges are unsafe (yjs#687) and the store is V1. */
  update: string;
  expectEmpty?: boolean;
}

export interface DocPushResult {
  docId: string;
  status: PushStatus;
  code: string | null;
  error: string | null;
}

/**
 * What a batched soft delete did with ONE note.
 *
 * `deleted` is the SAME write `DELETE /api/notes/:id` makes — a `deleted_at`
 * stamp, with the doc_id and the Yjs doc left intact — so a client cannot tell
 * the two routes apart by their effect, only by how many requests it sent.
 * `denied` means the caller may not edit that note and its mapping must SURVIVE:
 * dropping it locally would let the next pull re-materialize the file as a
 * stranger. An `error` carrying `unknown_note` is the batch's 404 — the row is
 * already gone, which is the goal state, and the client counts it as done.
 */
export type DeleteStatus = "deleted" | "denied" | "error";

export interface NoteDeleteResult {
  docId: string;
  status: DeleteStatus;
  code: string | null;
  error: string | null;
}

/** The answer to `POST /api/vaults/:vaultId/bootstrap`. */
export interface BootstrapSession {
  sessionId: string;
  /** Docs with stored bytes — the download set this session will page out. */
  docs: number;
  bytes: number;
  /** Readable docs the server holds NO bytes for: nothing to download, and the
   *  push side's work list (the same statement `ready.empty` makes). */
  emptyDocs: string[];
  emptyTruncated: boolean;
  expiresAt: string;
}

/** One decoded page of the bootstrap stream (see `bootstrapCodec.ts`). */
export interface BootstrapPage {
  docs: Array<{ docId: string; relPath: string; update: Uint8Array }>;
  /** `null` ⇒ the session is drained. */
  nextCursor: number | null;
  /** Uncompressed payload bytes, as the server counted them. */
  bytes: number;
}

/**
 * Every error code either side may name — exhaustive, and deliberately a union
 * rather than a `string`, so a typo cannot quietly become a new code.
 *
 * `server_too_old` is CLIENT-SIDE ONLY: no server ever sends it. It is what a
 * 404 on any bulk route means, and it is terminal — there is no silent per-note
 * fallback (design §3.7, a hard cut).
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
  | "unknown_note"
  | "note_too_large"
  | "vault_limit_reached"
  | "session_expired"
  | "bootstrap_busy"
  | "server_too_old";

/** The codes above, as a runtime set (a request's `code` arrives as a string). */
export const BULK_ERROR_CODES: readonly BulkErrorCode[] = [
  "unknown_vault",
  "not_a_member",
  "batch_too_large",
  "invalid_body",
  "doc_id_conflict",
  "path_folder_mismatch",
  "root_frozen",
  "no_write_access",
  "no_edit_permission",
  "unknown_note",
  "note_too_large",
  "vault_limit_reached",
  "session_expired",
  "bootstrap_busy",
  "server_too_old",
];

/** Narrow an arbitrary server-supplied string to a code we know. */
export function isBulkErrorCode(code: string | null | undefined): code is BulkErrorCode {
  return code != null && (BULK_ERROR_CODES as readonly string[]).includes(code);
}
