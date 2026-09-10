import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import type { RecentVault } from "../lib/ipc";
import { readOrgVaults, useStore } from "../store";
import {
  POPOVER_VAULT_ROWS,
  recentVaultRows,
  type VaultRow,
} from "../lib/vaultRows";
import { configOrgId } from "../lib/vault/rediscover";
import { authManager } from "../lib/auth/authManager";
import { statusTone } from "../lib/presence/color";
import { useLocalVaults, useRecentVaults } from "./useVaultLists";
import { AsyncButton } from "./AsyncButton";
import { LazyAvatar } from "./Face";
import { MenuIcon } from "./MenuIcon";

/* The settings surface is a whole second app (nine tabs, billing, MCP tokens,
   access) and nothing in it is on the first screen, so all three dialogs load
   on demand. `null` is the right fallback for a modal: the popover stays put
   and the sheet arrives a beat later. */
import type { SettingsTab } from "./VaultSettingsDialog";
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
 * Account & vault menu (spec 04 §2/§6/§7), redesigned as the standard
 * desktop-app identity flow: the sidebar footer is a single compact identity
 * bar (avatar + vault + sync dot). Clicking it opens a popover menu with
 * the vault switcher, sync state, theme, server settings and sign-out.
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

  const [open, setOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  // Which settings tab the vault page should open on (View all → Vaults).
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [accountOpen, setAccountOpen] = useState(false);
  // Signed out with a folder open: is that folder actually a SYNCED vault
  // (its `.context/config.json` is stamped with a vault id)? Labeling it
  // "Local · not synced" is factually wrong — the edits made here will merge
  // into the vault on the next sign-in — and it hides that signing in is the
  // way to bring it back online. Peeked from disk because the localStorage
  // caches may be gone while the folder still knows whose it is.
  const [openFolderSynced, setOpenFolderSynced] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const signedOut = authStatus !== "signed-in" || !session;
  const vaultPath = vault?.path ?? null;
  useEffect(() => {
    if (!signedOut || !vaultPath) {
      setOpenFolderSynced(false);
      return;
    }
    let alive = true;
    void ipc
      .peekVaultConfig(vaultPath)
      .then((raw) => {
        if (alive) setOpenFolderSynced(configOrgId(raw) !== null);
      })
      .catch(() => {
        if (alive) setOpenFolderSynced(false);
      });
    return () => {
      alive = false;
    };
  }, [signedOut, vaultPath]);

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

  if (authStatus !== "signed-in" || !session) {
    // Signed out is still local-first: the identity bar names the local
    // vault you're in (if any) and opens the switcher, so you can hop
    // between local vaults and sign in — not a dead-end "Sign in" button.
    return (
      <div className="account-menu" ref={rootRef}>
        <button
          className={`identity-bar ${open ? "open" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={
            vault
              ? openFolderSynced
                ? `${vault.name} · Synced vault, signed out`
                : `${vault.name} · Local`
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
            <span className="identity-line1">{vault?.name ?? "Sign in"}</span>
            <span className="identity-line2">
              {vault
                ? openFolderSynced
                  ? // A synced vault whose session is gone, not a local one —
                    // edits still merge on the next sign-in, and sign-in (not
                    // "turn on sync") is how it comes back online.
                    "Synced · signed out"
                  : "Local · not synced"
                : "Sync & collaborate"}
            </span>
          </span>
          <span className="identity-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        {open && (
          <SignedOutPopover
            onClose={() => setOpen(false)}
            onSignIn={() => {
              setOpen(false);
              setAuthOpen(true);
            }}
            onOpenSettings={() => {
              setOpen(false);
              setSettingsTab(undefined);
              setMembersOpen(true);
            }}
          />
        )}
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
              onClose={() => setMembersOpen(false)}
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
          <LazyAvatar label={userLabel} image={session.user.image} />
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
        <span className="identity-chevron" aria-hidden="true">
          ›
        </span>
      </button>

      {open && (
        <AccountPopover
          onClose={() => setOpen(false)}
          onOpenMembers={() => {
            setOpen(false);
            setSettingsTab(undefined);
            setMembersOpen(true);
          }}
          onOpenAccount={() => {
            setOpen(false);
            setAccountOpen(true);
          }}
        />
      )}
      {membersOpen && (
        <Suspense fallback={null}>
          <VaultSettingsDialog
            onClose={() => setMembersOpen(false)}
            initialTab={settingsTab}
          />
        </Suspense>
      )}
      {accountOpen && (
        <Suspense fallback={null}>
          <AccountSettings onClose={() => setAccountOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** Native-pick a folder and open it as a local vault, then close the menu. */
/**
 * "New vault": name it, and it's created under the vaults root.
 *
 * Name-only, matching the welcome screen. Asking which folder was a question
 * with one sensible answer — every vault we create lives under the same root,
 * and a vault's folder is just `slugify(its name)`. Adopting a folder you
 * already have is "Open existing" on the welcome screen, which keeps that
 * folder exactly where it is.
 *
 * Inline rather than a dialog: it's one field, and the menu is already open.
 */
function NewVaultItem({ onDone }: { onDone: () => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const root = await ipc.getVaultsRoot();
      const v = await ipc.createVault(root, trimmed);
      // `seed`: a just-created vault gets first-run starter content (adopting
      // an existing folder never does).
      await useStore.getState().adoptOpenedVault(v, { seed: true });
      setName("");
      setNaming(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!naming) {
    return (
      <button className="menu-item subtle" onClick={() => setNaming(true)}>
        <span className="menu-swatch plus" aria-hidden="true">
          +
        </span>
        <span className="menu-item-label">New vault</span>
      </button>
    );
  }

  return (
    <>
      <div className="menu-create-org">
        <input
          autoFocus
          placeholder="Vault name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
            if (e.key === "Escape") {
              setNaming(false);
              setName("");
            }
          }}
        />
        <button className="primary sm" disabled={busy || !name.trim()} onClick={() => void create()}>
          Create
        </button>
      </div>
      {error && <div className="auth-error">{error}</div>}
    </>
  );
}

/**
 * The vault switcher's rows: every vault you can switch to with one click,
 * newest-opened first, capped at four (`recentVaultRows` explains why they're
 * one list rather than two). The rest are on the Vaults settings page, reached
 * through the Vault settings row just below — so there's no "All vaults (N)"
 * link here spending a row to say what the item under it already does.
 */
function VaultRows({
  onClose,
  organizations,
  recents,
  locals,
  budget = POPOVER_VAULT_ROWS,
}: {
  onClose: () => void;
  organizations: readonly { id: string; name: string }[];
  /** The full recents list — where a synced vault's last-opened time comes from. */
  recents: readonly RecentVault[];
  /** Passed in rather than fetched here: the caller already has the list, and
   *  a second `useLocalVaults()` would mean a second IPC round-trip for it. */
  locals: readonly RecentVault[];
  budget?: number;
}) {
  const openPath = useStore((s) => s.vault?.path) ?? null;
  const rows = useMemo(
    () =>
      recentVaultRows({
        organizations,
        locals,
        orgVaults: readOrgVaults(),
        openedAt: Object.fromEntries(recents.map((r) => [r.path, r.openedAt])),
        openPath,
        budget,
      }),
    [organizations, locals, recents, openPath, budget],
  );
  if (rows.length === 0) return null;

  const open = (row: VaultRow) => {
    if (!row.current) {
      if (row.kind === "synced") {
        // Fire-and-forget on purpose: the switch is long and the menu should
        // not sit open through it. The feedback lives in the sidebar header,
        // which renames itself to this vault immediately (`switchingVault`)
        // and spins until the folder has swapped.
        void useStore.getState().setActiveOrganization(row.orgId);
      } else {
        void useStore.getState().openLocalVault(row.path);
      }
    }
    onClose();
  };

  return (
    <>
      <div className="menu-label">Baalda Vaults</div>
      {rows.map((row) => (
        <button
          key={row.key}
          className={`menu-item${row.current ? " active" : ""}`}
          role="menuitemradio"
          aria-checked={row.current}
          title={row.kind === "local" ? row.path : undefined}
          onClick={() => open(row)}
        >
          <span className="menu-swatch" aria-hidden="true">
            {row.name[0]?.toUpperCase() ?? "?"}
          </span>
          <span className="menu-item-label">{row.name}</span>
          {row.current ? (
            <>
              <span className="menu-current">Current</span>
              <svg
                className="menu-check"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </>
          ) : row.kind === "synced" ? (
            <span className="ws-badge synced">Remote</span>
          ) : (
            <span className="ws-badge local">Local</span>
          )}
        </button>
      ))}
    </>
  );
}

/**
 * Signed-out switcher. Local-first: you can hop between local vaults and
 * open/create folders without an account; signing in is one item in the menu,
 * not the only thing you can do.
 */
function SignedOutPopover({
  onClose,
  onSignIn,
  onOpenSettings,
}: {
  onClose: () => void;
  onSignIn: () => void;
  onOpenSettings: () => void;
}) {
  const vault = useStore((s) => s.vault);
  const recents = useRecentVaults();
  const locals = useLocalVaults();
  return (
    <div className="account-popover" role="menu">
      {vault && <HomeButton onClose={onClose} />}
      {/* Signed out there are no vaults in an account, so local folders get
          the whole budget. */}
      <VaultRows onClose={onClose} organizations={[]} recents={recents} locals={locals} />

      <NewVaultItem onDone={onClose} />

      {vault && (
        <button className="menu-item" onClick={onOpenSettings}>
          <MenuIcon>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </MenuIcon>
          <span className="menu-item-label">Vault settings</span>
          <span className="menu-hint">Turn on sync</span>
        </button>
      )}

      <div className="menu-sep" />
      <button className="menu-item" onClick={onSignIn}>
        <MenuIcon>
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <path d="M10 17l5-5-5-5M15 12H3" />
        </MenuIcon>
        <span className="menu-item-label">Sign in</span>
        <span className="menu-hint">Sync &amp; collaborate</span>
      </button>
    </div>
  );
}

function AccountPopover({
  onClose,
  onOpenMembers,
  onOpenAccount,
}: {
  onClose: () => void;
  onOpenMembers: () => void;
  onOpenAccount: () => void;
}) {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const pendingInvitations = useStore((s) => s.pendingInvitations);
  const userInvitations = useStore((s) => s.userInvitations);
  const vault = useStore((s) => s.vault);
  const recents = useRecentVaults();
  const locals = useLocalVaults();

  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!session) return null;
  const activeOrgId = session.activeOrganizationId;

  const joinByCode = async () => {
    if (!joinCode.trim()) return;
    setBusy(true);
    setJoinError(null);
    try {
      await useStore.getState().joinVault(joinCode);
      setJoinCode("");
      setJoining(false);
      onClose();
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // No identity card at the top. The trigger this popover opens from IS the
    // identity card — name, email and avatar, permanently on screen in the
    // sidebar footer — so repeating it here spent the most valuable row in the
    // menu saying something the user was already looking at. Home takes that
    // row instead: it's the one destination, and it was previously buried
    // below the fold on an account with several vaults.
    <div className="account-popover" role="menu">
      {vault && <HomeButton onClose={onClose} />}

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
                onClick={() => useStore.getState().acceptInvitation(inv.id)}
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

      <div className="menu-sep" />
      <VaultRows
        onClose={onClose}
        organizations={organizations}
        recents={recents}
        locals={locals}
      />

      <NewVaultItem onDone={onClose} />

      {/* Teammates join with the code shared from Vault settings. */}
      {joining ? (
        <div className="menu-create-org">
          <input
            autoFocus
            placeholder="Join code, e.g. K7MPX2RA"
            value={joinCode}
            spellCheck={false}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") void joinByCode();
              if (e.key === "Escape") setJoining(false);
            }}
          />
          <button className="primary sm" disabled={busy} onClick={() => void joinByCode()}>
            Join
          </button>
        </div>
      ) : (
        <button className="menu-item subtle" onClick={() => setJoining(true)}>
          <span className="menu-swatch plus" aria-hidden="true">
            #
          </span>
          <span className="menu-item-label">Join with code</span>
        </button>
      )}
      {joinError && <div className="auth-error">{joinError}</div>}

      {vault && (
        <button className="menu-item" onClick={onOpenMembers}>
          <MenuIcon>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </MenuIcon>
          <span className="menu-item-label">Vault settings</span>
          {activeOrgId ? (
            <span className="menu-hint">
              {members.length} member{members.length === 1 ? "" : "s"}
              {pendingInvitations.length > 0 ? ` +${pendingInvitations.length}` : ""}
            </span>
          ) : (
            <span className="ws-badge local">Local</span>
          )}
        </button>
      )}

      <div className="menu-sep" />

      <button className="menu-item" onClick={onOpenAccount}>
        <MenuIcon>
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </MenuIcon>
        <span className="menu-item-label">Account settings</span>
        <span className="menu-hint">Profile, status, theme</span>
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

/**
 * Close the open vault and return to the welcome (home) screen. A full menu
 * row like its siblings (a corner icon on the section label read as cramped) —
 * before this, the welcome screen was unreachable once any vault was open.
 */
function HomeButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      className="menu-item"
      onClick={() => {
        useStore.getState().closeLocalVault();
        onClose();
      }}
    >
      <MenuIcon>
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M9 22V12h6v10" />
      </MenuIcon>
      <span className="menu-item-label">Home</span>
      <span className="menu-hint">Close vault</span>
    </button>
  );
}


