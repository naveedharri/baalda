import { useEffect, useState } from "react";
import { Banner } from "./Banner";
import { useNoticeSlot } from "./useNoticeSlot";
import { authManager } from "../lib/auth/authManager";
import { hasBillingLapsedLock } from "../lib/locks";
import { syncManager } from "../lib/sync/docSession";
import { toast } from "../lib/toast";
import type { Share } from "../lib/api";
import { useStore } from "../store";

export const ACCOUNT_LAPSED_COPY =
  "Your Team subscription ended. This vault syncs read-only; your files still edit locally.";
export const ACCOUNT_LAPSED_MEMBER_COPY = "Ask the vault owner to resume the plan.";

/**
 * Should the lapsed-Team notice be up? Either signal is enough: the server's
 * synthetic `billing_lapsed` vault lock (read on every locks refresh), or a 402
 * `account_read_only` the sync layer met this run (before the next refresh).
 */
export function accountLapsedNotice(args: {
  syncEnabled: boolean;
  locks: readonly Share[];
  accountReadOnly: boolean;
}): boolean {
  if (!args.syncEnabled) return false;
  return args.accountReadOnly || hasBillingLapsedLock(args.locks);
}

/**
 * Presentational strip. The manager variant carries a pending choice (Resume
 * plan / Manage plan) and never fades; the member variant is informational.
 */
export function AccountLapsedNoticeView({
  show,
  canManage,
  busy,
  onResume,
  onManage,
  onDismiss,
}: {
  show: boolean;
  canManage: boolean;
  busy: boolean;
  onResume: () => void;
  onManage: () => void;
  onDismiss: () => void;
}) {
  return (
    <Banner show={show} className="account-lapsed-banner" role="alert">
      <span>
        {ACCOUNT_LAPSED_COPY}
        {!canManage && ` ${ACCOUNT_LAPSED_MEMBER_COPY}`}
      </span>
      <div className="banner-actions">
        {canManage ? (
          <>
            <button className="primary" disabled={busy} onClick={onResume}>
              Resume plan
            </button>
            <button disabled={busy} onClick={onManage}>
              Manage plan
            </button>
          </>
        ) : (
          <button onClick={onDismiss}>Dismiss</button>
        )}
      </div>
    </Banner>
  );
}

/**
 * The Team account behind the open vault lapsed (`lib/noticeSlot.ts`
 * "account-lapsed"). The registry flag is read on the same re-render trigger as
 * the note-limit strip: every run's progress.
 */
export function AccountLapsedNotice() {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const locks = useStore((s) => s.locks);
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  useStore((s) => s.syncProgress);
  const accountReadOnly = syncManager.registry.isAccountReadOnly();
  const wants = accountLapsedNotice({ syncEnabled, locks, accountReadOnly });

  // Manager = the caller's own billing account holds this vault and they can
  // manage it. Anything else (a member, an admin of someone else's account, a
  // failed read) gets the informational variant.
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    if (!wants || !orgId) {
      setCanManage(false);
      return;
    }
    let live = true;
    authManager.api
      .getBillingAccount()
      .then((a) => {
        if (live) setCanManage(a.canManage && a.vaults.some((v) => v.orgId === orgId));
      })
      .catch(() => {
        if (live) setCanManage(false);
      });
    return () => {
      live = false;
    };
  }, [wants, orgId]);

  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const dismissed = !canManage && dismissedFor === (orgId ?? "");
  const dismiss = () => setDismissedFor(orgId ?? "");
  const [busy, setBusy] = useState(false);

  const visible = useNoticeSlot(
    "account-lapsed",
    wants && !dismissed,
    canManage ? {} : { onFade: dismiss },
  );

  const resume = async () => {
    setBusy(true);
    try {
      await authManager.api.accountResume();
      await useStore.getState().refreshLocks();
      toast("Team plan resumed");
    } catch (e) {
      toast(`Couldn't resume the plan — ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccountLapsedNoticeView
      show={visible}
      canManage={canManage}
      busy={busy}
      onResume={() => void resume()}
      onManage={() => useStore.getState().requestAccountSettings("plan")}
      onDismiss={dismiss}
    />
  );
}
