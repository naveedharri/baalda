import { useEffect, useMemo, useRef, useState } from "react";
import {
  type McpToolInfo,
  type McpTokenRow,
  type Member,
  type VaultCheckpoint,
} from "../lib/api";
import { toast } from "../lib/toast";
import { agoFromIso, checkpointTitle, noteCountLabel } from "./versionFormat";
import { ITEM_COLORS, itemColorValue } from "../lib/appearance";
import { authManager } from "../lib/auth/authManager";
import { classifyLimitError, type LimitKind, limitFromError } from "../lib/billing";
import * as ipc from "../lib/ipc";
import type { RecentVault } from "../lib/ipc";
import {
  checkForUpdate,
  currentVersion,
  installUpdate,
  useUpdateState,
} from "../lib/updater";
import { readOrgVaults, useStore } from "../store";
import { configOrgId } from "../lib/vault/rediscover";
import { statusTone } from "../lib/presence/color";
import { AccessPanel } from "./AccessPanel";
import { AccountSettings } from "./AccountSettings";
import { AsyncButton } from "./AsyncButton";
import { canActOnMember } from "./memberRoles";
import { RoleSelect } from "./RoleSelect";
import { Avatar, SyncBadge } from "./Identity";
import { Spinner } from "./Spinner";
import { ThemeToggle } from "./ThemeToggle";
import { UpgradeDialog } from "./UpgradeDialog";

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
        {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} />}
        {membersOpen && (
          <VaultSettingsDialog
            onClose={() => setMembersOpen(false)}
            onRequestSignIn={() => setAuthOpen(true)}
            initialTab={settingsTab}
          />
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
      : syncStatus === "connecting" || syncStatus === "error"
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
          <Avatar label={userLabel} image={session.user.image} />
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
        <VaultSettingsDialog
          onClose={() => setMembersOpen(false)}
          initialTab={settingsTab}
        />
      )}
      {accountOpen && <AccountSettings onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

// How many vault rows the popover spends in total, across both kinds. A fixed
// budget rather than a per-kind cap is what keeps the menu the same height for
// everyone: whoever has vaults fills it. The rest live on the Vaults settings
// page, reached from the Vault settings row at the foot of this menu.
const POPOVER_VAULT_ROWS = 4;

/**
 * Divide the row budget between synced and local vaults: an even split when
 * both kinds can fill their half, otherwise the kind that has vaults takes the
 * space the other one isn't using. Signed out there are no synced vaults, so
 * local takes all four.
 *
 * Deliberately not proportional — someone with 12 synced and 1 local should
 * still see that 1 local vault, because it's the one the split is there to
 * protect. It only loses its slot when it doesn't exist.
 */
export function splitVaultRows(
  syncedCount: number,
  localCount: number,
  budget = POPOVER_VAULT_ROWS,
): { synced: number; local: number } {
  const half = Math.floor(budget / 2);
  // Each kind is guaranteed its half; local then claims whatever synced left
  // unused, and synced claims what's still free after that.
  const local = Math.min(localCount, budget - Math.min(syncedCount, half));
  return { synced: Math.min(syncedCount, budget - local), local };
}

/**
 * Recent on-disk folders that aren't bound to a synced vault — i.e. the
 * user's LOCAL vaults. A vault is one concept in two states; these are
 * the ones that just aren't syncing to an org yet.
 */
function useLocalVaults(nonce = 0): RecentVault[] {
  const [recents, setRecents] = useState<RecentVault[]>([]);
  // Re-fetch when the open folder changes (a switch/open reorders recents) and
  // when `nonce` is bumped (after a local remove/delete removes a row).
  const openPath = useStore((s) => s.vault?.path);
  useEffect(() => {
    let alive = true;
    ipc
      .getRecentVaults()
      .then((l) => {
        if (alive) setRecents(l);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nonce, openPath]);
  const bound = new Set(Object.values(readOrgVaults()));
  return recents.filter((r) => !bound.has(r.path));
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
 * The "On this device" rows: local vaults you can switch to with one click.
 * `limit` caps how many show inline; the rest are reached through the Vault
 * settings row just below, which lists local and synced together — so there's
 * no "All local vaults (N)" link here spending a row to say what the item
 * under it already does. The current local vault is always pinned to the top
 * so it never hides behind the cap.
 */
function LocalVaultRows({
  onClose,
  locals,
  limit,
}: {
  onClose: () => void;
  /** Passed in rather than fetched here: the caller needs the count anyway to
   *  divide the row budget, and two `useLocalVaults()` calls would mean two
   *  IPC round-trips for one list. */
  locals: RecentVault[];
  limit?: number;
}) {
  const vault = useStore((s) => s.vault);
  const syncEnabled = useStore((s) => s.syncEnabled);
  if (locals.length === 0) return null;
  const isCurrentLocal = (path: string) => !syncEnabled && vault?.path === path;
  const ordered = [
    ...locals.filter((r) => isCurrentLocal(r.path)),
    ...locals.filter((r) => !isCurrentLocal(r.path)),
  ];
  const shown = limit ? ordered.slice(0, limit) : ordered;
  return (
    <>
      <div className="menu-label">On this device</div>
      {shown.map((r) => {
        const isCurrent = isCurrentLocal(r.path);
        return (
          <button
            key={r.path}
            className={`menu-item${isCurrent ? " active" : ""}`}
            role="menuitemradio"
            aria-checked={isCurrent}
            title={r.path}
            onClick={() => {
              if (!isCurrent) void useStore.getState().openLocalVault(r.path);
              onClose();
            }}
          >
            <span className="menu-swatch" aria-hidden="true">
              {r.name[0]?.toUpperCase() ?? "?"}
            </span>
            <span className="menu-item-label">{r.name}</span>
            {isCurrent ? (
              <span className="menu-current">Current</span>
            ) : (
              <span className="ws-badge local">Local</span>
            )}
          </button>
        );
      })}
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
  const locals = useLocalVaults();
  // Signed out there are no synced vaults, so local vaults get the whole budget.
  const rows = splitVaultRows(0, locals.length);
  return (
    <div className="account-popover" role="menu">
      {vault && <HomeButton onClose={onClose} />}
      <div className="menu-label">Remote vaults</div>
      <LocalVaultRows onClose={onClose} locals={locals} limit={rows.local} />

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
  const locals = useLocalVaults();

  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!session) return null;
  const rows = splitVaultRows(organizations.length, locals.length);
  const activeOrgId = session.activeOrganizationId;
  const userLabel = session.user.name || session.user.email;
  // "Current" tracks the vault whose folder is actually OPEN right now —
  // not merely the account's active org. After signing in you can be viewing a
  // local folder while an org is active; only one row may read "Current".
  const openPath = vault?.path ?? null;
  const boundVaults = readOrgVaults();

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
    <div className="account-popover" role="menu">
      <div className="menu-account">
        <Avatar label={userLabel} image={session.user.image} />
        <span className="identity-meta">
          <span className="identity-line1">{session.user.name || "—"}</span>
          <span className="identity-line2">{session.user.email}</span>
        </span>
      </div>

      {userInvitations.length > 0 && (
        <div className="invite-inbox">
          <div className="subhead">You're invited</div>
          {userInvitations.map((inv) => (
            <div key={inv.id} className="invite-row">
              <span className="muted" title={inv.organizationId}>
                Vault invitation · {inv.role}
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
            </div>
          ))}
        </div>
      )}

      <div className="menu-sep" />
      {vault && <HomeButton onClose={onClose} />}
      <div className="menu-label">Remote vaults</div>

      {/* Active vault pinned to the top — it's the one you're working in.
          Only the first few show here; the rest live in Vault settings. */}
      {[
        ...organizations.filter((o) => o.id === activeOrgId),
        ...organizations.filter((o) => o.id !== activeOrgId),
      ]
        .slice(0, rows.synced)
        .map((o) => {
        const isActive = openPath != null && boundVaults[o.id] === openPath;
        return (
          <button
            key={o.id}
            className={`menu-item${isActive ? " active" : ""}`}
            role="menuitemradio"
            aria-checked={isActive}
            // Fire-and-forget on purpose: the switch is long and the menu should
            // not sit open through it. The feedback lives in the sidebar header,
            // which renames itself to this vault immediately (`switchingVault`)
            // and spins until the folder has swapped.
            onClick={() => {
              if (!isActive) {
                void useStore.getState().setActiveOrganization(o.id);
              }
              onClose();
            }}
          >
            <span className="menu-swatch" aria-hidden="true">
              {o.name[0]?.toUpperCase() ?? "?"}
            </span>
            <span className="menu-item-label">{o.name}</span>
            {!isActive && <span className="ws-badge synced">Remote</span>}
            {isActive && (
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
            )}
          </button>
        );
      })}

      <LocalVaultRows onClose={onClose} locals={locals} limit={rows.local} />

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

/** Google's four-color "G" mark for the OAuth button. */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.02-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
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

function MenuIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="menu-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Focused sign-in / sign-up modal; closes itself once a session lands. When a
 * caller needs to act on a *successful* sign-in (vs. a cancel), it passes
 * `onSignedIn` — fired instead of `onClose` when the session arrives, so the
 * two outcomes stay distinguishable.
 *
 * `initialMode` picks which tab opens first. It defaults to sign-in, but the
 * welcome screen's "Join a team" route opens on sign-up: someone holding a
 * teammate's join code is usually here for the first time.
 */
export function AuthDialog({
  onClose,
  onSignedIn,
  initialMode = "sign-in",
}: {
  onClose: () => void;
  onSignedIn?: () => void;
  initialMode?: "sign-in" | "sign-up";
}) {
  const authStatus = useStore((s) => s.authStatus);
  const authError = useStore((s) => s.authError);
  const serverUrl = useStore((s) => s.serverUrl);

  const [mode, setMode] = useState<"sign-in" | "sign-up">(initialMode);
  const [name, setName] = useState("");
  // Dev-only prefill of the local test account; production builds ship empty fields.
  const [email, setEmail] = useState(import.meta.env.DEV ? "test@context.local" : "");
  const [password, setPassword] = useState(import.meta.env.DEV ? "Context-Test-2026!" : "");
  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [busy, setBusy] = useState(false);
  // Google sign-in runs in the system browser and the app just waits for the
  // loopback handoff (up to a 3-min timeout). Its own busy flag lets us show a
  // "waiting for your browser" state instead of a silently disabled button.
  const [googleBusy, setGoogleBusy] = useState(false);
  // Google is only offered when the server is configured for it; ask on open
  // (and whenever the server changes) so a self-host without creds hides it.
  const [googleAvailable, setGoogleAvailable] = useState(false);

  useEffect(() => {
    if (authStatus === "signed-in") {
      if (onSignedIn) onSignedIn();
      else onClose();
    }
  }, [authStatus, onClose, onSignedIn]);

  useEffect(() => {
    let cancelled = false;
    authManager.api
      .getAuthMethods()
      .then((m) => {
        if (!cancelled) setGoogleAvailable(m.google);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "sign-in") {
        try {
          await useStore.getState().signIn(email.trim(), password);
        } catch (err) {
          // Dev convenience: the prefilled test account self-provisions on a
          // fresh database instead of dead-ending on "User not found".
          if (import.meta.env.DEV && email.trim() === "test@context.local") {
            await useStore.getState().signUp("Test User", email.trim(), password);
          } else {
            throw err;
          }
        }
      } else {
        await useStore.getState().signUp(name.trim(), email.trim(), password);
      }
      setPassword("");
    } catch {
      /* error surfaced via authError */
    } finally {
      setBusy(false);
    }
  };

  // Each Google attempt gets a generation number. Cancelling (or starting a new
  // attempt) bumps it, so when an abandoned flow finally rejects — the loopback
  // listener waits out its ~3-min timeout — we can drop that stale result instead
  // of flashing a "timed out" error at someone who already moved on.
  const googleFlow = useRef(0);

  const googleSignIn = async () => {
    const flow = ++googleFlow.current;
    useStore.setState({ authError: null });
    setGoogleBusy(true);
    try {
      await useStore.getState().signInWithGoogle();
    } catch (e) {
      if (flow === googleFlow.current) {
        useStore.setState({ authError: e instanceof Error ? e.message : String(e) });
      }
      // else: cancelled or superseded — the user isn't waiting on this anymore.
    } finally {
      if (flow === googleFlow.current) setGoogleBusy(false);
    }
  };

  // Stop waiting on the browser and return to the form so the user can retry or
  // sign in with email instead. The abandoned loopback listener harmlessly times
  // out on its own; its late result is ignored via the generation check above.
  const cancelGoogleSignIn = () => {
    googleFlow.current++;
    setGoogleBusy(false);
    useStore.setState({ authError: null });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal auth-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{mode === "sign-in" ? "Welcome back" : "Create your account"}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="segmented">
          <button
            className={mode === "sign-in" ? "active" : ""}
            onClick={() => setMode("sign-in")}
            type="button"
          >
            Sign in
          </button>
          <button
            className={mode === "sign-up" ? "active" : ""}
            onClick={() => setMode("sign-up")}
            type="button"
          >
            Sign up
          </button>
        </div>

        {googleAvailable && (
          <>
            <button
              type="button"
              className="oauth-btn google"
              onClick={() => void googleSignIn()}
              disabled={busy || googleBusy}
              aria-busy={googleBusy}
            >
              <GoogleGlyph />
              <span>{googleBusy ? "Waiting for your browser…" : "Continue with Google"}</span>
              {googleBusy && <Spinner size="xs" tone="neutral" />}
            </button>
            {googleBusy && (
              <p className="auth-hint">
                <button type="button" className="link-btn" onClick={cancelGoogleSignIn}>
                  Cancel
                </button>
              </p>
            )}
            <div className="auth-divider">
              <span>or</span>
            </div>
          </>
        )}

        <form onSubmit={submit} className="auth-form">
          {mode === "sign-up" && (
            <input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={8}
            required
          />
          <button
            className={`primary${busy ? " is-busy" : ""}`}
            type="submit"
            disabled={busy || googleBusy}
            aria-busy={busy || undefined}
          >
            <span className="async-btn-label">
              {mode === "sign-in" ? "Sign in" : "Create account"}
            </span>
            {busy && <Spinner size="xs" tone="on-accent" />}
          </button>
        </form>

        {authError && <div className="auth-error">{authError}</div>}

        <details className="server-config">
          <summary>Server settings</summary>
          <div className="server-config-body">
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://api.baalda.com"
              spellCheck={false}
            />
            <AsyncButton
              type="button"
              confirm
              onClick={() => useStore.getState().setServerUrl(urlDraft.trim())}
            >
              Save
            </AsyncButton>
          </div>
        </details>
      </div>
    </div>
  );
}

type SettingsTab =
  | "general"
  | "vaults"
  | "members"
  | "billing"
  | "access"
  | "mcp"
  | "versioning"
  | "import-export"
  | "appearance"
  | "updates";

// Sections that only make sense once the vault is synced to an org. On a
// local vault they're shown but locked, with a "Turn on sync" gate.
const TEAM_TABS = new Set<SettingsTab>([
  "members",
  "billing",
  "access",
  "mcp",
  "versioning",
]);

/** General tab: name, folder, and sync state (incl. the Turn-on-sync CTA). */
const GENERAL_TAB: { id: SettingsTab; label: string; icon: React.ReactNode } = {
  id: "general",
  label: "General",
  icon: (
    <MenuIcon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </MenuIcon>
  ),
};

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  {
    id: "vaults",
    label: "Vaults",
    icon: (
      <MenuIcon>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </MenuIcon>
    ),
  },
  {
    id: "members",
    label: "Members",
    icon: (
      <MenuIcon>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </MenuIcon>
    ),
  },
  {
    id: "access",
    label: "Access",
    icon: (
      <MenuIcon>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </MenuIcon>
    ),
  },
  {
    id: "mcp",
    label: "MCP",
    icon: (
      <MenuIcon>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </MenuIcon>
    ),
  },
  {
    id: "versioning",
    label: "Versioning",
    icon: (
      <MenuIcon>
        <path d="M3 12a9 9 0 1 0 2.6-6.4" />
        <path d="M3 4v4h4" />
        <path d="M12 8v4l3 2" />
      </MenuIcon>
    ),
  },
  {
    id: "import-export",
    label: "Import / Export",
    icon: (
      <MenuIcon>
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </MenuIcon>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: (
      <MenuIcon>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a10 10 0 0 1 0 20 5 5 0 0 1 0-10 5 5 0 0 0 0-10" />
      </MenuIcon>
    ),
  },
  {
    id: "updates",
    label: "Updates",
    icon: (
      <MenuIcon>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v5h-5" />
      </MenuIcon>
    ),
  },
];

/** The Billing tab, inserted after Members only when the server has billing on. */
const BILLING_TAB: { id: SettingsTab; label: string; icon: React.ReactNode } = {
  id: "billing",
  label: "Billing",
  icon: (
    <MenuIcon>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </MenuIcon>
  ),
};

/**
 * Vault settings — a dedicated full page (not a modal): everything about
 * the vault lives here. Members (roster + join code + invites),
 * Permissions (RBAC locks), and Appearance (theme + item colors).
 */
function VaultSettingsDialog({
  onClose,
  onRequestSignIn,
  initialTab,
}: {
  onClose: () => void;
  onRequestSignIn?: () => void;
  initialTab?: SettingsTab;
}) {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const billingConfig = useStore((s) => s.billingConfig);
  const vault = useStore((s) => s.vault);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const locals = useLocalVaults();

  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "general");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeOrg =
    organizations.find((o) => o.id === session?.activeOrganizationId) ?? null;
  // Is the vault we're looking at actually syncing to an org? A local
  // vault (signed out, or an unsynced local folder) shows a reduced page
  // with the team sections locked behind "Turn on sync".
  const isSynced = syncEnabled && !!activeOrg;
  const billingEnabled = billingConfig?.enabled === true;

  // "Vaults" (switch/create/manage) is shown for an account OR when there
  // are local folders to list — that's what "View all" opens into.
  const showVaults = !!session || locals.length > 0;
  const tabs = useMemo(() => {
    const out = [GENERAL_TAB];
    if (showVaults) out.push(...SETTINGS_TABS);
    else out.push(...SETTINGS_TABS.filter((t) => t.id !== "vaults"));
    if (billingEnabled) {
      const idx = out.findIndex((t) => t.id === "members");
      out.splice(idx >= 0 ? idx + 1 : out.length, 0, BILLING_TAB);
    }
    return out;
  }, [showVaults, billingEnabled]);

  if (!session && !vault) return null;
  const myMember = members.find((m) => m.userId === session?.user.id);
  const canManage = myMember?.role === "owner" || myMember?.role === "admin";
  const activeTab = tabs.find((t) => t.id === tab) ?? tabs[0];
  const lockedTab = TEAM_TABS.has(activeTab.id) && !isSynced;

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div className="settings-title">
          <span className="settings-eyebrow">
            {isSynced ? "Vault settings" : "Local vault"}
          </span>
          <h1>{activeOrg?.name ?? vault?.name ?? "Vault"}</h1>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          ✕
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map((t) => {
            const locked = TEAM_TABS.has(t.id) && !isSynced;
            return (
              <button
                key={t.id}
                type="button"
                className={`menu-item${tab === t.id ? " active" : ""}${locked ? " locked" : ""}`}
                onClick={() => setTab(t.id)}
                title={locked ? "Turn on sync to unlock" : undefined}
              >
                {t.icon}
                <span className="menu-item-label">{t.label}</span>
                {locked && (
                  <svg
                    className="nav-lock"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                )}
              </button>
            );
          })}
        </nav>

        <section className="settings-content" aria-label={activeTab.label}>
          <h2 className="settings-section-title">{activeTab.label}</h2>
          {tab === "general" ? (
            <GeneralTab
              isSynced={isSynced}
              canManage={canManage}
              activeOrgName={activeOrg?.name ?? null}
              onRequestSignIn={onRequestSignIn}
            />
          ) : lockedTab ? (
            <SyncGate label={activeTab.label} onGoToSync={() => setTab("general")} />
          ) : tab === "vaults" ? (
            <VaultsTab />
          ) : tab === "members" ? (
            <MembersTab canManage={canManage} />
          ) : tab === "billing" ? (
            <BillingTab canManage={canManage} />
          ) : tab === "access" ? (
            <AccessPanel canManage={canManage} />
          ) : tab === "mcp" ? (
            <McpTab />
          ) : tab === "versioning" ? (
            <VersioningTab canManage={canManage} />
          ) : tab === "import-export" ? (
            <ImportExportTab />
          ) : tab === "updates" ? (
            <UpdatesTab />
          ) : (
            <AppearanceTab />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * General tab: the identity of the current vault. Its heart is the
 * Turn-on-sync card for a local vault — which adopts the folder you're
 * already in (files and all) rather than making you set up a new one.
 */
function GeneralTab({
  isSynced,
  canManage,
  activeOrgName,
  onRequestSignIn,
}: {
  isSynced: boolean;
  /** Owner/admin — the only roles that may flip a vault-wide latch. */
  canManage: boolean;
  activeOrgName: string | null;
  onRequestSignIn?: () => void;
}) {
  const vault = useStore((s) => s.vault);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncEnabledState = useStore((s) => s.syncEnabled);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const syncPending = useStore((s) => s.syncPending);
  // The vault's bulk-run counter ("Syncing 128/500"), so this row reports the
  // whole vault's state and not just whether a socket is up.
  const syncProgress = useStore((s) => s.syncProgress);
  const serverUrl = useStore((s) => s.serverUrl);
  const authStatus = useStore((s) => s.authStatus);

  const [name, setName] = useState(vault?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitNudge, setLimitNudge] = useState<{ kind: LimitKind; limit: number | null } | null>(
    null,
  );
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const turnOn = async () => {
    if (authStatus !== "signed-in") {
      // Not signed in yet — launch sign-in right here instead of dead-ending.
      // After sign-in the button becomes "Turn on sync" (the page stays open).
      onRequestSignIn?.();
      return;
    }
    setBusy(true);
    setError(null);
    setLimitNudge(null);
    try {
      await useStore.getState().turnOnSyncForCurrentVault(name.trim() || undefined);
    } catch (e) {
      const kind = classifyLimitError(e);
      if (kind) setLimitNudge({ kind, limit: limitFromError(e) });
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {isSynced ? (
        <>
          <div className="muted">
            This vault syncs to your team. Its notes stay as plain files on
            disk and live-sync to everyone with access.
          </div>
          <div className="menu-row">
            <span className="menu-row-label">Sync</span>
            <SyncBadge
              status={syncStatus}
              enabled={syncEnabledState}
              lastSyncedAt={lastSyncedAt}
              pending={syncPending}
              progress={syncProgress}
            />
          </div>
          <div className="menu-row">
            <span className="menu-row-label">Server</span>
            <code className="vault-root-path" title={serverUrl}>
              {serverUrl}
            </code>
          </div>
        </>
      ) : (
        <>
          <div className="muted">
            {activeOrgName
              ? "You're viewing a local folder. Turn on sync to keep this vault on your account and across devices."
              : "This vault lives only on this computer. Turn on sync to reach it from other devices — or invite people to it."}
          </div>

          <div className="sync-promo">
            <h3 className="sync-promo-title">Turn on sync &amp; sharing</h3>
            <p className="sync-promo-desc">
              Keeps the notes and folders already here — nothing to re-import.
              Enables live collaboration and lets you invite people. Private by
              default; you choose what to share.
            </p>
            <div className="row invite-bar">
              <input
                placeholder="Vault name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void turnOn();
                }}
              />
              <button className="primary" disabled={busy} onClick={() => void turnOn()}>
                {busy
                  ? "…"
                  : authStatus === "signed-in"
                    ? "Turn on sync"
                    : "Sign in to turn on"}
              </button>
            </div>
            {authStatus !== "signed-in" && (
              <div className="muted">You'll need to sign in first — this button will prompt you.</div>
            )}
            {error && <div className="auth-error">{error}</div>}
            {limitNudge && (
              <LimitNudge
                kind={limitNudge.kind}
                limit={limitNudge.limit}
                onUpgrade={() => setUpgradeOpen(true)}
              />
            )}
          </div>
        </>
      )}

      {isSynced && <FreezeRootRow canManage={canManage} />}

      <div className="menu-sep" />
      <div className="subhead">Folder on disk</div>
      <div className="join-code-row">
        <code className="vault-root-path" title={vault?.path ?? ""}>
          {vault?.path ?? "—"}
        </code>
      </div>

      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

/**
 * The "Freeze vault root" latch.
 *
 * A vault's top level is the one place where a stray note or folder is most
 * visible and least recoverable — everyone sees it, and nobody is sure whose it
 * is. Once a team has agreed the top-level shape, this closes it: new notes and
 * folders have to go inside an existing folder.
 *
 * Deliberately applies to EVERYONE, owners and admins included, because the
 * accidental root folder is almost always created by someone who does have
 * permission. Only an owner/admin can lift it; everyone else sees the switch in
 * its real state, disabled, so the rule is visible rather than mysterious.
 */
function FreezeRootRow({ canManage }: { canManage: boolean }) {
  const rootFrozen = useStore((s) => s.rootFrozen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flip = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().setRootFrozen(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="menu-sep" />
      <div className="subhead">Vault structure</div>
      <label className="menu-row toggle-row">
        <span className="menu-row-label">
          Freeze vault root
          <span className="field-hint">
            Stops anything new being created at the top level of this vault —
            new notes and folders have to go inside an existing folder. Applies
            to everyone, including you; only an owner or admin can turn it off.
            Nothing already at the root is moved, renamed, or hidden.
          </span>
        </span>
        <input
          type="checkbox"
          checked={rootFrozen}
          disabled={!canManage || busy}
          title={canManage ? undefined : "Only an owner or admin can change this"}
          onChange={(e) => void flip(e.target.checked)}
        />
      </label>
      {!canManage && (
        <div className="muted">
          {rootFrozen
            ? "This vault's root is frozen. Ask an owner or admin to unfreeze it."
            : "Only an owner or admin can freeze this vault's root."}
        </div>
      )}
      {error && <div className="auth-error">{error}</div>}
    </>
  );
}

/** Locked-section gate shown for a team tab on a local vault. */
function SyncGate({ label, onGoToSync }: { label: string; onGoToSync: () => void }) {
  return (
    <div className="sync-gate">
      <svg
        className="sync-gate-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <h3>{label} unlocks with sync</h3>
      <p className="muted">
        Turn on sync for this vault to invite people, set sharing and
        permissions, and connect AI clients.
      </p>
      <button className="primary" onClick={onGoToSync}>
        Turn on sync &amp; sharing →
      </button>
    </div>
  );
}

/**
 * Vaults: switch between vaults, create/join, and manage where their
 * local folders live. Each vault owns one folder under the managed root;
 * switching swaps the sidebar to that vault's folder and repoints the
 * stable `current` symlink external tools point at.
 */
function VaultsTab() {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const vault = useStore((s) => s.vault);
  const syncEnabled = useStore((s) => s.syncEnabled);
  // Bumped after a local remove/delete so the recents list re-fetches.
  const [localsNonce, setLocalsNonce] = useState(0);
  const locals = useLocalVaults(localsNonce);

  const [root, setRoot] = useState<string | null>(null);
  const [bound, setBound] = useState<Record<string, string>>(() => readOrgVaults());
  const [creating, setCreating] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // orgId whose permanent deletion is awaiting a second confirming click.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // local-vault path whose file deletion is awaiting a second confirming click.
  const [confirmDeleteLocal, setConfirmDeleteLocal] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Free-plan vault-cap hit while creating — shows an upgrade nudge instead.
  const [limitNudge, setLimitNudge] = useState<{ kind: LimitKind; limit: number | null } | null>(
    null,
  );
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ipc
      .getVaultsRoot()
      .then((r) => {
        if (!cancelled) setRoot(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const activeOrgId = session?.activeOrganizationId ?? null;
  // We only know the caller's role for the ACTIVE vault (members are loaded
  // for it alone). On the active row we can therefore hide Delete from
  // non-owners; on other rows we can't tell, so we show it and let the server
  // enforce owner-only (403, surfaced via actionError). `deleteRemoteVault` takes
  // an explicit org id, so deleting a non-active vault works without first
  // switching to it.
  const isActiveOwner =
    members.find((m) => m.userId === session?.user.id)?.role === "owner";
  const canDelete = (orgId: string) =>
    orgId === activeOrgId ? isActiveOwner : true;

  const folderName = (orgId: string): string | null => {
    const p = bound[orgId];
    return p ? (p.split("/").pop() ?? p) : null;
  };

  // The org whose folder is actually open now — the true "Current", vs. merely
  // the account's active org (you can be viewing a local folder with sync off).
  const openPath = vault?.path ?? null;
  const isOpenOrg = (orgId: string) => openPath != null && bound[orgId] === openPath;

  const switchTo = async (orgId: string) => {
    if (busy || isOpenOrg(orgId)) return;
    setBusy(true);
    try {
      await useStore.getState().setActiveOrganization(orgId);
      setBound(readOrgVaults());
    } finally {
      setBusy(false);
    }
  };

  const switchToLocal = async (path: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await useStore.getState().openLocalVault(path);
      setBound(readOrgVaults());
    } finally {
      setBusy(false);
    }
  };

  // Detach a vault from this device only (server data untouched).
  const removeLocal = async (orgId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().removeVaultLocally(orgId);
      setBound(readOrgVaults());
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Permanently delete a vault everywhere (owner only, two-click confirm).
  const deletePermanently = async (orgId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().deleteRemoteVault(orgId);
      setBound(readOrgVaults());
      setConfirmDelete(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Forget a local vault from this device's list (files on disk are kept).
  const removeLocalVaultRow = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().removeLocalVault(path);
      setLocalsNonce((n) => n + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Move a local vault's folder to the OS trash (destructive, two-click confirm).
  const deleteLocalFiles = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().deleteLocalVault(path);
      setConfirmDeleteLocal(null);
      setLocalsNonce((n) => n + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createOrg = async () => {
    if (!orgName.trim()) return;
    setBusy(true);
    setActionError(null);
    setLimitNudge(null);
    try {
      await useStore.getState().createOrganization(orgName.trim());
      setOrgName("");
      setCreating(false);
      setBound(readOrgVaults());
    } catch (e) {
      // A 402 vault-cap rejection becomes an upgrade nudge; anything else is
      // a real error (previously swallowed silently — that was the create bug).
      const kind = classifyLimitError(e);
      if (kind) setLimitNudge({ kind, limit: limitFromError(e) });
      else setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const joinByCode = async () => {
    if (!joinCode.trim()) return;
    setBusy(true);
    setJoinError(null);
    try {
      await useStore.getState().joinVault(joinCode);
      setJoinCode("");
      setJoining(false);
      setBound(readOrgVaults());
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeRoot = async () => {
    try {
      const picked = await ipc.pickVaultsRoot();
      if (picked) setRoot(picked);
    } catch {
      /* picker cancelled/unavailable */
    }
  };

  // Active vault pinned to the top.
  const ordered = [
    ...organizations.filter((o) => o.id === activeOrgId),
    ...organizations.filter((o) => o.id !== activeOrgId),
  ];

  const localsOrdered = [
    ...locals.filter((r) => !syncEnabled && vault?.path === r.path),
    ...locals.filter((r) => !(!syncEnabled && vault?.path === r.path)),
  ];

  return (
    <>
      {session && (
        <>
      <div className="subhead">In this account ({organizations.length})</div>
      <ul className="member-list vault-list">
        {ordered.map((o) => {
          const isActive = isOpenOrg(o.id);
          const fname = folderName(o.id);
          return (
            <li key={o.id}>
              <span className="menu-swatch" aria-hidden="true">
                {o.name[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="member-name">
                {o.name}
                <span className="muted vault-folder">
                  {" "}
                  {fname ? `· ${fname}` : "· folder created on first open"}
                </span>
              </span>
              {confirmDelete === o.id ? (
                <span className="vault-row-actions">
                  <span className="muted">Delete everything?</span>
                  <button
                    className="link-btn"
                    disabled={busy}
                    onClick={() => setConfirmDelete(null)}
                  >
                    Cancel
                  </button>
                  <AsyncButton
                    className="link-btn danger"
                    disabled={busy}
                    onClick={() => deletePermanently(o.id)}
                  >
                    Delete
                  </AsyncButton>
                </span>
              ) : (
                <span className="vault-row-actions">
                  {isActive ? (
                    <span className="member-role">Current</span>
                  ) : (
                    <AsyncButton
                      className="link-btn"
                      disabled={busy}
                      onClick={() => switchTo(o.id)}
                    >
                      Switch
                    </AsyncButton>
                  )}
                  <AsyncButton
                    className="link-btn"
                    disabled={busy}
                    title="Stop syncing this vault here; server data is kept"
                    onClick={() => removeLocal(o.id)}
                  >
                    Remove from device
                  </AsyncButton>
                  {canDelete(o.id) && (
                    <button
                      className="link-btn danger"
                      disabled={busy}
                      title="Permanently delete this vault and all its notes for everyone"
                      onClick={() => {
                        setActionError(null);
                        setConfirmDelete(o.id);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="row vault-tab-actions">
        {creating ? (
          <div className="menu-create-org">
            <input
              autoFocus
              placeholder="Vault name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createOrg();
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <button className="primary sm" disabled={busy} onClick={() => void createOrg()}>
              Create
            </button>
          </div>
        ) : joining ? (
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
          <>
            <button className="link-btn" onClick={() => setCreating(true)}>
              + New vault
            </button>
            <button className="link-btn" onClick={() => setJoining(true)}>
              # Join with code
            </button>
          </>
        )}
      </div>
      {joinError && <div className="auth-error">{joinError}</div>}
      {actionError && <div className="auth-error">{actionError}</div>}
      {limitNudge && (
        <LimitNudge
          kind={limitNudge.kind}
          limit={limitNudge.limit}
          onUpgrade={() => setUpgradeOpen(true)}
        />
      )}
        </>
      )}

      {localsOrdered.length > 0 && (
        <>
          {session && <div className="menu-sep" />}
          <div className="subhead">On this device ({localsOrdered.length})</div>
          <div className="muted">
            Local folders open on this computer. They aren't on your account —
            turn on sync from a vault's settings to reach it elsewhere.
          </div>
          <ul className="member-list vault-list">
            {localsOrdered.map((r) => {
              const isCurrent = !syncEnabled && vault?.path === r.path;
              return (
                <li key={r.path}>
                  <span className="menu-swatch" aria-hidden="true">
                    {r.name[0]?.toUpperCase() ?? "?"}
                  </span>
                  <span className="member-name">
                    {r.name}
                    <span className="muted vault-folder" title={r.path}>
                      {" · Local"}
                    </span>
                  </span>
                  {confirmDeleteLocal === r.path ? (
                    <span className="vault-row-actions">
                      <span className="muted">Delete this vault?</span>
                      <button
                        className="link-btn"
                        disabled={busy}
                        onClick={() => setConfirmDeleteLocal(null)}
                      >
                        Cancel
                      </button>
                      <AsyncButton
                        className="link-btn danger"
                        disabled={busy}
                        onClick={() => deleteLocalFiles(r.path)}
                      >
                        Delete
                      </AsyncButton>
                    </span>
                  ) : (
                    <span className="vault-row-actions">
                      {isCurrent ? (
                        <span className="member-role">Current</span>
                      ) : (
                        <AsyncButton
                          className="link-btn"
                          disabled={busy}
                          onClick={() => switchToLocal(r.path)}
                        >
                          Switch
                        </AsyncButton>
                      )}
                      <button
                        className="link-btn"
                        disabled={busy}
                        title="Remove this folder from the list. Files stay on disk."
                        onClick={() => void removeLocalVaultRow(r.path)}
                      >
                        Remove
                      </button>
                      <button
                        className="link-btn danger"
                        disabled={busy}
                        title="Delete this vault — moves its folder and all its notes to the Trash"
                        onClick={() => {
                          setActionError(null);
                          setConfirmDeleteLocal(r.path);
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {session && (
        <>
          <div className="menu-sep" />
          <div className="subhead">Vault folder location</div>
          <div className="muted">
            New vaults get their own folder here. The active vault is also
            linked at <code>current</code> so tools like Claude Desktop can point at
            one fixed path.
          </div>
          <div className="join-code-row">
            <code className="vault-root-path" title={root ?? ""}>
              {root ?? "…"}
            </code>
            <button className="link-btn" onClick={() => void changeRoot()}>
              Change…
            </button>
          </div>
        </>
      )}

      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

function MembersTab({ canManage }: { canManage: boolean }) {
  const session = useStore((s) => s.session);
  const members = useStore((s) => s.members);
  const pendingInvitations = useStore((s) => s.pendingInvitations);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Invite errors had no home before — surface them here (silent-failure fix).
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [limitNudge, setLimitNudge] = useState<{ kind: LimitKind; limit: number | null } | null>(
    null,
  );
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // Member removal: an inline "Remove → Confirm" per row so it's never one click.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Role changes: no confirm step (reversible, unlike remove), one busy row
  // at a time so a slow server can't interleave two changes.
  const [roleBusyId, setRoleBusyId] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  // The caller's own role in this vault, so we mirror the server's rules and
  // only offer Remove / role changes where they would actually succeed
  // (see memberRoles.ts for the shared matrix).
  const myRole = members.find((m) => m.userId === session?.user.id)?.role;
  const canAct = (m: Member): boolean =>
    canActOnMember({
      canManage,
      myUserId: session?.user.id,
      myRole,
      target: { userId: m.userId, role: m.role },
    });

  const doRemove = async (userId: string) => {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await useStore.getState().removeMember(userId);
      setConfirmRemoveId(null);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  const doChangeRole = async (userId: string, role: "member" | "admin") => {
    setRoleBusyId(userId);
    setRoleError(null);
    try {
      await useStore.getState().updateMemberRole(userId, role);
    } catch (e) {
      setRoleError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleBusyId(null);
    }
  };

  // The vault's shareable join code (owner/admin only; server creates it
  // lazily). Older servers without the endpoint simply hide the section.
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    authManager.api
      .getJoinCode()
      .then((c) => {
        if (!cancelled) setCode(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const invite = async () => {
    if (!inviteEmail.trim()) return;
    setBusy(true);
    setInviteError(null);
    setLimitNudge(null);
    try {
      await useStore.getState().inviteMember(inviteEmail.trim(), inviteRole);
      setInviteEmail("");
    } catch (e) {
      // A 402 member-cap rejection becomes an upgrade nudge; anything else is a
      // real error (this tab had no error slot before — that was the bug).
      const kind = classifyLimitError(e);
      if (kind) setLimitNudge({ kind, limit: limitFromError(e) });
      else setInviteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {canManage && code && (
        <div className="join-code-row">
          <div className="join-code-meta">
            <span className="subhead">Join code</span>
            <span className="muted">
              Teammates pick “Join with code” in their account menu after signing in.
            </span>
          </div>
          <code className="join-code">{code}</code>
          <button className="link-btn" onClick={() => void copyCode()}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      )}
      {canManage && (
        <div className="row invite-bar">
          <input
            type="email"
            placeholder="email@team.com"
            value={inviteEmail}
            autoFocus
            onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void invite();
            }}
          />
          <RoleSelect
            variant="field"
            value={inviteRole}
            onSelect={setInviteRole}
            ariaLabel="Invite role"
          />
          <button className="primary" disabled={busy} onClick={() => void invite()}>
            Invite
          </button>
        </div>
      )}
      {inviteError && <div className="auth-error">{inviteError}</div>}
      {limitNudge && (
        <LimitNudge
          kind={limitNudge.kind}
          limit={limitNudge.limit}
          onUpgrade={() => setUpgradeOpen(true)}
        />
      )}

      <div className="subhead">In this vault ({members.length})</div>
      <ul className="member-list">
        {members.map((m) => {
          const label = m.user?.name || m.user?.email || m.userId;
          return (
            <li key={m.id}>
              <Avatar label={label} />
              <span className="member-name">
                {label}
                {m.userId === session?.user.id && <span className="muted"> (you)</span>}
              </span>
              {canAct(m) && (m.role === "member" || m.role === "admin") ? (
                <RoleSelect
                  variant="pill"
                  value={m.role}
                  disabled={roleBusyId !== null}
                  ariaLabel={`Change role of ${label}`}
                  onSelect={(r) => void doChangeRole(m.userId, r)}
                />
              ) : (
                <span className={`member-role ${m.role}`}>{m.role}</span>
              )}
              {canAct(m) &&
                (confirmRemoveId === m.userId ? (
                  <>
                    <AsyncButton
                      className="link-btn danger"
                      disabled={removeBusy}
                      onClick={() => doRemove(m.userId)}
                    >
                      Confirm
                    </AsyncButton>
                    <button
                      className="link-btn"
                      disabled={removeBusy}
                      onClick={() => setConfirmRemoveId(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="link-btn danger"
                    onClick={() => {
                      setRemoveError(null);
                      setConfirmRemoveId(m.userId);
                    }}
                  >
                    Remove
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {removeError && <div className="auth-error">{removeError}</div>}
      {roleError && <div className="auth-error">{roleError}</div>}

      {pendingInvitations.length > 0 && (
        <>
          <div className="subhead">Invited — awaiting response</div>
          <ul className="member-list">
            {pendingInvitations.map((inv) => (
              <li key={inv.id}>
                <Avatar label={inv.email} />
                <span className="member-name">{inv.email}</span>
                <span className="member-role pending">{inv.role} · pending</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

/**
 * BillingTab: this vault's plan + seat usage (spec 04). Facts are visible to
 * every member (read-only); the Upgrade/Manage actions are gated to owners/admins
 * the same way MembersTab gates its controls. Only rendered when the server has
 * billing enabled (the tab itself is hidden otherwise).
 */
function BillingTab({ canManage }: { canManage: boolean }) {
  const billingConfig = useStore((s) => s.billingConfig);
  const orgBilling = useStore((s) => s.orgBilling);
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refresh seat usage / plan whenever this tab is opened.
  useEffect(() => {
    void useStore.getState().refreshOrgBilling();
  }, []);

  const manage = async () => {
    if (!orgId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await authManager.api.getBillingPortalUrl(orgId);
      await ipc.openExternal(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!billingConfig?.enabled) {
    return (
      <div className="muted perm-empty">Billing isn't enabled on this server.</div>
    );
  }
  if (!orgId) {
    return (
      <div className="muted perm-empty">
        Billing needs an active vault — create or switch to one first.
      </div>
    );
  }
  if (!orgBilling) {
    return <div className="muted">Loading…</div>;
  }

  const isPro = orgBilling.plan === "pro";
  const { members, pendingInvitations, limit } = orgBilling.seats;
  const used = members + pendingInvitations;

  return (
    <>
      {isPro ? (
        <div className="billing-card plan-pro">
          <div className="billing-plan-head">
            <span className="billing-plan-name">Pro</span>
            <span className={`billing-status ${orgBilling.status}`}>
              {orgBilling.status === "past_due"
                ? "Past due"
                : orgBilling.status === "canceled"
                  ? "Canceled"
                  : "Active"}
            </span>
          </div>
          <div className="muted">Everything unlimited on this vault.</div>
          {orgBilling.currentPeriodEnd && (
            <div className="menu-row">
              <span className="menu-row-label">
                {orgBilling.cancelAtPeriodEnd ? "Access until" : "Renews"}
              </span>
              <span>{formatDate(orgBilling.currentPeriodEnd)}</span>
            </div>
          )}
          {orgBilling.cancelAtPeriodEnd && (
            <div className="limit-nudge">
              <span>
                Your subscription is set to cancel at the end of the current period.
              </span>
            </div>
          )}
          {error && <div className="auth-error">{error}</div>}
          {canManage ? (
            <AsyncButton
              className="secondary billing-action"
              disabled={busy}
              onClick={manage}
            >
              Manage subscription
            </AsyncButton>
          ) : (
            <div className="muted">Ask an owner or admin to manage the subscription.</div>
          )}
        </div>
      ) : (
        <div className="billing-card">
          <div className="billing-plan-head">
            <span className="billing-plan-name">Free</span>
          </div>
          <div className="menu-row">
            <span className="menu-row-label">Members</span>
            <span>
              {used} of {limit ?? "∞"}
              {limit != null && used >= limit ? " · full" : ""}
            </span>
          </div>
          {pendingInvitations > 0 && (
            <div className="muted">
              Includes {pendingInvitations} pending invitation
              {pendingInvitations === 1 ? "" : "s"}.
            </div>
          )}

          <div className="subhead">Upgrade to Pro unlocks</div>
          <ul className="upgrade-features">
            <li>Unlimited team members</li>
            <li>Unlimited notes, devices &amp; AI edits</li>
            <li>Doesn't count toward your free vaults</li>
            <li>Priority support</li>
          </ul>

          {error && <div className="auth-error">{error}</div>}
          {canManage ? (
            <button className="primary billing-action" onClick={() => setUpgradeOpen(true)}>
              Upgrade to Pro
            </button>
          ) : (
            <div className="muted">Ask an owner or admin to upgrade this vault.</div>
          )}
        </div>
      )}

      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

/** Compact absolute date for renewal/period-end lines. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Inline upgrade nudge shown in the create-vault / invite-member error slot
 * when the server rejects with a 402 free-plan limit. Styled with --warning-soft
 * (reserved for upgrade nudges), not the danger palette — this isn't an error.
 */
function LimitNudge({
  kind,
  limit,
  onUpgrade,
}: {
  kind: LimitKind;
  limit: number | null;
  onUpgrade: () => void;
}) {
  const freeLimits = useStore((s) => s.billingConfig?.freeLimits);
  // The server is the authority (the 402 carries `limit`, and billingConfig
  // reports both caps); these are last-resort defaults for a nudge rendered
  // before either arrived. They differ per kind — one shared number was right
  // only while the two caps happened to be equal, and would have quietly
  // claimed a 10-seat vault allows 3.
  const n =
    limit ??
    (kind === "member_limit"
      ? (freeLimits?.membersPerVault ?? 10)
      : (freeLimits?.vaultsPerUser ?? 3));
  const message =
    kind === "member_limit"
      ? `Free plan limit reached — this vault allows ${n} member${n === 1 ? "" : "s"}.`
      : `You have ${n} free vault${n === 1 ? "" : "s"}. Upgrade a vault to Pro to create more.`;
  return (
    <div className="limit-nudge">
      <span>{message}</span>
      <button className="link-btn" onClick={onUpgrade}>
        Upgrade →
      </button>
    </div>
  );
}

/**
 * Versioning: the vault-wide safety net. Lists the vault's checkpoints (max 5 —
 * a daily automatic one plus manual ones), and lets an owner OR admin take one
 * and roll the whole vault back to it. Per-note history lives in the editor's
 * version panel; this page is for the blast-radius case ("the reorg went wrong,
 * put everything back").
 *
 * Revert used to be owner-only. It is the recovery half of an action admins
 * could already take (create/delete a checkpoint), so a team whose owner was
 * away could take checkpoints and not use them.
 */
function VersioningTab({ canManage }: { canManage: boolean }) {
  const checkpoints = useStore((s) => s.checkpoints);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<VaultCheckpoint | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void useStore.getState().refreshCheckpoints();
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const create = async () => {
    setError(null);
    try {
      await useStore.getState().createCheckpoint(label);
      setLabel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await useStore.getState().deleteCheckpoint(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const revert = async (cp: VaultCheckpoint) => {
    setError(null);
    try {
      const result = await useStore.getState().revertVaultToCheckpoint(cp.id);
      setConfirming(null);
      toast(
        `Vault reverted — ${result.docsChanged} notes changed, ` +
          `${result.docsRestored} restored, ${result.docsDeleted} removed`,
        "success",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="versioning-tab">
      <div className="muted">
        A checkpoint captures every note in this vault — content and folder
        structure. One is taken automatically each day the vault changes; the
        vault keeps its 5 most recent. Reverting rolls every member's vault back
        and broadcasts live.
      </div>
      <div className="menu-sep" />
      {canManage && (
        <>
          <div className="subhead">Create checkpoint</div>
          <div className="row invite-bar">
            <input
              type="text"
              placeholder="Label (optional) — e.g. Before the big reorg"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <AsyncButton className="primary sm" onClick={create}>
              Create
            </AsyncButton>
          </div>
          <div className="menu-sep" />
        </>
      )}
      <div className="subhead">Checkpoints</div>
      {error && <div className="auth-error">{error}</div>}
      {checkpoints == null ? (
        <div className="muted perm-empty">Loading…</div>
      ) : checkpoints.length === 0 ? (
        <div className="muted perm-empty">
          No checkpoints yet. One is captured automatically within a day of the
          vault changing{canManage ? ", or create one above" : ""}.
        </div>
      ) : (
        <ul className="checkpoint-list">
          {checkpoints.map((cp) => (
            <li key={cp.id} className="checkpoint-row">
              <span className="checkpoint-main">
                <span className="checkpoint-title">
                  {checkpointTitle(cp.label, cp.kind, cp.createdAt, now)}
                </span>
                <span className="checkpoint-sub">
                  {agoFromIso(cp.createdAt, now)} · {noteCountLabel(cp.noteCount)}
                  {cp.createdByName ? ` · by ${cp.createdByName}` : ""}
                </span>
              </span>
              {canManage && (
                <button className="link-btn" onClick={() => setConfirming(cp)}>
                  Revert
                </button>
              )}
              {canManage && (
                <AsyncButton className="link-btn danger" onClick={() => remove(cp.id)}>
                  Delete
                </AsyncButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canManage && (
        <div className="muted checkpoint-note">
          Only a vault owner or admin can revert to a checkpoint.
        </div>
      )}
      {confirming && (
        <div className="modal-backdrop" onClick={() => setConfirming(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Revert the entire vault?</h2>
            </div>
            <p className="muted">
              Every note goes back to{" "}
              <strong>
                {checkpointTitle(
                  confirming.label,
                  confirming.kind,
                  confirming.createdAt,
                  now,
                )}
              </strong>{" "}
              ({agoFromIso(confirming.createdAt, now)}) — content, names and
              folders — for every member, live. Notes created since then are
              moved to trash. Attachments are not reverted. A checkpoint of the
              current state is taken first, so this can be undone.
            </p>
            <div className="banner-actions">
              <button className="secondary" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <AsyncButton
                className="primary danger"
                spinnerTone="on-accent"
                onClick={() => revert(confirming)}
              >
                Revert vault
              </AsyncButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * MCP: expose this vault to AI clients over the Model Context Protocol.
 * The MCP endpoint is part of the same server; a client authenticates with a
 * token minted here and then gets the SAME CRUD access to notes/folders that
 * the signed-in user has (owners/admins see everything; members see what's
 * shared with them). This is where you grab the URL + a token.
 */
function McpTab() {
  const session = useStore((s) => s.session);
  const serverUrl = useStore((s) => s.serverUrl);

  const mcpUrl = `${serverUrl.replace(/\/+$/, "")}/api/mcp`;
  const hasVault = !!session?.activeOrganizationId;

  const [tokens, setTokens] = useState<McpTokenRow[]>([]);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ name: string; token: string } | null>(
    null,
  );
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bumps every 20s so "connected" dots + relative times stay live while open.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!hasVault) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = () =>
      authManager.api
        .listMcpConnections()
        .then(({ tokens, tools }) => {
          if (cancelled) return;
          setTokens(tokens);
          setTools(tools);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    void load();
    // Poll so a connection that goes active/idle while the panel is open shows it.
    const poll = window.setInterval(() => void load(), 20_000);
    const tickle = window.setInterval(() => setTick((n) => n + 1), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tickle);
    };
  }, [hasVault]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await authManager.api.createMcpToken(name.trim() || "MCP token");
      setJustCreated({ name: created.name, token: created.token });
      const { token: _t, ...row } = created;
      setTokens((prev) => [row, ...prev]);
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await authManager.api.revokeMcpToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!hasVault) {
    return (
      <div className="muted perm-empty">
        MCP needs an active vault — create or switch to one first.
      </div>
    );
  }

  const snippet = justCreated
    ? `claude mcp add --transport http context ${mcpUrl} \\\n  --header "Authorization: Bearer ${justCreated.token}"`
    : "";

  return (
    <>
      <div className="muted">
        Connect any MCP-compatible AI client to this vault. It gets the same
        access you do — read, search, create, edit and delete notes and folders.
      </div>

      <div className="subhead">Endpoint URL</div>
      <div className="join-code-row">
        <code className="vault-root-path" title={mcpUrl}>
          {mcpUrl}
        </code>
        <button className="link-btn" onClick={() => void copy(mcpUrl, "url")}>
          {copied === "url" ? "Copied ✓" : "Copy"}
        </button>
      </div>

      <div className="menu-sep" />
      <div className="subhead">Access tokens</div>
      <div className="muted">
        A token authenticates the client and scopes it to you in this vault.
        Add it as an <code>Authorization: Bearer</code> header. Revoke any time.
      </div>

      <div className="row invite-bar">
        <input
          placeholder="Token name, e.g. Claude Desktop"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        <button className="primary" disabled={busy} onClick={() => void create()}>
          Create token
        </button>
      </div>

      {error && <div className="auth-error">{error}</div>}

      {justCreated && (
        <div className="mcp-new-token">
          <div className="subhead">Copy your token now — it won't be shown again</div>
          <div className="join-code-row">
            <code className="join-code mcp-token-value" title={justCreated.token}>
              {justCreated.token}
            </code>
            <button
              className="link-btn"
              onClick={() => void copy(justCreated.token, "token")}
            >
              {copied === "token" ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <div className="muted">Example — add it to Claude Code:</div>
          <div className="join-code-row">
            <code className="mcp-snippet">{snippet}</code>
            <button className="link-btn" onClick={() => void copy(snippet, "snippet")}>
              {copied === "snippet" ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <button className="link-btn" onClick={() => setJustCreated(null)}>
            Done
          </button>
        </div>
      )}

      <div className="menu-sep" />
      <div className="subhead">Connections</div>
      <div className="muted">
        Every token is a connection into this vault. Each reaches the same{" "}
        {tools.length || ""} tools, gated by your access — expand one to see them,
        how active it is, and how much it's been used.
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="muted">No connections yet.</div>
      ) : (
        <ul className="mcp-conn-list">
          {tokens.map((t) => {
            const live = isConnected(t.lastUsedAt);
            const open = expanded === t.id;
            return (
              <li key={t.id} className={`mcp-conn${open ? " open" : ""}`}>
                <div className="mcp-conn-head">
                  <span
                    className={`mcp-dot ${live ? "on" : "off"}`}
                    title={live ? "Connected" : "Disconnected"}
                    aria-hidden="true"
                  />
                  <div className="mcp-conn-main">
                    <div className="mcp-conn-title">
                      {t.name}
                      <span className={`mcp-status ${live ? "on" : "off"}`}>
                        {live ? "Connected" : "Disconnected"}
                      </span>
                    </div>
                    <div className="mcp-conn-sub muted">
                      {clientLabel(t.lastClient)}
                      {" · "}
                      {t.tokenPrefix}
                      {" · "}
                      {t.useCount} {t.useCount === 1 ? "call" : "calls"}
                      {" · "}
                      {t.lastUsedAt ? `last active ${relTime(t.lastUsedAt)}` : "never used"}
                    </div>
                  </div>
                  <button
                    className="link-btn"
                    onClick={() => setExpanded((e) => (e === t.id ? null : t.id))}
                  >
                    {open ? "Hide tools" : `Tools · ${tools.length}`}
                  </button>
                  <AsyncButton
                    className="link-btn danger"
                    disabled={busy}
                    onClick={() => revoke(t.id)}
                  >
                    Revoke
                  </AsyncButton>
                </div>
                {open && (
                  <ul className="mcp-tool-list">
                    {tools.map((tool) => (
                      <li key={tool.name} title={tool.description}>
                        <span className={`mcp-tool-badge ${tool.access}`}>
                          {tool.access === "read"
                            ? "read"
                            : tool.access === "destructive"
                              ? "delete"
                              : "write"}
                        </span>
                        <code>{tool.name}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** A connection is "active" when it made a request in the last few minutes
 *  (MCP here is stateless HTTP — there's no socket to watch, so recency is it). */
const CONNECTED_WINDOW_MS = 3 * 60 * 1000;
function isConnected(lastUsedAt: string | null): boolean {
  if (!lastUsedAt) return false;
  return Date.now() - new Date(lastUsedAt).getTime() < CONNECTED_WINDOW_MS;
}

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", else a date. */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Best-effort human name for a client from its User-Agent. */
function clientLabel(ua: string | null): string {
  if (!ua) return "Unknown client";
  const s = ua.toLowerCase();
  if (s.includes("claude-code") || s.includes("claude code")) return "Claude Code";
  if (s.includes("claude")) return "Claude";
  if (s.includes("cursor")) return "Cursor";
  if (s.includes("node")) return "Node client";
  // Fall back to the leading token of the UA (e.g. "MyApp/1.2" → "MyApp").
  return ua.split(/[\s/]/)[0].slice(0, 40) || "Unknown client";
}

/**
 * Appearance: theme plus the vault's folder/note colors. Colors are assigned
 * from each item's ⋯ menu in the sidebar; this tab reviews and clears them.
 */
/**
 * Updates tab — shows the running version and lets the user check for and
 * install a newer release on demand. The launch-time check populates the same
 * shared updater state, so if an update was already found this reflects it.
 */
function UpdatesTab() {
  const update = useUpdateState();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void currentVersion().then(setVersion);
  }, []);

  const busy = update.phase === "checking" ||
    update.phase === "downloading" ||
    update.phase === "installing";

  // A single status line that stays mounted across phases so the card never
  // reflows (and the button never jumps) as the check progresses. The button
  // keeps one fixed label + width; the spinner and this line carry the state.
  let statusText: string | null = null;
  let statusError = false;
  switch (update.phase) {
    case "checking":
      statusText = "Checking for updates…";
      break;
    case "uptodate":
      statusText = "You're on the latest version.";
      break;
    case "available":
      statusText = "An update is available.";
      break;
    case "downloading":
      statusText = update.total > 0
        ? `Downloading ${update.version} — ${Math.round((update.downloaded / update.total) * 100)}%`
        : `Downloading ${update.version}…`;
      break;
    case "installing":
      statusText = `Installing ${update.version} — the app will restart…`;
      break;
    case "error":
      statusText = `Couldn't check for updates: ${update.message}`;
      statusError = true;
      break;
  }

  return (
    <div className="updates-tab">
      <div className="menu-row">
        <span className="menu-row-label">Current version</span>
        <span className="mono">{version ?? "…"}</span>
      </div>

      <div className="update-actions">
        <button
          className="primary sm update-check-btn"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void checkForUpdate()}
        >
          {busy && <span className="btn-spinner" aria-hidden="true" />}
          <span>Check for updates</span>
        </button>

        <span
          className={`update-status${statusError ? " error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {statusText}
        </span>
      </div>

      {update.phase === "available" && (
        <div className="update-detail">
          <div className="subhead">Version {update.version} available</div>
          {update.notes && <div className="muted release-notes">{update.notes}</div>}
          <AsyncButton className="primary sm" onClick={() => installUpdate()}>
            Install &amp; Restart
          </AsyncButton>
        </div>
      )}
    </div>
  );
}

const APPEARANCE_ICON = {
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
};

function importSummaryText(s: ipc.ImportSummary): string {
  const parts = [`Imported ${s.files} file${s.files === 1 ? "" : "s"}`];
  if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
  return parts.join(" · ") + ".";
}

/**
 * Import / Export — vault-level data operations on the open local vault. Imports
 * land at the vault root; exports copy out to a chosen folder. The same commands
 * back the sidebar ⋮ menu and drag-and-drop, so behavior is identical everywhere.
 */
function ImportExportTab() {
  const [busy, setBusy] = useState<null | "files" | "folder" | "export">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    await useStore.getState().refreshTree();
    await useStore.getState().refreshTitles();
  }

  async function run(
    kind: "files" | "folder" | "export",
    fn: () => Promise<string | null>,
  ) {
    setBusy(kind);
    setError(null);
    setMsg(null);
    try {
      const result = await fn();
      if (result) setMsg(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const importFiles = () =>
    run("files", async () => {
      // Captured before the native picker — a vault switch while it is open must
      // not redirect the import into the vault the user landed in.
      const epoch = useStore.getState().vault?.epoch;
      const sources = await ipc.pickFiles();
      if (!sources || sources.length === 0) return null;
      const summary = await ipc.importPaths("", sources, epoch);
      await refresh();
      return importSummaryText(summary);
    });

  const importFolder = () =>
    run("folder", async () => {
      const epoch = useStore.getState().vault?.epoch; // before the dialog
      const src = await ipc.pickFolder();
      if (!src) return null;
      const summary = await ipc.importPaths("", [src], epoch);
      await refresh();
      return importSummaryText(summary);
    });

  const exportVault = () =>
    run("export", async () => {
      const epoch = useStore.getState().vault?.epoch; // before the dialog
      const dest = await ipc.pickFolder();
      if (!dest) return null;
      await ipc.exportPath("", dest, epoch);
      return "Exported the vault.";
    });

  return (
    <div className="io-tab">
      <section className="io-section">
        <h3 className="io-heading">Import</h3>
        <p className="io-desc">
          Bring existing files and folders into this vault — any format. Markdown and text
          become notes; everything else is kept as-is, with its folder structure. Existing
          names are never overwritten.
        </p>
        <div className="io-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void importFiles()}>
            {busy === "files" ? "Importing…" : "Import files…"}
          </button>
          <button className="primary" disabled={busy !== null} onClick={() => void importFolder()}>
            {busy === "folder" ? "Importing…" : "Import folder…"}
          </button>
        </div>
        <p className="io-hint">
          You can also right-click any folder in the sidebar, or drag files straight onto it.
        </p>
      </section>

      <section className="io-section">
        <h3 className="io-heading">Export</h3>
        <p className="io-desc">
          Save a copy of this whole vault to a folder on your computer. The hidden{" "}
          <code>.context</code> index is skipped.
        </p>
        <div className="io-actions">
          <button className="primary" disabled={busy !== null} onClick={() => void exportVault()}>
            {busy === "export" ? "Exporting…" : "Export entire vault…"}
          </button>
        </div>
      </section>

      {error ? (
        <div className="auth-error">{error}</div>
      ) : (
        msg && <div className="io-result">{msg}</div>
      )}
    </div>
  );
}

function AppearanceTab() {
  const itemColors = useStore((s) => s.itemColors);
  const tree = useStore((s) => s.tree);

  // Flatten the vault into indented rows, same order as the sidebar.
  const items = useMemo(() => {
    const out: Array<{ path: string; name: string; depth: number; isDir: boolean }> = [];
    const walk = (n: ipc.TreeNode, depth: number) => {
      out.push({
        path: n.path,
        name: n.isDir ? n.name : n.name.replace(/\.(md|html?)$/i, ""),
        depth,
        isDir: n.isDir,
      });
      n.children?.forEach((c) => walk(c, depth + 1));
    };
    tree?.children?.forEach((c) => walk(c, 0));
    return out;
  }, [tree]);

  const coloredCount = items.filter((i) => itemColors[i.path]).length;

  return (
    <>
      <div className="menu-row">
        <span className="menu-row-label">Theme</span>
        <ThemeToggle />
      </div>

      <div className="subhead">Folder &amp; note colors</div>
      <div className="muted">
        Color-code your sidebar: click a swatch to tint that folder or note. Colors are saved
        with this device's vault settings.
      </div>

      {items.length === 0 ? (
        <div className="muted perm-empty">Open a vault to color its folders and notes.</div>
      ) : (
        <>
          <ul className="appearance-list">
            {items.map((item) => {
              const active = itemColors[item.path];
              return (
                <li
                  key={item.path}
                  className="appearance-row"
                  style={{ paddingLeft: `${12 + item.depth * 16}px` }}
                >
                  <span
                    className="appearance-glyph"
                    style={{ color: itemColorValue(active) }}
                    aria-hidden="true"
                  >
                    {item.isDir ? APPEARANCE_ICON.folder : APPEARANCE_ICON.note}
                  </span>
                  <span className="appearance-name" title={item.path}>
                    {item.name}
                  </span>
                  <span className="appearance-swatches" role="radiogroup" aria-label={`Color for ${item.name}`}>
                    <button
                      type="button"
                      className={`swatch clear${!active ? " on" : ""}`}
                      title="Default"
                      aria-label="Default color"
                      onClick={() => useStore.getState().setItemColor(item.path, null)}
                    />
                    {ITEM_COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`swatch${active === c.id ? " on" : ""}`}
                        style={{ backgroundColor: c.value }}
                        title={c.label}
                        aria-label={c.label}
                        onClick={() => useStore.getState().setItemColor(item.path, c.id)}
                      />
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
          {coloredCount > 0 && (
            <button
              className="link-btn"
              onClick={() => {
                const { itemColors: colors, setItemColor } = useStore.getState();
                Object.keys(colors).forEach((path) => setItemColor(path, null));
              }}
            >
              Clear all colors ({coloredCount})
            </button>
          )}
        </>
      )}
    </>
  );
}
