// Shared contract for Vault Settings → Health: the page that answers "what is
// synced, what is not, why, and what is in this vault".
//
// Three producers meet here and MUST agree on these shapes:
//   - Rust `vault_stats` (src-tauri) serialises a `VaultStats` (camelCase).
//   - `lib/health/model.ts` folds store + sync-layer state into a `HealthReport`.
//   - `components/HealthTab.tsx` renders both and drives `HealthActions`.
//
// Pure types only. No imports from React, Tauri or the store, so the model and
// its tests stay dependency-free like `syncRollup.ts`. (The two check-action
// types below are a TYPE-only import from `checkActions.ts`, which imports this
// file back — erased at compile time, so nothing circular survives to runtime.)

import type { CheckActionOutcome, CheckActionPlan } from "./checkActions";

// ── Vault analytics (Rust) ─────────────────────────────────────────────────────

/** One file, for "largest" lists. `bytes` is the on-disk size. */
export interface SizedFile {
  path: string;
  bytes: number;
  /** Last modification, ms since epoch. */
  mtime: number;
}

/** One note's local CRDT footprint (the `.context/index.sqlite` yjs tables). */
export interface HistoryFootprint {
  docId: string;
  /** The note's path when the index still knows the doc, else null (orphan). */
  path: string | null;
  /** `yjs_updates` rows for this doc. */
  updates: number;
  /** Bytes across its update log AND its snapshot. */
  bytes: number;
}

/**
 * A one-shot census of the open vault, computed by Rust in one pass over the
 * disk (same ignore rules as the tree: `.context/`, `.git`, dotfiles skipped)
 * plus a few aggregate queries over the SQLite index. Cheap enough to recompute
 * on demand; never cached across vaults.
 */
export interface VaultStats {
  /** When this census was taken, ms since epoch. */
  computedAt: number;
  notes: {
    /** Files the index treats as notes (rows in `notes`). */
    count: number;
    bytes: number;
    /** Notes whose file is 0 bytes. */
    empty: number;
  };
  /** Directories under the vault root (ignored ones excluded). */
  folders: number;
  /** Files under the vault-root `attachments/` store. */
  attachments: { count: number; bytes: number };
  /** Every other non-ignored file (images/PDFs next to notes, code, …). */
  otherFiles: { count: number; bytes: number };
  /** Distinct tags in the index. */
  tags: number;
  /** Wikilinks the index resolved to a note. */
  links: number;
  /** Wikilinks that point at no note. */
  brokenLinks: number;
  /** `index.sqlite` (+ its WAL) on disk, and what the FILE index costs inside
   *  it. The two are not additive: `bytes` is the whole file,
   *  `extractedTextBytes` the part of it the binaries account for. */
  index: {
    bytes: number;
    /** Tree binaries with a `files` row (a .docx, a .mp4, a .csv). */
    files: number;
    /** Extracted text: the `file_text` cache plus the `files_fts` bodies. */
    extractedTextBytes: number;
  };
  /** The local CRDT store, in aggregate. */
  history: {
    /** Distinct doc ids with any update or snapshot. */
    docs: number;
    updates: number;
    /** Update log + snapshots, all docs. */
    bytes: number;
    /** Docs whose id is not in `notes` any more — reclaimable. */
    orphanDocs: number;
    orphanBytes: number;
  };
  /** Top 10 by file size, largest first. */
  largestNotes: SizedFile[];
  /** Top 10 across `attachments/` and other files, largest first. */
  largestFiles: SizedFile[];
  /** Top 10 by CRDT bytes, heaviest first. */
  heaviestHistory: HistoryFootprint[];
  activity: {
    modifiedLast7d: number;
    modifiedLast30d: number;
    /** Notes modified per rolling 7-day window for the last 12 windows,
     *  OLDEST first; index 11 is the window ending now. */
    weeks: number[];
    /** Notes modified per CALENDAR day for the last 371 days (53 weeks), OLDEST
     *  first; the last entry is today. Days are cut at the local midnight the caller
     *  passes to `vault_stats` (`todayStartMs`), so a note edited at 23:50
     *  yesterday counts for yesterday. */
    days: number[];
  };
}

