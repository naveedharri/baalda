// Vault ↔ server registry reconciliation (spec 03 §5 "doc registry mapping").
//
// On vault-connect (signed in, with an active org) we make the server aware of
// this vault's folders and notes so that `doc_id`s are STABLE and SHARED across
// devices. We adopt existing server rows by path, and for anything missing we
// create it USING THE LOCAL INDEX doc_id (the server honours a supplied id) so a
// note keeps one identity across its .md file, the local CRDT store, and the
// server. The resulting {relPath → {vaultId, docId}} map is what the sync layer
// uses to name Hocuspocus documents.
//
// The mapping is persisted to the vault's own `.context/config.json` (via ipc),
// so it travels with the vault, not the app profile.
//
// Bulk behaviour (phase 2). Registering a large vault is a bounded, checkpointed,
// cancellable, honest operation:
//   • bounded — folders (level by level, parents first) and notes go through a
//     `runPool` at `REGISTRY_CONCURRENCY`, not a sequential await-in-a-loop;
//   • checkpointed — the doc-id map is flushed incrementally (`Checkpointer`), so
//     a kill -9 at note 200/500 keeps the first 200 and the next run resumes;
//   • cancellable — every lane re-checks the VaultScope before each item;
//   • honest — a per-item failure is retried with backoff and then RECORDED
//     (`failures()`), so a vault with failures can never report fully synced.

import {
  ACCESS_CHECK_MAX,
  ApiClient,
  ApiError,
  isServerTooOld,
  noteCreatedBy,
  noteDocId,
  noteLastEdited,
  noteRelPath,
  vaultOrgId,
  type NoteLastEdited,
  type RegisteredFolder,
  type RegisteredNote,
} from "../api";
import * as ipc from "../ipc";
import type { TreeNode } from "../ipc";
import * as perf from "../perf";
import { seedWelcomeContent } from "../vault/seed";
import { Checkpointer, checkpointBatchFor } from "./checkpoint";
import { sha256Hex } from "../bridge/adapter";
import { mergeSv, svFromBase64, svIsEmpty, svToBase64, unseenWork } from "./ackedSv";
import { reconcileReport } from "./reconcileReport";

/** Timestamped `.context/trash` folder for an inbound-removal recovery copy. */
function recoveryStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** The server's creation timestamp for a listed note, when it says. */
function noteCreatedAtOf(n: RegisteredNote): string | null {
  return n.createdAt ?? n.created_at ?? null;
}

