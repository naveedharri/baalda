// Sidebar sync indicators: fold the vault's per-document sync state — which is
// keyed by `docId` — onto the tree's rows, which are keyed by path.
//
// Pure and dependency-free (like `locks.ts`) so it is unit-tested without React
// or Tauri, and so the whole roll-up is one function the UI calls once per render
// instead of work smeared across every row.
//
// Three properties this exists to guarantee:
//
//  1. HONESTY. The user asked for this so that "synced" can be trusted. So a note
//     with no server mapping counts as NOT synced (because it is), and a folder is
//     only "synced" when every note under it is.
//  2. AN HONEST DENOMINATOR. The percentage is computed against the FULL note set
//     (the local title index ∪ the registry's map), never against the sidebar
//     tree — that tree is lazily loaded, so a folder nobody has expanded holds an
//     empty `children` placeholder and would roll up 0 of 0 notes, i.e. "100%".
//  3. ONE O(N) PASS. Rolling up inside each rendered row is O(subtree) per row —
//     quadratic on a large vault, re-run on every progress emission. Here every
//     note is visited once and credited to each of its ancestor folders, so the
//     cost is linear in the number of path segments in the vault.

import { isSafeAttachmentRelPath } from "./sync/attachments";
import type { DocSyncState } from "./sync/vaultScope";

/** Rolled-up sync state of everything under one folder. */
export interface FolderSyncSummary {
  /** Notes under this folder, at any depth. Never 0 for a summary that exists. */
  total: number;
  synced: number;
  /** In flight right now (queued or syncing). */
  pending: number;
  failed: number;
  /** The folder row's state. See {@link rollupState}. */
  state: DocSyncState;
  /** `synced / total` as a whole percentage, floored (so it reads 99% at 499/500
   *  and only ever reads 100% when everything really is synced). */
  percent: number;
}

export interface TreeSyncIndex {
  /** Note relPath → its state. Absent ⇒ not a synced note (e.g. an image). */
  notes: Map<string, DocSyncState>;
  /** Folder relPath → roll-up. Folders containing no notes are ABSENT, so they
   *  render no indicator rather than a meaningless "0 of 0". */
  folders: Map<string, FolderSyncSummary>;
  /** The whole vault's roll-up (the root folder), or null when it holds no notes. */
  vault: FolderSyncSummary | null;
}

