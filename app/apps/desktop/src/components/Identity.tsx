import { useEffect, useState } from "react";
import { CheckMark } from "./Spinner";
import { isBulkPhase, type SyncProgress } from "../lib/sync/vaultScope";
import { syncPauseRemaining, type SyncPause } from "../lib/sync/syncPause";

/** "just now" / "1m ago" / "2h ago" — coarse on purpose; it ticks every 30s. */
export function relativeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * True while the open vault has a bulk sync run with OUTSTANDING work. A run
 * opens its phases before it knows their size (the reconcile opens
 * `registering` at 0, the bulk engine `downloading` at 0); a phase with
 * nothing left to do is not news, and counting it kept the pill amber through
 * the whole reconcile on every launch and switch. Display only: the sync
 * layer's own gating (`liveSince`, the first pull) never reads this.
 * `removing` always counts (its label is a remaining count of its own), and so
 * does an upload with notes the server has never had (#258).
 */
export function isSyncRunActive(progress: SyncProgress | null | undefined): boolean {
  if (!progress || !isBulkPhase(progress.phase)) return false;
  if (progress.phase === "removing") return true;
  if (progress.phase === "uploading" && (progress.notUploaded ?? 0) > 0) return true;
  // A counter that raced past its denominator is a run still in flight.
  return progress.total > progress.done || (progress.total > 0 && progress.done > progress.total);
}

/** How long a run that just appeared must last before the pill leaves green. */
export const SYNC_RUN_HOLD_MS = 500;

/**
 * Whether the pill should SHOW a run as active: a run that just appeared is
 * held back for {@link SYNC_RUN_HOLD_MS}, so a burst that finishes inside it
 * never flickers green → amber → green. `activeSince` is when the run became
 * active (null when it is not); real work past the hold shows its counts.
 */
export function shownRunActive(activeSince: number | null, now: number): boolean {
  return activeSince != null && now - activeSince >= SYNC_RUN_HOLD_MS;
}

/** {@link isSyncRunActive}, held back by {@link shownRunActive}. */
function useShownRunActive(progress: SyncProgress | null | undefined): boolean {
  const active = isSyncRunActive(progress);
  const [since, setSince] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      setSince(null);
      return;
    }
    const start = Date.now();
    setSince((prev) => prev ?? start);
    const t = setTimeout(() => setTick((n) => n + 1), SYNC_RUN_HOLD_MS);
    return () => clearTimeout(t);
  }, [active]);
  return active && shownRunActive(since, Date.now());
}

/** The progress the pill renders: a run still inside its hold reads as settled. */
export function heldProgress(
  progress: SyncProgress | null | undefined,
  shown: boolean,
): SyncProgress | null | undefined {
  if (!progress || shown || !isSyncRunActive(progress)) return progress;
  return { ...progress, phase: "done" };
}

/** The run's completion as a whole percentage, or null when it has no total.
 *  Floored, so it never reads 100% while a unit of work is still outstanding. */
export function syncRunPercent(progress: SyncProgress | null | undefined): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((progress.done / progress.total) * 100)));
}

/**
 * The run as the pill sees it: a run that ENDED in `error` reads as a finished
 * run. The pill speaks two words when sync is on and connected — "Syncing" and
 * "Synced" — and a stopped run is not news that belongs on it: per-note
 * failures, notes the server refused for access and a failing registry pull
 * all have their own surfaces (the sidebar's per-doc and vault badges, the
 * Activity panel, the banners), and `syncManager.syncFailures()` is left
 * untouched. What the pill shows instead is the state that is still true: the
 * open note's own connection ("Synced" / "Syncing…" / "Retrying…" / "Offline"),
 * or, for the vault-wide pill, the vault channel's live status.
 *
 * (It used to keep a run with no failed note, or one with refused notes or a
 * failing pull, as `error` and read "Sync incomplete" with a "Sync now"
 * action. That label was removed: it was more alarming than accurate.)
 */