/** `dir/stem (conflict YYYY-MM-DD).ext`, with ` 2`, ` 3`… until free (case-insensitive). */
export function conflictPath(relPath: string, taken: ReadonlySet<string>, now = new Date()): string {
  const slash = relPath.lastIndexOf("/");
  const dir = slash >= 0 ? relPath.slice(0, slash + 1) : "";
  const name = relPath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const day = now.toISOString().slice(0, 10);
  for (let i = 1; ; i++) {
    const candidate = `${dir}${stem} (conflict ${day}${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
import { planInbound, samePath, type InboundPlan, type InboundTrash } from "./inbound";
import type { BootstrapResume } from "./bootstrap";
import type { FolderBatchItem, NoteBatchItem, NoteDeleteResult } from "./bulkTypes";
import {
  BATCH_MAX_FOLDERS,
  BATCH_MAX_NOTES,
  IPC_CONCURRENCY,
  REGISTRY_CONCURRENCY,
  runPool,
  useBulkPath,
  withRetry,
} from "./pool";
import { nullProgressSink, type SyncProgressSink } from "./progress";
import { isSymlinkRefusal, SYMLINK_REFUSAL_REASON } from "./linkRefusals";
import { toast } from "../toast";
import { vaultScopes, type VaultScope, type VaultScopeSource } from "./vaultScope";

export interface DocMapping {
  vaultId: string;
  docId: string;
}

/**
 * What {@link VaultRegistry.deletePaths} did with ONE path.
 *
 * Reported rather than thrown, because a batch has N answers: the single-item
 * `deletePath` says "done" by returning and "refused" by throwing, and this is
 * the same two verdicts per path — plus `denied`, which the single path spells
 * as a 403 thrown out of `deleteNote`.
 */
export interface NoteDeleteOutcome {
  path: string;
  /** `deleted` ⇒ the mapping is gone locally too; the other two keep it. */
  status: "deleted" | "denied" | "failed";
  reason: string | null;
  code: string | null;
}

interface VaultSyncConfig {
  /**
   * The vault (Better Auth org) this folder was last reconciled under. The
   * org→folder binding itself lives in webview localStorage (`context.orgVaults`),
   * which can be lost (reinstall, cleared storage, another device); this field is
   * what lets `store.setActiveOrganization` REDISCOVER the folder instead of
   * auto-creating a duplicate under the vaults root.
   */
  organizationId?: string;
  serverVaultId?: string;
  /** relPath → server docId (notes). */
  docs?: Record<string, string>;
  /** folder relPath → server folder id. */
  folders?: Record<string, string>;
  /**
   * TREE BINARY relPath → server `files` row id (PR3 Stage A).
   *
   * A separate key from `docs`, and it must stay separate: `docs` is the CRDT
   * note map that every sync path keys off, and a binary must never appear in
   * it (nothing about a `.docx` may reach `NoteBridge`, `ContentUploader` or
   * `registerNote`). All this remembers is "the server already has a `files`
   * row for this path under this id", so a reconnect skips the re-registration
   * round trip per binary.
   *
   * Like `docs` it is an optimization, never proof: re-registering is an
   * idempotent create with a client-supplied id, so a wiped `.context/` costs
   * one POST per binary and nothing else.
   */
  files?: Record<string, string>;
  /**
   * The subset of {@link files} whose BYTES this device has confirmed the
   * server holds: an upload that completed, a download, an intent that deduped
   * onto an existing row, or a listing whose sha matched the local file.
   *
   * Unlike {@link pushed} this IS a correctness gate, and it exists because
   * `files` is not one. A row is minted BEFORE its bytes move
   * (`attachments.ts ensureFileRow` / `preregisterFiles`), and the bytes can
   * then never follow — a Free vault's standalone file, one over the blob size
   * ceiling, one behind a full storage quota. Treating the row as proof of
   * possession is what would let a revocation take the only copy of that file
   * off the disk of the person who made it.
   *
   * Ids, not paths, so a rename carries the confirmation. ABSENT means
   * unconfirmed, which is how every config written before this key loads — the
   * safe direction, and one the next successful pass repairs by listing match
   * rather than by re-uploading anything.
   */
  filesConfirmed?: string[];
  /**
   * `files` id → the sha256 this device last agreed with the server on for that
   * file (uploaded, downloaded, or listed equal). The BASE of the blob mirror's
   * three-way decision (`attachments.ts planBinarySync`): local == base while the
   * server differs is a teammate's edit to download, local != base is a local
   * edit to upload with `baseSha`. Keyed by id so a rename carries it. Absent
   * means "no base", and a doc with no base never overwrites the server.
   */
  fileBases?: Record<string, string>;
  /**
   * docIds whose CONTENT this device has confirmed on the server (the bulk
   * upload's resume point — see `ContentUploader`).
   *
   * A "the server holds a copy" flag: the bulk upload's resume point and the
   * OUTBOUND delete-safety gate (a disk delete of a doc the server never held
   * is not propagated, because the only copy may be local). It is NEVER the
   * gate for accepting INBOUND destruction — a teammate's delete or a
   * revocation asks `hasUnseenWork` (the acknowledged state vector, `ackedSv`)
   * instead, since "confirmed once" says nothing about edits made since. The
   * vault channel's `ready.empty` stays the authority on what the server
   * actually holds. Correctness never depends on this list, because the upload
   * path is idempotent by construction (pull-before-seed; it only ever transmits
   * CRDT state that already exists locally, never re-inserts text). A missing
   * entry costs a round trip; a WRONG one (a crashed run, a wiped `.context/`,
   * a restored backup) would strand a note forever if anything treated it as
   * proof — which is why the server re-states the truth on every connect.
   */
  pushed?: string[];
  /**
   * docId → base64 Yjs state vector the SERVER is known to cover for that doc
   * (offline reconciliation, Phase 0; see `ackedSv.ts`). Recorded on Hocuspocus
   * `synced`, a batch-push ack, and a backfill/bootstrap apply. This, not
   * `pushed`, is the gate for accepting inbound destruction: a doc whose local
   * state vector it does not cover holds unseen work. Absent ⇒ never acked.
   */
  ackedSv?: Record<string, string>;
  /**
   * docIds whose current file is a registry-created 0-byte placeholder that
   * has not yet been hydrated. Persisted so a restart between materialization
   * and the canonical pull cannot turn the placeholder into a fake local edit.
   */
  unhydratedPlaceholders?: string[];
  /**
   * docId → relPath as of the last AGREED reconciliation, for THIS collection.
   *
   * The one piece of memory that makes inbound reconciliation possible: without a
   * prior agreement, "the server moved this note" and "we have never seen this
   * note" are indistinguishable, and so are "the server deleted it" and "it's new
   * here". `docs` can't serve — it's keyed by path (so a rename produces two
   * entries with no way to tell which is stale) and it's rewritten from scratch
   * every pass.
   *
   * Accumulates rather than mirroring `docs`: a doc whose access was revoked stays
   * here on purpose, so we keep recognising it as "was ours, now unreadable" and
   * keep leaving it alone. Dropping it would make the next pass see a brand-new
   * local note and re-register it — the ghost, back every other pull.
   */
  baseline?: Record<string, string>;
  /**
   * docIds a NAMED user is recorded as having authored, learned from the
   * listing's `created_by` and accumulated like {@link baseline}.
   *
   * Persisted by older clients for the former author-recovery policy. Current
   * deletion and revocation behavior is final regardless of authorship; the
   * field remains readable so existing config files stay compatible.
   *
   * The `userId` is not decoration. This file travels with the vault (it is
   * read on any device that opens the folder) and a device can be signed into a
   * different account tomorrow. Honouring a list that belonged to someone else
   * would attribute THEIR notes to THIS user. A list whose
   * `userId` does not match the session is dropped, not inherited. (An older
   * config's bare `string[]` is unattributable and is dropped for the same
   * reason; the next pass relearns it.)
   */
  authored?: { userId: string; docIds: string[] };
  /**
   * Where the bulk BOOTSTRAP download got to, so a killed run resumes instead of
   * re-paging the vault (`sync/bootstrap.ts`).
   *
   * Written through this same checkpointer — i.e. through the already-atomic
   * `set_vault_config` — and always AFTER the page it describes has been
   * applied, so the worst a crash can do is re-send one page, which the Rust
   * eligibility table makes a no-op. Guarded by `serverVaultId` like every other
   * key here: a cursor into another collection's session names nothing.
   */
  bootstrap?: BootstrapResume;
}

/**
 * A tree that came from `ipc.listTree` — the FULL recursive walk.
 *
 * The brand is unforgeable outside this module, so no caller can hand the LAZY
 * sidebar tree (`store.refreshTree` → `ipc.listChildren`, where unexpanded
 * folders carry placeholder children) to anything that mutates the disk. That
 * exact confusion is what once materialized empty files over 428 real notes, and
 * inbound reconciliation raises the stakes: a short tree would read as "the
 * server deleted everything I can't see".
 */
type FullTree = TreeNode & { readonly __fullTree: unique symbol };

/**
 * Rust stamps `childrenLoaded: true` on every directory in `list_tree` and
 * `false`/absent only on `list_children` placeholders, so this is a real check
 * rather than a formality.
 */
function assertFullTree(node: TreeNode): void {
  if (node.isDir && node.childrenLoaded !== true) {
    throw new Error(`[registry] partial tree at "${node.path}" — refusing to reconcile`);
  }
  for (const child of node.children ?? []) assertFullTree(child);
}

/**
 * How the registry asks the layers above it to let go of a doc before its path
 * moves or disappears.
 *
 * Injected rather than imported so this module stays free of the editor and the
 * background doc store (and unit-testable without either).
 */
/** Adopt a persisted `ackedSv` map, merging any acks recorded in memory since. */
function adoptAcked(
  rec: Record<string, string> | undefined,
  live: Map<string, string> | null,
): Map<string, string> {
  const out = new Map<string, string>();
  if (rec && typeof rec === "object" && !Array.isArray(rec)) {
    for (const [id, b64] of Object.entries(rec)) {
      if (id && typeof b64 === "string" && b64) out.set(id, b64);
    }
  }
  for (const [id, b64] of live ?? []) {
    const prev = out.get(id);
    const b = svFromBase64(b64);
    if (b) out.set(id, svToBase64(mergeSv(prev ? svFromBase64(prev) : null, b)));
  }
  return out;
}

export interface InboundHost {
  /**
   * This device's local Yjs state vector for `docId` (resident bridge first,
   * else the SQLite CRDT store), or null when it holds no CRDT for it. Used by
   * {@link VaultRegistry.hasUnseenWork}. Optional: no host ⇒ file fallback only.
   */
  localStateVector?(docId: string): Promise<Uint8Array | null>;
  /**
   * `docId` was deleted on the server while this device held unseen work.
   * Push its local CRDT to the server's soft-deleted copy if the server will
   * take it (the server trash, D6). Best-effort and never awaited by the
   * removal loop: a refusal is fine, the `.context/trash` copy already exists.
   */
  recoverDeletedDoc?(docId: string, path: string): Promise<void>;
  /** The markdown this device's local CRDT holds for `docId`, or null. */
  localText?(docId: string): Promise<string | null>;
  /** Notes that were not readable on the previous pass are readable now (a
   *  grant). Once per pass, never on the first pass after a vault opens. */
  accessGranted?(info: { count: number; paths: string[] }): void;
  /**
   * Resolve only once NOTHING can still write to `docId`'s current path — the
   * editor's bridge, the background hot bridge, and any in-flight cold apply.
   *
   * Without this, a bridge that still holds the OLD path egests after the move and
   * RECREATES the file. Worse than a stray copy: the watcher then indexes it as a
   * new file and mints a fresh docId, so the note is resurrected *and* forked into
   * a second server row.
   */
  releaseDoc(docId: string): Promise<void>;
  /** The file moved: re-point anything showing it (e.g. the open editor). */
  notePathChanged(docId: string, from: string, to: string): void;
  /**
   * The file is gone: close anything showing it. Confirmed deletions and
   * revocations now pass `null`; the nullable destination remains in the host
   * contract for compatibility with older recovery behavior.
   */
  noteRemoved(
    docId: string,
    path: string,
    trashedTo: string | null,
    reason: "deleted" | "revoked",
    crdtCleared?: boolean,
  ): void;
  /**
   * A server-only note was just materialized as a 0-byte placeholder at `path`.
   * Fill it in from THIS DEVICE's local CRDT, if it has one, and resolve whether
   * it did.
   *
   * The registry cannot do this itself: the content lives in a Y.Doc, and only
   * the session owns bridges. Best-effort by contract — false leaves today's
   * empty placeholder, which hydrates lazily on open (a fresh device has nothing
   * to fill it with anyway).
   *
   * It matters because the placeholder is a real file write, so the watcher
   * reports it and the local-change push diff-merges it into the note's CRDT. On
   * a device that already holds the note, that merge was a delete-all — and it
   * was pushed (#93). Writing the content the device already has removes the
   * trigger instead of guarding against it.
   */
  materializeContent(docId: string, path: string): Promise<boolean>;
  /**
   * May this pass act on a wholesale loss of access — is the session live AND
   * did the server announce an access change moments ago
   * (`SyncManager.revocationAuthority`)?
   *
   * Inbound asks because a shrunken readable set only means "access was taken
   * away" when both hold: before the session is live, absence can still mean
   * "this device hasn't caught up"; with no `acl-changed` frame behind it, a
   * listing that came back small is more likely a server fault than a decision
   * anyone made. See `InboundInput.authoritative`.
   *
   * Optional: a registry with no host (unit tests) never has the authority,
   * which keeps the conservative behaviour as the default.
   */
  revocationAuthority?(): boolean;
  /**
   * WHICH docs the server has named as no longer readable in this vault session
   * — the union of every `ready.revoked` list and every live `drop` frame — or
   * `null` when it has never named any.
   *
   * Only consulted on an authoritative pass, where it narrows the cap lift to
   * the docs actually named. `null` is the old-server path (nothing is ever
   * named, so the live `reauth` keeps the wholesale lift it always had).
   *
   * NOT an independent opinion: the names and the listing absences are the same
   * server function read twice. The independent one is
   * {@link revocationRefused} / the access-check round trip below. See
   * `InboundInput.authoritativeRevoked`.
   *
   * Optional, like the question above: a registry with no host never has a list
   * and never has the authority either.
   */
  authoritativeRevoked?(): ReadonlySet<string> | null;
  /**
   * The server's own resolver says these docs are still readable, so their
   * removal was refused. Drop them from the named-revocation set: leaving them
   * there would let a later pass try again on the strength of a claim that has
   * already been contradicted.
   */
  revocationRefused?(docIds: string[]): void;
  /**
   * The vault root folder is gone (renamed, moved, unmounted) while the app is
   * open (#221). Every structural step stops while this holds — materialize,
   * register, move, delete — because each of them would act on a folder that no
   * longer exists: re-creating the old root from the server, or reading the
   * whole vault as deleted. Synchronous, so {@link VaultRegistry.stale} can ask.
   */
  structurePaused?(): boolean;
  /**
   * Ask the disk right now whether the vault root is still a folder, and
   * resolve false (having paused structure) when it is not. Called at the top
   * of every reconcile and pull, before anything reads the tree.
   */
  confirmVaultRoot?(): Promise<boolean>;
  /**
   * Docs removed from disk in a live bulk delete that the user has not decided
   * about yet ("delete for everyone" or "restore", #221). Until they answer, a
   * pull neither re-materializes these nor treats them as anything else.
   */
  heldDocIds?(): ReadonlySet<string>;
  /**
   * The signed-in user's id, or null when there is no session.
   *
   * Used to keep legacy authorship metadata attributable to one account.
   */
  localUserId?(): string | null;
  /**
   * A revoked TREE BINARY is about to be removed from disk by US.
   *
   * The binary delete queue (`binaryDeletes.ts`) watches every non-note file in
   * the vault and reads "gone from disk, present on the server" as the user
   * deleting it — which is exactly what this removal looks like. Left unclaimed,
   * a revocation would come back 2.5 s later as `DELETE /api/files/:id` and
   * destroy the OWNER's copy of a file they had merely stopped sharing.
   *
   * One echo per path, the same contract `registry.markMaterialized` makes for a
   * note placeholder. Called BEFORE the removal, so the claim is in place before
   * the watcher can possibly fire.
   */
  suppressBinaryDelete?(relPath: string): void;
  /**
   * A tree binary left this disk: drop its sidebar dot and any cached state.
   *
   * The binary equivalent of {@link noteRemoved}, and deliberately a separate
   * hook — there is no doc to release, no CRDT to clear and no editor to close.
   * `trashedTo` is retained for host compatibility; confirmed removals pass null.
   */
  fileRemoved?(docId: string, path: string, trashedTo: string | null): void;
  /**
   * These docs were just CREATED server-side by this pass — rows that did not
   * exist a moment ago, never rows adopted by path or doc_id.
   *
   * The difference is the whole point: a row the server has only now made holds
   * no CRDT at all, so its content can be pushed through the batch path with
   * `expectEmpty`; an ADOPTED row may already hold a teammate's (or this user's
   * other device's) work, and seeding it is precisely the split-brain the
   * pull-before-seed rule exists to prevent. The session uses this to route a
   * live import of brand-new notes through `DocBatchPusher` instead of one
   * WebSocket per note.
   *
   * Called once per registration chunk, never with an empty list, and always
   * AFTER the mapping is in place — so a handler may look the path up
   * immediately. Fire-and-forget: a throwing handler must not fail a pass.
   */
  noteServerCreated?(docIds: readonly string[]): void;
}

export interface ReconcileInput {
  /** Active organization to create the vault under (required to create). */
  organizationId: string;
  /** Display name for a newly created server vault. */
  vaultName: string;
  /** True only when the user JUST created this vault. Gates first-run seeding:
   *  without it an empty vault stays empty — adopting an existing folder,
   *  joining a team vault, or reopening one must never invent content. */
  seedIfEmpty?: boolean;
}

/** A folder/note that could NOT be registered, after retries. Surfaced so the
 *  vault is never reported fully synced while an arbitrary subset is local-only. */
export interface RegistryFailure {
  kind: "folder" | "note" | "materialize" | "inbound" | "inbound-blocked" | "orphan";
  /** Vault-relative path. */
  path: string;
  /** Intended docId, when known (notes) — phase 3 keys its badge by this. */
  docId: string | null;
  reason: string;
  /** Server error code when it carried one (`vault_limit_reached`, …). */
  code: string | null;
}

/** Paths already toasted about a frozen-root refusal — reconcile re-runs and
 *  retry clicks re-hit the same 403, and one sticky explanation is enough. */
const frozenRootNotified = new Set<string>();

/**
 * How many inbound REMOVALS run at once.
 *
 * A unit here includes local disk checks and a `deleteFile` call, so it takes the shared local width
 * ({@link IPC_CONCURRENCY}) rather than the registry's HTTP one. A folder a
 * teammate deleted arrives here as hundreds of independent paths, and serially
 * that was one round trip through the bridge per file with the link and the
 * disk idle in between.
 */
const INBOUND_REMOVE_CONCURRENCY = IPC_CONCURRENCY;

/**
 * Notes per page when THIS file asks for the registry.
 *
 * 5,000 — the server's own `PAGE_LIMIT_MAX` (`http/routes/registry.ts`), not
 * `api.ts`'s gentler 1,000 default. A pull re-reads the whole listing, and
 * during an import the watcher fires it about once a second: at 1,000 a
 * 5,000-note vault paid FIVE round trips per pull, each one rebuilding the
 * permission-filtered readable set on the server from scratch. One page is one
 * build. A server that predates pagination ignores `limit` entirely and answers
 * the whole vault, exactly as before, and one that supports it accepts 5,000 as
 * its documented ceiling (above it the route answers 400, which is why this
 * tracks the cap rather than exceeding it).
 */
const PULL_PAGE_LIMIT = 5000;

/** Extensions treated as editable notes (reconciled to the server `notes` set).
 *  Images/PDFs surface in the tree but sync as embedded attachments, not notes.
 *
 *  Deliberately a LITERAL, not an import of `lib/formats.ts NOTE_EXTS`: this
 *  list and the ones in `inbound.ts` and Rust `vault.rs` are what
 *  `__tests__/formatsLockstep.test.ts` compares against the registry, and a
 *  list that imports its own answer cannot drift — nor can it detect drift. */
const NOTE_EXTS = ["md", "markdown", "mdx", "txt", "html", "htm", "canvas"];
function isNoteFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") && NOTE_EXTS.includes(ext);
}

/** Flatten a tree into folder paths and note paths (both vault-relative). */
export function flattenTree(root: TreeNode): { folders: TreeNode[]; notes: TreeNode[] } {
  const folders: TreeNode[] = [];
  const notes: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (n.isDir) {
      if (n.path) folders.push(n); // skip the root (empty path)
      for (const c of n.children ?? []) walk(c);
    } else if (isNoteFile(n.path)) {
      notes.push(n); // only text/note files become server notes
    }
  };
  walk(root);
  // Parents before children so folder parentId links resolve.
  folders.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  return { folders, notes };
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Server error `code` field, when the body carried one. */
function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body && typeof body === "object" && "code" in body) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * "Retrying this can never help."
 *
 * Any 4xx is the server telling us the REQUEST is wrong, not that it was
 * unlucky: 402 = a plan limit (`vault_limit_reached` / `member_limit_reached`),
 * 403 = no grant, 409 = this doc_id already belongs to another vault. Those must
 * be surfaced immediately rather than retried forever. 5xx and network failures
 * (no `ApiError` at all) are the retryable ones.
 */
function isTerminalApiError(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

/** Split `items` into consecutive groups of at most `size` (never empty). */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function reasonOf(err: unknown): string {
  if (err instanceof ApiError) return `${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A server note that could not be materialized. A symbolic link at the path is
 *  not a disk-write failure but a deliberate refusal, so it is recorded as an
 *  `inbound-blocked` safety issue (code `symlink`) rather than `materialize`. */
function materializeFailure(path: string, docId: string | null, err: unknown): RegistryFailure {
  if (isSymlinkRefusal(err)) {
    return { kind: "inbound-blocked", path, docId, reason: SYMLINK_REFUSAL_REASON, code: "symlink" };
  }
  return { kind: "materialize", path, docId, reason: reasonOf(err), code: null };
}

/** The shapes `listFolderRegistry` / `listNoteRegistry` resolve to, named here so
 *  the optimistic prefetch can hold onto them. Inferred rather than re-declared,
 *  so they cannot drift from the api client. */
type FolderRegistry = Awaited<ReturnType<ApiClient["listFolderRegistry"]>>;
type NoteRegistry = Awaited<ReturnType<ApiClient["listNoteRegistry"]>>;

export class VaultRegistry {
  private serverVaultId: string | null = null;
  /**
   * The folder + note listings, started OPTIMISTICALLY against the collection id
   * `.context/config.json` already names, in parallel with the `listVaults` call
   * whose only job is to validate that id.
   *
   * On every warm relaunch the cached id is correct, so this takes a whole
   * serial round trip out of the launch chain. When validation resolves a
   * DIFFERENT collection the prefetch is simply discarded and the listings are
   * re-issued — the id is the cache key precisely so a wrong guess cannot be
   * mistaken for the right one.
   */
  private prefetchedListings: {
    vaultId: string;
    p: Promise<[FolderRegistry, NoteRegistry]>;
  } | null = null;
  /** The org this registry is reconciling under (see `VaultSyncConfig.organizationId`). */
  private organizationId: string | null = null;
  private byPath = new Map<string, DocMapping>();
  /** Reverse of byPath: docId → relPath, for the vault sync engine (spec 05). */
  private byDocId = new Map<string, string>();
  /** Lazy case-folded view of `byPath` (lowercased path → the path as mapped).
   *  Null = not built / invalidated; see `canonicalNotePath`. */
  private byPathCi: Map<string, string> | null = null;
  private folderByPath = new Map<string, string>();
  /** Tree-binary relPath → server `files` id (see `VaultSyncConfig.files`).
   *  Deliberately NOT part of `byPath`/`byDocId`: those two are the CRDT note
   *  join, and a binary has no Y.Doc, no bridge and no content upload. */
  private fileByPath = new Map<string, string>();
  /** `files` ids whose BYTES this device has confirmed on the server — the
   *  binary counterpart of {@link pushed}, and unlike it a correctness gate.
   *  See {@link confirmFileBytes} and `VaultSyncConfig.filesConfirmed`. */
  private filesConfirmed = new Set<string>();
  /** `files` id → last agreed sha256 (see `VaultSyncConfig.fileBases`). */
  private fileBases = new Map<string, string>();
  /** docIds whose content this device has confirmed on the server. See
   *  `VaultSyncConfig.pushed` for why this is an optimization, not a guarantee. */
  private pushed = new Set<string>();
  /** docId → base64 server-acknowledged state vector (see `VaultSyncConfig.ackedSv`). */
  private ackedSvs = new Map<string, string>();
  /**
   * docIds deleted on the server while this device held unseen work, whose
   * local ops are being offered to the server's soft-deleted copy (D1/D6).
   * In-memory: the `.context/trash` copy is the durable guarantee.
   */
  private recoverPending = new Set<string>();

  /**
   * docIds the vault channel's `ready.tombstones` named as soft-deleted. Folded
   * into the listing's tombstones on every pull (only when the listing itself
   * answers the tombstone question, so an older server's `null` stays "cannot
   * answer"). Session-scoped; cleared with the rest on a vault switch.
   */
  private serverTombstones = new Set<string>();

  /** Record ids `ready.tombstones` named (see {@link serverTombstones}). */
  noteServerTombstones(docIds: readonly string[]): void {
    for (const d of docIds) if (d) this.serverTombstones.add(d);
  }

  /** Did `ready.tombstones` name `docId` this session? */
  isServerTombstoned(docId: string): boolean {
    return this.serverTombstones.has(docId);
  }

  /**
   * The note ids the previous pass's listing held, and when it was taken.
   * Null until the first pass after a vault is opened, which only seeds it
   * (everything is "new" to a first listing). Cleared on a vault switch.
   */
  private lastListed: { ids: Set<string>; at: number } | null = null;

  /**
   * Fire `InboundHost.accessGranted` once for the notes that became readable
   * since the previous pass. A note counts only when it is newly LISTED, not
   * already mapped on this device (this device's own creations are mapped the
   * moment they register), and CREATED before the previous listing was taken:
   * a teammate's brand-new note is new content, not a grant. A row whose
   * creation time the server does not send is not counted.
   */
  private detectAccessGrants(serverNotes: RegisteredNote[]): void {
    const now = Date.now();
    const ids = new Set(serverNotes.map((n) => noteDocId(n)));
    const prev = this.lastListed;
    this.lastListed = { ids, at: now };
    if (!prev) return;
    const paths: string[] = [];
    for (const n of serverNotes) {
      const id = noteDocId(n);
      if (prev.ids.has(id) || this.byDocId.has(id)) continue;
      const created = Date.parse(noteCreatedAtOf(n) ?? "");
      if (!Number.isFinite(created) || created >= prev.at) continue;
      const rp = noteRelPath(n);
      if (rp) paths.push(rp);
    }
    if (paths.length === 0) return;
    try {
      this.host?.accessGranted?.({ count: paths.length, paths });
    } catch (e) {
      console.warn("[registry] accessGranted listener threw", e);
    }
  }

  /** Paths (lower-cased) this pass may re-create that were mapped before it. */
  private restoreCandidatesCi = new Set<string>();

  /** A materialize just re-created `rp`: report it if it was a mapped note (D5). */
  private noteRestored(rp: string): void {
    if (!this.restoreCandidatesCi.delete(rp.toLowerCase())) return;
    reconcileReport.record({
      kind: "restoredFromServer",
      docId: this.byPath.get(rp)?.docId,
      path: rp,
      detail: "removed on this device without reaching the team; restored from the server",
    });
  }

  /** Is a D1 recovery push in flight for `docId`? */
  isRecoverPending(docId: string): boolean {
    return this.recoverPending.has(docId);
  }
  /** Last agreed docId → relPath (see `VaultSyncConfig.baseline`). */
  private baselineDocs = new Map<string, string>();
  /** docIds this user authored (see `VaultSyncConfig.authored`). Accumulates. */
  private authoredDocs = new Set<string>();
  /** Whose authorship {@link authoredDocs} describes. Null until a session with
   *  a user id has learned or adopted one. */
  private authoredBy: string | null = null;
  /**
   * The collection `baselineDocs` describes. A baseline recorded against ANOTHER
   * collection must never decide that a file moved or died, so a mismatch
   * disables inbound reconciliation for the pass — degrading to the outbound-only
   * behaviour we had before, never to a guess.
   */
  private baselineVaultId: string | null = null;
  /** Set by `SyncManager`; absent in unit tests, where inbound is a no-op host. */
  private host: InboundHost | null = null;
  /** Local note paths the current pass must not re-register (see `InboundPlan.suppress`). */
  private inboundSuppressed = new Set<string>();
  /**
   * Local note paths the server has told us are a DUPLICATE of an identity it
   * already holds somewhere else (#129).
   *
   * `POST /api/notes` with a docId the vault already has at another path is an
   * idempotent no-op that echoes the row's canonical `rel_path`. The file at the
   * path we asked about is therefore a stale second copy — a move whose source
   * survived, a materialize that raced a rename. It is left ON DISK and
   * UNMAPPED: registering it as a new note would publish a duplicate of the note
   * to the whole team, and deleting a user's file on a mapping disagreement is
   * out of the question. Remembering it here is what stops the pull asking the
   * same question every pass — which is what pinned `registering` at 0/N.
   *
   * Cleared per path the moment the server does account for it (the user removed
   * or moved the duplicate), and wholesale on `reset`.
   */
  private aliasPaths = new Set<string>();
  /**
   * Lower-cased local paths the server answered `not_readable` for: a folder or
   * note already exists there, and this user cannot see it (an item set to
   * Private after it reached their disk). Registering them again can only get
   * the same answer, and before the server refused it the adopt-then-prune
   * cycle re-sent ~3,900 folders every 10 s (prod 2026-09-23). Nothing on disk
   * is touched. An entry leaves when the server lists the path again (access
   * came back) or the path leaves the disk; wholesale on `reset`.
   */
  private hiddenPaths = new Set<string>();
  /**
   * Lower-cased local note paths, and the doc_ids they carried, that the server
   * refused with `note_deleted`: the id names a note a teammate DELETED, and
   * this device still holds a copy it never confirmed uploading (so the inbound
   * pass refused to remove it — it may be the only copy of that work).
   *
   * Asking again can only get the same answer, and before the server refused it
   * the answer was a false "created": a vault-wide `registry-changed`
   * broadcast, a content upload whose token mint 404'd, and 4 upload slots
   * waiting 10 s each — every ~30 s, forever (prod 2026-09-23). The file is left
   * exactly where it is, as an unsynced local note; it is deliberately NOT
   * re-registered under a fresh id, which would silently undo a teammate's
   * delete for the whole vault. A path leaves when it leaves the disk or the
   * server lists it again (the note was restored); an id when the server lists
   * it again; both wholesale on `reset`.
   */
  private deletedPaths = new Set<string>();
  private deletedDocIds = new Set<string>();
  /**
   * Paths THIS device just created as materialized placeholders, awaiting their
   * own watcher echo (see {@link consumeMaterialized}).
   *
   * `writeNoteIfMissing` is a real atomic write, so the watcher reports the file
   * ~150ms later as `modified` for a path the registry maps — indistinguishable,
   * from the sync layer's side, from an AI having just written it. Queuing a
   * content push for it is how a 0-byte placeholder came to be diff-merged into a
   * populated doc as a delete-all (#93). One entry is consumed per path by the
   * first event that arrives for it.
   */
  private materialized = new Set<string>();
  private unhydratedPlaceholders = new Set<string>();
  /** Everything that could not be registered in the last run. */
  private failed: RegistryFailure[] = [];
  /** See {@link lastPassDrift}. */
  private passDrift: { missingMapped: number; unmappedLocal: number } | null = null;
  /** Set when the server refused on a plan limit: the rest of the run is
   *  pointless (every further create would 402 too), so it stops. */
  private limitReached: string | null = null;

  /**
   * The scope this registry's *contents* belong to: `serverVaultId` and the path
   * maps were all resolved for THAT vault. Bound by `reconcile`, dropped by
   * `reset`. Null means "not bound" — nothing reconciled yet, or no scope manager
   * scope at all (unit tests), which keeps the legacy unguarded behaviour.
   *
   * It is deliberately NOT re-read from `scopes.current()` per operation. Doing
   * that defeats the entire guard: the debounced `pull()` fires *after* a vault
   * switch, so `current()` is already the NEW vault while `serverVaultId` still
   * holds the OLD one — which is precisely the merge this class exists to
   * prevent. The question is never "what vault is open now" but "is the vault my
   * data came from still the open one".
   */
  private bound: VaultScope | null = null;

  /**
   * Coalesced writer for `.context/config.json`. Recreated per `reconcile` and
   * disposed by `reset()` — disposal is synchronous precisely so a queued flush
   * can't snapshot the vault we left and write it into the one we just opened.
   */
  private checkpoint: Checkpointer<VaultSyncConfig> | null = null;
  /** Resume point for the bulk bootstrap download; see {@link VaultSyncConfig.bootstrap}. */
  private bootstrapState: BootstrapResume | null = null;

  /**
   * The config `primeLocal` parsed, held for the `reconcile` that follows it.
   * One read of a file that is ~1.85 MB on a 6k-note vault, per boot, shared by
   * both — instead of one apiece.
   */
  private primedConfig: VaultSyncConfig | null = null;

  /**
   * Notified whenever the {relPath → docId} map changes.
   *
   * This map is the ONLY place a sidebar path and a note's docId meet, and every
   * sync fact (`docSyncState`) is keyed by docId — so the UI needs it to badge a
   * row. It used to be read imperatively from `getMapping()` during render, which
   * is not reactive: rows kept a stale badge until something else re-rendered
   * them. The listener (owned by `SyncManager`, which coalesces it) replaces that.
   *
   * Owned for the process lifetime, so `reset()` deliberately does NOT clear it —
   * a vault switch has to be *published* as "no mapped notes", not go silent.
   */
  private onMapChanged: (() => void) | null = null;

  /**
   * Notified with the {docId → last-edit} map every time a pull tells us who
   * last touched each note.
   *
   * Liveness rides the registry re-pull rather than a protocol frame of its own:
   * the server already fires `registry-changed` when it stamps an edit, and that
   * pull is coalesced (120ms/250ms), so "edited by X just now" converges on the
   * same round trip that moves/renames use. Owned for the process lifetime like
   * {@link onMapChanged} — a vault switch must *publish* an empty map, not go
   * silent.
   */
  private onNoteMeta: ((meta: Record<string, NoteLastEdited>) => void) | null = null;

  /**
   * Notified with the {relPath → color id} map on every pull.
   *
   * Item colors used to be a localStorage preference keyed by path, so a folder
   * you tinted was grey on every other machine and for every teammate. They are
   * a fact about the folder, not about this computer, so they live on the row
   * (keyed by id, surviving renames) and ride the registry pull that already
   * fires whenever the structure changes. Keyed by PATH on the way out because
   * that is what the sidebar draws with.
   */
  private onColors: ((colors: Record<string, string>) => void) | null = null;
  /** Notified per recorded failure, in order (see {@link setFailureListener}). */
  private onFailure: ((failure: RegistryFailure) => void) | null = null;

  constructor(
    private readonly api: ApiClient,
    /** Where the current VaultScope comes from; injectable for tests. */
    private readonly scopes: VaultScopeSource = vaultScopes,
    /** Progress reporting; a no-op sink by default (unit tests). */
    private progress: SyncProgressSink = nullProgressSink,
  ) {}

  get vaultId(): string | null {
    return this.serverVaultId;
  }

  /** Point the registry at a progress sink (SyncManager, per vault scope). */
  setProgressSink(sink: SyncProgressSink): void {
    this.progress = sink;
  }

  /** Subscribe to {relPath → docId} changes (see {@link onMapChanged}). */
  setMapListener(cb: (() => void) | null): void {
    this.onMapChanged = cb;
  }

  /** Subscribe to per-note last-edit metadata (see {@link onNoteMeta}). */
  setNoteMetaListener(cb: ((meta: Record<string, NoteLastEdited>) => void) | null): void {
    this.onNoteMeta = cb;
  }

  /** Subscribe to the vault's shared item colors (see {@link onColors}). */
  setColorListener(cb: ((colors: Record<string, string>) => void) | null): void {
    this.onColors = cb;
  }

  /**
   * Subscribe to failures as they are recorded.
   *
   * {@link failures} is the accumulated list, which answers "what is broken
   * now"; this answers "when, and in what order" — the difference between a
   * Health page that can show a vault's sync history and one that can only show
   * its current wreckage. Purely additive: the failure is recorded, badged and
   * logged exactly as before whether or not anyone listens.
   */
  setFailureListener(cb: ((failure: RegistryFailure) => void) | null): void {
    this.onFailure = cb;
  }

  /** Provide the editor/doc-store coupling inbound reconciliation needs. Without
   *  a host, inbound still runs but nothing is released — safe only in tests,
   *  where no bridge is open. */
  setInboundHost(host: InboundHost | null): void {
    this.host = host;
  }

  /** Announce a change to the path→docId map. Fired freely (once per adopted or
   *  created note); the listener is responsible for coalescing. */
  private notifyMapChanged(): void {
    // Every `byPath` mutation funnels through here, which makes it the one place
    // the case-folded view has to be dropped. See `canonicalNotePath`.
    this.byPathCi = null;
    this.onMapChanged?.();
  }

  /**
   * The path this vault already uses for `relPath`, compared case-insensitively,
   * or null if nothing is mapped there yet.
   *
   * macOS and Windows cannot distinguish `Projects/Community/x.md` from
   * `Projects/community/x.md` — they are one file. If this device maps its disk
   * spelling to a second doc_id while the server holds another, the two docs
   * write over each other through that one file forever (the 2026-09-04 runaway;
   * `samePath` in the server's tree-ops.ts has the full account). The server now
   * adopts case-insensitively and answers with its canonical spelling, so this
   * is the client half: recognise that we already track the file and reuse the
   * mapping instead of registering a twin.
   *
   * Exact hits skip the folded map entirely, so the common path is one Map.get
   * and nothing is built during a reconcile that finds everything already
   * mapped. The lazy index is rebuilt at most once per mutation batch.
   */
  private canonicalNotePath(relPath: string): string | null {
    if (this.byPath.has(relPath)) return relPath;
    if (!this.byPathCi) {
      this.byPathCi = new Map();
      // Insertion order = first writer wins, so a vault that still holds
      // pre-migration-023 twins resolves to one of them consistently rather
      // than alternating between passes.
      for (const rp of this.byPath.keys()) {
        const k = rp.toLowerCase();
        if (!this.byPathCi.has(k)) this.byPathCi.set(k, rp);
      }
    }
    return this.byPathCi.get(relPath.toLowerCase()) ?? null;
  }

  /** Folder twin of {@link canonicalNotePath}. Scanned rather than indexed:
   *  `folderByPath` is a fraction of `byPath` and this runs only when a folder
   *  is genuinely missing from the map. */
  private canonicalFolderPath(relPath: string): string | null {
    if (this.folderByPath.has(relPath)) return relPath;
    const want = relPath.toLowerCase();
    for (const rp of this.folderByPath.keys()) {
      if (rp.toLowerCase() === want) return rp;
    }
    return null;
  }

  /**
   * Publish the last-edit stamps carried by a registry pull, keyed by **docId**
   * (the sidebar joins it back to a row through the path→docId map). Notes the
   * server has no stamp for are simply absent, so the whole map replaces the
   * previous one rather than merging into it.
   */
  private publishNoteMeta(serverNotes: RegisteredNote[]): void {
    const cb = this.onNoteMeta;
    if (!cb) return;
    const meta: Record<string, NoteLastEdited> = {};
    for (const n of serverNotes) {
      const edited = noteLastEdited(n);
      if (edited) meta[noteDocId(n)] = edited;
    }
    cb(meta);
  }

  /**
   * Publish the server's item colors, keyed by vault-relative path.
   *
   * Whole-map replacement, like {@link publishNoteMeta}: a folder whose color was
   * cleared by a teammate has no row here, and merging would keep it tinted
   * forever on this machine.
   */
  private publishColors(
    serverFolders: RegisteredFolder[],
    serverNotes: RegisteredNote[],
  ): void {
    const cb = this.onColors;
    if (!cb) return;
    const colors: Record<string, string> = {};
    for (const f of serverFolders) if (f.color) colors[f.path] = f.color;
    for (const n of serverNotes) {
      const rp = noteRelPath(n);
      if (rp && n.color) colors[rp] = n.color;
    }
    cb(colors);
  }

  /**
   * Forget everything about the vault this registry was reconciled against.
   * MUST be called on every vault switch / disable: this instance is a process
   * singleton, so a surviving `serverVaultId` + path maps are exactly what let
   * vault A's server ids be applied to vault B's tree.
   */
  reset(): void {
    // Synchronously first: a pending flush must never outlive the vault.
    this.checkpoint?.dispose();
    this.checkpoint = null;
    this.primedConfig = null;
    this.serverVaultId = null;
    this.organizationId = null;
    this.passDrift = null;
    this.byPath.clear();
    this.byDocId.clear();
    this.byPathCi = null;
    // Paths, so they belong to the vault we are leaving.
    this.aliasPaths.clear();
    this.hiddenPaths.clear();
    this.deletedPaths.clear();
    this.deletedDocIds.clear();
    this.folderByPath.clear();
    // Server ids for vault A's binaries name nothing in vault B.
    this.fileByPath.clear();
    this.filesConfirmed.clear();
    this.fileBases.clear();
    this.pushed.clear();
    this.ackedSvs.clear();
    this.serverTombstones.clear();
    this.lastListed = null;
    // A surviving baseline is exactly the cross-vault confusion this method
    // exists to prevent — it would tell vault B that vault A's notes moved.
    this.baselineDocs.clear();
    this.authoredDocs.clear();
    this.authoredBy = null;
    this.baselineVaultId = null;
    this.failed = [];
    this.limitReached = null;
    // Paths, so they belong to the vault we are leaving — and a stale entry would
    // suppress the next vault's first watcher event for the same relative path.
    this.materialized.clear();
    this.unhydratedPlaceholders.clear();
    // The identical-config memo (see {@link writeConfig}) is only honest while
    // this registry is the last thing that wrote `.context/config.json`. A
    // teardown ends that: `store.clearVaultStamp` writes the same file through
    // `ipc.setVaultConfig`, and deleting `.context/` by hand (a documented dev
    // habit) rewrites it to nothing — either way a surviving memo would make the
    // next identical write a no-op and leave the doc-id map unpersisted.
    this.lastWrittenConfig = null;
    this.bound = null;
    this.progress = nullProgressSink;
  }

  /** True when this registry's contents belong to a vault that is no longer the
   *  open one. Bail silently — "the user moved on" is not an error. */
  private stale(): boolean {
    if (this.bound != null && !this.bound.isCurrent()) return true;
    // A vanished vault root (#221) is the same answer for a different reason:
    // whatever this pass meant to write belongs to a folder that is not there.
    return this.host?.structurePaused?.() === true;
  }

  /**
   * What the last structure pass saw that it could not explain (#221):
   * `missingMapped` notes this device already knew by path whose files are no
   * longer on disk (re-materialized from the server), and `unmappedLocal` files
   * on disk the server has never seen (registered as new). Both at once, on the
   * first pass after a vault opens, is what a rename, move or delete made while
   * the app was closed looks like. Reported only; the pass acts as it always did.
   */
  lastPassDrift(): { missingMapped: number; unmappedLocal: number } | null {
    return this.passDrift;
  }

  /**
   * Where to report progress. Silenced once this registry's contents are stale.
   *
   * This class is a process singleton, so a newer `enable` for ANOTHER vault will
   * already have replaced `this.progress` with that vault's reporter by the time a
   * reconcile for the vault we left reaches its next checkpoint. Emitting through
   * the raw field would then pour vault A's counts into vault B's progress bar.
   */
  private get sink(): SyncProgressSink {
    return this.stale() ? nullProgressSink : this.progress;
  }

  /** `expectedEpoch` to pin vault-relative IPC to: the epoch of the vault these
   *  contents came from, so Rust refuses any call that outlives it. */
  private epoch(): number | null {
    return this.bound?.vaultEpoch ?? null;
  }

  /** Server doc mapping for a note's vault-relative path, if registered. */
  getMapping(relPath: string): DocMapping | null {
    return this.byPath.get(relPath) ?? null;
  }

  /**
   * {@link getMapping}, but tolerant of a case-different spelling.
   *
   * `byPath` is keyed by the path the SERVER says a doc lives at (see
   * `registerNote`), while the sidebar and the editor know a note by its DISK
   * spelling. On macOS/Windows those are the same file even when they disagree
   * about case, so an exact `Map.get` can miss a note that is perfectly well
   * mapped — which used to leave a teammate's presence dot homeless on the
   * receiving side and made the sender announce nothing on the sending side
   * (#125).
   *
   * Hot path (`peersForNode` runs per sidebar row, per render): an exact hit
   * costs one `Map.get` and never touches the folded index; the O(n) build
   * behind `canonicalNotePath` happens only on a genuine miss, is cached, and
   * is invalidated once per mutation batch by `notifyMapChanged`.
   */
  getMappingCi(relPath: string): DocMapping | null {
    const exact = this.byPath.get(relPath);
    if (exact) return exact;
    const canonical = this.canonicalNotePath(relPath);
    return canonical ? (this.byPath.get(canonical) ?? null) : null;
  }

  /** Vault-relative path for a docId, if mapped (reverse of getMapping). */
  pathForDocId(docId: string): string | null {
    return this.byDocId.get(docId) ?? null;
  }

  /**
   * Was `relPath` created by this device's own materialize step, and is its
   * watcher echo still owed? Consumes the entry, so the SECOND event for the
   * path (a real external edit) is treated normally.
   */
  consumeMaterialized(relPath: string): boolean {
    return this.materialized.delete(relPath);
  }

  /**
   * Record a path THIS device just wrote, so its watcher echo is recognised as
   * ours (see {@link materialized}).
   *
   * Public because the binary sync materializes too: a tree binary a teammate
   * dropped lands here as a blob written straight to disk, and its echo must
   * not be mistaken for an external edit any more than a note placeholder's is.
   */
  markMaterialized(relPath: string): void {
    // Bounded: an echo that never arrives (the write was outside the watcher's
    // window, the vault was closed) would otherwise pin the entry forever. A
    // vault's worth of placeholders is the natural high-water mark, so a set an
    // order of magnitude past that is stale by definition.
    if (this.materialized.size > 20_000) this.materialized.clear();
    this.materialized.add(relPath);
  }

  markUnhydratedPlaceholder(docId: string): void {
    this.unhydratedPlaceholders.add(docId);
    this.checkpoint?.touch();
  }

  clearUnhydratedPlaceholder(docId: string): void {
    if (!this.unhydratedPlaceholders.delete(docId)) return;
    this.checkpoint?.touch();
  }

  isUnhydratedPlaceholder(docId: string): boolean {
    return this.unhydratedPlaceholders.has(docId);
  }

  // ---- Tree binaries (PR3 Stage A) ---------------------------------------
  //
  // A `files` row is NOT a note: no Y.Doc, no bridge, no content upload. The
  // only thing this map buys is the doc_id the blob store stamps on the bytes,
  // which is what makes a binary obey its folder's share instead of the path
  // heuristic. Kept beside the note map only because both belong to the vault
  // and both travel in `.context/config.json`.

  /** The server `files` id this device registered for a tree binary, if any. */
  getFileId(relPath: string): string | null {
    return this.fileByPath.get(relPath) ?? null;
  }

  /**
   * Remember a registered tree binary and queue the config write.
   *
   * `authored` means THIS device put the bytes there. It is retained in config
   * for compatibility with older clients; current removal policy does not
   * exempt the uploader. A DOWNLOAD calls this with `authored` off.
   */
  setFileId(relPath: string, id: string, opts: { authored?: boolean } = {}): void {
    if (this.stale()) return;
    if (opts.authored) this.claimAuthorship(id);
    if (this.fileByPath.get(relPath) === id) return;
    this.fileByPath.set(relPath, id);
    this.persist();
  }

  /** Add one doc to the persisted authorship list, claiming the list for this
   *  user first — the same guard `learnAuthorship` makes, and for the same
   *  reason: a list learned under one account says nothing about another. */
  private claimAuthorship(docId: string): void {
    const me = this.host?.localUserId?.() ?? null;
    if (me === null) return;
    if (this.authoredBy !== me) {
      this.authoredBy = me;
      this.authoredDocs.clear();
    }
    if (this.authoredDocs.has(docId)) return;
    this.authoredDocs.add(docId);
    this.persist();
  }

  /** Forget a tree binary whose file is gone (the delete queue drained it), so
   *  a path re-used later registers afresh instead of adopting a dead id. */
  forgetFileId(relPath: string): void {
    if (this.stale()) return;
    const id = this.fileByPath.get(relPath);
    if (!this.fileByPath.delete(relPath)) return;
    // The row is gone, so the claim about its bytes goes with it. Leaving it
    // behind would let a path re-used later inherit a confirmation that was
    // made about a different file's content.
    if (id) {
      this.filesConfirmed.delete(id);
      this.fileBases.delete(id);
    }
    this.persist();
  }

  /** The sha256 this device last agreed with the server on for a `files` id —
   *  the base of the blob mirror's three-way decision. */
  getFileBase(docId: string): string | null {
    return this.fileBases.get(docId) ?? null;
  }

  /** Record that this device and the server agree on these bytes for `docId`. */
  setFileBase(docId: string, sha256: string): void {
    if (this.stale()) return;
    if (!docId || !sha256 || this.fileBases.get(docId) === sha256) return;
    this.fileBases.set(docId, sha256);
    this.persist();
  }

  /** Move a registration with its file — a rename done outside the app, where
   *  the server row moved rather than died (`binaryDeletes.applyRename`). */
  moveFileId(from: string, to: string): void {
    if (this.stale()) return;
    const id = this.fileByPath.get(from);
    if (!id) return;
    this.fileByPath.delete(from);
    this.fileByPath.set(to, id);
    // `filesConfirmed` is keyed by doc_id precisely so a move needs no entry of
    // its own: the row travelled, and so did what we know about its bytes.
    this.persist();
  }

  /**
   * THIS device has confirmed the server holds this path's bytes.
   *
   * The one signal that makes a tree binary removable — see
   * {@link removeRevokedBinary}. Only the blob mirror may call it, and only
   * from a position where the server's possession is a fact rather than an
   * inference: a completed upload, a download (the bytes came FROM there), an
   * intent that deduped onto an existing row, or a listing whose sha matches
   * this file's. Registering a row is NOT one of those positions.
   *
   * Keyed by doc_id, not path, so a rename carries it (see {@link moveFileId}).
   */
  confirmFileBytes(relPath: string): void {
    if (this.stale()) return;
    const id = this.fileByPath.get(relPath);
    if (!id || this.filesConfirmed.has(id)) return;
    this.filesConfirmed.add(id);
    this.persist();
  }

  /** Has this device confirmed the server holds this doc's bytes? */
  fileBytesConfirmed(docId: string): boolean {
    return this.filesConfirmed.has(docId);
  }

  /**
   * Every tree binary's server `files` id — what the vault channel's `hello`
   * announces so `ready.revoked` can name a revoked binary.
   *
   * CONFIRMED rows only. The server names a revocation by intersecting this
   * claim with its readable set, so announcing a row whose bytes never left
   * this device would invite an answer we must refuse anyway — and refusing it
   * is not free: every `ready.revoked` re-stamps the ACL-authority clock
   * (`docSession.aclChangedAt`), so a permanently unconfirmable file (a Free
   * vault's standalone binary, one over the blob ceiling, one behind a full
   * quota) would hold the wholesale-removal window open for every OTHER doc on
   * every reconnect. Not claiming it ends the loop at the source; the guard in
   * {@link removeRevokedBinary} is the belt to this pair of braces.
   */
  fileDocIds(): string[] {
    return [...this.fileByPath.values()].filter((id) => this.filesConfirmed.has(id));
  }

  /**
   * The same map inverted, doc_id → path, for the inbound plan's binary pass.
   * Last one wins on the (impossible-by-construction) duplicate id.
   *
   * Deliberately NOT filtered by {@link filesConfirmed}, unlike
   * {@link fileDocIds}. The two rails do different jobs: not claiming a row
   * stops the server asking, while planning one and REFUSING it is what makes
   * the refusal visible (`removeRevokedBinary` records it, so Vault Health can
   * say a file stayed and why). Filtering here as well would silently drop a
   * doc the server named some other way — a live `drop`, or a name that
   * outlived the confirmation — and silence is the one thing this path must
   * not produce.
   */
  localFiles(): Map<string, string> {
    const byDocId = new Map<string, string>();
    for (const [rp, id] of this.fileByPath) byDocId.set(id, rp);
    return byDocId;
  }

  /** Adopt a `files` map read from `.context/config.json`, plus the subset of
   *  its ids whose bytes this device once confirmed. An older config has no
   *  such key and every row loads UNCONFIRMED — the safe direction: the next
   *  pass whose listing matches the file's sha confirms it without moving a
   *  byte (`AttachmentSync.pass`). */
  private adoptConfigFiles(
    files: Record<string, string>,
    confirmed: readonly string[],
    bases: Record<string, string> = {},
  ): void {
    for (const [rp, id] of Object.entries(files)) {
      if (typeof id === "string" && id) this.fileByPath.set(rp, id);
    }
    for (const id of confirmed) if (typeof id === "string" && id) this.filesConfirmed.add(id);
    for (const [id, sha] of Object.entries(bases)) {
      if (id && typeof sha === "string" && sha) this.fileBases.set(id, sha);
    }
  }

  /** Adopt a bootstrap cursor read from `.context/config.json`, under the same
   *  collection guard everything else here is adopted under. */
  private adoptBootstrap(cfg: VaultSyncConfig, vaultId: string): void {
    const saved = cfg.bootstrap;
    this.bootstrapState =
      saved && saved.serverVaultId === vaultId && typeof saved.sessionId === "string"
        ? saved
        : null;
  }

  /** All mapped doc ids (for the vault sync engine's initial doc set). */
  allDocIds(): string[] {
    return [...this.byDocId.keys()];
  }

  /** Every mapped note as {docId, relPath} — the bulk upload's work list. */
  mappedNotes(): Array<{ docId: string; relPath: string }> {
    return [...this.byDocId].map(([docId, relPath]) => ({ docId, relPath }));
  }

  /** Read-only census of the last reconciled server registry for Health. */
  healthInventory(): {
    hasServerVault: boolean;
    notePaths: string[];
    folderPaths: string[];
    filePaths: string[];
  } {
    return {
      hasServerVault: this.serverVaultId != null,
      notePaths: [...this.byPath.keys()].sort(),
      folderPaths: [...this.folderByPath.keys()].sort(),
      filePaths: [...this.fileByPath.keys()].sort(),
    };
  }

  /** Server folder id for a folder's vault-relative path, if registered. */
  getFolderId(relPath: string): string | null {
    return this.folderByPath.get(relPath) ?? null;
  }

  /**
   * Persist an item's accent color on the server row behind `relPath`.
   *
   * Resolves folder-first, then note. Returns false when the path isn't mapped
   * (a local-only vault, or a file registered a moment ago) — the caller keeps
   * its optimistic local value rather than reporting a failure the user can do
   * nothing about.
   */
  async setColor(relPath: string, colorId: string | null): Promise<boolean> {
    const folderId = this.folderByPath.get(relPath);
    if (folderId) {
      await this.api.updateFolder(folderId, { color: colorId });
      return true;
    }
    const mapping = this.byPath.get(relPath);
    if (mapping) {
      await this.api.updateNote(mapping.docId, { color: colorId });
      return true;
    }
    return false;
  }

  // ---- content-push checkpoint (resume point for the bulk upload) ---------

  /** Has this device confirmed `docId`'s content on the server? */
  isPushed(docId: string): boolean {
    return this.pushed.has(docId);
  }

  /** Record that `docId`'s content is on the server (checkpointed, batched). */
  markPushed(docId: string): void {
    if (this.pushed.has(docId)) return;
    this.pushed.add(docId);
    this.checkpoint?.touch();
  }

  /**
   * Forget that `docId`'s content is on the server.
   *
   * The counterpart to `markPushed`, for the one case where the server's copy
   * genuinely goes away underneath a live checkpoint: a history reset
   * (`SyncManager.resetNoteHistory`). Leaving the doc marked pushed there would
   * skip it in every future content run, so the freshly-emptied server doc would
   * never be re-filled from the file.
   */
  unmarkPushed(docId: string): void {
    if (!this.pushed.delete(docId)) return;
    this.ackedSvs.delete(docId);
    this.checkpoint?.touch();
  }

  // ---- server-acknowledged state vector (offline reconciliation) ----------

  /**
   * The server now covers at least `sv` for `docId` (Hocuspocus `synced`, a
   * batch-push ack, a backfill/bootstrap apply). Merged by per-client max, so a
   * late, smaller ack can never shrink what the server is known to hold.
   */
  recordAck(docId: string, sv: Uint8Array): void {
    if (!docId || svIsEmpty(sv)) return;
    const prev = this.ackedSvs.get(docId);
    const merged = svToBase64(mergeSv(prev ? svFromBase64(prev) : null, sv));
    if (merged === prev) return;
    this.ackedSvs.set(docId, merged);
    this.checkpoint?.touch();
  }

  /** The server-acknowledged state vector for `docId`, or null (never acked). */
  ackedSvOf(docId: string): Uint8Array | null {
    const b64 = this.ackedSvs.get(docId);
    return b64 ? svFromBase64(b64) : null;
  }

  /**
   * Does this device hold work on `docId` the server has not acknowledged?
   *
   * The gate for accepting INBOUND destruction (a teammate's delete, a
   * revocation): a stale device accepts it, a device with unseen work keeps a
   * recovery copy first. With a local CRDT the answer is the state-vector
   * comparison; without one (a never-opened note, or no host), the file's hash
   * against the disk base Rust records on every egest. Unreadable ⇒ true.
   */
  async hasUnseenWork(docId: string, relPath: string | null): Promise<boolean> {
    return (await this.unseenWorkVerdict(docId, relPath)) !== "none";
  }

  /**
   * {@link hasUnseenWork} with the one distinction the inbound removal needs:
   *  - `none`    — stale device: accept the delete / revocation outright;
   *  - `unseen`  — this doc holds work the server never acknowledged;
   *  - `unknown` — a non-empty file at the doc's path with no local CRDT and NO
   *    disk base for the doc: nothing proves the file IS that note (a
   *    re-import under a fresh local id lands exactly here), so it must not be
   *    removed at all, copy or not.
   */
  async unseenWorkVerdict(
    docId: string,
    relPath: string | null,
  ): Promise<"none" | "unseen" | "unknown"> {
    try {
      const localSv = (await this.host?.localStateVector?.(docId)) ?? null;
      const ackedSv = this.ackedSvOf(docId);
      if (localSv && !svIsEmpty(localSv)) {
        return unseenWork({ localSv, ackedSv }) ? "unseen" : "none";
      }
      if (relPath === null) return "none";
      let text: string;
      try {
        text = await ipc.readNote(relPath, this.epoch());
      } catch {
        return "none"; // no file ⇒ nothing on this disk to lose
      }
      if (text.trim().length === 0) return "none";
      const diskBase = (await ipc.getDiskBase(docId, this.epoch()).catch(() => null)) ?? null;
      if (diskBase === null) return "unknown";
      const fileHash = await sha256Hex(text);
      return unseenWork({ localSv: null, ackedSv, fileHash, diskBase }) ? "unseen" : "none";
    } catch {
      return "unknown";
    }
  }


  // ---- bootstrap resume point (the bulk download's cursor) ---------------

  /**
   * Where the bootstrap download got to for THIS collection, or null.
   *
   * Collection-guarded on read as well as on write: a cursor recorded against
   * another `vaults` row would page a session that does not exist here, and the
   * honest answer to that is "start again", not "resume into the wrong vault".
   */
  bootstrapResume(): BootstrapResume | null {
    const state = this.bootstrapState;
    if (!state) return null;
    if (!this.serverVaultId || state.serverVaultId !== this.serverVaultId) return null;
    return state;
  }

  /** Record (or clear, with `null`) the bootstrap cursor. Checkpointed, never
   *  written synchronously — the page it describes is already applied. */
  setBootstrapResume(state: BootstrapResume | null): void {
    if (this.stale()) return;
    this.bootstrapState = state;
    this.checkpoint?.touch();
  }

  /** Flush any owed checkpoint now (end of a phase / before teardown). */
  async flushCheckpoint(): Promise<void> {
    await this.checkpoint?.flush();
  }

  /** Completed config.json writes (tests: "did we checkpoint incrementally?"). */
  checkpointWrites(): number {
    return this.checkpoint?.writes ?? 0;
  }

  // ---- failure reporting --------------------------------------------------

  /** Everything that could not be registered in the last reconcile/pull. */
  failures(): RegistryFailure[] {
    return [...this.failed];
  }

  hasFailures(): boolean {
    return this.failed.length > 0;
  }

  /** The plan-limit code that stopped the run, if one did. */
  limitCode(): string | null {
    return this.limitReached ?? this.failed.find(f => f.code === "note_limit_reached")?.code ?? null;
  }

  /**
   * Record something that could not be synced.
   *
   * Public because the session records failures too: a batch of disk deletes the
   * blast-radius cap refused (`SyncManager.drainDiskDeletes`) has to reach the
   * same "N items not synced" surface as a failed create, or a refusal that
   * protected the user's notes would be invisible to them.
   */
  recordFailure(f: RegistryFailure): "ok" | "failed" {
    // Something already exists at this path that this user cannot see (an item
    // set to Private after it reached their disk). Not a failure and nothing to
    // fix: the file stays exactly where it is, local-only, and the path is left
    // out of every later pass until the server lists it again — see `hiddenPaths`.
    if (f.code === "not_readable" && (f.kind === "folder" || f.kind === "note")) {
      this.hiddenPaths.add(f.path.toLowerCase());
      return "ok";
    }
    // The id names a note deleted on the server. Reported ONCE (the path is
    // skipped from now on — see `deletedPaths`), with a reason that says the
    // file is safe and why it no longer syncs.
    if (f.code === "note_deleted" && f.kind === "note") {
      const firstTime = !this.deletedPaths.has(f.path.toLowerCase());
      this.deletedPaths.add(f.path.toLowerCase());
      if (f.docId) this.deletedDocIds.add(f.docId);
      if (!firstTime) return "failed";
      f = {
        ...f,
        reason: "deleted on the server by another member — kept on this device, no longer synced",
      };
    }
    this.failed.push(f);
    if (f.code === "vault_limit_reached" || f.code === "member_limit_reached") {
      this.limitReached = f.code;
    }
    // A frozen-root refusal is the user's problem to fix (move the item into a
    // folder), not a transient sync error — so say so, once per path. Without
    // this the item just counts toward "N not synced" forever with no reason.
    if (f.code === "root_frozen" && !frozenRootNotified.has(f.path)) {
      frozenRootNotified.add(f.path);
      toast(
        `"${f.path}" can't sync — this vault's root is frozen. Move it into a folder to sync it.`,
        "error",
      );
    }
    if (f.docId) this.sink.doc(f.docId, "error");
    // Keep all diagnostics, but cap per-item logging and UI timeline emissions
    // during a mass refusal. Thousands of synchronous log renders can freeze it.
    if (this.failed.length > 20) return "failed";
    // Timeline only — a listener must never be able to change what a run does.
    try {
      this.onFailure?.(f);
    } catch (e) {
      console.warn("[registry] failure listener threw", e);
    }
    console.warn(`[registry] ${f.kind} ${f.path} failed — ${f.reason}`);
    return "failed";
  }

  /** Stop the current bulk run? Either the vault moved on, or the server told us
   *  we've hit a plan limit and every further create would 402 as well. */
  private stopRun(): boolean {
    return this.stale() || this.limitReached != null;
  }

  // ---- config.json -------------------------------------------------------

  private async loadConfig(): Promise<VaultSyncConfig> {
    try {
      const raw = await ipc.getVaultConfig(this.epoch());
      if (!raw) return {};
      return JSON.parse(raw) as VaultSyncConfig;
    } catch {
      return {};
    }
  }

  /** The value the checkpointer writes: whatever the in-memory maps hold NOW. */
  private configSnapshot(): VaultSyncConfig {
    const docs: Record<string, string> = {};
    for (const [rp, m] of this.byPath) docs[rp] = m.docId;
    const folders: Record<string, string> = {};
    for (const [rp, id] of this.folderByPath) folders[rp] = id;
    const files: Record<string, string> = {};
    for (const [rp, id] of this.fileByPath) files[rp] = id;
    const baseline: Record<string, string> = {};
    for (const [docId, rp] of this.baselineDocs) baseline[docId] = rp;
    return {
      organizationId: this.organizationId ?? undefined,
      serverVaultId: this.serverVaultId ?? undefined,
      docs,
      folders,
      files,
      // Omitted while empty, so a vault with no tree binaries writes the same
      // bytes it always did and the identical-config memo keeps working.
      ...(this.filesConfirmed.size > 0 ? { filesConfirmed: [...this.filesConfirmed] } : {}),
      ...(this.fileBases.size > 0 ? { fileBases: Object.fromEntries(this.fileBases) } : {}),
      pushed: [...this.pushed],
      ...(this.ackedSvs.size > 0 ? { ackedSv: Object.fromEntries(this.ackedSvs) } : {}),
      ...(this.unhydratedPlaceholders.size > 0
        ? { unhydratedPlaceholders: [...this.unhydratedPlaceholders] }
        : {}),
      baseline,
      // Written only when we know whose it is; an unattributed list is worse
      // than none (see `VaultSyncConfig.authored`).
      ...(this.authoredBy
        ? { authored: { userId: this.authoredBy, docIds: [...this.authoredDocs] } }
        : {}),
      // Omitted when there is no run to resume, so a drained session leaves no
      // stale cursor behind for the next launch to chase.
      ...(this.bootstrapState ? { bootstrap: this.bootstrapState } : {}),
    };
  }

  /**
   * Bring local disk into line with the server's structure: create folders that
   * only exist server-side, apply remote renames/moves, and permanently remove
   * notes when the server says they were deleted OR when they left this
   * user's readable set (access revoked — see `InboundTrash.reason`).
   *
   * Every mutation below is guarded, and the guards are the point:
   *   - a persisted baseline for THIS collection must exist (else we can't tell a
   *     remote move from a note we've simply never seen);
   *   - the tree must be the full walk (enforced by the `FullTree` brand);
   *   - the scope is re-checked immediately before each call, and every IPC is
   *     epoch-pinned so Rust refuses anything that outlives the vault;
   *   - the doc is RELEASED first, so no bridge can egest to the old path and
   *     recreate the file we just moved;
   *   - and `planInbound` caps how much one pass may change.
   */
  /**
   * Resolve `plan.needsAccessCheck` against the server's OTHER permission
   * answer, and strike from the plan everything that answer does not confirm.
   *
   * Three outcomes, and the default of each is "keep the file":
   *
   *  - the resolver also says no access ⇒ the removal stands;
   *  - the resolver still grants access ⇒ the two server answers disagree, the
   *    file stays, and the path is un-suppressed so the next pass treats it as
   *    an ordinary note again rather than freezing it out;
   *  - the request fails ⇒ no answer, so nothing in the group is removed. A
   *    permission change is never so urgent that it justifies deleting files on
   *    a round trip that did not happen.
   */
  /**
   * Remember which of these notes THIS user wrote.
   *
   * Accumulative, like the baseline, and persisted for compatibility with older
   * clients. Current removal policy does not branch on this value.
   */
  private learnAuthorship(serverNotes: RegisteredNote[]): void {
    const me = this.host?.localUserId?.() ?? null;
    if (me === null) return;
    // A list learned under one account says nothing about another. Claim it (or
    // start a fresh one) before adding to it, so the persisted record is always
    // attributable to exactly one user.
    if (this.authoredBy !== me) {
      this.authoredBy = me;
      this.authoredDocs.clear();
    }
    for (const n of serverNotes) {
      if (noteCreatedBy(n) === me) this.authoredDocs.add(noteDocId(n));
    }
  }

  /**
   * Take the persisted authorship list only if it is THIS user's.
   *
   * Anything else — another account's list, or an older config's unattributed
   * `string[]` — is dropped rather than inherited, and the next `learnAuthorship`
   * rebuilds it from the listing. Keeping attribution account-scoped prevents
   * stale ownership metadata from leaking between sign-ins.
   */
  private adoptAuthored(cfg: VaultSyncConfig): void {
    this.authoredDocs = new Set();
    this.authoredBy = null;
    const rec = cfg.authored;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return;
    const me = this.host?.localUserId?.() ?? null;
    if (me === null || typeof rec.userId !== "string" || rec.userId !== me) return;
    this.authoredBy = me;
    for (const d of rec.docIds ?? []) if (typeof d === "string" && d) this.authoredDocs.add(d);
  }

  /**
   * Take one revoked TREE BINARY off this disk.
   *
   * The same decision as a revoked note's, reached by the same plan — and a
   * completely different execution, because a binary has no doc:
   *
   *  - nothing to `releaseDoc`: no bridge, no provider, no editor session;
   *  - nothing to `clearYjsDoc`: the bytes never entered the CRDT pipeline;
   *  - a `pushed` checkpoint it cannot use, and a stand-in that had to be built.
   *    The `files` row is NOT that stand-in, though it was read as one: the row
   *    is minted before the bytes move (`attachments.ts ensureFileRow`,
   *    `preregisterFiles`), and on a Free vault, above the blob size ceiling or
   *    behind a full quota the bytes never follow it. Removing such a file on a
   *    revocation destroys the only copy there is — exactly what `isPushed`
   *    refuses to do for a note. So the real stand-in is
   *    {@link confirmFileBytes}: an upload that completed, a download, an
   *    intent that deduped, or a listing whose sha matched. Unconfirmed rows
   *    are not announced in `hello.files` either, so the server cannot name
   *    them and the plan never reaches here — this check is the belt;
   *  - and one thing a note does NOT need: the binary delete queue has to be
   *    told this removal was ours, or it propagates it back as a user delete and
   *    the owner loses their copy of a file they only meant to stop sharing.
   *
   * `deleteFile` works on any bytes and refuses a directory and an ignored path,
   * so it needs no binary twin in Rust.
   */
  private async removeRevokedBinary(gone: InboundTrash): Promise<boolean> {
    // The one refusal, and the same shape the note rail's `isPushed` makes: the
    // mapping is LEFT in place, so a pass that later confirms these bytes can
    // remove the file properly. It stays out of `hello.files` meanwhile
    // (`fileDocIds`), so nothing re-announces it and the ACL-authority clock is
    // not re-stamped on every reconnect.
    if (!this.filesConfirmed.has(gone.docId)) {
      this.recordFailure({
        kind: "orphan",
        path: gone.path,
        docId: gone.docId,
        code: null,
        reason:
          "access was removed, but this device never confirmed its bytes upstream — left on disk",
      });
      return false;
    }
    // BEFORE the removal, so the claim beats the watcher to the queue.
    this.host?.suppressBinaryDelete?.(gone.path);
    try {
      // Idempotent when the source already disappeared in the same watcher
      // window, so the mapping can still be retired cleanly.
      await ipc.deleteFile(gone.path, this.epoch());
      // The row is gone for us, so the mapping goes with it — otherwise the next
      // `hello` re-announces an id whose file is not here, the server names it
      // revoked again, and the ACL-authority clock is re-stamped on every
      // reconnect for a removal that already happened.
      this.forgetFileId(gone.path);
      this.authoredDocs.delete(gone.docId);
      this.host?.fileRemoved?.(gone.docId, gone.path, null);
      return true;
    } catch (e) {
      if (ipc.isVaultMismatch(e)) return false;
      this.recordFailure({
        kind: "inbound",
        path: gone.path,
        docId: gone.docId,
        reason: reasonOf(e),
        code: null,
      });
      return false;
    }
  }

  private async confirmRevocations(vaultId: string, plan: InboundPlan): Promise<void> {
    const asked = new Set(plan.needsAccessCheck);
    let confirmed: Set<string>;
    try {
      // Chunked, because the route refuses more than `ACCESS_CHECK_MAX` ids with
      // a 400 — and a 400 reads here as "no answer", so one oversized request
      // turned every revocation on a vault of more than 2000 mapped notes into a
      // permanent failure that repeated on every connect and never landed.
      //
      // A throw on ANY slice fails the WHOLE group, not just that slice: the
      // answers are corroboration for one decision, and acting on the half we
      // happened to get back would delete files on a partial second opinion.
      confirmed = new Set<string>();
      const ids = [...asked];
      for (let i = 0; i < ids.length; i += ACCESS_CHECK_MAX) {
        const slice = ids.slice(i, i + ACCESS_CHECK_MAX);
        for (const docId of await this.api.accessCheck(vaultId, slice)) {
          confirmed.add(docId);
        }
        if (this.stopRun()) throw new Error("vault changed during the access check");
      }
    } catch (e) {
      for (const t of plan.trash) {
        if (t.reason !== "revoked" || !asked.has(t.docId)) continue;
        plan.suppress.delete(t.path);
        plan.rejected.push({
          kind: "trash",
          path: t.path,
          docId: t.docId,
          reason: `refused: could not confirm the access change with the server (${reasonOf(e)}) — left on disk`,
        });
      }
      plan.trash = plan.trash.filter((t) => !(t.reason === "revoked" && asked.has(t.docId)));
      return;
    }
    const disputed: string[] = [];
    for (const t of plan.trash) {
      if (t.reason !== "revoked" || !asked.has(t.docId) || confirmed.has(t.docId)) continue;
      disputed.push(t.docId);
      // Un-suppress: the server says we may still read it, so it is an ordinary
      // note again. Leaving it suppressed would keep it out of every later pass
      // on the strength of a claim the server has just contradicted.
      plan.suppress.delete(t.path);
      plan.rejected.push({
        kind: "trash",
        path: t.path,
        docId: t.docId,
        reason:
          "refused: the server listing omitted it but the resolver still grants access — left on disk",
      });
    }
    if (disputed.length === 0) return;
    const dropped = new Set(disputed);
    plan.trash = plan.trash.filter((t) => !(t.reason === "revoked" && dropped.has(t.docId)));
    // Tell the session, so the contradicted ids leave the named-revocation set
    // instead of being retried on the next authoritative pass.
    this.host?.revocationRefused?.(disputed);
  }

  private async applyInbound(
    vaultId: string,
    args: {
      folders: TreeNode[];
      notes: TreeNode[];
      /** The index's {path → docId} rows, READ ON DEMAND: they are needed only
       *  for on-disk notes this registry doesn't already map, and the read parks
       *  on the index write lock (see the thunk in `syncStructure`). */
      titles: () => Promise<Array<{ path: string; id: string }>>;
      serverFolders: Array<{ id: string; path: string }>;
      serverNotes: RegisteredNote[];
      tombstones: string[] | null;
      folderTombstones: string[] | null;
    },
  ): Promise<{ changedDisk: boolean; suppress: Set<string> }> {
    const none = { changedDisk: false, suppress: new Set<string>() };
    // No baseline for this collection ⇒ no inbound. A first run, a config written
    // by another vault, or a wiped `.context` all land here, and all of them mean
    // "we have no idea what moved" — which must degrade to outbound-only, never to
    // a guess about what to delete.
    if (this.baselineVaultId !== vaultId) return none;

    const localNotePaths = new Set(args.notes.map((n) => n.path));
    // What docId does this device believe each on-disk note has?
    //
    // The registry's OWN map answers first, and it has to: a note this device
    // MATERIALIZED from the server got its file written by `writeNoteIfMissing`,
    // and Rust's indexer mints a fresh local UUID for any file it hasn't seen
    // before. The materialize step now rebinds that row to the server's id
    // straight away (#147), but every note materialized by an older build still
    // carries the fork, so `byPath` remains the only place the two identities
    // are reliably joined (see viewingDocId.ts, which says the same thing for
    // presence).
    //
    // Keying this map on index ids alone therefore made every remote delete of a
    // materialized note a no-op: `local.get(serverDocId)` came back undefined, the
    // plan read that as "already gone locally" and suppressed nothing, and the
    // outbound half below re-registered the still-present file under its LOCAL id
    // — resurrecting the note on the server as a brand-new row with a brand-new
    // docId. Deleting it again just repeated the cycle, which is what made a
    // deleted note look undeletable.
    //
    // The index id stays as the fallback for paths the registry doesn't map yet
    // (a note created locally and not yet registered). One docId per path either
    // way — `claimed` stops a mapped path also entering under its index id, which
    // would let one file be both renamed and trashed in a single pass.
    const local = new Map<string, string>();
    const claimed = new Set<string>();
    for (const path of localNotePaths) {
      const m = this.byPath.get(path);
      // `byPath` can still hold another collection's entries at this point (they
      // are pruned after inbound runs), and those ids mean nothing here.
      if (m && m.vaultId === vaultId) {
        local.set(m.docId, path);
        claimed.add(path);
      }
    }
    // Only notes that are BOTH in the tree and in the index have a docId we can
    // match on. The index now covers the WHOLE note family (`index.rs` asks
    // `vault::is_note_file`), so a `.txt`/`.canvas` note is inbound-renameable
    // like any other; before that it could only ever be materialized, never
    // renamed or trashed — the safe direction, but a half-synced one.
    //
    // Asked for only when some on-disk note is NOT claimed above: on a
    // steady-state relaunch the registry's own map covers every one of them, so
    // this loop has nothing to add and the index read is pure launch latency.
    if ([...localNotePaths].some((p) => !claimed.has(p))) {
      for (const t of await args.titles()) {
        if (localNotePaths.has(t.path) && !claimed.has(t.path)) local.set(t.id, t.path);
      }
    }
    const server = new Map<string, string>();
    for (const n of args.serverNotes) {
      const rp = noteRelPath(n);
      if (rp) server.set(noteDocId(n), rp);
    }

    const plan = planInbound({
      server,
      tombstones: args.tombstones ? new Set(args.tombstones) : null,
      baseline: this.baselineDocs,
      local,
      serverFolders: new Set(args.serverFolders.map((f) => f.path)),
      serverFolderIds: new Map(args.serverFolders.map((f) => [f.id, f.path] as const)),
      localFolders: new Set(args.folders.map((f) => f.path)),
      folderTombstones: args.folderTombstones ? new Set(args.folderTombstones) : null,
      // The persisted path → server-folder-id join: an id match against a
      // tombstone is proof the local folder IS the deleted one.
      localFolderIds: new Map(this.folderByPath),
      // Both listings came back 200 (a failure throws out of `syncStructure`
      // before this runs), the session is live, and the server itself announced
      // an access change moments ago — so a doc absent from these listings has
      // genuinely left this user's readable set. That is what lets "Entire vault
      // → Private" remove ALL of them; without it the revocation cap refuses any
      // pass that takes away more than half the vault, which is every
      // whole-vault revocation there is.
      authoritative: this.host?.revocationAuthority?.() === true,
      // …and, when the server named the docs rather than only announcing that
      // access moved, the names. The cap then lifts for those docs only.
      authoritativeRevoked: this.host?.authoritativeRevoked?.() ?? undefined,
      // Legacy authorship metadata remains in the plan input for config/API
      // compatibility. Confirmed removal no longer branches on it.
      authoredByMe: this.authoredDocs,
      // Tree binaries: doc_id → path, the `files` map inverted. Only ever acted
      // on when the server NAMED the id — see the binary pass in `planInbound`.
      localFiles: this.localFiles(),
    });

    // Anything the cap lift saved has to survive a SECOND, differently-computed
    // answer before a file is deleted. `GET /api/notes` and the vault channel's
    // `ready.revoked` are one function read twice, so a regression inside it
    // produces the short listing and the announcement together — which is
    // exactly the authority needed to clear a member's disk. `access-check`
    // resolves each doc through `effectivePermission` instead, and a
    // disagreement means the file stays.
    const plannedRemovals = plan.trash.length + plan.removeFolders.length;
    if (plannedRemovals > 0) this.sink.phase("removing", plannedRemovals);
    if (plan.needsAccessCheck.length > 0) {
      await this.confirmRevocations(vaultId, plan);
      if (this.stale()) return none;
    }

    for (const r of plan.rejected) {
      this.recordFailure({
        kind: "inbound-blocked",
        path: r.path,
        docId: r.docId,
        reason: r.reason,
        code: null,
      });
    }

    let changedDisk = false;

    // Folders first: a rename or materialize below may need one as a parent.
    // `ensureFolder` is idempotent, so a folder that already exists costs nothing
    // and a second pull is a no-op.
    for (const path of plan.createFolders) {
      if (this.stopRun()) break;
      try {
        // Only a directory this call actually created is a disk change — and it
        // is OUR change, so its watcher echo is remembered and consumed rather
        // than read as an external edit that needs another pull (#98).
        if (await ipc.ensureFolder(path, this.epoch())) {
          changedDisk = true;
          this.markMaterialized(path);
        }
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return none;
        this.recordFailure({
          kind: "inbound",
          path,
          docId: null,
          reason: reasonOf(e),
          code: null,
        });
      }
    }

    for (const move of plan.renames) {
      if (this.stopRun()) break;
      // Nothing may still hold the old path when we move it.
      await this.host?.releaseDoc(move.docId);
      if (this.stale()) return { changedDisk, suppress: plan.suppress };
      try {
        // Rust refuses a rename onto an existing file, so this cannot overwrite
        // content — we lean on that rather than pre-checking and racing.
        await ipc.renamePath(move.from, move.to, this.epoch());
        changedDisk = true;
        this.host?.notePathChanged(move.docId, move.from, move.to);
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return { changedDisk, suppress: plan.suppress };
        this.recordFailure({
          kind: "inbound",
          path: move.to,
          docId: move.docId,
          reason: reasonOf(e),
          code: null,
        });
      }
    }

    // Use bounded IPC batches for large revocations. Only one batch is resident
    // and in flight, and each yields to the UI before preparing the next one.
    // Authorization and the unconfirmed-content guard still precede every delete.
    const removalTotal = plan.trash.length + plan.removeFolders.length;
    if (removalTotal > 0) this.sink.phase("removing", removalTotal);
    const bulkRemoval = useBulkPath(plan.trash.length);
    /** path → `.context/trash` copy made for unseen work before removal. */
    const recovered = new Map<string, string>();
    for (const group of chunked(plan.trash, bulkRemoval ? 64 : INBOUND_REMOVE_CONCURRENCY)) {
      if (this.stopRun()) return { changedDisk, suppress: plan.suppress };
      const ready: InboundTrash[] = [];
      let cancelled = false;
      await runPool(group, async (gone) => {
        try {
          if (gone.binary) {
            const removed = await this.removeRevokedBinary(gone);
            if (removed) changedDisk = true;
            this.sink.item(removed ? "ok" : "failed");
            return;
          }
          // The gate is UNSEEN WORK, not `pushed`: a stale device (nothing new
          // since the server's last acknowledgement) accepts the delete or the
          // revocation outright; a device holding ops the server never saw keeps
          // a recovery copy under `.context/trash` first (offline
          // reconciliation D1/D7). Measured BEFORE the release, while a resident
          // bridge still answers for ops not yet in SQLite.
          const verdict = await this.unseenWorkVerdict(gone.docId, gone.path);
          if (verdict === "unknown") {
            // Unprovable identity: the old "left on disk" refusal, unchanged.
            this.recordFailure({
              kind: "orphan", path: gone.path, docId: gone.docId, code: null,
              reason: gone.reason === "revoked"
                ? "access was removed, but this device never confirmed its content upstream — left on disk"
                : "deleted on the server, but this device never confirmed its content — left on disk",
            });
            // Releasing the claim lets a file that is really a NEW note at this
            // path (re-imported under a fresh local id) register on a later
            // pass. A file still carrying THIS doc_id stays suppressed without
            // it: `planInbound` suppresses any local note whose own id is
            // tombstoned, and the server refuses a dead id with `note_deleted`
            // besides (prod 2026-09-23).
            if (gone.reason !== "revoked") this.baselineDocs.delete(gone.docId);
            this.sink.item("failed");
            return;
          }
          await this.host?.releaseDoc(gone.docId);
          if (verdict === "unseen") {
            let dest: string | null = null;
            try {
              // An empty file (a placeholder never egested into) says nothing
              // about the ops in the CRDT, and a revocation clears that CRDT:
              // preserve its TEXT instead of an empty copy.
              const crdtText = (await this.isEmptyOnDisk(gone.path))
                ? ((await this.host?.localText?.(gone.docId)) ?? "")
                : "";
              dest = crdtText.trim().length > 0
                ? await ipc.writeTrashCopy(gone.path, recoveryStamp(), crdtText, this.epoch())
                : await ipc.copyToTrash(gone.path, recoveryStamp(), this.epoch());
            } catch (e) {
              if (ipc.isVaultMismatch(e)) throw e;
              dest = null;
            }
            if (dest === null) {
              // No copy, no removal: this file may be the only home of that work.
              this.recordFailure({
                kind: "orphan", path: gone.path, docId: gone.docId, code: null,
                reason: gone.reason === "revoked"
                  ? "access was removed while this device held unsent edits, and they could not be preserved — left on disk"
                  : "deleted on the server while this device held unsent edits, and they could not be preserved — left on disk",
              });
              // See the tombstone note on `baselineDocs` below: releasing the
              // claim keeps a re-imported NEW note at this path registrable.
              if (gone.reason !== "revoked") this.baselineDocs.delete(gone.docId);
              this.sink.item("failed");
              return;
            }
            recovered.set(gone.path, dest);
            // D1 + D6: offer the unseen ops to the server's trash copy of the
            // doc. Never awaited — the local copy above is the guarantee.
            if (gone.reason !== "revoked") {
              this.recoverPending.add(gone.docId);
              void Promise.resolve(this.host?.recoverDeletedDoc?.(gone.docId, gone.path))
                .catch(() => {})
                .finally(() => this.recoverPending.delete(gone.docId));
            }
          }
          if (!this.stopRun()) ready.push(gone);
        } catch (e) {
          if (ipc.isVaultMismatch(e) || this.stale()) {
            cancelled = true;
            return;
          }
          this.sink.item(this.recordFailure({
            kind: "inbound", path: gone.path, docId: gone.docId,
            reason: reasonOf(e), code: null,
          }));
        }
      }, { concurrency: INBOUND_REMOVE_CONCURRENCY, shouldStop: () => cancelled || this.stopRun() });
      if (cancelled || this.stopRun()) return { changedDisk, suppress: plan.suppress };
      let outcomes: Array<{ path: string; error: string | null }>;
      try {
        if (bulkRemoval) {
          outcomes = ready.length === 0 ? [] : await ipc.deleteFilesBatch(ready.map((gone) => ({
            path: gone.path, docId: gone.reason === "revoked" ? gone.docId : null,
          })), this.epoch());
        } else {
          outcomes = await Promise.all(ready.map(async (gone) => {
            try {
              await ipc.deleteFile(gone.path, this.epoch());
              return { path: gone.path, error: null };
            } catch (e) {
              if (ipc.isVaultMismatch(e)) throw e;
              return { path: gone.path, error: reasonOf(e) };
            }
          }));
        }
      } catch (e) {
        if (ipc.isVaultMismatch(e) || this.stale()) return { changedDisk, suppress: plan.suppress };
        outcomes = ready.map((gone) => ({ path: gone.path, error: reasonOf(e) }));
      }
      if (this.stale()) return { changedDisk, suppress: plan.suppress };
      const byPath = new Map(outcomes.map((out) => [out.path, out]));
      for (const gone of ready) {
        const out = byPath.get(gone.path);
        if (!out || out.error) {
          this.sink.item(this.recordFailure({ kind: "inbound", path: gone.path, docId: gone.docId,
            reason: out?.error ?? "local cleanup did not return a result", code: null }));
          continue;
        }
        changedDisk = true;
        this.baselineDocs.delete(gone.docId);
        this.authoredDocs.delete(gone.docId);
        const trashedTo = recovered.get(gone.path) ?? null;
        this.host?.noteRemoved(gone.docId, gone.path, trashedTo, gone.reason, bulkRemoval);
        if (trashedTo !== null) {
          reconcileReport.record({
            kind: gone.reason === "revoked" ? "keptLocally" : "deletedByTeammate",
            docId: gone.docId,
            path: gone.path,
            detail: trashedTo,
          });
        }
        this.sink.item("ok");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // Paths the plan suppressed WITHOUT trashing: a tombstoned note whose file
    // is still on disk under an identity the index no longer ties to the
    // tombstone (a materialized placeholder whose mapping was pruned). The plan
    // cannot prove that file IS the deleted note, so it leaves it — rightly, for
    // a file with text in it. An EMPTY file is different: there is no work in it
    // to lose, and left alone it sits unmapped, uncounted and unsyncable forever
    // (21 zero-byte stubs under re-created "… 2/" folders in one vault). So the
    // empty ones can be removed permanently without risking user content.
    // (`plan.stubs` is only ever filled for notes the server confirmed deleted —
    // never for revocations or a listing that didn't report tombstones, where
    // "I don't know" must remove nothing.)
    for (const path of plan.stubs) {
      if (this.stopRun()) break;
      if (!(await this.isEmptyOnDisk(path))) {
        // A file WITH content at a path the server says was deleted, and no
        // docId match to prove it is that note (the `dead && loc === undefined`
        // branch in `planInbound`). We will not trash it — we cannot prove whose
        // it is — but we must also stop claiming it, or the baseline suppresses
        // this path on every pass forever and the user's content becomes
        // permanently unsyncable while the header still reads "Synced".
        //
        // That is exactly what re-dropping a previously-synced folder did: 176
        // `Daily/*` tombstones still held baseline entries, the re-imported files
        // landed on those same paths under fresh local index ids, and all 176 were
        // suppressed — `0/174`, nothing queued, no error, and only opening a note
        // synced it (the editor calls `registerNote` directly, bypassing
        // `suppress`). Releasing the claim lets the NEXT pass register it as the
        // new local note it is.
        //
        // The trade this makes, deliberately: a file that really IS the deleted
        // note — same path, new local identity — re-registers under a fresh docId
        // instead of staying dead (the resurrect this branch was written to
        // prevent). That case is visible and re-deletable; silent permanent
        // divergence is neither, and `.md` on disk is the source of truth. The
        // device that performed the delete removes its own file, so it never
        // reaches here. Recorded rather than done silently.
        for (const [docId, rp] of [...this.baselineDocs]) {
          if (rp !== path) continue;
          this.baselineDocs.delete(docId);
          this.recordFailure({
            kind: "inbound",
            path,
            docId,
            reason:
              "deleted on the server but still on disk with content — re-registering it as a new local note",
            code: "resurrected_local_note",
          });
        }
        continue;
      }
      if (this.stale()) return { changedDisk, suppress: plan.suppress };
      try {
        await ipc.deleteFile(path, this.epoch());
        changedDisk = true;
        // Nothing is at that path any more, so no baseline entry may keep
        // claiming it (which would suppress a genuinely new file there later).
        for (const [docId, rp] of [...this.baselineDocs]) {
          if (rp === path) this.baselineDocs.delete(docId);
        }
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return { changedDisk, suppress: plan.suppress };
        // Left on disk; it stays suppressed and harmless, as before.
      }
    }

    // Folders the server has deleted, moved away from, or taken this user's
    // access to (made private: absent from the permission-filtered listing with
    // no tombstone), children before parents, AFTER the trash loop above has
    // moved their notes out. Empty-only removal (`remove_dir`, never recursive):
    // a folder still holding anything stays on disk and — its dead mapping
    // dropped below — re-registers under a fresh id, because content must live
    // somewhere. Either way the stale id leaves the map, so nothing can later
    // rename/color/re-register against a deleted server row.
    // Folders a teammate DELETED (tombstoned ids), as opposed to moved or made
    // private: one that survives the empty-only removal below still holds work
    // of this device's — new notes the deleter never saw — and is kept (D8).
    const tombstonedFolders = new Set<string>();
    if (args.folderTombstones) {
      const dead = new Set(args.folderTombstones);
      for (const [rp, id] of this.folderByPath) if (dead.has(id)) tombstonedFolders.add(rp);
    }
    for (const path of plan.removeFolders) {
      if (this.stopRun()) break;
      try {
        const removed = await ipc.deleteFolderIfEmpty(path, this.epoch());
        this.sink.item("ok");
        if (removed) {
          changedDisk = true;
          this.markMaterialized(path); // our removal; one watcher echo to swallow
        } else if (tombstonedFolders.has(path)) {
          reconcileReport.record({
            kind: "folderKept",
            path,
            detail: "deleted by a teammate, kept because it still holds notes created here",
          });
        }
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return { changedDisk, suppress: plan.suppress };
        this.sink.item("failed");
        this.recordFailure({
          kind: "inbound",
          path,
          docId: null,
          reason: reasonOf(e),
          code: null,
        });
      }
      this.folderByPath.delete(path);
    }
    if (plannedRemovals > 0) {
      this.sink.flush();
      this.sink.phase("registering", 0);
    }
    // Drop EVERY mapping whose id is tombstoned, not just the ones whose dir
    // still existed: a surviving dead entry would make `registerFolder` at the
    // same path adopt the deleted row's id and silently skip creating.
    if (args.folderTombstones) {
      const dead = new Set(args.folderTombstones);
      for (const [rp, id] of [...this.folderByPath]) {
        if (dead.has(id)) this.folderByPath.delete(rp);
      }
    }

    return { changedDisk, suppress: plan.suppress };
  }

  /**
   * Pair each missing mapped path with an unmapped local file holding its
   * exact text (sha256 of this device's local CRDT text against the file), and
   * turn the pair into a RENAME: the server row moves (`renamePath`) and the
   * index row gets the doc_id back (`rebindNoteId`). Each candidate is used
   * once; a text shared by two candidates is ambiguous and pairs nothing. The
   * listing row is rewritten in place so the rest of the pass agrees.
   * Returns from → to for every pair that landed.
   */
  private async pairClosedAppRenames(
    missingMapped: string[],
    unmapped: string[],
    serverNotes: RegisteredNote[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (missingMapped.length === 0 || unmapped.length === 0 || !this.host?.localText) return out;
    const held = this.host.heldDocIds?.() ?? null;
    const byHash = new Map<string, string | null>(); // null ⇒ ambiguous
    for (const p of unmapped) {
      let text: string;
      try {
        text = await ipc.readNote(p, this.epoch());
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return out;
        continue;
      }
      if (text.trim().length === 0) continue;
      const h = await sha256Hex(text);
      byHash.set(h, byHash.has(h) ? null : p);
    }
    if (byHash.size === 0) return out;
    for (const from of missingMapped) {
      if (this.stopRun()) break;
      const docId = this.byPath.get(from)?.docId;
      if (!docId || (held && held.has(docId))) continue;
      let text: string | null = null;
      try {
        text = (await this.host.localText(docId)) ?? null;
      } catch {
        text = null;
      }
      if (!text || text.trim().length === 0) continue;
      const to = byHash.get(await sha256Hex(text));
      if (!to) continue;
      byHash.delete(await sha256Hex(text));
      if (!(await this.renamePath(from, to))) continue;
      try {
        await ipc.rebindNoteId(to, docId, this.epoch());
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return out;
        console.warn(`[registry] couldn't rebind ${to} to ${docId}`, e);
      }
      for (const n of serverNotes) {
        if (noteDocId(n) !== docId) continue;
        if (n.relPath !== undefined) n.relPath = to;
        if (n.rel_path !== undefined || n.relPath === undefined) n.rel_path = to;
      }
      console.info(`[registry] ${from} → ${to} (renamed while the app was closed; keeping doc ${docId})`);
      out.set(from, to);
    }
    return out;
  }

  /**
   * Same-path create (offline reconciliation D4): this device made a note at a
   * path where, meanwhile, a teammate's note appeared on the server.
   *
   * A candidate is a listed note this device has NEVER agreed on (absent from
   * the baseline and from the doc map) whose path holds an UNMAPPED, non-empty
   * local file with a different local id. A device with no baseline for this
   * collection is excluded: a first sync adopts by path on purpose (the same
   * files copied onto a second machine). The listing carries no content hash,
   * so the baseline is what separates "someone else's new note" from "mine".
   *
   * The earlier creation keeps the path. The later one moves to
   * `<stem> (conflict YYYY-MM-DD).<ext>`: the SERVER note through the rename
   * API when it is later (falling back to moving the local file if that is
   * refused), else the local file. Either way the two stay two notes. The
   * listing row is rewritten in place so every consumer of this pass sees the
   * server note at its new path.
   */
  private async resolveSamePathConflicts(
    serverNotes: RegisteredNote[],
    localNotePathCi: Map<string, string>,
    titles: () => Promise<ipc.NoteTitle[]>,
  ): Promise<void> {
    if (this.baselineDocs.size === 0) return;
    const candidates: Array<{ n: RegisteredNote; localPath: string; docId: string }> = [];
    for (const n of serverNotes) {
      const rp = noteRelPath(n);
      const docId = noteDocId(n);
      if (!rp || this.baselineDocs.has(docId) || this.byDocId.has(docId)) continue;
      const localPath = localNotePathCi.get(rp.toLowerCase());
      if (localPath === undefined || this.byPath.has(localPath)) continue;
      candidates.push({ n, localPath, docId });
    }
    if (candidates.length === 0) return;
    const localIds = new Map((await titles()).map((t) => [t.path.toLowerCase(), t.id] as const));
    const taken = new Set<string>([
      ...localNotePathCi.keys(),
      ...serverNotes.map((x) => (noteRelPath(x) ?? "").toLowerCase()),
    ]);
    for (const { n, localPath, docId } of candidates) {
      if (this.stopRun()) return;
      if (localIds.get(localPath.toLowerCase()) === docId) continue; // the same note
      if (await this.isEmptyOnDisk(localPath)) continue; // nothing of ours to lose
      const serverAt = Date.parse(noteCreatedAtOf(n) ?? "");
      let localAt = Number.POSITIVE_INFINITY; // unknown ⇒ local is the later one
      try {
        const st = await ipc.fileStat(localPath, this.epoch());
        localAt = st.created ?? st.modified ?? Number.POSITIVE_INFINITY;
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return;
      }
      const target = conflictPath(localPath, taken);
      taken.add(target.toLowerCase());
      const serverIsLater = Number.isFinite(serverAt) && serverAt > localAt;
      if (serverIsLater) {
        try {
          const moved = await this.api.updateNote(docId, { relPath: target });
          const now = noteRelPath(moved) ?? target;
          if (n.relPath !== undefined) n.relPath = now;
          if (n.rel_path !== undefined || n.relPath === undefined) n.rel_path = now;
          reconcileReport.record({
            kind: "renamedConflict", docId, path: localPath, newPath: now,
            detail: "a teammate created a note at the same path later; theirs was renamed",
          });
          continue;
        } catch {
          /* refused (permission, path taken, offline): move ours instead */
        }
      }
      try {
        // Not `markMaterialized`: the watcher event for `target` is what gets
        // the renamed note registered as the NEW note it is, promptly.
        await ipc.renamePath(localPath, target, this.epoch());
        localNotePathCi.delete(localPath.toLowerCase());
        reconcileReport.record({
          kind: "renamedConflict", path: localPath, newPath: target,
          detail: serverIsLater
            ? "a teammate created a note at the same path; theirs could not be renamed, so this one moved"
            : "a teammate created a note at the same path first; this one was renamed",
        });
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return;
        // Could not move ours: never bind it to their id. Hold the path out of
        // this pass entirely, so the file is left exactly as it is.
        localNotePathCi.delete(localPath.toLowerCase());
        this.aliasPaths.add(localPath);
        this.recordFailure({
          kind: "note", path: localPath, docId: null, code: null,
          reason: `a teammate's note was created at the same path and this one could not be renamed — left on disk, not synced (${reasonOf(e)})`,
        });
      }
    }
  }

  /**
   * Is this note empty on disk (nothing but whitespace)? Public for the session's
   * `ready.empty` probe: a doc the server has no content for AND whose file here
   * is empty has nothing to push, so it must not be queued (see
   * `SyncManager.settleServerEmpty`). Epoch-pinned like every read here.
   */
  isNoteEmptyOnDisk(relPath: string): Promise<boolean> {
    return this.isEmptyOnDisk(relPath);
  }

  /** Is this note empty on disk? Used to decide whether an unconfirmed note is
   *  safe to remove — an empty file can't be holding the only copy of anything. */
  private async isEmptyOnDisk(relPath: string): Promise<boolean> {
    try {
      const text = await ipc.readNote(relPath, this.epoch());
      return text.trim().length === 0;
    } catch {
      // Unreadable ⇒ treat as non-empty, i.e. refuse to remove it.
      return false;
    }
  }

  /** Read the FULL tree (never the lazy sidebar one) — see {@link FullTree}. */
  private async readFullTree(): Promise<FullTree> {
    const tree = await ipc.listTree(this.epoch());
    assertFullTree(tree);
    return tree as FullTree;
  }

  private async writeConfig(cfg: VaultSyncConfig): Promise<void> {
    // Never write another vault's doc map into this folder's config.
    if (this.stale()) return;
    if (!cfg.serverVaultId) return; // nothing meaningful to persist yet
    // Compact, not pretty-printed. This file is rewritten whole on every
    // checkpoint and holds three entries per note; two-space indentation added
    // ~35% to every one of those writes for the benefit of nobody — it is derived
    // state, not something a person edits.
    const json = JSON.stringify(cfg);
    // Identical bytes are not a write. A checkpoint fires on a timer as well as
    // on a count, and during a bulk run most of those ticks find a map nothing
    // has added to — a 5,000-note vault's config is ~500 KB, and re-serializing
    // it into a temp file and renaming it over the old one several times a
    // second is pure I/O for a file that did not change. Keyed by collection so
    // a vault switch can never be mistaken for a no-op, and this stays the ONLY
    // writer of the file (anything else touching it would make the memo lie).
    if (this.lastWrittenConfig?.vaultId === cfg.serverVaultId && this.lastWrittenConfig.json === json) {
      return;
    }
    await ipc.setVaultConfig(json, this.epoch());
    this.lastWrittenConfig = { vaultId: cfg.serverVaultId, json };
  }

  /** The last bytes {@link writeConfig} actually persisted, and for which
   *  collection. See the no-op check there. */
  private lastWrittenConfig: { vaultId: string; json: string } | null = null;

  private newCheckpointer(): Checkpointer<VaultSyncConfig> {
    this.checkpoint?.dispose();
    const cp = new Checkpointer<VaultSyncConfig>({
      write: (cfg) => this.writeConfig(cfg),
      snapshot: () => this.configSnapshot(),
      // Starts at the default and is retuned by `tuneCheckpointBatch` the moment
      // we know how many notes this vault has (see `checkpointBatchFor`).
      everyItems: checkpointBatchFor(this.byPath.size),
    });
    this.checkpoint = cp;
    return cp;
  }

  /** Size the config.json flush batch to this vault: one write per
   *  `checkpointBatchFor(n)` notes, so the write COUNT stays flat as the file
   *  itself grows. */
  private tuneCheckpointBatch(mapped: number): void {
    this.checkpoint?.setEveryItems(checkpointBatchFor(mapped));
  }

  /**
   * Map one path to one docId — and ONLY one.
   *
   * The invariant `byPath` and `byDocId` are two views of: a docId lives at
   * exactly one path. Setting a docId that is already mapped elsewhere used to
   * leave the old `byPath` key in place while `byDocId` flipped to the new path,
   * so the two maps disagreed and `configSnapshot` persisted BOTH keys — the
   * "duplicate path alias" of #129 (470 mapped paths for 464 identities). The
   * consequences were all silent: the alias re-entered `missingNotes` on every
   * pull (re-stamping `registering 0/N` forever), the canonical file lost its
   * badge because `store.docIdByPath` is built from `byDocId`, and the bridge
   * egested the doc's text into whichever path `byDocId` happened to hold.
   *
   * The LAST writer wins, deliberately: within a pass the server listing
   * (`resolveNote`, step 3) runs before anything else that maps a note, so this
   * is what lets the server's canonical spelling displace a stale one loaded
   * from `.context/config.json`. Nothing after step 3 may displace a listing
   * entry — the create pool no longer tries (see the `!samePath(serverPath, rp)`
   * branch in `syncStructure`), which is what keeps this a backstop rather than
   * a source of alternation between two spellings on successive passes.
   */
  private setMapping(relPath: string, docId: string, vaultId: string): void {
    const previous = this.byDocId.get(docId);
    if (previous !== undefined && previous !== relPath) this.byPath.delete(previous);
    this.byPath.set(relPath, { vaultId, docId });
    this.byDocId.set(docId, relPath);
    this.notifyMapChanged();
  }

  /**
   * Adopt `.context/config.json`'s `docs` map — ONE path per docId.
   *
   * Configs in the wild already carry duplicate path aliases (#129), and
   * `configSnapshot` round-trips whatever it is given, so without a dedupe here
   * an alias minted by an older build survives every relaunch even after the
   * bug that minted it is gone.
   *
   * LAST entry wins. The file's key order is `byPath`'s insertion order, and in
   * the shape that produced these aliases the stale path was already in the map
   * when the canonical one arrived from the server listing — so the later key is
   * the one the server agreed with. It is a tie-break, not a source of truth:
   * this runs offline (`primeLocal` has no listing yet, and `reconcile` reads
   * the config before it fetches one), and step 3 of `syncStructure` re-derives
   * every mapping from the server on the same pass, with `setMapping` letting
   * the listing displace whatever was loaded here.
   */
  private adoptConfigDocs(docs: Record<string, unknown>, vaultId: string): void {
    const pathForDoc = new Map<string, string>();
    for (const [rp, docId] of Object.entries(docs)) {
      if (typeof docId === "string" && docId) pathForDoc.set(docId, rp);
    }
    for (const [docId, rp] of pathForDoc) this.setMapping(rp, docId, vaultId);
  }

  /**
   * Ensure the server knows this vault's folders + notes; adopt existing ids,
   * create missing rows, and persist the mapping. Idempotent.
   *
   * Reads the tree ITSELF (`listTree`, the full recursive walk) rather than
   * accepting one from the caller — exactly as `pull()` does, and for a reason
   * that cost 428 notes: the sidebar's tree is LAZY. `store.refreshTree` fetches
   * only the top level, and every unexpanded folder carries an empty `children`
   * placeholder. Handed that tree, `flattenTree` sees root-level notes and
   * nothing else, so (a) no nested note is ever registered or uploaded, and
   * (b) — the destructive half — every nested note the server already knows
   * about looks server-only to step 5 below and gets materialized as an EMPTY
   * file over real content. A partial tree must never reach this method, and the
   * only way to guarantee that is for this method to be the one that reads it.
   *
   * Returns `{ seeded }` — true only when this call wrote first-run starter
   * content into a brand-new, empty vault (so the caller can open it).
   */
  /**
   * Adopt this folder's OWN doc-id map from `.context/config.json`, with no
   * server round trip — so a note this device already maps can open with a
   * provider (pull-before-seed, spec 03 §5) while `reconcile` is still running.
   *
   * Provisional by construction: the collection id comes from disk, and
   * `reconcile` re-validates it against `listVaults` a moment later. A mismatch
   * drops these mappings in `syncStructure`'s different-collection prune,
   * exactly as it drops a stale map today.
   *
   * REQUIRES the config to carry the `organizationId` stamp, and for it to
   * match: a pre-stamp config proves nothing about whose folder this is, and
   * priming a foreign one is the cross-vault merge every guard in this file
   * exists to stop. Such a folder simply doesn't prime — the reconcile then
   * adopts it the slow, verified way, which is today's behaviour.
   *
   * Returns whether anything was adopted.
   */
  async primeLocal(orgId: string): Promise<boolean> {
    this.bound = this.scopes.current();
    const cfg = await this.loadConfig();
    if (this.stale()) return false;
    if (!cfg.organizationId || cfg.organizationId !== orgId) return false;
    if (!cfg.serverVaultId) return false;
    // Handed to `reconcile` so the file is read once per boot, not twice.
    this.primedConfig = cfg;
    this.organizationId = orgId;
    this.serverVaultId = cfg.serverVaultId;
    // The layers above read the collection id off the scope.
    if (this.bound) this.bound.serverVaultId = cfg.serverVaultId;
    // So a `markPushed` for a note opened during the window is persisted rather
    // than dropped (`reconcile` adopts this same checkpointer).
    this.newCheckpointer();
    this.adoptConfigDocs(cfg.docs ?? {}, cfg.serverVaultId);
    for (const [rp, id] of Object.entries(cfg.folders ?? {})) {
      if (typeof id === "string" && id) this.folderByPath.set(rp, id);
    }
    this.adoptConfigFiles(cfg.files ?? {}, cfg.filesConfirmed ?? [], cfg.fileBases ?? {});
    this.pushed = new Set(cfg.pushed ?? []);
    this.ackedSvs = adoptAcked(cfg.ackedSv, null);
    this.unhydratedPlaceholders = new Set(cfg.unhydratedPlaceholders ?? []);
    // Same collection guard as `reconcile`'s: the baseline describes the
    // collection the config names, which is the one we just adopted.
    this.baselineDocs = new Map<string, string>();
    for (const [docId, rp] of Object.entries(cfg.baseline ?? {})) {
      if (typeof rp === "string" && rp) this.baselineDocs.set(docId, rp);
    }
    this.adoptAuthored(cfg);
    this.adoptBootstrap(cfg, cfg.serverVaultId);
    this.baselineVaultId = cfg.serverVaultId;
    return true;
  }

  async reconcile(input: ReconcileInput): Promise<{ seeded: boolean }> {
    // Bind this registry to the vault the reconcile is FOR — this is the one
    // operation allowed to (re)claim it. Every await below is a chance for the
    // user to switch vaults; each `stale()` checkpoint drops the rest of the work
    // instead of applying it to whatever vault is now open.
    // `primeLocal` may have claimed the same scope moments ago; keep that claim
    // while it is still current rather than re-reading it.
    if (!this.bound || !this.bound.isCurrent()) this.bound = this.scopes.current();
    // See `pullOnce`: nothing below may run against a vault root that is gone.
    if (this.host?.confirmVaultRoot && !(await this.host.confirmVaultRoot())) {
      return { seeded: false };
    }
    if (this.stale()) return { seeded: false };
    this.organizationId = input.organizationId;
    this.failed = [];
    this.limitReached = null;
    // NOT unconditional: `newCheckpointer` disposes the previous one, and after
    // a prime that one may hold a `markPushed` for a note the user opened during
    // the window — dropping it loses a real fact about the server.
    this.checkpoint ?? this.newCheckpointer();
    this.sink.phase("registering", 0);
    // Epoch-pinned like every other read here: a vault switch mid-walk makes Rust
    // reject it, which `stale()` then turns into a clean drop.
    const tree = await this.readFullTree();
    if (this.stale()) return { seeded: false };
    // The prime already parsed it (one read per boot); it is consumed here so a
    // later pull re-reads from disk as before.
    const cfg = this.primedConfig ?? (await this.loadConfig());
    this.primedConfig = null;
    if (this.stale()) return { seeded: false };
    this.tuneCheckpointBatch(Object.keys(cfg.docs ?? {}).length);

    // 1. Ensure a server note collection (the `vaults` table row, 1:1 with this
    //    vault in practice) — resolved by ID, never by name (names collide and
    //    vary per device; the vault's org id is the identity).
    //    Precedence:
    //      a. the collection id recorded in .context/config.json, IF it still
    //         exists in THIS vault (a stale or cross-vault id is discarded);
    //      b. the vault's oldest existing collection (server lists created_at
    //         ASC), so every device deterministically adopts the same one —
    //         matching by folder name here used to fork a second, empty
    //         collection (and 403 for plain members, who can't create them),
    //         which is why a freshly-joined device saw an empty vault;
    //      c. create one (owner/admin bootstrapping a brand-new vault).
    // Start the listings for the id we already believe in, so they fly alongside
    // the validation rather than behind it. See `prefetchedListings`.
    if (cfg.serverVaultId) this.prefetchListings(cfg.serverVaultId);
    const vaults = await this.api.listVaults();
    if (this.stale()) return { seeded: false };
    const inOrg = vaults.filter((v) => vaultOrgId(v) === input.organizationId);
    let vaultId = cfg.serverVaultId ?? null;
    if (vaultId && !inOrg.some((v) => v.id === vaultId)) vaultId = null;
    if (!vaultId) {
      let vault = inOrg[0] ?? null;
      if (!vault) {
        try {
          vault = await this.api.createVault({
            name: input.vaultName,
            organizationId: input.organizationId,
          });
        } catch (e) {
          // Only owner/admin may create a collection (403 for a plain member).
          // A member reaching here means the server showed them no collection
          // in this vault — they have no access to one yet, which is a waiting
          // state, not a broken client. Letting this throw failed the whole
          // reconcile, so sync never came on and the only visible remedy made
          // them a brand-new vault of their own. Report it and stop instead.
          throw new Error(
            `No accessible note collection in this vault yet. ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      vaultId = vault.id;
    }
    if (this.stale()) return { seeded: false };
    this.serverVaultId = vaultId;
    // Publish the resolved collection id on the scope for the layers above.
    if (this.bound) this.bound.serverVaultId = vaultId;
    // Adopt the previous run's content-push checkpoint. This is what makes a
    // killed backfill resume instead of re-walking the whole vault. Guarded on
    // the collection matching, like everything else read back from config: a
    // pushed-set recorded against another collection says nothing about this one.
    //
    // The in-memory set is folded in, not replaced: a note opened during the
    // PRIME window can be confirmed (`confirmOpenDoc` → `markPushed`) before
    // this line runs, and that is a real fact about the server. Overwriting it
    // from the file would send the doc back through the content run for nothing.
    // Both halves still die together when the collection doesn't match.
    this.pushed =
      cfg.serverVaultId === vaultId
        ? new Set([...(cfg.pushed ?? []), ...this.pushed])
        : new Set();
    this.ackedSvs =
      cfg.serverVaultId === vaultId ? adoptAcked(cfg.ackedSv, this.ackedSvs) : new Map();
    this.unhydratedPlaceholders =
      cfg.serverVaultId === vaultId
        ? new Set([...(cfg.unhydratedPlaceholders ?? []), ...this.unhydratedPlaceholders])
        : new Set();
    // Adopt the baseline ONLY if the config we just read describes the collection
    // we actually resolved. Anything else (a first run, a config from another
    // vault, a rewritten `.context`) leaves it empty, which disables inbound for
    // this pass — outbound-only, i.e. exactly the old behaviour.
    this.baselineDocs = new Map<string, string>();
    this.baselineVaultId = null;
    this.authoredDocs = new Set();
    this.authoredBy = null;
    if (cfg.serverVaultId === vaultId && cfg.baseline) {
      for (const [docId, rp] of Object.entries(cfg.baseline)) {
        if (typeof rp === "string" && rp) this.baselineDocs.set(docId, rp);
      }
      this.adoptAuthored(cfg);
      this.baselineVaultId = vaultId;
    }
    // Restore the path → server-docId join too, under the same collection guard.
    //
    // `docs` was written every pass and read back by nobody, so after a relaunch
    // the ONE link between a file and its server identity was gone until the
    // server's listing rebuilt it in step 3. For a note the server has since
    // DELETED that listing never comes, so inbound could not recognise the file
    // as the deleted doc and the note lingered on disk (and, before the inbound
    // fix, got re-registered under a new docId).
    //
    // Safe to trust for exactly the reason it can't serve as the baseline: it is
    // rewritten from scratch each pass and maintained by `registerNote` /
    // `deletePath`, so it describes what this device believes NOW. A note the
    // user deleted and recreated at the same path carries the new docId here, not
    // the old one — so a stale tombstone still fails to match, which is what
    // stops inbound removing a file it can't prove the identity of. Step 3
    // overwrites these entries from the server and step 4 prunes whatever the
    // server no longer lists, so nothing survives the pass unconfirmed.
    if (cfg.serverVaultId === vaultId && cfg.docs) {
      this.adoptConfigDocs(cfg.docs, vaultId);
    }
    // Restore the folder path → server-id join too (same collection guard). It
    // was written every pass and read back by nobody — so after a relaunch a
    // folder the server had DELETED could not be recognised as the deleted one
    // (the tombstone match is by id), and the outbound half re-registered it.
    if (cfg.serverVaultId === vaultId && cfg.folders) {
      for (const [rp, id] of Object.entries(cfg.folders)) {
        if (typeof id === "string" && id) this.folderByPath.set(rp, id);
      }
    }
    // Same guard for the tree-binary map: an id minted against another
    // collection names nothing here.
    if (cfg.serverVaultId === vaultId && cfg.files) {
      this.adoptConfigFiles(cfg.files, cfg.filesConfirmed ?? [], cfg.fileBases ?? {});
    }
    this.adoptBootstrap(cfg, vaultId);

    // 1b. First-run seeding. A vault the user JUST created (`seedIfEmpty`) —
    //     with nothing on the server AND an empty local folder — gets
    //     welcome/starter content so the vault isn't an empty void. We seed
    //     BEFORE flattening so the files register as ordinary server docs in
    //     steps 2–4. Skipped when the server already has notes (joining/
    //     rejoining a populated vault) or the folder already has content —
    //     those paths adopt/materialize instead. And skipped WITHOUT the
    //     caller's explicit creation intent: turning on sync for a folder the
    //     user opened, or joining an empty team vault, must never invent
    //     content in it.
    //
    //     Ask the FREE questions first. Only a just-created vault can seed, and
    //     only into an empty folder — both local facts. The server's note list
    //     is not free: it is the same `GET /api/notes` that `syncStructure`
    //     fetches below (`listNoteRegistry`), so on a 6k-note vault every
    //     ordinary relaunch downloaded all 6k rows TWICE to answer one boolean.
    let workingTree = tree;
    let seeded = false;
    const localFlat = flattenTree(tree);
    if (
      input.seedIfEmpty === true &&
      localFlat.notes.length === 0 &&
      localFlat.folders.length === 0
    ) {
      const serverNotes = await this.api.listNotes(vaultId);
      if (this.stale()) return { seeded: false };
      if (serverNotes.length === 0) {
        await seedWelcomeContent(this.epoch());
        if (this.stale()) return { seeded: false };
        workingTree = await this.readFullTree();
        seeded = true;
      }
    }

    await this.syncStructure(vaultId, workingTree, { inbound: true });
    return { seeded };
  }

  /**
   * The tail of the pull chain. Pulls are SERIALIZED: two interleaved
   * `syncStructure` passes feed the shared progress reporter from both sides at
   * once (each resets the denominator the other is still counting against),
   * which is how the header once read "Syncing 585/164".
   */
  private pullChain: Promise<boolean> = Promise.resolve(false);

  /**
   * Re-pull the server's folder/note set and reconcile it against the current
   * local tree WITHOUT re-resolving the vault or seeding. Called when the vault
   * channel signals a `registry` change (a teammate created/renamed/moved/
   * deleted something) so this device's tree catches up live. Idempotent, and
   * serialized — a pull that arrives while one is running waits its turn.
   *
   * Resolves TRUE only when the pass actually changed something this device can
   * see (disk moved, rows created, notes materialized), so callers can skip a
   * sidebar refresh — and the re-render flicker it causes — for the common
   * "nothing new" pull.
   */
  pull(): Promise<boolean> {
    const run = this.pullChain.then(
      () => this.pullOnce(),
      () => this.pullOnce(),
    );
    this.pullChain = run.catch(() => false);
    return run;
  }

  /**
   * Kick the folder + note listings for `vaultId` without awaiting them. Idempotent
   * per collection id: a second call for the same id reuses the flight in progress.
   */
  private prefetchListings(vaultId: string): void {
    if (this.prefetchedListings?.vaultId === vaultId) return;
    // PAGED: the note listing follows the server's keyset cursor internally, so
    // a 6,000-note vault is a handful of round trips instead of one response
    // that has to be built, serialized and parsed whole. The answer is
    // identical either way — including `tombstones: null` meaning "the server
    // did not say", which is what stops the reconciler inferring a delete — and
    // a server that predates `limit`/`after` ignores them, answers everything
    // with no `nextAfter`, and is therefore asked exactly once.
    const p = Promise.all([
      this.api.listFolderRegistry(vaultId),
      this.api.listNoteRegistryPaged(vaultId, { limit: PULL_PAGE_LIMIT }),
    ]) as Promise<[FolderRegistry, NoteRegistry]>;
    // The consumer awaits this and handles the failure; attach here so a reject
    // that arrives before `takeListings` runs is never an unhandled rejection.
    p.catch(() => {
      /* surfaced at the await in takeListings */
    });
    this.prefetchedListings = { vaultId, p };
  }

  /**
   * The listings for `vaultId`, using the optimistic prefetch when it was started
   * for this same collection. Consumed once — a later pull re-issues them, because
   * these describe the server as of one moment and a pull's whole job is to ask
   * again.
   */
  private async takeListings(vaultId: string): Promise<[FolderRegistry, NoteRegistry]> {
    const hit = this.prefetchedListings;
    this.prefetchedListings = null;
    if (hit && hit.vaultId === vaultId) return hit.p;
    return Promise.all([
      this.api.listFolderRegistry(vaultId),
      this.api.listNoteRegistryPaged(vaultId, { limit: PULL_PAGE_LIMIT }),
    ]) as Promise<[FolderRegistry, NoteRegistry]>;
  }

  private async pullOnce(): Promise<boolean> {
    // Scope-guarded because this is THE historical corruption path: a debounced
    // pull that survived a vault switch still held vault A's `serverVaultId`
    // while `listTree()` returned vault B's tree, so B's folders/notes were
    // created under A and A's doc map was written into B's config.json.
    if (this.stale()) return false;
    if (!this.serverVaultId) return false;
    // The root is still a folder (#221). Asked of the disk, not of the last
    // watcher batch: a renamed root may never have reported anything.
    if (this.host?.confirmVaultRoot && !(await this.host.confirmVaultRoot())) return false;
    if (this.stale()) return false;
    const vaultId = this.serverVaultId;
    const tree = await this.readFullTree();
    if (this.stale()) return false;
    // The vault id must not have moved on either (a reconcile for another vault
    // could have re-pointed it while we were reading the tree).
    if (this.serverVaultId !== vaultId) return false;
    return this.syncStructure(vaultId, tree, { inbound: true });
  }

  /**
   * The shared core of reconcile/pull: make the server + this device agree on the
   * folder/note set. Adopts existing rows by path, creates missing ones (reusing
   * local doc_ids), materializes server-only notes onto disk, and checkpoints the
   * {relPath → docId} + {folderPath → id} maps to `.context/config.json`.
   *
   * Bounded and cancellable throughout: folders go level by level (so a parent
   * always exists before its children ask for its id), notes go in one flat pool,
   * and every lane re-checks the scope before it picks up an item.
   */
  private async syncStructure(
    vaultId: string,
    workingTree: FullTree,
    opts: { inbound: boolean },
  ): Promise<boolean> {
    if (this.stale()) return false;
    // Did this pass change anything the sidebar can see? Returned so a pull
    // that found nothing new can skip the tree refresh (and its flicker).
    let mutated = false;
    // Failures describe THIS pass. They used to accumulate across pulls — every
    // registry signal re-recorded the same refusals, so a vault could never come
    // back from "N not synced" even after the underlying cause was gone.
    this.failed = [];
    this.limitReached = null;
    const [folderRegistry, noteRegistry] = await this.takeListings(vaultId);
    if (this.stale()) return false;
    const serverFolders = folderRegistry.folders;
    let serverNotes = noteRegistry.notes;
    let { folders, notes } = flattenTree(workingTree);
    // The paths this device already knew BEFORE this pass (#221 drift report).
    const priorMappedCi = new Set([...this.byPath.keys()].map((p) => p.toLowerCase()));
    const checkpoint = this.checkpoint ?? this.newCheckpointer();
    // A pull can be the first thing to touch a big vault's map (a reconnect
    // catch-up), so retune here too rather than trusting the construction-time
    // guess.
    this.tuneCheckpointBatch(this.byPath.size);

    // The local index's docId per note path, for inbound to match by docId
    // rather than by path (a rename changes the path, which is exactly why
    // path-matching produced duplicates).
    //
    // A memoized THUNK, not a value: this read parks on the SQLite index write
    // lock held by the background rebuild (#84), which made it the single worst
    // blocking call on the launch path — and a steady-state relaunch needs it for
    // nothing at all. Both consumers (the inbound fallback identity map and the
    // registry creation pass) ask for it only when they have an unmapped path to
    // resolve. Memoized so the two of them share one read when they do.
    let titlesCache: ipc.NoteTitle[] | null = null;
    const titles = async (): Promise<ipc.NoteTitle[]> =>
      (titlesCache ??= await (async () => {
        // Timed, because this is the one call on the launch path that can park
        // for seconds on a lock nothing here controls. When a launch is slow and
        // the network numbers look fine, this is where to look first.
        const started = performance.now();
        const rows = await ipc.listNoteTitles(this.epoch());
        const ms = Math.round(performance.now() - started);
        if (ms > 250) {
          console.warn(
            `[sync] listNoteTitles parked ${ms}ms on the index lock (${rows.length} notes)`,
          );
        }
        return rows;
      })());

    // Learn who wrote what, BEFORE any of the steps below and outside the inbound
    // guard: the very first pass of a fresh vault has no baseline and so runs no
    // inbound, yet it is the one pass that sees every row. Authorship has to be
    // captured while the row is still LISTED — once access to it is taken away
    // the listing omits it, which is precisely the moment the answer is needed.
    this.learnAuthorship(serverNotes);
    // Access GRANTS: notes readable now that were not in the previous pass's
    // listing. Measured against the listing, before anything below maps them.
    this.detectAccessGrants(serverNotes);

    // 1. Inbound: apply the server's structural changes to disk. Runs first so the
    //    outbound steps below see a tree that already agrees about paths.
    if (opts.inbound) {
      const applied = await this.applyInbound(vaultId, {
        folders,
        notes,
        titles,
        serverFolders,
        serverNotes,
        tombstones:
          noteRegistry.tombstones && this.serverTombstones.size > 0
            ? [...new Set([...noteRegistry.tombstones, ...this.serverTombstones])]
            : noteRegistry.tombstones,
        folderTombstones: folderRegistry.tombstones,
      });
      if (this.stale()) return false;
      if (applied.changedDisk) {
        mutated = true;
        // One re-read, only when we actually moved something. Without it the steps
        // below still see the OLD path as a local note missing from the server (so
        // they re-register it) and the NEW path as server-only (so they materialize
        // an empty file over it) — the duplicate we just fixed, reintroduced.
        // Patching the in-memory lists by hand instead is the dual-bookkeeping that
        // caused this class of bug in the first place.
        const reread = await this.readFullTree();
        if (this.stale()) return false;
        ({ folders, notes } = flattenTree(reread));
        // The paths moved under us, so any memoized read describes the old tree.
        titlesCache = null;
        // Re-read the server's notes too: `move_note` bumps rows we may have just
        // raced, and a stale list here would undo the move we just applied.
        const fresh = await this.api.listNoteRegistryPaged(vaultId, { limit: PULL_PAGE_LIMIT });
        if (this.stale()) return false;
        serverNotes = fresh.notes;
      }
      this.inboundSuppressed = applied.suppress;
    } else {
      this.inboundSuppressed = new Set();
    }

    // Published from the FINAL note list (the inbound branch above may have
    // re-read it), so the "edited by" tags reflect the same rows the rest of this
    // pass reconciles against.
    this.publishNoteMeta(serverNotes);
    this.publishColors(serverFolders, serverNotes);

    // Drop anything belonging to a different collection before we start adding:
    // the maps are written into incrementally from here on (so a mid-run
    // checkpoint is a valid partial map rather than an empty one), which is only
    // safe if nothing from another vault is still in them.
    for (const [rp, m] of [...this.byPath]) {
      if (m.vaultId !== vaultId) {
        this.byPath.delete(rp);
        // Only when the reverse entry is THIS path. A legacy config can still
        // carry two paths for one docId (#129), and dropping one of them must
        // never take the surviving path's identity with it — that silently
        // removes the doc from `mappedNotes`, `allDocIds`, `contentWorkList`
        // and every badge derived from them.
        if (this.byDocId.get(m.docId) === rp) this.byDocId.delete(m.docId);
        this.notifyMapChanged();
      }
    }

    // 2. Folders: adopt by path, create missing (parents first).
    //
    // The path → id map is RE-DERIVED from the server's listing, not merely added
    // to. A folder the server moved keeps its id under a new path, and the old
    // path's entry used to survive here forever. This device then believed the
    // old directory — still on disk, e.g. holding a `.txt` the index doesn't key
    // and so the per-note rename never carried — was registered, never re-created
    // it, and registered any note inside it with the MOVED folder's id. The server
    // rightly refused that as `path_folder_mismatch`, on every pull, forever:
    // "1 not synced" with nothing the user could do about it.
    //
    // Matched case-INSENSITIVELY, and the local spelling wins. macOS and Windows
    // store one directory per case-insensitive name, so `Projects/community` on
    // disk and `Projects/Community` on the server are the same folder — and after
    // migration 023 merged the case-duplicated rows, that disagreement is exactly
    // what a vault that had them looks like. Compared exactly, all 71 merged
    // folders (and the 164 notes under them) read as "missing from the server" on
    // every pass: the client registered them, the server adopted them
    // case-insensitively and answered with ITS spelling, the client filed the
    // mapping under that, and the local paths were still unmatched next pass.
    // A 235-item wave that could never empty — "Syncing 225/235", restart, loop.
    const serverFolderByPathCi = new Map(
      serverFolders.map((f) => [f.path.toLowerCase(), f.id] as const),
    );
    for (const [rp, id] of [...this.folderByPath]) {
      if (serverFolderByPathCi.get(rp.toLowerCase()) !== id) this.folderByPath.delete(rp);
    }
    // The path we keep is the one on DISK: every other lookup in this class is
    // made with a local path, so mapping the server's spelling instead would
    // leave those lookups missing. The id is the identity; the spelling is ours.
    const localFolderPathCi = new Map(folders.map((f) => [f.path.toLowerCase(), f.path] as const));
    for (const f of serverFolders) {
      this.folderByPath.set(localFolderPathCi.get(f.path.toLowerCase()) ?? f.path, f.id);
    }
    // …and drop the twin the merge left behind. Both spellings are in the
    // persisted map for a vault that had case-duplicated rows, and neither is
    // wrong enough for the prune above to remove (they carry the same id), so
    // without this they stay in `config.json` for good.
    for (const rp of [...this.folderByPath.keys()]) {
      const onDisk = localFolderPathCi.get(rp.toLowerCase());
      if (onDisk !== undefined && onDisk !== rp) {
        this.folderByPath.delete(rp);
        mutated = true;
      }
    }
    // A hidden path the server now lists (access came back), or that left the
    // disk, is an ordinary path again.
    if (this.hiddenPaths.size > 0) {
      const onDiskCi = new Set([...folders, ...notes].map((x) => x.path.toLowerCase()));
      for (const key of [...this.hiddenPaths]) {
        if (serverFolderByPathCi.has(key) || !onDiskCi.has(key)) this.hiddenPaths.delete(key);
      }
    }
    const missingFolders = folders.filter(
      (f) => !this.folderByPath.has(f.path) && !this.hiddenPaths.has(f.path.toLowerCase()),
    );

    // 3. Notes: adopt by relPath, create missing. Any first-run seeding happened
    //    in reconcile before this runs; the seeded files register here as docs.
    // Case-insensitive for the same reason as the folders above, and again the
    // local spelling is the one mapped.
    const localNotePathCi = new Map(notes.map((n) => [n.path.toLowerCase(), n.path] as const));
    /** Every path the server accounted for, in the spelling we MAPPED it under. */
    const resolvedNotePaths = new Set<string>();
    /** The same set, lower-cased — what every membership test below compares on. */
    const resolvedNotePathsCi = new Set<string>();
    const resolveNote = (serverPath: string, docId: string) => {
      const mapped = localNotePathCi.get(serverPath.toLowerCase()) ?? serverPath;
      this.setMapping(mapped, docId, vaultId);
      resolvedNotePaths.add(mapped);
      resolvedNotePathsCi.add(mapped.toLowerCase());
    };
    // D4: two people created a note at the same path while apart. Resolve it
    // BEFORE anything binds the local file to the server's id, which would
    // otherwise egest the teammate's text over this device's bytes.
    await this.resolveSamePathConflicts(serverNotes, localNotePathCi, titles);
    if (this.stale()) return mutated;
    for (const n of serverNotes) {
      const rp = noteRelPath(n);
      if (rp) resolveNote(rp, noteDocId(n));
    }
    // The note twin of the folder collapse above: a mapping under a spelling this
    // pass did not resolve, whose case-variant it DID, is the leftover of a
    // merged pair. `byDocId` already points at the spelling we kept, so only the
    // path index needs the removal.
    for (const [rp, m] of [...this.byPath]) {
      if (resolvedNotePaths.has(rp)) continue;
      if (!resolvedNotePathsCi.has(rp.toLowerCase())) continue;
      if (m.vaultId !== vaultId) continue;
      this.byPath.delete(rp);
      this.notifyMapChanged();
      mutated = true;
    }

    // `inboundSuppressed` is what stops the ghost. A note the server has DELETED
    // (or that we've lost access to) is still on disk, so it looks "missing from
    // the server" here and used to be re-created — which the server answers 201 to
    // without clearing `deleted_at`, leaving a sidebar entry that can never sync.
    //
    // `aliasPaths` is the same idea for the other refusal: a path the server has
    // already told us is a duplicate of an identity it holds elsewhere (#129).
    // Asking again can only get the same answer, so the pass would re-enter the
    // `registering` phase — and reset its counter to 0/N — forever. Entries are
    // dropped the moment the server DOES account for the path (the user deleted
    // or moved the duplicate, or the note genuinely moved back), so a healed
    // vault re-registers normally.
    for (const rp of [...this.aliasPaths]) {
      if (
        resolvedNotePathsCi.has(rp.toLowerCase()) ||
        !localNotePathCi.has(rp.toLowerCase())
      ) {
        this.aliasPaths.delete(rp);
      }
    }
    for (const key of [...this.hiddenPaths]) {
      if (resolvedNotePathsCi.has(key)) this.hiddenPaths.delete(key);
    }
    // Restored on the server, or gone from this disk: no longer a refusal to
    // remember (see `deletedPaths`).
    for (const key of [...this.deletedPaths]) {
      if (resolvedNotePathsCi.has(key) || !localNotePathCi.has(key)) this.deletedPaths.delete(key);
    }
    if (this.deletedDocIds.size > 0) {
      const listed = new Set(serverNotes.map((n) => noteDocId(n)));
      for (const id of [...this.deletedDocIds]) if (listed.has(id)) this.deletedDocIds.delete(id);
    }
    let missingNotes = notes.filter(
      (n) =>
        !resolvedNotePathsCi.has(n.path.toLowerCase()) &&
        !this.inboundSuppressed.has(n.path) &&
        !this.aliasPaths.has(n.path) &&
        !this.hiddenPaths.has(n.path.toLowerCase()) &&
        !this.deletedPaths.has(n.path.toLowerCase()),
    );

    // 3b. A rename made while the app was closed (offline reconciliation, row
    // 4b): a mapped note's file is missing AND an unmapped file holds exactly
    // its text. Without this the old path is re-materialized and the new one
    // registers as a SECOND note. The same content-hash pairing the live
    // disk-delete drain makes, run before anything registers or materializes.
    if (missingNotes.length > 0) {
      const paired = await this.pairClosedAppRenames(
        [...resolvedNotePaths].filter(
          (rp) => !localNotePathCi.has(rp.toLowerCase()) && priorMappedCi.has(rp.toLowerCase()),
        ),
        missingNotes.map((n) => n.path),
        serverNotes,
      );
      if (this.stale()) return mutated;
      if (paired.size > 0) {
        mutated = true;
        for (const [from, to] of paired) {
          resolvedNotePaths.delete(from);
          resolvedNotePathsCi.delete(from.toLowerCase());
          resolvedNotePaths.add(to);
          resolvedNotePathsCi.add(to.toLowerCase());
        }
        const taken = new Set([...paired.values()].map((p) => p.toLowerCase()));
        missingNotes = missingNotes.filter((n) => !taken.has(n.path.toLowerCase()));
      }
    }

    // Announce the phase only when there is something to create. A pull with
    // nothing missing — the common case: the server broadcast `registry-changed`
    // for a checkpoint stamp, a teammate's rename, our own last-edited mark —
    // used to announce "registering 0" here, which the corner pill rendered as
    // "Syncing" for the length of the listing round-trip on every note open.
    // The initial `reconcile` still shows life on its own (see its early
    // `phase("registering", 0)`); this is the quiet path for everything after.
    const toCreate = missingFolders.length + missingNotes.length;
    if (toCreate > 0) this.sink.phase("registering", toCreate);
    // A bulk pass stretches the checkpoint's TIME window (the batch trigger is
    // what flushes during a run; see `Checkpointer.setBulk`). Same threshold the
    // batch paths below take, so the two can never disagree about what "bulk" is.
    checkpoint.setBulk(useBulkPath(toCreate));

    // Titles + local doc_ids for the notes we are about to CREATE server-side —
    // so the index read happens only when there is something to create (on a
    // fully-registered vault, never). `this.sink.phase` above needs none of it.
    //
    // The local index already keyed each note by a stable doc_id. Supply it as
    // the server id so a note has ONE identity across the .md file, the local
    // CRDT store, and the server (the invariant: key by doc_id, never by path).
    // Omitting it lets the server mint a *different* random id, which forks the
    // note — the editor's bridge persists CRDT under the local id while sync
    // reads/writes the server id, so content silently fails to appear.
    const titleRows = missingNotes.length > 0 ? await titles() : [];
    if (this.stale()) return false;
    const titleByPath = new Map(titleRows.map((t) => [t.path, t.title] as const));
    const idByPath = new Map(titleRows.map((t) => [t.path, t.id] as const));

    // ---- folders, level by level ----
    const byDepth = new Map<number, TreeNode[]>();
    for (const f of missingFolders) {
      const depth = f.path.split("/").length;
      const bucket = byDepth.get(depth);
      if (bucket) bucket.push(f);
      else byDepth.set(depth, [f]);
    }
    // At/above the threshold the whole set goes in batches instead: the server
    // sorts by depth and resolves parents IN-REQUEST, which is what removes the
    // level-by-level serialization (a deep tree paid one round trip per level).
    if (useBulkPath(missingFolders.length)) {
      if (await this.registerFoldersBatched(vaultId, missingFolders, checkpoint)) {
        mutated = true;
      }
    } else
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      if (this.stopRun()) break;
      await runPool(
        byDepth.get(depth)!,
        async (f) => {
          const parentPath = parentDir(f.path);
          const parentId = parentPath ? (this.folderByPath.get(parentPath) ?? null) : null;
          const out = await withRetry<RegisteredFolder>(
            () =>
              this.api.createFolder({ vaultId, name: f.name, path: f.path, parentId }),
            { isTerminal: isTerminalApiError, shouldStop: () => this.stopRun() },
          );
          if (out.ok) {
            this.folderByPath.set(f.path, out.value.id);
            checkpoint.touch();
            mutated = true;
            this.sink.item("ok");
          } else {
            this.sink.item(this.recordFailure({
              kind: "folder",
              path: f.path,
              docId: null,
              reason: reasonOf(out.error),
              code: errorCode(out.error),
            }));
          }
        },
        { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
      );
    }
    if (this.stale()) return mutated;

    // ---- notes ----
    // Above the threshold: the same work, batched. Identical accounting —
    // `withRetry` per request, `recordFailure` per item, `checkpoint.touch` per
    // accepted row, one `sink.item` per item, and the 402 stop through
    // `stopRun()` — so the two paths cannot report a vault differently.
    // Filled by the per-note path below; the batch path announces per chunk.
    const createdNow: string[] = [];
    if (useBulkPath(missingNotes.length)) {
      const bulk = await this.registerNotesBatched(vaultId, missingNotes, {
        titleByPath,
        idByPath,
        resolvedNotePaths,
        resolvedNotePathsCi,
        checkpoint,
      });
      if (bulk) mutated = true;
    } else
    // ---- …or one flat pool (parentIds are all resolved by now) ----
    await runPool(
      missingNotes,
      async (note) => {
        const rp = note.path;
        const docId = idByPath.get(rp) ?? null;
        if (docId) this.sink.doc(docId, "queued");
        const folderId = this.folderByPath.get(parentDir(rp)) ?? null;
        const out = await withRetry(
          () =>
            this.api.createNote({
              vaultId,
              relPath: rp,
              title: titleByPath.get(rp) ?? note.name,
              folderId,
              docId: docId ?? undefined,
            }),
          { isTerminal: isTerminalApiError, shouldStop: () => this.stopRun() },
        );
        if (out.ok) {
          const serverPath = noteRelPath(out.value);
          // The server answers 200 in two quite different situations, and the
          // `rel_path` it echoes is how they are told apart (#129):
          //
          //  * it accepted `rp`, or adopted a live row whose spelling is a
          //    CASE-VARIANT of it (its uniqueness is `lower(rel_path)`, like the
          //    filesystem's). Then `rp` — the local spelling — is what we map,
          //    exactly as `resolveNote` does.
          //  * the docId we supplied already names a row in this vault at a
          //    DIFFERENT path. `INSERT … ON CONFLICT (id) DO NOTHING` wrote
          //    nothing and the row did NOT move; the echo is the canonical path.
          //    The file at `rp` is then a stale second copy of a note that is
          //    already registered elsewhere, and mapping `rp` to that docId is
          //    what minted the duplicate path alias: two paths, one identity, a
          //    reverse map pointing at the stale copy, and both keys persisted
          //    into `.context/config.json` to be reloaded forever.
          //
          // So: map nothing, claim nothing (`resolvedNotePaths` would shield the
          // alias from the step-4 prune), report it once, and remember the path
          // so the next pull does not ask the same question again. The FILE is
          // left alone — see `aliasPaths`.
          if (serverPath && !samePath(serverPath, rp)) {
            this.aliasPaths.add(rp);
            this.recordFailure({
              kind: "note",
              path: rp,
              // Deliberately no docId. The identity is FINE — it is registered,
              // it syncs, and it lives at `serverPath`. Badging it `error` would
              // paint the healthy note's sidebar row red for a problem that
              // belongs to the other FILE, and the content run would stamp it
              // `synced` again moments later. The path is the whole report.
              docId: null,
              reason: `already registered at ${serverPath} — left on disk, not synced`,
              code: null,
            });
            this.sink.item("failed");
            return;
          }
          // Keep `rp` (the local spelling) even when the server adopted a
          // case-variant and answered with its own — see `resolveNote`.
          const noteId = noteDocId(out.value);
          this.setMapping(rp, noteId, vaultId);
          resolvedNotePaths.add(rp);
          resolvedNotePathsCi.add(rp.toLowerCase());
          // 201, not 200: a row the server MADE (see `api.createNote`). An
          // adopted one may already hold content and must never be announced.
          if (out.value.created && noteId) createdNow.push(noteId);
          checkpoint.touch();
          mutated = true;
          this.sink.item("ok");
          return;
        }
        // 409 = this note's local doc_id is already a note in a DIFFERENT vault
        // (e.g. this folder was previously synced to another vault whose ids the
        // local index still carries). Deliberately leave it UNMAPPED: the note
        // keeps working locally, whereas mapping it would point sync at a doc the
        // user has no grant on, which only yields a permanent 403. Rotating the
        // local doc_id to rejoin such a note to this vault is not implemented.
        const code = errorCode(out.error) ?? (isConflict(out.error) ? "doc_id_conflict" : null);
        // The server says the folder id we sent is not the folder at this path:
        // our mapping for the parent is stale (see step 2). Drop it so the next
        // pass re-creates the folder and this note registers — belt to step 2's
        // braces, for a listing that changed between the two reads of one pass.
        if (code === "path_folder_mismatch") this.folderByPath.delete(parentDir(rp));
        this.sink.item(this.recordFailure({
          kind: "note",
          path: rp,
          docId,
          reason: reasonOf(out.error),
          code,
        }));
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
    );
    // After the mappings, so a handler can resolve every id it is given.
    this.announceCreated(createdNow);
    if (this.stale()) return mutated;

    // 4. Prune mappings for notes that no longer exist anywhere (deleted on the
    //    server AND absent locally), then checkpoint the map.
    for (const [rp, m] of [...this.byPath]) {
      if (!resolvedNotePathsCi.has(rp.toLowerCase())) {
        this.byPath.delete(rp);
        // Reverse entry only if it still names this path — see the same guard in
        // the cross-collection prune above (#129).
        if (this.byDocId.get(m.docId) === rp) this.byDocId.delete(m.docId);
        this.notifyMapChanged();
      }
    }
    // The push checkpoint describes docs we still track OR still remember in the
    // baseline. The baseline part is load-bearing: a note deleted remotely leaves
    // the server listing (and hence `byDocId`) on the pass that LEARNS about the
    // delete, but its file may only be removed on a LATER pass — and the removal
    // executor refuses any doc whose content was never confirmed upstream.
    // Pruning `pushed` by `byDocId` alone erased that confirmation in between,
    // which is how already-synced notes turned into permanent "left on disk"
    // orphans with an error badge that never cleared.
    for (const docId of [...this.pushed]) {
      if (!this.byDocId.has(docId) && !this.baselineDocs.has(docId)) {
        this.pushed.delete(docId);
      }
    }
    for (const docId of [...this.ackedSvs.keys()]) {
      if (!this.byDocId.has(docId) && !this.baselineDocs.has(docId)) {
        this.ackedSvs.delete(docId);
      }
    }
    checkpoint.touch();
    await checkpoint.flush();
    if (this.stale()) return mutated;

    // 5. Materialize server-only notes locally. This is what makes a folder
    //    that's empty on this device (a just-joined vault, or a fresh
    //    per-vault folder) actually show the vault's notes. We create the file
    //    empty — `writeNoteIfMissing` creates any missing parent folders — and
    //    then, when THIS DEVICE already holds the note's CRDT, immediately write
    //    its text (`InboundHost.materializeContent`). Otherwise it stays a 0-byte
    //    placeholder and hydrates lazily when the note is opened
    //    (pull-before-seed in docSession, which never seeds a non-empty server
    //    doc from an empty file) or when the vault channel backfills it.
    //
    //    The hydrate is not cosmetic. A local delete of a synced note used to
    //    reach this step, be re-created as 0 bytes, and then have that emptiness
    //    diff-merged into the note's still-populated CRDT and pushed — the
    //    server's copy destroyed by a file the app had just written (#93).
    //
    //    CREATE-ONLY, never overwrite. `toMaterialize` is a *difference of two
    //    lists*, and the local side of that difference is only as complete as the
    //    tree we were given. When it was short — a lazily-loaded tree that stopped
    //    at the vault root — every nested note read as "server-only" and a plain
    //    empty `writeNote` destroyed 428 real notes. `reconcile` now reads the
    //    full tree itself, which fixes the wrong input; this call makes the same
    //    mistake non-destructive if it ever recurs. Both, deliberately: one bug
    //    here is worth a belt and braces.
    // Case-insensitive, or a note whose server spelling differs from the one on
    // disk would be "server-only" here and get an empty file written at the other
    // spelling — which on a case-insensitive filesystem is the SAME file.
    const localNotePaths = new Set(notes.map((n) => n.path.toLowerCase()));
    // Removed from disk in a live bulk delete the user has not answered yet
    // (#221): neither restored nor deleted until they do.
    const held = this.host?.heldDocIds?.() ?? null;
    const toMaterialize = [...resolvedNotePaths].filter((rp) => {
      if (localNotePaths.has(rp.toLowerCase())) return false;
      if (held && held.size > 0) {
        const docId = this.byPath.get(rp)?.docId;
        if (docId && held.has(docId)) return false;
      }
      return true;
    });
    this.passDrift = {
      missingMapped: toMaterialize.filter((rp) => priorMappedCi.has(rp.toLowerCase())).length,
      unmappedLocal: missingNotes.length,
    };
    // D5: a path this device had MAPPED before the pass and no longer has on
    // disk was removed here without the delete reaching the team (app closed,
    // or a refused propagation). Re-creating it undoes that; say so.
    this.restoreCandidatesCi = new Set(
      toMaterialize.filter((rp) => priorMappedCi.has(rp.toLowerCase())).map((rp) => rp.toLowerCase()),
    );
    this.sink.addTotal(toMaterialize.length);
    // Materializing is the other half a pull can be bulk for — a fresh device
    // writes the whole vault here without registering a single row above.
    if (useBulkPath(toMaterialize.length)) checkpoint.setBulk(true);
    if (useBulkPath(toMaterialize.length)) {
      if (await this.materializeBatched(toMaterialize)) mutated = true;
    } else
    await runPool(
      toMaterialize,
      async (rp) => {
        // Doubly guarded: the pool's shouldStop stops the run the instant the
        // vault changes, and the pinned epoch makes Rust refuse anything that
        // slips past (this loop used to litter vault A's note paths through
        // vault B's folder).
        try {
          // Create-only FIRST and unconditionally — that guard is what makes a
          // wrong "server-only" verdict cost nothing (see above), and its boolean
          // says whether THIS pass created the file, so an existing real note is
          // never touched by the hydrate below.
          const created = await ipc.writeNoteIfMissing(rp, "", this.epoch());
          // A path that already held a file is not a change: claiming one made a
          // pull with nothing to do report "changed" (and re-read the registry,
          // and refresh the UI) on every pass it ran.
          if (created) {
            mutated = true;
            // Remember it for one watcher echo, so the sync layer does not treat
            // our own placeholder as an external edit worth pushing.
            this.markMaterialized(rp);
            this.noteRestored(rp);
            // The mapping is already in `byPath`: step 3 registered/adopted
            // every server note above, and `toMaterialize` is a subset of that
            // same resolved server listing. No config.json re-read needed.
            const docId = this.byPath.get(rp)?.docId ?? null;
            // Put the SERVER's doc_id on the row Rust just indexed, BEFORE
            // anything can open the note.
            //
            // `writeNoteIfMissing` re-indexes synchronously, and `index_one`
            // reuses an id only via `id_for_path` — a path Rust has never seen
            // gets a FRESH `Uuid::new_v4()`. Without this rebind the note
            // carries two identities for the rest of its life: `Editor.tsx`
            // keys its bridge by the INDEX id (`ipc.getNoteMeta`) while
            // `syncManager.openDoc` / `vaultDocStore` key `DocSync` by the
            // registry's SERVER id — two Y.Docs, two local CRDT logs, one file
            // (#147). Every teammate who joins a shared vault got this for
            // every note they didn't already have.
            //
            // Safe here specifically because the row is one pass old and holds
            // no CRDT: `rebind_note_id` re-keys `notes`/`note_tags`/`links` and
            // re-resolves backlinks, but deliberately does NOT touch
            // `yjs_updates`/`yjs_snapshot` — with nothing there yet that is a
            // clean no-op rather than a stranded log. It also refuses (false,
            // never a merge) when the id already belongs to a DIFFERENT path,
            // so a stale row from an earlier run cannot break the UNIQUE path
            // constraint or fork the note; we simply keep today's behaviour.
            //
            // Before `materializeContent`, which promotes a bridge under the
            // server id and writes through it — that write re-indexes, and
            // `id_for_path` then preserves the id we just bound.
            if (docId) {
              try {
                const rebound = await ipc.rebindNoteId(rp, docId, this.epoch());
                if (!rebound) {
                  console.warn(`[registry] couldn't rebind ${rp} to ${docId} (id taken?)`);
                }
              } catch (e) {
                // Never abort the pull for this: the old behaviour (a note with
                // a local-only index id) is the fallback, and it is what every
                // build before this one did.
                if (!ipc.isVaultMismatch(e)) {
                  console.warn(`[registry] rebinding ${rp} to ${docId} failed`, e);
                } else {
                  return; // the vault moved on
                }
              }
            }
            // Fill it in from local CRDT when this device has it. Best effort: a
            // failure leaves today's 0-byte placeholder, which is exactly the
            // current behaviour, so this can never make things worse.
            if (docId && this.host) {
              try {
                await this.host.materializeContent(docId, rp);
              } catch (e) {
                console.warn(`[registry] hydrating ${rp} from local CRDT failed`, e);
              }
            }
          }
          this.sink.item("ok");
        } catch (e) {
          if (ipc.isVaultMismatch(e)) return; // the vault moved on — not a failure
          this.sink.item(
            this.recordFailure(materializeFailure(rp, this.byPath.get(rp)?.docId ?? null, e)),
          );
        }
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
    );

    // 6. Record what we now agree on, for the NEXT pass to compare against.
    //
    //    Accumulative, not a mirror of `byDocId`: entries for docs we've lost
    //    access to are kept deliberately. They're pruned from `byPath` above, so
    //    without keeping them here the next pass would see a brand-new local note
    //    and re-register it — the ghost returning on every other pull. Entries only
    //    leave when the file leaves (see `applyInbound`).
    for (const [docId, rp] of this.byDocId) this.baselineDocs.set(docId, rp);
    this.baselineVaultId = vaultId;
    // Flushed, not just touched: the baseline is only useful to the NEXT run, so
    // one that never reaches disk is one inbound reconciliation that silently
    // can't happen after a relaunch.
    checkpoint.touch();
    await checkpoint.flush();
    // The run is over, so the short idle window comes back — and the flush above
    // means nothing is owed across the switch.
    checkpoint.setBulk(false);
    perf.mark("reconcile-done");
    return mutated;
  }

  // ---- batched structure registration (the bulk engine's outbound half) ----
  //
  // Substitutions INSIDE reconcile, not a second reconciler: same `withRetry`,
  // same `recordFailure`, same `checkpoint.touch`, same `sink.item` accounting,
  // same 402 stop through `stopRun()`. Only the number of round trips changes.

  /**
   * Register every missing folder in `POST /folders/batch` requests.
   *
   * No `parentId` and no depth loop: the server sorts by depth and resolves each
   * parent inside the request. Sent in depth order anyway so a chunk boundary
   * can never split a parent from its child in a way the server has to guess at.
   */
  private async registerFoldersBatched(
    vaultId: string,
    folders: TreeNode[],
    checkpoint: Checkpointer<VaultSyncConfig>,
  ): Promise<boolean> {
    let mutated = false;
    const ordered = [...folders].sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length,
    );
    const chunks = chunked(ordered, BATCH_MAX_FOLDERS);
    await runPool(
      chunks,
      async (group) => {
        const items: FolderBatchItem[] = group.map((f) => ({ path: f.path, name: f.name }));
        const out = await withRetry(() => this.api.batchCreateFolders(vaultId, items), {
          isTerminal: isTerminalApiError,
          shouldStop: () => this.stopRun(),
        });
        if (!out.ok) {
          // A failed REQUEST is a failure of every folder in it: the run must
          // not claim work it cannot prove happened.
          for (const f of group) {
            this.sink.item(this.recordFailure({
              kind: "folder",
              path: f.path,
              docId: null,
              reason: reasonOf(out.error),
              code: errorCode(out.error),
            }));
          }
          return;
        }
        const byPath = new Map(out.value.map((r) => [r.path, r]));
        for (const f of group) {
          const res = byPath.get(f.path);
          if (res && res.id && (res.status === "created" || res.status === "adopted")) {
            this.folderByPath.set(f.path, res.id);
            checkpoint.touch();
            mutated = true;
            this.sink.item("ok");
            continue;
          }
          this.sink.item(this.recordFailure({
            kind: "folder",
            path: f.path,
            docId: null,
            reason: res?.error ?? res?.code ?? "the server did not answer for this folder",
            code: res?.code ?? null,
          }));
        }
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
    );
    return mutated;
  }

  /**
   * Register every missing note in `POST /notes/batch` requests.
   *
   * Item for item this is the single-note path (`api.createNote`), including the
   * two refusals that are NOT ordinary errors:
   *
   *  * a canonical `relPath` echo that differs from what we sent is the
   *    duplicate-path alias of #129 — map nothing, claim nothing, remember the
   *    path so the next pull does not ask again, leave the FILE alone;
   *  * `path_folder_mismatch` means our parent mapping is stale, so it is
   *    dropped and the next pass re-creates the folder.
   *
   * `folderPath` (the parent's path) rather than `folderId` is what makes the
   * chunking safe: a folder created in an earlier chunk needs no id lookup here.
   */
  /**
   * Hand the session the ids the server just CREATED (see
   * {@link InboundHost.noteServerCreated}). Empty lists are not announced, and a
   * throwing listener is a listener problem — never a failed pass.
   */
  private announceCreated(docIds: readonly string[]): void {
    if (docIds.length === 0) return;
    try {
      this.host?.noteServerCreated?.(docIds);
    } catch (e) {
      console.warn("[registry] noteServerCreated listener threw", e);
    }
  }

  private async registerNotesBatched(
    vaultId: string,
    notes: TreeNode[],
    ctx: {
      titleByPath: Map<string, string>;
      idByPath: Map<string, string>;
      resolvedNotePaths: Set<string>;
      resolvedNotePathsCi: Set<string>;
      checkpoint: Checkpointer<VaultSyncConfig>;
    },
  ): Promise<boolean> {
    let mutated = false;
    const chunks = chunked(notes, BATCH_MAX_NOTES);
    await runPool(
      chunks,
      async (group) => {
        const items: NoteBatchItem[] = group.map((n) => ({
          relPath: n.path,
          title: ctx.titleByPath.get(n.path) ?? n.name,
          folderPath: parentDir(n.path) || null,
          // The local index's doc_id, so one note has ONE identity across the
          // `.md`, the CRDT store and the server (see the single-note path).
          ...(ctx.idByPath.get(n.path) ? { docId: ctx.idByPath.get(n.path)! } : {}),
        }));
        for (const n of group) {
          const docId = ctx.idByPath.get(n.path);
          if (docId) this.sink.doc(docId, "queued");
        }
        const out = await withRetry(() => this.api.batchCreateNotes(vaultId, items), {
          isTerminal: isTerminalApiError,
          shouldStop: () => this.stopRun(),
        });
        if (!out.ok) {
          for (const n of group) {
            this.sink.item(this.recordFailure({
              kind: "note",
              path: n.path,
              docId: ctx.idByPath.get(n.path) ?? null,
              reason: reasonOf(out.error),
              code: errorCode(out.error),
            }));
          }
          return;
        }
        // The server echoes the path it was given, so results join on it; the
        // CANONICAL spelling it registered is in the same row and is what the
        // alias check below compares against.
        const byPath = new Map<string, (typeof out.value)[number]>();
        for (let i = 0; i < out.value.length; i++) {
          const res = out.value[i];
          // Positional fallback for a server that echoes only the canonical
          // spelling: the contract is order-preserving, so index i is item i.
          const sent = items[i]?.relPath;
          byPath.set(res.relPath, res);
          if (sent && !byPath.has(sent)) byPath.set(sent, res);
        }
        // Ids the server MADE in this chunk — announced once, after the loop
        // has mapped them all (see `InboundHost.noteServerCreated`).
        const createdInChunk: string[] = [];
        for (const n of group) {
          const rp = n.path;
          const localDocId = ctx.idByPath.get(rp) ?? null;
          const res = byPath.get(rp);
          if (!res) {
            this.sink.item(this.recordFailure({
              kind: "note",
              path: rp,
              docId: localDocId,
              reason: "the server did not answer for this note",
              code: null,
            }));
            continue;
          }
          if (res.status === "created" || res.status === "adopted") {
            // Same #129 guard as the single path: an echo at a DIFFERENT path
            // means the docId we supplied already names a row elsewhere, so the
            // file here is a stale second copy of a registered note.
            if (res.relPath && !samePath(res.relPath, rp)) {
              this.aliasPaths.add(rp);
              this.recordFailure({
                kind: "note",
                path: rp,
                docId: null,
                reason: `already registered at ${res.relPath} — left on disk, not synced`,
                code: null,
              });
              this.sink.item("failed");
              continue;
            }
            if (!res.docId) {
              this.sink.item(this.recordFailure({
                kind: "note",
                path: rp,
                docId: localDocId,
                reason: "the server registered this note without an id",
                code: null,
              }));
              continue;
            }
            // Keep `rp` (the local spelling) even when the server adopted a
            // case-variant and answered with its own — see `resolveNote`.
            this.setMapping(rp, res.docId, vaultId);
            ctx.resolvedNotePaths.add(rp);
            ctx.resolvedNotePathsCi.add(rp.toLowerCase());
            // `created` only — an ADOPTED row may already hold content, and
            // seeding one is the split-brain pull-before-seed exists to prevent.
            if (res.status === "created") createdInChunk.push(res.docId);
            ctx.checkpoint.touch();
            mutated = true;
            this.sink.item("ok");
            continue;
          }
          if (res.code === "path_folder_mismatch") this.folderByPath.delete(parentDir(rp));
          this.sink.item(this.recordFailure({
            kind: "note",
            path: rp,
            docId: localDocId,
            reason: res.error ?? res.code ?? "the server refused this note",
            code: res.code ?? null,
          }));
        }
        this.announceCreated(createdInChunk);
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
    );
    return mutated;
  }

  /**
   * Materialize server-only notes with ONE `materialize_notes_batch` per chunk.
   *
   * Identical semantics to the per-note loop it replaces: every write is
   * create-only (`write_note_if_missing`, never an overwrite — which is why the
   * 428-note incident cost nothing), each created path is remembered for exactly
   * one watcher echo, and the server's doc_id is bound onto the row BEFORE
   * anything can open the note. What changes is the cost: the per-note version
   * paid 2–3 IPC round trips each, and each `rebind_note_id` carried a whole
   * `links` scan plus an O(vault) `resolve_links` map rebuild (~88 ms on a
   * 1,560-note vault ⇒ ~7 minutes of map rebuilds alone on 5,000 notes).
   */
  private async materializeBatched(paths: string[]): Promise<boolean> {
    let mutated = false;
    const chunks = chunked(paths, BATCH_MAX_NOTES);
    for (const group of chunks) {
      if (this.stopRun()) break;
      let outcomes: ipc.MaterializeOutcome[];
      try {
        outcomes = await ipc.materializeNotesBatch(
          group.map((rp) => ({ relPath: rp, docId: this.byPath.get(rp)?.docId ?? null })),
          this.epoch(),
        );
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return mutated; // the vault moved on
        for (const rp of group) {
          this.sink.item(this.recordFailure({
            kind: "materialize",
            path: rp,
            docId: this.byPath.get(rp)?.docId ?? null,
            reason: reasonOf(e),
            code: null,
          }));
        }
        continue;
      }
      const byPath = new Map(outcomes.map((o) => [o.relPath, o]));
      const created: string[] = [];
      for (const rp of group) {
        const out = byPath.get(rp);
        // A link at the path is refused per item by Rust (#216) and must be
        // said, not counted "ok". Other per-item write errors keep their
        // existing quiet behaviour here.
        if (out?.error && isSymlinkRefusal(out.error)) {
          this.sink.item(
            this.recordFailure(materializeFailure(rp, this.byPath.get(rp)?.docId ?? null, out.error)),
          );
          continue;
        }
        if (out?.created) {
          mutated = true;
          // One owed watcher echo, so the sync layer does not treat our own
          // placeholder as an external edit worth pushing.
          this.markMaterialized(rp);
          this.noteRestored(rp);
          created.push(rp);
        }
        this.sink.item("ok");
      }
      // Fill the placeholders in from THIS device's local CRDT where it has one.
      // Still per-note: it is a bridge write, not an index write. Best effort —
      // a failure leaves the 0-byte placeholder, which is today's behaviour.
      const host = this.host;
      if (host) {
        await runPool(
          created,
          async (rp) => {
            const docId = this.byPath.get(rp)?.docId ?? null;
            if (!docId) return;
            try {
              await host.materializeContent(docId, rp);
            } catch (e) {
              console.warn(`[registry] hydrating ${rp} from local CRDT failed`, e);
            }
          },
          { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
        );
      }
    }
    return mutated;
  }

  /**
   * Register a single newly-created note on demand (e.g. after ⌘N) and return
   * its mapping, or null if the vault isn't reconciled yet.
   *
   * O(1) amortized: it updates the in-memory maps and `touch()`es the
   * checkpointer. It used to read config.json, merge one key and rewrite the
   * whole file per note — O(N) bytes each, O(N²) for a vault being filled in.
   */
  async registerNote(
    relPath: string,
    title: string | null,
    docId?: string,
  ): Promise<DocMapping | null> {
    if (this.stale()) return null;
    const vaultId = this.serverVaultId;
    if (!vaultId) return null;
    // Case-insensitive, because on macOS/Windows a case-variant of a path we
    // already track is the SAME FILE — registering it would map one file to two
    // doc_ids and start the ping-pong (see `canonicalNotePath`).
    const mappedAs = this.canonicalNotePath(relPath);
    if (mappedAs) return this.byPath.get(mappedAs) ?? null;
    // Deleted on the server (see `deletedPaths`): opening the local copy must
    // not ask again — the answer is known, and it stays a local-only note.
    if ((docId && this.deletedDocIds.has(docId)) || this.deletedPaths.has(relPath.toLowerCase())) {
      return null;
    }
    try {
      const folderId = this.folderByPath.get(parentDir(relPath)) ?? null;
      const created = await this.api.createNote({
        vaultId,
        relPath,
        title,
        folderId,
        // Reuse the local index doc_id so the server doesn't fork a second
        // identity for this note (see reconcile's idByPath note).
        docId,
      });
      if (this.stale() || this.serverVaultId !== vaultId) return null;
      const mapping = { vaultId, docId: noteDocId(created) };
      // Key by the path the SERVER says this doc lives at. It adopts by path
      // case-insensitively, so when its spelling differs from ours this is how
      // the two converge — keying by our own `relPath` instead would leave the
      // server's spelling unmapped and re-register it on every pass.
      this.setMapping(noteRelPath(created) ?? relPath, mapping.docId, vaultId);
      this.checkpoint?.touch();
      return mapping;
    } catch (e) {
      this.recordFailure({
        kind: "note",
        path: relPath,
        docId: docId ?? null,
        reason: reasonOf(e),
        code: errorCode(e),
      });
      return null;
    }
  }

  /**
   * Register a newly-created folder on the server so teammates see it live and
   * it can be shared. Idempotent (the server adopts an existing path). No-op if
   * the vault isn't reconciled yet.
   */
  async registerFolder(relPath: string, name: string): Promise<string | null> {
    if (this.stale()) return null;
    const vaultId = this.serverVaultId;
    if (!vaultId) return null;
    // Case-insensitive for the same reason as `registerNote`: one directory on
    // disk must not become two folder rows whose subtrees then fork.
    const mappedAs = this.canonicalFolderPath(relPath);
    if (mappedAs) return this.folderByPath.get(mappedAs) ?? null;
    try {
      const parentId = this.folderByPath.get(parentDir(relPath)) ?? null;
      const created = await this.api.createFolder({
        vaultId,
        name,
        path: relPath,
        parentId,
      });
      if (this.stale() || this.serverVaultId !== vaultId) return null;
      // The server's canonical spelling, as in `registerNote`.
      this.folderByPath.set(created.path ?? relPath, created.id);
      this.persist();
      return created.id;
    } catch (e) {
      this.recordFailure({
        kind: "folder",
        path: relPath,
        docId: null,
        reason: reasonOf(e),
        code: errorCode(e),
      });
      return null;
    }
  }

  /**
   * Propagate a local rename/move to the server. Handles both a folder (with its
   * whole subtree of paths) and a single note. doc_ids never change — only the
   * path columns move — so open docs and backlinks survive (spec invariant).
   */
  async renamePath(oldPath: string, newPath: string): Promise<boolean> {
    if (this.stale()) return false;
    const vaultId = this.serverVaultId;
    if (!vaultId) return false;
    const folderId = this.folderByPath.get(oldPath);
    if (folderId) {
      // Folder move: rewrite the server subtree, then the local prefix maps.
      const parentId = this.folderByPath.get(parentDir(newPath)) ?? null;
      try {
        await this.api.updateFolder(folderId, { name: baseName(newPath), path: newPath, parentId });
      } catch (e) {
        // REPORTED, not just logged. The server can refuse this move on its
        // merits — dragging a folder out to a frozen root is the common one —
        // and a console line is invisible to the person who made the move. The
        // local directory has already moved on disk by the time we get here, so
        // swallowing the refusal left the two sides disagreeing with nothing
        // said. `recordFailure` owns the one-toast-per-path explanation.
        console.error("[registry] updateFolder failed", oldPath, e);
        this.recordFailure({
          kind: "folder",
          path: newPath,
          docId: null,
          reason: reasonOf(e),
          code: errorCode(e),
        });
        return false;
      }
      // The maps may belong to a different vault by now — remapping them would
      // rewrite that vault's paths with this one's move.
      if (this.stale() || this.serverVaultId !== vaultId) return false;
      this.folderByPath = remapPrefix(this.folderByPath, oldPath, newPath);
      this.byPath = remapPrefix(this.byPath, oldPath, newPath);
      // The server moved the subtree's `files` rows too (`planFolderMove`), so
      // the binaries under it keep their registrations at the new paths.
      this.fileByPath = remapPrefix(this.fileByPath, oldPath, newPath);
      this.rebuildByDocId();
      this.persist();
      this.notifyMapChanged();
      return true;
    }
    const mapping = this.byPath.get(oldPath);
    if (mapping) {
      const newFolderId = this.folderByPath.get(parentDir(newPath)) ?? null;
      try {
        await this.api.updateNote(mapping.docId, { relPath: newPath, folderId: newFolderId });
      } catch (e) {
        // Same reason as the folder branch above. This one is the path an
        // EXTERNAL rename takes (`docSession.applyDiskRename`), which treats a
        // silent return as success and carries on to rebind the note's id and
        // push its content — so a refused move out to a frozen root used to end
        // with the note quietly back in its old folder and not a word to the
        // user about why.
        console.error("[registry] updateNote failed", oldPath, e);
        this.recordFailure({
          kind: "note",
          path: newPath,
          docId: mapping.docId,
          reason: reasonOf(e),
          code: errorCode(e),
        });
        return false;
      }
      if (this.stale() || this.serverVaultId !== vaultId) return false;
      this.byPath.delete(oldPath);
      this.byPath.set(newPath, mapping);
      this.byDocId.set(mapping.docId, newPath);
      this.persist();
      this.notifyMapChanged();
      return true;
    }
    return false;
  }

  /**
   * Propagate a delete of a folder subtree or a note to the server.
   *
   * BINARIES are not its business: a tree file has no `notes` row and no folder
   * row, so this is a no-op for one — deliberately, because the delete that
   * matters for a binary is its blob's, and that runs off the watcher event the
   * disk delete produces (`binaryDeletes.ts`). One path, not two.
   *
   * THROWS when the server refused (offline, 403): callers run server-first —
   * `deletePaths` only removes the local files once the server rows are gone —
   * so a swallowed failure here would let the local delete proceed and the next
   * pull resurrect the item as an empty ghost. A 404 is treated as success: the
   * row is already gone, which is the goal state.
   */
  async deletePath(path: string): Promise<void> {
    if (this.stale()) return;
    const vaultId = this.serverVaultId;
    if (!vaultId) return;
    const folderId = this.folderByPath.get(path);
    if (folderId) {
      try {
        await this.api.deleteFolder(folderId);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          if (!(e instanceof ApiError && e.status === 403)) throw e;
          // Revocation can leave a folder around its local-only files. Its
          // stale/adopted server identity must not prevent deleting that local
          // remainder, but a readable, read-only folder still stays protected.
          const beneath = (candidate: string) => {
            const root = path.toLowerCase();
            const value = candidate.toLowerCase();
            return value === root || value.startsWith(root + "/");
          };
          const hasMappedContent = () =>
            [...this.byPath.keys(), ...this.fileByPath.keys()].some(beneath);
          if (hasMappedContent()) throw e;
          const listing = await this.api.listFolderRegistry(vaultId);
          if (this.stale() || this.serverVaultId !== vaultId) throw e;
          if (listing.tombstones === null || hasMappedContent() || listing.folders.some((folder) =>
            folder.id === folderId || beneath(folder.path),
          )) throw e;
        }
      }
      if (this.stale() || this.serverVaultId !== vaultId) return;
      this.folderByPath = dropPrefix(this.folderByPath, path);
      this.byPath = dropPrefix(this.byPath, path);
      this.rebuildByDocId();
      this.prunePushed();
      this.persist();
      this.notifyMapChanged();
      return;
    }
    const mapping = this.byPath.get(path);
    if (mapping) {
      try {
        await this.api.deleteNote(mapping.docId);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      if (this.stale() || this.serverVaultId !== vaultId) return;
      this.forgetNote(path, mapping.docId);
      this.persist();
      this.notifyMapChanged();
    }
  }

  /**
   * Local bookkeeping for ONE deleted note: the map entries and the push
   * checkpoint, nothing else.
   *
   * Shared by {@link deletePath} and {@link deletePaths} so the single and the
   * batched route cannot drift — a batch of N must leave this registry in the
   * state N single deletes would (`registryDeleteBatch.test.ts` pins it).
   * Deliberately does NOT persist or notify: the batch does both once, at the
   * end, instead of N times.
   */
  private forgetNote(path: string, docId: string): void {
    this.byPath.delete(path);
    this.byDocId.delete(docId);
    this.pushed.delete(docId);
    this.ackedSvs.delete(docId);
  }

  /**
   * Propagate MANY note deletes — one request per {@link BATCH_MAX_NOTES}
   * chunk instead of one per note.
   *
   * The batched twin of {@link deletePath}, and the same soft delete: the server
   * stamps `deleted_at`, keeps the doc_id and the Yjs doc, and broadcasts ONE
   * `registry-changed` per request rather than one per note (500 sidebar deletes
   * used to be 500 requests and 500 whole-vault re-pulls on every peer).
   *
   * Per item it is exactly what the single route does, which is why the outcome
   * is reported per path rather than thrown:
   *  · `deleted` — the row is gone (or `unknown_note`: already gone, the batch's
   *    404, which the single path also treats as success) and the mapping with it;
   *  · `denied`  — no edit grant. The mapping SURVIVES, so the next pull
   *    re-materializes the file instead of leaving a half-deleted ghost;
   *  · `failed`  — offline, or the server refused. Mapping survives too.
   *
   * Two paths deliberately stay single-item: a FOLDER path (already one
   * cascading request, batching it would be a regression), and a whole chunk on
   * a server that answers 404 `server_too_old` — an older self-hosted instance
   * that has the per-note route and not this one.
   */
  async deletePaths(paths: readonly string[]): Promise<NoteDeleteOutcome[]> {
    const unique = [...new Set(paths)];
    // Default `deleted`: the no-op cases (stale registry, no server vault, an
    // unmapped path) are exactly the ones `deletePath` returns silently from,
    // and the caller reads that as done. Same verdict, same bookkeeping.
    const out = new Map<string, NoteDeleteOutcome>(
      unique.map((p) => [p, { path: p, status: "deleted" as const, reason: null, code: null }]),
    );
    const answer = () => unique.map((p) => out.get(p)!);
    const fail = (path: string, e: unknown) =>
      out.set(path, { path, status: "failed", reason: reasonOf(e), code: errorCode(e) });

    if (this.stale()) return answer();
    const vaultId = this.serverVaultId;
    if (!vaultId) return answer();

    const notes: Array<{ path: string; docId: string }> = [];
    for (const path of unique) {
      if (this.folderByPath.has(path)) {
        // One folder is one cascading request already — see the doc comment.
        try {
          await this.deletePath(path);
        } catch (e) {
          fail(path, e);
        }
        continue;
      }
      const mapping = this.byPath.get(path);
      if (mapping) notes.push({ path, docId: mapping.docId });
    }
    if (notes.length === 0) return answer();

    let mutated = false;
    for (const group of chunked(notes, BATCH_MAX_NOTES)) {
      if (this.stale()) break;
      let results: NoteDeleteResult[];
      try {
        results = await this.api.deleteNotesBatch(
          vaultId,
          group.map((g) => g.docId),
        );
      } catch (e) {
        if (isServerTooOld(e)) {
          // The one fallback: this server has `DELETE /api/notes/:id` and not
          // the batch route. Per note, pooled — the same call, N times.
          await runPool(
            group,
            async (g) => {
              try {
                await this.deletePath(g.path);
              } catch (err) {
                fail(g.path, err);
              }
            },
            { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stale() },
          );
          continue;
        }
        for (const g of group) fail(g.path, e);
        continue;
      }
      // The vault may have moved on while the request was in flight; mutating
      // the maps now would rewrite ANOTHER vault's mapping (see `deletePath`).
      if (this.stale() || this.serverVaultId !== vaultId) return answer();
      const byDocId = new Map<string, NoteDeleteResult>();
      results.forEach((r, i) => {
        // Positional fallback for a server that answers without echoing the id:
        // the contract is order-preserving, so result i is item i.
        byDocId.set(r.docId || group[i]?.docId || `#${i}`, r);
      });
      for (const g of group) {
        const res = byDocId.get(g.docId);
        if (!res) {
          out.set(g.path, {
            path: g.path,
            status: "failed",
            reason: "the server did not answer for this note",
            code: null,
          });
          continue;
        }
        // `unknown_note` is this route's 404: no LIVE row with that id here, so
        // the delete's goal state already holds.
        if (res.status === "deleted" || res.code === "unknown_note") {
          this.forgetNote(g.path, g.docId);
          mutated = true;
          continue;
        }
        out.set(g.path, {
          path: g.path,
          status: res.status === "denied" ? "denied" : "failed",
          reason: res.error ?? res.code ?? "the server refused this delete",
          code: res.code ?? null,
        });
      }
    }
    if (mutated) {
      this.persist();
      this.notifyMapChanged();
    }
    return answer();
  }

  /** Rebuild byDocId from byPath after a bulk prefix remap/drop. */
  private rebuildByDocId(): void {
    this.byDocId.clear();
    for (const [rp, m] of this.byPath) this.byDocId.set(m.docId, rp);
  }

  /** Drop push-checkpoint entries for docs we neither track nor remember in the
   *  baseline (see the pass-end prune in `syncStructure` for why the baseline
   *  keeps a confirmation alive until the file actually leaves). */
  private prunePushed(): void {
    for (const docId of [...this.pushed]) {
      if (!this.byDocId.has(docId) && !this.baselineDocs.has(docId)) {
        this.pushed.delete(docId);
      }
    }
    for (const docId of [...this.ackedSvs.keys()]) {
      if (!this.byDocId.has(docId) && !this.baselineDocs.has(docId)) {
        this.ackedSvs.delete(docId);
      }
    }
  }

  /** Queue a write of the current in-memory maps to `.context/config.json`.
   *  Batched by the checkpointer — never a synchronous read-modify-write. */
  private persist(): void {
    if (this.stale()) return;
    if (!this.serverVaultId) return;
    this.checkpoint?.touch();
  }
}

/** Is `err` the server's doc-id-belongs-to-another-vault conflict? */
function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/** basename of a vault-relative path. */
function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Rewrite every key at `oldPrefix` (exact or `oldPrefix/…`) to `newPrefix`. */
function remapPrefix<V>(map: Map<string, V>, oldPrefix: string, newPrefix: string): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of map) {
    if (k === oldPrefix) out.set(newPrefix, v);
    else if (k.startsWith(oldPrefix + "/")) out.set(newPrefix + k.slice(oldPrefix.length), v);
    else out.set(k, v);
  }
  return out;
}

/** Drop every key at `prefix` (exact or `prefix/…`). */
function dropPrefix<V>(map: Map<string, V>, prefix: string): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of map) {
    if (k === prefix || k.startsWith(prefix + "/")) continue;
    out.set(k, v);
  }
  return out;
}
