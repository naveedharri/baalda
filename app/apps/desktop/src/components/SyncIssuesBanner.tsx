import { Banner } from "./Banner";
import type { SyncProgress } from "../lib/sync/vaultScope";

/**
 * Should the "these notes didn't sync" strip be up, and for how many notes?
 *
 * Pure, so the one decision the banner exists for is testable without a DOM —
 * the same split `notSyncingReason` uses for its own strip.
 *
 * The rule and its three refusals:
 *
 * 1. **A vault that isn't syncing cannot have failed to sync.** A local folder
 *    has no server to fall behind, and telling its owner that notes "didn't
 *    sync" would be an alarm about something they never turned on.
 * 2. **Only a TERMINAL run speaks.** `error` is the phase `completeRun` stamps
 *    once the run is over; while one is still moving, the counter in the pill is
 *    the honest report and a banner would be shouting about work in progress.
 * 3. **Only a run with named casualties.** `failed === 0` with an `error` phase
 *    is the download watchdog: the app never reached the server, so no
 *    individual note has a reason to explain. The pill already reads
 *    "Retrying…", and the Health page would have nothing to add.
 *
 * `dismissedRunToken` is the run the user has already waved away. It is compared
 * against `runToken`, which the store bumps on each fresh transition into
 * `error` — so Dismiss silences THIS failure and nothing else: the next failing
 * run raises the banner again.
 */
export function syncIssuesBanner(args: {
  syncEnabled: boolean;
  progress: SyncProgress | null;
  /** Identity of the current failed run (`store.failedRunToken`). */
  runToken: number;
  /** The run the user dismissed, or null when they have dismissed none. */
  dismissedRunToken: number | null;
}): { show: boolean; failed: number } {
  const { syncEnabled, progress, runToken, dismissedRunToken } = args;
  const failed = progress?.failed ?? 0;
  if (!syncEnabled) return { show: false, failed: 0 };
  if (progress?.phase !== "error") return { show: false, failed: 0 };
  if (failed <= 0) return { show: false, failed: 0 };
  if (dismissedRunToken != null && dismissedRunToken === runToken) {
    return { show: false, failed };
  }
  return { show: true, failed };
}

/**
 * A full-width strip naming the fact the sync pill can only fit into two words:
 * **some of your notes are not on the server, and the app can say which and
 * why.**
 *
 * Presentational on purpose (the store wiring lives in `App.tsx` alongside the
 * other banners) so the copy and both actions can be exercised without booting
 * the store. It reuses the shared `Banner` shape and the `.not-syncing-banner`
 * geometry — a strip flush across the note pane, not a floating card, for the
 * same reason: a card in this amber is what users scroll past.
 *
 * Unlike the not-syncing strip this one is dismissible, because it describes a
 * finished event rather than a state that is still true. Dismissing it does not
 * fix anything and does not claim to; the pill keeps reading "N not synced".
 */
export function SyncIssuesBannerView({
  show,
  failed,
  onOpenHealth,
  onDismiss,
  noteLimit = false,
}: {
  show: boolean;
  noteLimit?: boolean;
  failed: number;
  onOpenHealth: () => void;
  onDismiss: () => void;
}) {
  return (
    <Banner show={show} className="sync-issues-banner" role="alert">
      {noteLimit ? <span><strong>20,000-note Free sync limit reached.</strong> Additional notes stay on this device. Upgrade to Pro to sync more notes and use Baalda Steward.</span> : <span>
        <strong>
          {failed} {failed === 1 ? "note didn't" : "notes didn't"} sync
        </strong>{" "}
        — open the Health page for each note's reason and a fix.
      </span>}
      <div className="banner-actions">
        <button className="primary" onClick={onOpenHealth}>
          {noteLimit ? "Upgrade to Pro" : "Open Health"}
        </button>
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </Banner>
  );
}
