import { Banner } from "./Banner";
import type { SyncProgress } from "../lib/sync/vaultScope";

/**
 * Should the Free note-limit strip be up?
 *
 * The one survivor of the old "N notes didn't sync" banner. That message is
 * gone — per-note failures live on the Health page and nowhere else, so the pill
 * and sidebar can read "Synced" once a run ends — but the Cloud note cap is not
 * a failure to explain: it is an upgrade the user has to be offered, and this
 * strip was its only prompt. Same trigger it always had (a finished run with
 * notes left behind, while the registry reports `note_limit_reached`), same
 * per-run dismissal.
 *
 * `dismissedRunToken` is compared against `runToken`, which the store bumps on
 * each fresh transition into `error` — so Dismiss silences THIS run only.
 */
export function noteLimitBanner(args: {
  syncEnabled: boolean;
  progress: SyncProgress | null;
  /** `registry.limitCode() === "note_limit_reached"`. */
  noteLimit: boolean;
  /** Identity of the current failed run (`store.failedRunToken`). */
  runToken: number;
  /** The run the user dismissed, or null when they have dismissed none. */
  dismissedRunToken: number | null;
}): boolean {
  const { syncEnabled, progress, noteLimit, runToken, dismissedRunToken } = args;
  if (!syncEnabled || !noteLimit) return false;
  if (progress?.phase !== "error" || progress.failed <= 0) return false;
  return dismissedRunToken == null || dismissedRunToken !== runToken;
}

/**
 * A full-width strip offering the upgrade past the Free 20,000-note sync cap.
 * Presentational on purpose (the store wiring lives in `App.tsx` alongside the
 * other banners), reusing the shared `Banner` shape and the flush strip
 * geometry of `.not-syncing-banner`.
 */
export function NoteLimitBannerView({
  show,
  onUpgrade,
  onDismiss,
}: {
  show: boolean;
  onUpgrade: () => void;
  onDismiss: () => void;
}) {
  return (
    <Banner show={show} className="note-limit-banner" role="alert">
      <span>
        <strong>20,000-note Free sync limit reached.</strong> Additional notes stay on this
        device. Upgrade to Pro to sync more notes and use Baalda Assistant.
      </span>
      <div className="banner-actions">
        <button className="primary" onClick={onUpgrade}>
          Upgrade to Pro
        </button>
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </Banner>
  );
}