export interface TreeSyncInput {
  /** relPath → server docId for every note the registry has mapped
   *  (`store.docIdByPath`). */
  docIdByPath: Record<string, string>;
  /** docId → reported state (`store.docSyncState`). A missing entry means "no
   *  transition reported yet", which is visually identical to `unsynced`. */
  docSyncState: Record<string, DocSyncState>;
  /**
   * Every note path the LOCAL index knows about (`store.titles`). This is what
   * keeps the denominator honest: a note that exists on disk but has no server
   * mapping (registration failed, or hasn't happened yet) is counted, and counted
   * as unsynced, instead of quietly vanishing from its folder's total.
   */
  localNotePaths: Iterable<string>;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

interface Counts {
  total: number;
  synced: number;
  pending: number;
  failed: number;
}

/**
 * A folder's state from its descendants' states. Deliberately pessimistic in
 * that order: an error anywhere is the thing the user must see, and "synced"
 * requires unanimity.
 */
function rollupState(c: Counts): DocSyncState {
  if (c.failed > 0) return "error";
  if (c.synced === c.total) return "synced";
  if (c.pending > 0) return "syncing";
  return "unsynced";
}

function summarize(c: Counts): FolderSyncSummary {
  return {
    ...c,
    state: rollupState(c),
    percent:
      c.total === 0 ? 0 : c.synced === c.total ? 100 : Math.floor((c.synced / c.total) * 100),
  };
}

/** Build the whole tree's sync index in one pass. */
export function buildTreeSyncIndex(input: TreeSyncInput): TreeSyncIndex {
  const { docIdByPath, docSyncState, localNotePaths } = input;
  const notes = new Map<string, DocSyncState>();

  // Every note the server knows about, at its reported state.
  for (const [relPath, docId] of Object.entries(docIdByPath)) {
    notes.set(relPath, docSyncState[docId] ?? "unsynced");
  }
  // Every note only this device knows about. It has no docId, so it cannot have a
  // state — and "no server row" is exactly what unsynced means.
  for (const relPath of localNotePaths) {
    // The vault-root `attachments/` store is the ONE place the local title index
    // and the sidebar disagree: Rust indexes markdown inside it but hides the
    // folder from the tree, and the registry never registers it as a note. It has
    // no row to badge, so counting it would only spoil a denominator.
    if (isSafeAttachmentRelPath(relPath)) continue;
    if (!notes.has(relPath)) notes.set(relPath, "unsynced");
  }

  const counts = new Map<string, Counts>();
  const credit = (dir: string, state: DocSyncState): void => {
    let c = counts.get(dir);
    if (!c) {
      c = { total: 0, synced: 0, pending: 0, failed: 0 };
      counts.set(dir, c);
    }
    c.total++;
    if (state === "synced") c.synced++;
    else if (state === "error") c.failed++;
    else if (state === "queued" || state === "syncing") c.pending++;
  };

  // Credit each note to every folder above it, up to and including the root ("").
  for (const [relPath, state] of notes) {
    let dir = parentDir(relPath);
    for (;;) {
      credit(dir, state);
      if (dir === "") break;
      dir = parentDir(dir);
    }
  }

  const folders = new Map<string, FolderSyncSummary>();
  let vault: FolderSyncSummary | null = null;
  for (const [dir, c] of counts) {
    const summary = summarize(c);
    if (dir === "") vault = summary;
    else folders.set(dir, summary);
  }
  return { notes, folders, vault };
}

/** What to draw on one sidebar row. `null` ⇒ draw nothing at all. */
export interface RowSyncMark {
  state: DocSyncState;
  /** Render this percentage instead of a dot (folders that aren't settled). */
  percent: number | null;
  /** Tooltip / accessible label. */
  title: string;
}

/** Per-note tooltips. Plain language: this is the "is my work safe?" signal. */
export const DOC_SYNC_TITLES: Record<DocSyncState, string> = {
  unsynced: "Not on the server yet",
  queued: "Waiting to sync",
  syncing: "Syncing…",
  synced: "Synced",
  error: "Couldn't sync — this note is only on this device",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Tooltip for a folder row: always the real counts, never a rounded claim. */
export function folderSyncTitle(s: FolderSyncSummary): string {
  if (s.failed > 0) {
    return `${plural(s.failed, "note")} of ${s.total} couldn't sync`;
  }
  if (s.synced === s.total) {
    return `All ${plural(s.total, "note")} synced`;
  }
  return `${s.synced} of ${plural(s.total, "note")} synced (${s.percent}%)`;
}

/**
 * Resolve one row to its indicator, or null when it should have none:
 * a file that isn't a synced note (an image, an unmapped page), or a folder that
 * contains no notes at all.
 *
 * A folder shows a PERCENTAGE until it is settled, then a single dot — which is
 * what makes "are all my folders synced?" answerable at a glance: a column of
 * quiet dots means yes, any number in it means not yet.
 */
export function rowSyncMark(
  row: { path: string; isDir: boolean },
  index: TreeSyncIndex,
): RowSyncMark | null {
  if (row.isDir) {
    const summary = row.path === "" ? index.vault : (index.folders.get(row.path) ?? null);
    if (!summary) return null;
    const settled = summary.state === "synced" || summary.state === "error";
    return {
      state: summary.state,
      percent: settled ? null : summary.percent,
      title: folderSyncTitle(summary),
    };
  }
  const state = index.notes.get(row.path);
  if (!state) return null;
  return { state, percent: null, title: DOC_SYNC_TITLES[state] };
}
