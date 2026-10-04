import { Banner } from "./Banner";
import { syncPauseRemaining, syncPauseText, type SyncPause } from "../lib/sync/syncPause";

/**
 * "Sync paused: many notes were emptied at once" — the server's shrink burst
 * brake (#252) is holding THIS account's writes in the vault.
 *
 * Without it the held user saw only "Syncing…" for the whole hold. The banner
 * says the two things they need: their edits are safe on this device, and they
 * sync when the pause ends or an owner/admin releases it. Dismissible, because
 * the pill and Health keep saying it until the pause actually lifts; dismissal
 * is per episode (`since`), so a NEW pause shows again.
 *
 * Presentational; the store wiring lives in `App.tsx` with the other banners.
 */
export function SyncPausedBannerView({
  pause,
  dismissed,
  now,
  onDismiss,
}: {
  pause: SyncPause | null;
  /** The `since` of the dismissed episode, if any. */
  dismissed: number | null;
  now: number;
  onDismiss: () => void;
}) {
  const show = pause != null && dismissed !== pause.since;
  const remaining = pause ? syncPauseRemaining(pause, now) : null;
  return (
    <Banner show={show} className="not-syncing-banner" role="status">
      {pause && (
        <span>
          <strong>{syncPauseText(pause)}</strong> — your edits are safe on this device and
          will sync when the pause ends{remaining ? ` (in ${remaining})` : ""} or a vault
          owner or admin releases it.
        </span>
      )}
      <div className="banner-actions">
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </Banner>
  );
}