// ── Vault checks (Rust) ────────────────────────────────────────────────────────

/**
 * Stable ids of the integrity checks Rust runs. The UI owns the labels,
 * descriptions and severities (`lib/health/checks.ts`); Rust only reports
 * counts and the affected files, so adding a check is one Rust arm + one row.
 */
export type VaultCheckId =
  /** Notes whose file is 0 bytes. */
  | "empty-notes"
  /** Notes that are not valid UTF-8 text (cannot be edited or synced). */
  | "unreadable-notes"
  /** A leading `---` frontmatter block that does not close or is not YAML-ish. */
  | "bad-frontmatter"
  /** Two or more paths equal ignoring case (one file on macOS/Windows, two on the server). */
  | "case-collisions"
  /** Names Windows refuses: `<>:"|?*`, control chars, trailing dot/space, CON/PRN/AUX/NUL/COM1-9/LPT1-9. */
  | "illegal-names"
  /** Vault-relative path longer than 200 characters. */
  | "long-paths"
  /** Index row whose stored mtime/sha256 no longer matches the file on disk. */
  | "stale-index"
  /** Wikilinks that resolve to no note (`links.dst_note_id IS NULL`), by source note. */
  | "broken-links"
  /** `![[file]]` / `![](path)` embeds whose target is not in the vault. */
  | "missing-embeds"
  /** Two or more notes sharing one derived title (ambiguous wikilinks). */
  | "duplicate-titles"
  /** `.md`/`.markdown` files on disk with no `notes` row (never indexed). */
  | "unindexed-markdown"
  /** Notes at or above the server cap (10 MB); items carry `bytes`. */
  | "oversized-notes"
  /** Docs whose CRDT history is over 20× the file or over 256 updates uncompacted. */
  | "heavy-history"
  /** CRDT docs no live id claims (same rule as `VaultStats.history.orphanDocs`). */
  | "orphan-history"
  /** Recovery copies under `.context/trash` (count = files, bytes = total). */
  | "trash";

export interface VaultCheckItem {
  /** Vault-relative path; for `trash` the path under `.context/trash`. */
  path: string;
  docId?: string | null;
  /** One short fact: the colliding sibling, the bad character, the missing target… */
  detail?: string | null;
  bytes?: number | null;
}

export interface VaultCheckResult {
  id: VaultCheckId;
  /** True total, even when `items` is capped. */
  count: number;
  /** Total bytes when the check is about size (oversized, heavy history, orphans, trash). */
  bytes?: number | null;
  /** At most 25, most significant first (largest bytes, else path order). */
  items: VaultCheckItem[];
}

export interface VaultChecks {
  computedAt: number;
  /** One entry per `VaultCheckId`, always all of them, in the union's order. */
  results: VaultCheckResult[];
  /** Symbolic links under the vault (#216). Sync never follows them, so each is
   *  a path Baalda treats as absent. Items are link paths, `detail` the target.
   *  Reported beside `results` because it feeds the issue list, not the checks
   *  list. Optional so a fixture without it still types. */
  linkedPaths?: { id: "linked-paths"; count: number; bytes?: number | null; items: VaultCheckItem[] };
  /** Mapped notes whose paths resolve to ONE file on disk (same device + inode). */
  sharedFiles?: SharedFileGroup[];
}

export interface SharedFileGroup {
  /** Vault-relative paths, sorted. */
  paths: string[];
  /** The doc id mapped at each path, in `paths` order. */
  docIds: string[];
}

// ── Sync health (TS model) ─────────────────────────────────────────────────────

/**
 * The one-word answer at the top of the page, most urgent first when several
 * apply. `local` = sync is off for this vault; `attention` = synced vault with
 * at least one issue the user must act on; `healthy` = everything confirmed.
 */
export type HealthVerdict =
  | "local"
  | "signed-out"
  | "no-access"
  | "offline"
  | "connecting"
  | "syncing"
  | "attention"
  | "healthy";