export function pillProgress(
  progress: SyncProgress | null | undefined,
): SyncProgress | null | undefined {
  if (progress?.phase === "error") return { ...progress, phase: "done" };
  // A phase opened with nothing outstanding (see `isSyncRunActive`) reads as
  // settled, so a vault with nothing to move is green, not "Syncing…".
  if (progress && isBulkPhase(progress.phase) && !isSyncRunActive(progress)) {
    return { ...progress, phase: "done" };
  }
  return progress;
}

/**
 * Pure label for the sync pill. Extracted so the (surprisingly load-bearing)
 * "Syncing…" vs "Synced · just now" logic is unit-testable without a DOM.
 *
 * `pending` (local edits not yet acked) wins over the timestamp: while flushing
 * we show "Syncing…" — the pill speaks exactly two words, Syncing and Synced,
 * so nobody has to learn what a third ("Saving") means. Once acked, the caller
 * has bumped `lastSyncedAt`, so it reads "Synced · just now" and counts up.
 *
 * `progress` is the VAULT's bulk run, and it outranks `status` (the open note's
 * CONNECTION) whenever it is live. Those two are genuinely independent: the
 * socket can be perfectly "synced" while 380 of 500 notes have never reached the
 * server, and reporting "Synced · just now" there is precisely the lie this
 * progress exists to kill.
 *
 * `noteOpen: false` puts the pill in vault-wide mode: `status` belongs to a
 * socket that doesn't exist, so the label comes from `progress` while a run is
 * live (the counter) and from `vaultStatus`, the vault channel's own live
 * connection, once it has stopped (see {@link vaultWideLabel}). The pill never
 * says "Synced" for the vault unless that channel is synced.
 */
export function syncBadgeLabel(args: {
  status: string;
  pending?: boolean;
  lastSyncedAt?: number | null;
  now: number;
  enabled?: boolean;
  /** The open vault's bulk sync run, when one is in flight. */
  progress?: SyncProgress | null;
  /** False when the pill stands for the vault, not an open note. */
  noteOpen?: boolean;
  /** The vault channel's live status (`store.vaultSyncStatus`): what the
   *  vault-wide pill reports once no run is live. */
  vaultStatus?: string;
}): string {
  const { status, pending, lastSyncedAt, now, enabled, noteOpen, vaultStatus } = args;
  const progress = pillProgress(args.progress);
  if (progress?.phase === "removing") {
    return `Updating access · ${Math.max(0, progress.total - progress.done).toLocaleString()} remaining`;
  }
  // A grant fact about the open note outranks everything else: there is no point
  // reporting upload progress on a doc we are not allowed to write.
  if (noteOpen !== false) {
    if (status === "no-access") return "No access";
    if (status === "read-only") return "Read-only";
  }
  // Terminal and vault-wide-relevant: this note will never reach the server on
  // its own, so it outranks run progress whether or not it is the open note.
  // Saying "Syncing…" over a doc the server has permanently refused is the lie
  // the whole badge exists to avoid.
  if (status === "too-large") return "Too large to sync";
  // The server has no such doc any more (its row is soft-deleted, or it was
  // never registered), so no reconnect can sync it. One stable word beats the
  // Synced/Syncing strobe this state used to produce.
  if (status === "deleted") return "Deleted";
  if (progress && isSyncRunActive(progress)) {
    // The one exception to "one verb": notes whose content the server has
    // never had (#258) — an interrupted first upload resuming, or a fresh one.
    // That is the user's situation, not the mechanism, and the count is what
    // tells them not to quit yet. `notUploaded` is only stamped when non-zero,
    // so an already-synced vault never reads "Uploading".
    const left = progress.notUploaded ?? 0;
    if (progress.phase === "uploading" && left > 0) {
      return `Uploading · ${left.toLocaleString()} ${left === 1 ? "note" : "notes"} left`;
    }
    if (progress.total <= 0) return "Syncing…";
    // One verb for every phase. The old per-phase labels ("Uploading",
    // "Downloading") described the mechanism, not the user's situation — the
    // content pass pulls each note's server state before pushing anything, so
    // on an already-synced vault "Uploading files" read as "my synced vault is
    // being re-sent". Done is clamped so a racing denominator can never render
    // an impossible "585/164".
    return `Syncing ${Math.min(progress.done, progress.total)}/${progress.total} updates`;
  }
  if (noteOpen === false) return vaultWideLabel(vaultStatus, enabled);
  if (status === "synced") {
    if (pending) return "Syncing…";
    return lastSyncedAt != null ? `Synced · ${relativeAgo(lastSyncedAt, now)}` : "Synced";
  }
  if (status === "connecting") return "Syncing…";
  if (status === "error") return "Retrying…";
  return enabled === false ? "Local only" : "Offline";
}

