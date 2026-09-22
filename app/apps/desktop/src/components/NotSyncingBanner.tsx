import { Banner } from "./Banner";
import type { AuthStatus } from "../store";
import type { SyncStatus } from "../lib/sync/syncManager";

/**
 * Why the open note is not reaching the server, when the answer is something the
 * user must act on rather than wait out.
 *
 * These are the *silent divergence* states, where the app
 * looks and behaves exactly like a healthy one — the vault opens, notes render,
 * edits are accepted — while nothing leaves the device. A vault that is merely
 * offline or reconnecting is NOT here; it resolves itself, and the corner pill
 * already says so.
 */
export type NotSyncingReason = "signed-out" | "no-access" | "vault-no-access";

/**
 * Should the "not syncing" banner be up, and for which reason?
 *
 * Pure, so the one decision the whole banner exists for is testable without a
 * DOM — the same split `syncBadgeLabel` uses for the corner pill.
 *
 * The precedence and the three refusals:
 *
 * 1. **A folder that was never a synced vault has nothing to warn about.**
 *    `folderIsSynced` is the store's `openFolderIsSynced` — the folder's own
 *    `.context/config.json` stamp, peeked at boot — so it answers for a signed
 *    OUT app too, which is exactly when we need it. `null` means the peek has
 *    not landed: stay silent rather than accuse a local folder of being offline.
 * 2. **Auth still loading says nothing.** `authStatus: "unknown"` is the window
 *    between paint and the session restore. Claiming "Signed out" there would
 *    flash the alarm at everyone, every launch, for the fraction of a second
 *    before the restore proves them signed in.
 * 3. **Signed out wins over every sync status.** With no session there is no
 *    token to mint, so `syncStatus` is whatever the socket last said (usually a
 *    quiet "offline" — `mintFailureStatus` maps a 401 straight to it, which is
 *    the whole reason a signed-out app is indistinguishable from a working
 *    offline one today). The auth fact is the real one; report it.
 *
 * Only then does a per-doc refusal matter: `no-access` is the server's 403 at
 * token mint (the grant was withdrawn), a terminal state no reconnect resolves.
 * It is gated on a note actually being open, because `syncStatus` belongs to the
 * open doc's socket and `closeNote` leaves the last one's verdict behind — the
 * same reason `syncBadgeLabel` skips the grant states when `noteOpen` is false.
 * "Signed out" is not gated: that one is a fact about the vault, and it is just
 * as true on an empty editor pane.
 */
export function notSyncingReason(args: {
  authStatus: AuthStatus;
  /** True once a session object exists — mirrors `AccountMenu`'s own check, so
   *  a half-established session cannot read as signed in. */
  hasSession: boolean;
  syncStatus: SyncStatus;
  /** The vault channel alone: a note denial does not revoke membership. */
  vaultSyncStatus?: SyncStatus;
  /** The store's `openFolderIsSynced`: null until the stamp peek lands. */
  folderIsSynced: boolean | null;
  /** Is a note actually on screen? `syncStatus` is only about the open doc. */
  noteOpen: boolean;
}): NotSyncingReason | null {
  const { authStatus, hasSession, syncStatus, folderIsSynced, noteOpen } = args;
  if (folderIsSynced !== true) return null;
  if (authStatus === "unknown") return null;
  if (authStatus !== "signed-in" || !hasSession) return "signed-out";
  if (args.vaultSyncStatus === "no-access") return "vault-no-access";
  if (noteOpen && syncStatus === "no-access") return "no-access";
  return null;
}

/**
 * A full-width strip across the top of the note pane naming the fact that the
 * corner pill kept losing: **this note is not syncing and will not start on its
 * own.**
 *
 * Presentational on purpose (the store wiring lives in `App.tsx` alongside the
 * other banners) so the copy and the Sign in action can be exercised in a test
 * without booting the store. It reuses the shared `Banner` shape — same
 * `--warning-soft` tint, same height animation — with a modifier that squares
 * the corners and spans the pane, because a floating card is precisely what the
 * user in #145 scrolled past repeatedly.
 *
 * No dismiss: the banner is the state, so it leaves when the state does.
 */
export function NotSyncingBannerView({
  reason,
  onSignIn,
  onOpenHealth,
}: {
  reason: NotSyncingReason | null;
  /** Opens the app's sign-in card. Only rendered for the signed-out reason. */
  onSignIn: () => void;
  /**
   * Opens the Health page. Offered alongside both reasons, never instead of the
   * primary action: the banner names a fact, and Health is where the rest of the
   * facts are — which notes are affected, what is only on this device, and what
   * happens to them when access comes back.
   */
  onOpenHealth?: () => void;
}) {
  return (
    <Banner show={reason != null} className="not-syncing-banner" role="alert">
      {reason === "no-access" || reason === "vault-no-access" ? (
        <span>
          <strong>
            {reason === "vault-no-access"
              ? "You no longer have access to this vault"
              : "You no longer have access to this note"}
          </strong>{" "}— changes here are not syncing.
        </span>
      ) : (
        <span>
          <strong>Signed out</strong> — your changes are not syncing. Edits stay on this
          device until you sign in.
        </span>
      )}
      {reason != null && (onOpenHealth != null || reason === "signed-out") && (
        <div className="banner-actions">
          {reason === "signed-out" && (
            <button className="primary" onClick={onSignIn}>
              Sign in
            </button>
          )}
          {onOpenHealth != null && <button onClick={onOpenHealth}>Open Health</button>}
        </div>
      )}
    </Banner>
  );
}