export type HealthStageId = "disk" | "index" | "history" | "connection" | "server";

export type HealthStageState = "ok" | "busy" | "warn" | "error" | "off";

/**
 * One node of the pipeline diagram: files on disk → local index → local
 * history (CRDT) → connection → server. The FIRST non-ok stage, left to right,
 * is where the problem is; the diagram highlights that edge.
 */
export interface HealthStage {
  id: HealthStageId;
  label: string;
  state: HealthStageState;
  /** Big number or short status under the label, e.g. "1,204" or "Connected". */
  headline: string;
  /** One sentence for the tooltip / expanded row. */
  detail: string;
}

export type HealthIssueKind =
  /** Over the server's per-note cap; retrying cannot help. */
  | "too-large"
  /** A real local edit was refused after access became read-only. */
  | "no-write-access"
  /** Content push failed for a reason a retry may fix. */
  | "upload-failed"
  /** The registry could not create/move the server row. */
  | "register-failed"
  /** The server refused for a plan limit (`vault_limit_reached`, …). */
  | "limit"
  /** A note on disk with no server mapping and no failure recorded yet. */
  | "unregistered"
  /** Server says the doc exists but this user may not read it. */
  | "no-access"
  /** The server deleted or revoked this note but this device never confirmed
   *  its content upstream, so the file was left on disk rather than removed. */
  | "left-behind"
  /** A server note could not be written to disk. */
  | "materialize-failed"
  /** An inbound removal or move was withheld by a safety check. */
  | "inbound-blocked"
  /** Local CRDT history for a doc the vault no longer has. */
  | "orphan-history"
  /** Symbolic links in the vault, which sync ignores (#216). */
  | "linked-paths"
  /** Two or more mapped notes resolve to one file on disk (#216). */
  | "shared-file";

export type HealthRemedy =
  | "retry"
  | "open"
  | "reveal"
  | "delete"
  | "upgrade"
  | "reset-history"
  | "reclaim"
  | "sign-in"
  /** Save a copy of the file outside the vault (native save dialog). */
  | "export-copy"
  /** Put this issue's facts + explanation on the clipboard as text. */
  | "copy-details"
  /** Register this path with the server again as a note (left-behind files). */
  | "reregister"
  /** Show who owns the vault and copy a ready-to-send access request. */
  | "contact-owner";

/**
 * The reasoning behind an issue, in the user's terms. This is the point of the
 * page: a failed note must explain itself here, not in a console.
 */
export interface HealthExplanation {
  /** What this means: one or two sentences, no jargon. */
  meaning: string;
  /** What Baalda will do on its own, e.g. "Retries on the next connect" or
   *  "Nothing — it will not retry until the note is smaller". */
  next: string;
  /** What the user can do, ordered best-first. Prose, one item per line. */
  fixes: string[];
  /** Where copies of this note's content exist RIGHT NOW. */
  safety: "only-here" | "on-server" | "both" | "unknown";
}

/** One row of the issue's fact table: Path, Doc id, Size, Cap, Error code, … */
export interface HealthFact {
  label: string;
  value: string;
  /** Show a copy button (ids, raw reasons). */
  copyable?: boolean;
}

export interface HealthIssue {
  /** Stable key for React and for de-duplication: the docId when known, else the path. */
  key: string;
  docId: string | null;
  path: string | null;
  kind: HealthIssueKind;
  severity: "error" | "warn";
  /** Short label, e.g. "Too large to sync". */
  title: string;
  /** Plain-language cause, e.g. "This note is 12.4 MB; the server accepts up to 10 MB." */
  why: string;
  /** Offered in this order. Empty ⇒ informational only. */
  remedies: HealthRemedy[];
  /** Server error code when one was carried. */
  code: string | null;
  explanation: HealthExplanation;
  facts: HealthFact[];
  /** True when the sync layer will try again by itself (next connect / drain);
   *  false when only a user action can move it. */
  autoRetries: boolean;
}