/**
 * The pill's tone class. Same precedence as {@link syncBadgeLabel}, so the colour
 * never contradicts the words (a green "Syncing 12/500" would be worse than no
 * indicator at all).
 */
export function syncBadgeTone(args: {
  status: string;
  progress?: SyncProgress | null;
  /** False when the pill stands for the vault, not an open note. */
  noteOpen?: boolean;
  /** See {@link syncBadgeLabel}. */
  vaultStatus?: string;
}): string {
  const { status, noteOpen, vaultStatus } = args;
  const progress = pillProgress(args.progress);
  if (progress?.phase === "removing") return "connecting";
  if (noteOpen !== false && (status === "no-access" || status === "read-only")) {
    return status;
  }
  // Red, not amber: nothing about these resolves on its own.
  if (status === "too-large" || status === "deleted") return "error";
  if (isSyncRunActive(progress)) return "connecting";
  if (noteOpen === false) return vaultWideTone(vaultStatus);
  return status;
}

/**
 * The vault-wide pill once no run is live: the vault channel's own connection,
 * never a hard-coded "Synced". A channel still opening or backfilling reads
 * "Syncing…", a dropped one "Retrying…", no channel at all "Offline" (or
 * "Local only" with sync off).
 */
function vaultWideLabel(vaultStatus: string | undefined, enabled: boolean | undefined): string {
  switch (vaultStatus) {
    case "synced":
      return "Synced";
    case "connecting":
      return "Syncing…";
    case "error":
      return "Retrying…";
    case "no-access":
      return "No access";
    default:
      return enabled === false ? "Local only" : "Offline";
  }
}

/** Tone for {@link vaultWideLabel}, so the colour matches the words. */
function vaultWideTone(vaultStatus: string | undefined): string {
  switch (vaultStatus) {
    case "synced":
    case "connecting":
    case "error":
    case "no-access":
      return vaultStatus;
    default:
      return "offline";
  }
}

/**
 * A vault-wide hold that outranks every per-note and per-run state: while it
 * lasts nothing syncs, so no call site may claim "Synced" (#273 — a second
 * badge that skipped these read "Synced · 9m ago" under a paused vault).
 *
 * - The vault folder is gone (#228): neutral, not an error — the banner has
 *   the fix.
 * - The server's shrink burst brake holds our writes (#252): amber, not red —
 *   nothing is lost, and it ends on its own or when an owner releases it.
 * - The vault is keyed and this computer does not hold its key yet: nothing
 *   reaches the server until a teammate shares it. It used to read "Synced"
 *   over hundreds of files that never left the computer.
 */
export function syncBadgeHold(args: {
  rootMissing?: boolean;
  /** Sync turned on for this vault; the brake only means something then. */
  enabled?: boolean;
  pause?: Pick<SyncPause, "until"> | null;
  /** The open vault waits for its key on this computer (`useVaultKeyBlocked`). */
  keyLocked?: boolean;
  now: number;
}): { tone: "offline" | "connecting"; label: string; title: string } | null {
  const { rootMissing, enabled, pause, keyLocked, now } = args;
  if (rootMissing) {
    return {
      tone: "offline",
      label: "Paused",
      title: "Sync is paused until the vault folder is back",
    };
  }
  if (enabled && pause) {
    const remaining = syncPauseRemaining(pause, now);
    return {
      tone: "connecting",
      label: "Sync paused",
      title:
        "Many notes were emptied at once, so the server paused your sync. Your edits are safe " +
        `on this device and sync when the pause ends${remaining ? ` (in ${remaining})` : ""} ` +
        "or a vault owner or admin releases it.",
    };
  }
  if (enabled && keyLocked) {
    return {
      tone: "connecting",
      label: "Sync paused",
      title: "This computer is waiting for the vault's key from a teammate. Nothing syncs until then; your files here are safe.",
    };
  }
  return null;
}

