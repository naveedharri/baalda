// Small pure helpers behind the Health page's summary figures: the nav badge,
// the "Files & attachments" size, and the bulk runner for left-on-disk notes.
// Kept apart from the hooks so each decision is testable without React.

import type { HealthFailures } from "./model";
import type { HealthInventory, HealthIssue, HealthIssueKind, VaultStats } from "./types";

/**
 * How many sync failures need a PERSON: a note over the size cap, a local edit
 * refused for lack of write access, or a file left on disk because the Remote
 * Vault dropped it before this device confirmed its content. Everything else
 * (timeouts, push failures, registry retries) heals by itself and never counts,
 * so the badge cannot nag about work Baalda is already redoing.
 */
export function actionNeededCount(failures: HealthFailures | null | undefined): number {
  if (!failures) return 0;
  const content = failures.content.filter(
    (f) => f.kind === "too-large" || f.kind === "no-write-access",
  ).length;
  const orphans = failures.registry.filter((f) => f.kind === "orphan").length;
  return content + orphans;
}

/**
 * This computer's side of "Files & attachments": the bytes of embedded
 * attachments plus standalone non-note files on disk. Deliberately NOT note
 * text, the index or edit history — the Remote Vault's storage figure counts
 * only file/attachment blobs, and both cards must measure the same thing for a
 * synced vault to show matching numbers. Null while the census is unknown.
 */
export function localFilesBytes(stats: VaultStats | null | undefined): number | null {
  if (!stats) return null;
  return stats.attachments.bytes + stats.otherFiles.bytes;
}

export interface EachOutcome {
  done: number;
  total: number;
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Run one per-item remedy over many paths, one at a time: the remedies write to
 * the registry and the disk, and a serial run keeps each refusal attributable
 * to its own path. A failure is recorded and the run continues.
 */
export async function runEach(
  paths: readonly string[],
  run: (path: string) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<EachOutcome> {
  const failed: EachOutcome["failed"] = [];
  let done = 0;
  const total = paths.length;
  onProgress?.(done, total);
  for (const path of paths) {
    try {
      await run(path);
    } catch (e) {
      failed.push({ path, reason: e instanceof Error ? e.message : String(e) });
    }
    done++;
    onProgress?.(done, total);
  }
  return { done, total, failed };
}

// ── Needs attention: one item, one place ─────────────────────────────────────

/**
 * Drop difference-group paths that an issue already covers. The issue wins: it
 * carries the reason and the action, so listing the same path again under
 * "missing from the Remote Vault" only repeats it with less to say. Paths
 * compare case-insensitively, like everywhere else in sync.
 */
export function dedupeDifferences(
  inventory: HealthInventory,
  issues: readonly Pick<HealthIssue, "path">[],
): HealthInventory {
  const covered = new Set(
    issues.filter((i) => i.path).map((i) => (i.path as string).toLowerCase()),
  );
  if (covered.size === 0) return inventory;
  const keep = (paths: string[]) => paths.filter((p) => !covered.has(p.toLowerCase()));
  return {
    ...inventory,
    deviceOnlyNotes: keep(inventory.deviceOnlyNotes),
    serverOnlyNotes: keep(inventory.serverOnlyNotes),
    deviceOnlyFolders: keep(inventory.deviceOnlyFolders),
    serverOnlyFolders: keep(inventory.serverOnlyFolders),
    deviceOnlyFiles: keep(inventory.deviceOnlyFiles),
    serverOnlyFiles: keep(inventory.serverOnlyFiles),
  };
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The group header for one kind of issue, in plain words. The rows under it
 *  then need nothing but their path. */
export function issueGroupTitle(kind: HealthIssueKind, n: number): string {
  switch (kind) {
    case "too-large":
      return `${plural(n, "note", "notes")} too large to sync`;
    case "no-write-access":
      return `${plural(n, "edit", "edits")} blocked by read-only access`;
    case "upload-failed":
      return `${plural(n, "note", "notes")} couldn't upload`;
    case "register-failed":
      return `${plural(n, "item", "items")} couldn't be added to the Remote Vault`;
    case "limit":
      return "Plan limit reached";
    case "unregistered":
      return `${plural(n, "note isn't", "notes aren't")} registered`;
    case "no-access":
      return "No access";
    case "left-behind":
      return `${plural(n, "note", "notes")} left on disk`;
    case "materialize-failed":
      return `${plural(n, "note", "notes")} couldn't be written to this computer`;
    case "inbound-blocked":
      return `${plural(n, "local change", "local changes")} held for safety`;
    case "orphan-history":
      return "Leftover edit history";
  }
}

/** What a path-less row says instead of a path — one short sentence. */
export function issueRowSentence(issue: Pick<HealthIssue, "kind" | "title">): string {
  switch (issue.kind) {
    case "no-access":
      return "You don't have access to this vault";
    case "limit":
      return "Your plan's limit stopped new notes from syncing";
    case "orphan-history":
      return "History kept for notes this vault no longer has";
    default:
      return issue.title;
  }
}