/** The vault's per-note tally — the same numbers the sidebar dots roll up. */
export interface HealthCounts {
  total: number;
  synced: number;
  /** Queued or syncing right now. */
  pending: number;
  failed: number;
  /** No server mapping, or reported unsynced. */
  unsynced: number;
  /** Mapped but nothing reported yet this session (see `syncRollup.ts`). */
  unreported: number;
}

export interface HealthReport {
  verdict: HealthVerdict;
  /** e.g. "All 1,204 notes are on the server". */
  headline: string;
  /** e.g. "Last confirmed 2 minutes ago · api.baalda.com". */
  detail: string;
  stages: HealthStage[];
  /** Null when sync is off for this vault. */
  counts: HealthCounts | null;
  /** Errors first, then warnings; stable order within a severity. */
  issues: HealthIssue[];
  lastSyncedAt: number | null;
  /** Host of the server this vault syncs against, or null when local. */
  serverHost: string | null;
}

// ── Device ↔ server inventory ───────────────────────────────────────────────

/** The user-facing inventory comparison on Health. The server half is the
 * registry's last reconciled view, so it is nullable and carries freshness. */
export interface HealthInventory {
  local: { notes: number; folders: number; files: number; total: number };
  /** False until the supported-file tree has completed; local counts are placeholders. */
  localReady: boolean;
  server: { notes: number; folders: number; files: number; total: number } | null;
  /** Complete stored totals, available only through the owner/admin endpoint. */
  serverStored?: { notes: number; folders: number; files: number; total: number } | null;
  serverState: "current" | "updating" | "last-known" | "unavailable";
  /** Paths present on only one side, separated by transport kind. */
  deviceOnlyNotes: string[];
  serverOnlyNotes: string[];
  deviceOnlyFolders: string[];
  serverOnlyFolders: string[];
  deviceOnlyFiles: string[];
  serverOnlyFiles: string[];
}

// ── Sync timeline ──────────────────────────────────────────────────────────────

export type SyncLogLevel = "info" | "warn" | "error";

/**
 * One line of the vault's recent sync history, kept in a ring buffer by the
 * sync manager (newest last). `event` is a short stable kind for filtering
 * ("connect", "run-start", "run-done", "push-failed", "retry", "revoked", …);
 * `message` is the sentence shown.
 */
export interface SyncLogEntry {
  at: number;
  level: SyncLogLevel;
  event: string;
  message: string;
  docId?: string | null;
  path?: string | null;
  /** How many times this exact event repeated inside the fold window (see
   *  `syncLog.ts`); absent or 1 when it happened once. */
  count?: number;
}

// ── Per-note inspector ────────────────────────────────────────────────────────

/**
 * Everything the app knows about ONE note's sync position, for the page's
 * "Check a note" box. Every field is a fact the sync layer already holds;
 * nothing here is inferred.
 */
export interface NoteInspection {
  path: string;
  /** False when no such file is on disk (the path was typed or is stale). */
  exists: boolean;
  docId: string | null;
  /** Reported per-doc state this session, or null when nothing was reported. */
  state: "unsynced" | "queued" | "syncing" | "synced" | "error" | null;
  /** The registry's durable "server has this content" checkpoint. */
  pushed: boolean;
  /** Sitting in the local-change queue (will be pushed on the next drain). */
  queued: boolean;
  /** Holds local ops the server may not have (forces a real connect). */
  diverged: boolean;
  /** Remembered permanent failure reason, or null. */
  permanentFailure: string | null;
  /** Settled as "empty here and on the server" — nothing to push. */
  emptyEverywhere: boolean;
  bytes: number | null;
  mtime: number | null;
  /** Local CRDT footprint (encoded state), or null when unavailable. */
  historyBytes: number | null;
  /** One honest sentence, e.g. "Synced — the server confirmed this note's content." */
  verdict: string;
  /** The matching issue when this note is in the Needs-attention list. */
  issue: HealthIssue | null;
}

// ── Actions the page can take ──────────────────────────────────────────────────