function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function SyncBadge({
  status,
  enabled,
  lastSyncedAt,
  pending,
  progress: rawProgress,
  noteOpen,
  vaultStatus,
  rootMissing,
  pause,
  keyLocked,
}: {
  status: string;
  enabled?: boolean;
  /** When set and status is "synced", the badge reads "Synced · 1m ago". */
  lastSyncedAt?: number | null;
  /** True while local edits are still flushing to the server → "Syncing…". */
  pending?: boolean;
  /** The open vault's bulk sync run — turns the pill into "Syncing 128/500"
   *  with a determinate bar. Omit for a pill that only tracks the connection. */
  progress?: SyncProgress | null;
  /** False when the pill stands for the vault, not an open note: socket-derived
   *  states are skipped and the label comes from `progress` and `vaultStatus`. */
  noteOpen?: boolean;
  /** The vault channel's live status — see {@link syncBadgeLabel}. */
  vaultStatus?: string;
  /** The vault folder is gone — see {@link syncBadgeHold}. */
  rootMissing?: boolean;
  /** The server's shrink brake (`store.syncPause`) — see {@link syncBadgeHold}. */
  pause?: SyncPause | null;
  /** The vault waits for its key here — see {@link syncBadgeHold}. */
  keyLocked?: boolean;
}) {
  // A run that just appeared is held back briefly so the pill never flickers
  // amber for a burst that settles at once; past the hold its counts show.
  const shown = useShownRunActive(rawProgress);
  const progress = heldProgress(rawProgress, shown);
  const running = isSyncRunActive(progress);
  // Only tick the relative clock once we're settled (synced, nothing pending, no
  // bulk run — while one is live the label is a counter, not a timestamp).
  const now = useNowTick(
    status === "synced" && !pending && lastSyncedAt != null && !running,
  );
  const label = syncBadgeLabel({
    status,
    pending,
    lastSyncedAt,
    now,
    enabled,
    progress,
    noteOpen,
    vaultStatus,
  });
  const tone = syncBadgeTone({ status, progress, noteOpen, vaultStatus });
  // A determinate fill whenever the run knows its own size; the pre-existing
  // indeterminate slide covers "working, size unknown" (connecting, saving).
  const percent = running ? syncRunPercent(progress) : null;
  // Hover answers "how far along?" in the same shape as the folder tooltips.
  const title =
    running && progress && percent != null
      ? `${progress.done} of ${progress.total} ${progress.phase === "removing" ? "items checked" : "updates"} · ${percent}%`
      : undefined;
  const body = (
    <>
      {tone === "connecting" || (tone === "synced" && pending) ? (
        <span
          className={`sync-progress${percent != null ? " determinate" : ""}`}
          aria-hidden="true"
        >
          <span
            className="sync-progress-fill"
            style={percent != null ? { width: `${percent}%` } : undefined}
          />
        </span>
      ) : tone === "read-only" ? (
        <svg
          className="sync-lock"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      ) : tone === "synced" ? (
        // Settled and safe reads as a tick, not just a green dot — the same
        // "this completed" glyph AsyncButton uses.
        <CheckMark size="xs" />
      ) : (
        <span className="sync-dot" aria-hidden="true" />
      )}
      <span className="sync-badge-label">{label}</span>
    </>
  );
  const hold = syncBadgeHold({ rootMissing, enabled, pause, keyLocked, now: Date.now() });
  if (hold) {
    return (
      <span className={`sync-badge ${hold.tone}`} title={hold.title}>
        <span className="sync-dot" aria-hidden="true" />
        <span className="sync-badge-label">{hold.label}</span>
      </span>
    );
  }
  return (
    <span className={`sync-badge ${tone}${pending ? " pending" : ""}`} title={title}>
      {body}
    </span>
  );
}
