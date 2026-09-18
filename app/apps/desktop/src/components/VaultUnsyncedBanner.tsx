import { Banner } from "./Banner";
import { AsyncButton } from "./AsyncButton";

/**
 * The strip that meets a vault which was made **local only** from somewhere
 * else — the owner's other device, or a teammate's.
 *
 * Without it this is a silent dead end. The folder's `.context/config.json` is
 * still stamped for a vault that no longer exists, so the app cannot open it as
 * a synced vault (there is nothing to open) and `planTurnOnSync` refuses to
 * adopt it as a new one (`blocked-foreign` — the stamp looks exactly like a
 * folder belonging to another account). The notes are all there, nothing syncs,
 * and every affordance on screen says no. This is the only way out.
 *
 * The decision lives in `lib/vault/unsyncPlan.ts` and the store wiring in
 * `App.tsx`, alongside the other banners, so this stays a pure view — the same
 * split `NotSyncingBanner` uses. It reuses the shared `Banner` shape rather than
 * growing a second, subtly different strip.
 *
 * No dismiss: the banner IS the state, and both buttons resolve it.
 */
export function VaultUnsyncedBannerView({
  show,
  onKeepLocal,
  onTurnOnSync,
}: {
  show: boolean;
  /** Accept it: keep this folder as a plain local vault. Touches no file. */
  onKeepLocal: () => Promise<unknown> | unknown;
  /** Sync it up again as a NEW vault, reusing the local doc ids. */
  onTurnOnSync: () => Promise<unknown> | unknown;
}) {
  return (
    <Banner show={show} className="not-syncing-banner" role="alert">
      <span>
        <strong>This vault was made local only</strong> — your notes are still here,
        but they no longer sync.
      </span>
      <div className="banner-actions">
        <AsyncButton className="primary" onClick={onTurnOnSync}>
          Turn sync back on
        </AsyncButton>
        <AsyncButton onClick={onKeepLocal}>Keep as local vault</AsyncButton>
      </div>
    </Banner>
  );
}