export interface HealthActions {
  downloadFiles(paths: readonly string[]): Promise<void>;
  removeServerFile(path: string): Promise<void>;
  /** Run the file upload pass now for files on this computer the Remote Vault
   *  lacks, forgetting any refusal this session remembered for them. */
  retryLocalFiles(paths: readonly string[]): Promise<void>;
  /** Delete files from this computer (the sidebar's delete, permanent on disk). */
  deleteLocalFiles(
    paths: readonly string[],
  ): Promise<{ deleted: string[]; failed: Array<{ path: string; reason: string }> }>;
  /** Re-pull the registry and re-run the content pass for everything unconfirmed. */
  syncNow(): Promise<void>;
  /** Re-queue ONE note's content, clearing any remembered permanent failure. */
  retryDoc(docId: string): Promise<void>;
  /** Discard a note's CRDT history everywhere and re-seed from its file. */
  resetHistory(docId: string): Promise<{ bytesFreed: number }>;
  /** Drop orphan CRDT docs and vacuum the index. */
  reclaimOrphans(): Promise<{ docsRemoved: number; bytesReclaimed: number }>;
  openNote(path: string): void;
  /** Show the file in Finder / Explorer. */
  reveal(path: string): Promise<void>;
  /** The sidebar's delete (soft, server-aware). */
  deleteNote(path: string): Promise<void>;
  openUpgrade(): void;
  requestSignIn(): void;
  /** Build the plain-text diagnostic bundle and copy it; returns the text. */
  copyDiagnostics(): Promise<string>;
  /** Native save dialog, then copy the file out of the vault. Resolves to the
   *  destination, or null when cancelled. */
  exportCopy(path: string): Promise<string | null>;
  /** Copy one issue's title, why, facts and explanation as text; returns it. */
  copyIssue(issue: HealthIssue): Promise<string>;
  /** Register a left-behind path with the server again and queue its content. */
  reregister(path: string): Promise<void>;
  /** Who owns this vault, plus a ready-to-send access request copied to the
   *  clipboard. Null owner when unknown. */
  contactOwner(): Promise<{ owner: { name: string; email: string } | null; message: string }>;
  /** Everything known about one note's sync position. */
  inspectNote(path: string): Promise<NoteInspection>;
  /** Delete every recovery copy under `.context/trash`; returns bytes freed. */
  emptyTrash(): Promise<{ filesRemoved: number; bytesFreed: number }>;
  /** Drop and rebuild the local search index from the files (fixes stale rows). */
  rebuildIndex(): Promise<void>;
  /**
   * Run one planned check-level action — a heal or a bulk form of a per-item
   * button. The plan (and every word it says) comes from
   * `lib/health/checkActions.ts`; this only supplies the I/O. It never throws:
   * a failure is a line in the outcome, so a partial run still reports what it
   * managed to do.
   */
  applyCheckAction(
    plan: CheckActionPlan,
    onProgress?: (done: number, total: number) => void,
  ): Promise<CheckActionOutcome>;
}

/** What `useVaultHealth()` hands the tab. */
/** Server-side bytes for the vault's files and attachments. */
export interface ServerStorage {
  usedBytes: number;
  /** Null ⇒ this vault's plan has no storage cap. */
  limitBytes: number | null;
}

export interface VaultHealthSnapshot {
  report: HealthReport;
  inventory: HealthInventory;
  /** Local attachment evidence from both the hidden store and surfaced binary
   * files. Null while either census is still unknown. */
  hasLocalAttachments?: boolean | null;
  stats: VaultStats | null;
  statsError: string | null;
  /** The Remote Vault's attachment/file bytes (`GET /vaults/:id/storage`).
   *  Null when sync is off, the read failed or it has not landed — the page
   *  shows "—" and never waits on it. */
  serverStorage?: ServerStorage | null;
  /** The integrity checks; null until the first pass lands or when it failed. */
  checks: VaultChecks | null;
  /** True while the first census is in flight. */
  loading: boolean;
  /** Recent sync events, oldest first (ring buffer, ≤ 200). */
  log: SyncLogEntry[];
  refresh(): void;
  actions: HealthActions;
}
