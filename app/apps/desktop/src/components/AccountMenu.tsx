import { lazy, Suspense, useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import { statusTone } from "../lib/presence/color";
import { AsyncButton } from "./AsyncButton";
import { toast } from "../lib/toast";
import { acceptInviteFailureMessage } from "../lib/inviteFlow";
import { LazyAvatar } from "./Face";
import { MenuIcon } from "./MenuIcon";
import { BugReportDialog } from "./BugReportDialog";

/* The settings surface is a whole second app (nine tabs, billing, MCP tokens,
   access) and nothing in it is on the first screen, so all three dialogs load
   on demand. `null` is the right fallback for a modal: the popover stays put
   and the sheet arrives a beat later. */
import type { AccountSettingsTab, SettingsTab } from "../lib/settingsTabs";
const VaultSettingsDialog = lazy(() =>
  import("./VaultSettingsDialog").then((m) => ({ default: m.VaultSettingsDialog })),
);
const AccountSettings = lazy(() =>
  import("./AccountSettings").then((m) => ({ default: m.AccountSettings })),
);
const AuthDialogLazy = lazy(() =>
  import("./AuthDialog").then((m) => ({ default: m.AuthDialog })),
);

/**
 * "On this device only · Turn on sync": a quick way out of a LOCAL vault from
 * the sidebar footer, sitting directly above the identity bar. Shown only once
 * we know the folder is local — auth resolved, sync off, and the folder's own
 * `.context` stamp names no vault (`openFolderIsSynced === false`; null means
 * the peek hasn't landed, and a synced vault reconciling at boot also has
 * `syncEnabled` false for a moment, so the stamp is what keeps it from
 * flashing there). Signed in, the button opens Vault Settings → General, whose
 * "Turn on sync & sharing" promo does the work; signed out it raises sign-in.
 */
function LocalVaultSyncRow({ onTurnOnSync }: { onTurnOnSync: () => void }) {
  const vault = useStore((s) => s.vault);
  const authStatus = useStore((s) => s.authStatus);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const openFolderIsSynced = useStore((s) => s.openFolderIsSynced);
  if (!vault || authStatus === "unknown" || syncEnabled || openFolderIsSynced !== false) {
    return null;
  }
  return (
    <div className="local-sync-row">
      <svg
        className="local-sync-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="5" y="5" width="14" height="10" rx="1.5" />
        <path d="M3 19h18" />
      </svg>
      <span className="local-sync-label" title="This vault lives only on this computer">
        On this device only
      </span>
      <button type="button" className="link-btn local-sync-btn" onClick={onTurnOnSync}>
        Turn on sync
      </button>
    </div>
  );
}

/**
 * Account & vault menu (spec 04 §2/§6/§7), redesigned as the standard
 * desktop-app identity flow: the sidebar footer is a single compact identity
 * bar (avatar + name + presence). Clicking it opens a popover menu with
 * invitations, account settings and sign-out. Vaults — switching, creating,
 * joining, their settings — live in the switcher on the sidebar header.
 * Heavy flows (sign-in, members & invites) live in focused modals so the
 * sidebar itself stays a file tree, not a settings page.
 */
export function AccountMenu() {
  const authStatus = useStore((s) => s.authStatus);
  const session = useStore((s) => s.session);
  // See the guard on this component's own AuthDialog below.
  const authPrompt = useStore((s) => s.authPrompt);
  const organizations = useStore((s) => s.organizations);
  const userInvitations = useStore((s) => s.userInvitations);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const activityStatus = useStore((s) => s.activityStatus);
  const vault = useStore((s) => s.vault);
  // "Open Vault Settings on this page", asked for from anywhere in the app (the
  // sync banner and the sync pill both point at Health). This component owns the
  // only settings dialog, so it is the only place that can answer.
  const settingsRequest = useStore((s) => s.settingsRequest);
  const accountSettingsRequest = useStore((s) => s.accountSettingsRequest);

  const [open, setOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  // Which full-screen settings dialog shows lives in the store, so opening one
  // closes the other in the same update (`requestSettings` /
  // `requestAccountSettings`): every cross-link swaps instead of stacking. The
  // page each one opens on is the tab its latest request named.
  const settingsDialog = useStore((s) => s.settingsDialog);
  const closeSettingsDialog = useStore((s) => s.closeSettingsDialog);
  const membersOpen = settingsDialog === "vault";
  const accountOpen = settingsDialog === "account";
  const settingsTab: SettingsTab | undefined = settingsRequest?.tab;
  const accountSettingsTab: AccountSettingsTab | undefined = accountSettingsRequest?.tab;
  // Signed out with a folder open: is that folder actually a SYNCED vault
  // (its `.context/config.json` is stamped with a vault id)? Labeling it
  // "Local · not synced" is factually wrong — the edits made here will merge
  // into the vault on the next sign-in — and it hides that signing in is the
  // way to bring it back online. Peeked from disk because the localStorage
  // caches may be gone while the folder still knows whose it is.
  const [openFolderSynced, setOpenFolderSynced] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [bugOpen, setBugOpen] = useState(false);
  // The bug icon shows only when THIS server takes reports (its operator set
  // BUG_REPORT_EMAIL). Re-asked per account + server, so switching either never
  // leaves a button pointing at an inbox that is not there.
  const [bugReport, setBugReport] = useState(false);
  const serverUrl = useStore((s) => s.serverUrl);
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) {
      setBugReport(false);
      return;
    }
    let alive = true;
    // getAuthMethods fails CLOSED, so one answer taken while the server was
    // down (or before it gained the setting) would hide the icon for the whole
    // session. Ask again whenever the window comes back and the menu opens.
    const check = () =>
      void authManager.api.getAuthMethods().then((m) => {
        if (alive) setBugReport(m.bugReport);
      });
    check();
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
    };
  }, [userId, serverUrl, open]);

  // "unknown" is a state the user can now SEE: the sidebar paints before the
  // session restore finishes, so for its first moments we do not yet know
  // whether anyone is signed in. Claiming "Local · not synced" then is a lie
  // about a synced vault, so pending renders the vault's name and nothing else.
  const authPending = authStatus === "unknown";
  const signedOut = !authPending && (authStatus !== "signed-in" || !session);
  const vaultPath = vault?.path ?? null;
  useEffect(() => {
    // Runs while PENDING too (the peek is ~60 bytes and answers the question
    // auth is still deciding), and never for a signed-in session — there the
    // vault list is the authority, not the folder's stamp.
    if (authStatus === "signed-in" || !vaultPath) {
      setOpenFolderSynced(false);
      return;
    }
    let alive = true;
    // ~60 bytes, parsed in Rust: this used to ship the folder's whole
    // `.context/config.json`, whose doc-id map is megabytes on a big vault.
    void ipc
      .peekVaultStamp(vaultPath)
      .then((stamp) => {
        if (alive) setOpenFolderSynced(stamp?.organizationId != null);
      })
      .catch(() => {
        if (alive) setOpenFolderSynced(false);
      });
    return () => {
      alive = false;
    };
  }, [authStatus, vaultPath]);

  // A new token means a NEW request, including a repeat of the tab already
  // showing — which is why the dialog below is keyed on it: `initialTab` is read
  // once, on mount, so a request that arrives while settings are already open
  // has to remount the dialog to land on its page.
  // (`dismissSettings` clears the store's dialog flag itself.)

  // Sign-out closes every dialog this component owns (#302), for the case where
  // it stays mounted through sign-out → sign-in (see the tokens below for the
  // case where it does not).
  const hadSession = useRef(session != null);
  useEffect(() => {
    if (hadSession.current && session == null) {
      closeSettingsDialog();
      setAuthOpen(false);
      setOpen(false);
    }
    hadSession.current = session != null;
  }, [session]);

  // The open dialog is kept in the store, so it outlives this component.
  // Sign-out swaps the app for the sign-in screen and unmounts it; on sign-in
  // it would mount and reopen whichever settings dialog was showing (#302).
  // Only a request made while this component is mounted opens a dialog.
  useEffect(() => {
    useStore.getState().closeSettingsDialog();
  }, []);

  // Opening either settings dialog closes the account popover.
  useEffect(() => {
    if (settingsDialog) setOpen(false);
  }, [settingsDialog]);

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (signedOut || authPending || !session) {
    // Signed out is still local-first: the identity bar names the local
    // vault you're in (if any) and opens the switcher, so you can hop
    // between local vaults and sign in — not a dead-end "Sign in" button.
    //
    // While auth is PENDING this same bar renders, minus every claim about sync
    // state: the name only, until the restore says who is signed in.
    return (
      <div className="account-menu" ref={rootRef}>
        <LocalVaultSyncRow onTurnOnSync={() => setAuthOpen(true)} />
        {/* Vault switching moved to the sidebar header, leaving signing in as
            the only thing a signed-out account menu could offer — so the bar
            does it directly instead of opening a one-item menu. */}
        <button
          className="identity-bar"
          onClick={() => {
            if (!authPending) setAuthOpen(true);
          }}
          title={
            vault
              ? authPending
                ? vault.name
                : openFolderSynced
                  ? `${vault.name} · Synced vault, signed out`
                  : `${vault.name} · Local`
              : authPending
                ? ""
                : "Sign in to sync & collaborate"
          }
        >
          <span className="identity-avatar signed-out" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <span className="identity-meta">
            <span className="identity-line1">
              {vault?.name ?? (authPending ? "" : "Sign in")}
            </span>
            <span className="identity-line2">
              {authPending
                ? // The restore is still deciding. Anything here would be a
                  // guess, and the wrong guess ("Local · not synced" on a synced
                  // vault) is the one that alarms people.
                  ""
                : vault
                  ? openFolderSynced
                    ? // A synced vault whose session is gone, not a local one —
                      // edits still merge on the next sign-in, and sign-in (not
                      // "turn on sync") is how it comes back online.
                      "Synced · signed out"
                    : "Local · not synced"
                  : "Sync & collaborate"}
            </span>
          </span>
        </button>
        {/* Same rule as VaultPicker: a link-driven prompt mounts its own
            AuthDialog from App.tsx, and two stacked sign-in cards is a bug.
            The prompted one wins while it is up; this one comes back after. */}
        {authOpen && !authPrompt && (
          <Suspense fallback={null}>
            <AuthDialogLazy onClose={() => setAuthOpen(false)} />
          </Suspense>
        )}
        {membersOpen && (
          <Suspense fallback={null}>
            <VaultSettingsDialog
              key={settingsRequest?.token ?? 0}
              onClose={() => closeSettingsDialog("vault")}
              onRequestSignIn={() => setAuthOpen(true)}
              initialTab={settingsTab}
            />
          </Suspense>
        )}
      </div>
    );
  }

  const activeOrg =
    organizations.find((o) => o.id === session.activeOrganizationId) ?? null;
  const userLabel = session.user.name || session.user.email;
  const hasInvites = userInvitations.length > 0;
  // Presence light on the avatar. Connectivity gates it first — no-access is
  // blocked, an in-flight socket is idle. Once we're actually live (synced or
  // read-only), the user's *chosen* availability takes over: online → green,
  // away → amber, busy → red, invisible → appears offline. This is what makes
  // the Settings "Activity status" reflect on your own circle.
  const connected = syncStatus === "synced" || syncStatus === "read-only";
  const presence =
    syncStatus === "no-access"
      ? "blocked"
      : syncStatus === "connecting" || syncStatus === "error" || syncStatus === "too-large"
        ? "idle"
        : connected
          ? // online → "active"; away/busy pass through; invisible → "offline".
            ((t) => (t === "online" ? "active" : t))(statusTone(activityStatus))
          : "offline";
  const presenceLabel =
    presence === "active"
      ? "Active"
      : presence === "away"
        ? "Away"
        : presence === "busy"
          ? "Busy"
          : presence === "idle"
            ? "Idle"
            : presence === "blocked"
              ? "No access"
              : syncEnabled
                ? "Offline"
                : "Local only";

  return (
    <div className="account-menu" ref={rootRef}>
      <LocalVaultSyncRow onTurnOnSync={() => useStore.getState().requestSettings("general")} />
      <div className="identity-row">
        <button
          className={`identity-bar ${open ? "open" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`${userLabel} · ${presenceLabel}${
            syncEnabled && activeOrg ? ` · ${activeOrg.name}` : vault ? ` · ${vault.name}` : ""
          }`}
        >
          <span className="identity-avatar-wrap">
            <LazyAvatar label={userLabel} image={session.user.image} userId={session.user.id} />
            <span className={`presence-light ${presence}`} aria-label={presenceLabel} />
          </span>
          <span className="identity-meta">
            {/* This bar is the profile control — it names its person. The vault's
                name is the sidebar header's job, so repeating it here would just
                say the same thing twice down one column. When the account has no
                display name, line 1 is already the email, so line 2 falls back to
                presence rather than repeating it. */}
            <span className="identity-line1">{userLabel}</span>
            <span className="identity-line2">
              {session.user.name ? session.user.email : presenceLabel}
            </span>
          </span>
          {hasInvites && <span className="identity-alert" aria-label="Pending invitation" />}
        </button>
        {bugReport && (
          <button
            type="button"
            className="icon-btn identity-bug"
            title="Report a bug"
            aria-label="Report a bug"
            aria-haspopup="dialog"
            onClick={() => {
              setOpen(false);
              setBugOpen(true);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 7.5V6a3 3 0 0 1 6 0v1.5" />
              <rect x="7" y="7.5" width="10" height="12" rx="5" />
              <path d="M12 11v8.5M7 13H3.5M20.5 13H17M7.6 9.2 5 7M16.4 9.2 19 7M7.4 17.5 5 19.5M16.6 17.5 19 19.5" />
            </svg>
          </button>
        )}
      </div>
      {bugOpen && <BugReportDialog onClose={() => setBugOpen(false)} />}

      {open && (
        <AccountPopover
          onClose={() => setOpen(false)}
          onOpenAccount={() => {
            useStore.getState().requestAccountSettings("profile");
          }}
        />
      )}
      {membersOpen && (
        <Suspense fallback={null}>
          <VaultSettingsDialog
            key={settingsRequest?.token ?? 0}
            onClose={() => closeSettingsDialog("vault")}
            initialTab={settingsTab}
          />
        </Suspense>
      )}
      {accountOpen && (
        <Suspense fallback={null}>
          <AccountSettings
            key={accountSettingsRequest?.token ?? 0}
            onClose={() => closeSettingsDialog("account")}
            initialTab={accountSettingsTab}
          />
        </Suspense>
      )}
    </div>
  );
}

function AccountPopover({
  onClose,
  onOpenAccount,
}: {
  onClose: () => void;
  onOpenAccount: () => void;
}) {
  const session = useStore((s) => s.session);
  const userInvitations = useStore((s) => s.userInvitations);

  if (!session) return null;

  return (
    // No identity card at the top. The trigger this popover opens from IS the
    // identity card — name, email and avatar, permanently on screen in the
    // sidebar footer — so repeating it here would say what the user is already
    // looking at.
    <div className="account-popover" role="menu">
      {/* Vault items used to live here; point people at their new home. */}
      <div className="menu-moved-note" role="note">
        <MenuIcon>
          <path d="M12 19V5M5 12l7-7 7 7" />
        </MenuIcon>
        <span>
          Vault settings and switching have moved up. Click the vault icon at the
          top of the sidebar.
        </span>
      </div>
      <div className="menu-sep" />
      {userInvitations.length > 0 && (
        <div className="invite-inbox">
          <div className="subhead">You're invited</div>
          {userInvitations.map((inv) => (
            <div key={inv.id} className="invite-row">
              {/* The vault's NAME and the inviter's, not "Vault invitation" with
                  an org id hidden in a title attribute — nobody recognises a
                  vault by its id, and this row is the whole basis for deciding
                  whether to accept. Both fields come from our own
                  /api/invitations/mine; Better Auth's fallback route has
                  neither, hence the plain-language defaults. */}
              <span className="invite-row-meta">
                <span className="invite-row-title">
                  Join {inv.organizationName ?? "a vault"}
                </span>
                <span className="muted">
                  {inv.inviterName ? `invited by ${inv.inviterName} · ` : ""}
                  {inv.role}
                </span>
              </span>
              {/* Accepting is: accept → re-read session → roster → switch into
                  the vault → bind a folder → reconcile. Easily seconds, and it
                  used to be a bare fire-and-forget click with no acknowledgement
                  of any kind. */}
              <AsyncButton
                className="primary sm"
                onClick={async () => {
                  // AsyncButton swallows a rejection, so a refused accept (a
                  // full vault, wrong account) used to do nothing visible.
                  try {
                    await useStore.getState().acceptInvitation(inv.id);
                  } catch (e) {
                    toast(
                      acceptInviteFailureMessage(e, {
                        inviteEmail: inv.email ?? null,
                        sessionEmail: useStore.getState().session?.user.email ?? null,
                      }),
                      "error",
                    );
                  }
                }}
              >
                Accept
              </AsyncButton>
              {/* Declining is a real answer, and without it the only way to
                  clear the row is to join a vault you were never joining. */}
              <AsyncButton
                className="link-btn"
                onClick={async () => {
                  try {
                    await authManager.api.rejectInvitation(inv.id);
                  } finally {
                    await useStore.getState().refreshVault();
                  }
                }}
              >
                Decline
              </AsyncButton>
            </div>
          ))}
        </div>
      )}

      {userInvitations.length > 0 && <div className="menu-sep" />}
      <button className="menu-item" onClick={onOpenAccount}>
        <MenuIcon>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </MenuIcon>
        <span className="menu-item-label">Account settings</span>
        <span className="menu-hint">Profile, status, theme</span>
      </button>
      {/* Shortcuts straight to a page of Account settings, through the same
          request the rest of the app uses (it closes this popover too). */}
      <button
        className="menu-item"
        onClick={() => useStore.getState().requestAccountSettings("appearance")}
      >
        <MenuIcon>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />
        </MenuIcon>
        <span className="menu-item-label">Appearance</span>
        <span className="menu-hint">Theme, colours</span>
      </button>
      <button
        className="menu-item"
        onClick={() => useStore.getState().requestAccountSettings("connection")}
      >
        <MenuIcon>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </MenuIcon>
        <span className="menu-item-label">Connection</span>
        <span className="menu-hint">Server URL</span>
      </button>

      <div className="menu-sep" />
      <button
        className="menu-item danger"
        onClick={() => {
          onClose();
          void useStore.getState().signOut();
        }}
      >
        <MenuIcon>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="M16 17l5-5-5-5M21 12H9" />
        </MenuIcon>
        <span className="menu-item-label">Sign out</span>
      </button>
    </div>
  );
}
