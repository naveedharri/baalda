import { useEffect, useMemo, useRef, useState } from "react";
import { type McpToolInfo, type McpTokenRow, type Member } from "../lib/api";
import { ITEM_COLORS, itemColorValue } from "../lib/appearance";
import { authManager } from "../lib/auth/authManager";
import { classifyLimitError, type LimitKind, limitFromError } from "../lib/billing";
import * as ipc from "../lib/ipc";
import {
  checkForUpdate,
  currentVersion,
  installUpdate,
  useUpdateState,
} from "../lib/updater";
import { readOrgVaults, useStore } from "../store";
import { AccessPanel } from "./AccessPanel";
import { AccountSettings } from "./AccountSettings";
import { Avatar, SyncBadge } from "./Identity";
import { ThemeToggle } from "./ThemeToggle";
import { UpgradeDialog } from "./UpgradeDialog";

/**
 * Account & workspace menu (spec 04 §2/§6/§7), redesigned as the standard
 * desktop-app identity flow: the sidebar footer is a single compact identity
 * bar (avatar + workspace + sync dot). Clicking it opens a popover menu with
 * the workspace switcher, sync state, theme, server settings and sign-out.
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

  const [open, setOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    return (
      <div className="account-menu" ref={rootRef}>
        <button className="identity-bar" onClick={() => setAuthOpen(true)}>
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
            <span className="identity-line1">Sign in</span>
            <span className="identity-line2">Sync &amp; collaborate</span>
          </span>
          <span className="identity-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} />}
      </div>
    );
  }

  const activeOrg =
    organizations.find((o) => o.id === session.activeOrganizationId) ?? null;
  const userLabel = session.user.name || session.user.email;
  const hasInvites = userInvitations.length > 0;
  // Presence light on the avatar: green = live, amber = getting there, grey = offline.
  const presence =
    syncStatus === "synced" || syncStatus === "read-only"
      ? "active"
      : syncStatus === "connecting" || syncStatus === "error"
        ? "idle"
        : syncStatus === "no-access"
          ? "blocked"
          : "offline";
  const presenceLabel =
    presence === "active"
      ? "Active"
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
        title={`${userLabel} · ${presenceLabel}${activeOrg ? ` · ${activeOrg.name}` : ""}`}
      >
        <span className="identity-avatar-wrap">
          <Avatar label={userLabel} image={session.user.image} />
          <span className={`presence-light ${presence}`} aria-label={presenceLabel} />
        </span>
        <span className="identity-meta">
          <span className="identity-line1">{activeOrg?.name ?? userLabel}</span>
          <span className="identity-line2">
            {activeOrg ? userLabel : "No workspace yet"}
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
            setMembersOpen(true);
          }}
          onOpenAccount={() => {
            setOpen(false);
            setAccountOpen(true);
          }}
        />
      )}
      {membersOpen && <WorkspaceSettingsDialog onClose={() => setMembersOpen(false)} />}
      {accountOpen && <AccountSettings onClose={() => setAccountOpen(false)} />}
    </div>
  );
}

// How many workspaces the popover shows inline (the current one + a couple of
// recents). Anything past this lives on the Workspaces settings page so a long
// account list never turns the menu into a scroll trap.
const POPOVER_WORKSPACE_LIMIT = 3;

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
  const syncStatus = useStore((s) => s.syncStatus);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const syncPending = useStore((s) => s.syncPending);

  const [creating, setCreating] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!session) return null;
  const activeOrgId = session.activeOrganizationId;
  const userLabel = session.user.name || session.user.email;

  const createOrg = async () => {
    if (!orgName.trim()) return;
    setBusy(true);
    setCreateError(null);
    try {
      await useStore.getState().createOrganization(orgName.trim());
      setOrgName("");
      setCreating(false);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const joinByCode = async () => {
    if (!joinCode.trim()) return;
    setBusy(true);
    setJoinError(null);
    try {
      await useStore.getState().joinWorkspace(joinCode);
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
                Workspace invitation · {inv.role}
              </span>
              <button
                className="primary sm"
                onClick={() => void useStore.getState().acceptInvitation(inv.id)}
              >
                Accept
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="menu-sep" />
      <div className="menu-label">Workspace</div>

      {/* Active workspace pinned to the top — it's the one you're working in.
          Only the first few show here; the rest live in Workspace settings. */}
      {[
        ...organizations.filter((o) => o.id === activeOrgId),
        ...organizations.filter((o) => o.id !== activeOrgId),
      ]
        .slice(0, POPOVER_WORKSPACE_LIMIT)
        .map((o) => {
        const isActive = o.id === activeOrgId;
        return (
          <button
            key={o.id}
            className={`menu-item${isActive ? " active" : ""}`}
            role="menuitemradio"
            aria-checked={isActive}
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

      {organizations.length > POPOVER_WORKSPACE_LIMIT && (
        <button className="menu-item subtle" onClick={onOpenMembers}>
          <span className="menu-swatch more" aria-hidden="true">
            …
          </span>
          <span className="menu-item-label">
            All workspaces ({organizations.length})
          </span>
        </button>
      )}

      {creating ? (
        <>
          <div className="menu-create-org">
            <input
              autoFocus
              placeholder="Workspace name"
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
          {createError && <div className="auth-error">{createError}</div>}
        </>
      ) : (
        <button className="menu-item subtle" onClick={() => setCreating(true)}>
          <span className="menu-swatch plus" aria-hidden="true">
            +
          </span>
          <span className="menu-item-label">New workspace</span>
        </button>
      )}

      {/* Teammates join with the code shared from Workspace settings. */}
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

      {activeOrgId && (
        <>
          <button className="menu-item" onClick={onOpenMembers}>
            <MenuIcon>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </MenuIcon>
            <span className="menu-item-label">Workspace settings</span>
            <span className="menu-hint">
              {members.length} member{members.length === 1 ? "" : "s"}
              {pendingInvitations.length > 0 ? ` +${pendingInvitations.length}` : ""}
            </span>
          </button>
          <div className="menu-row">
            <span className="menu-row-label">Sync</span>
            <SyncBadge
              status={syncStatus}
              enabled={syncEnabled}
              lastSyncedAt={lastSyncedAt}
              pending={syncPending}
            />
          </div>
        </>
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

/** Focused sign-in / sign-up modal; closes itself once a session lands. */
function AuthDialog({ onClose }: { onClose: () => void }) {
  const authStatus = useStore((s) => s.authStatus);
  const authError = useStore((s) => s.authError);
  const serverUrl = useStore((s) => s.serverUrl);

  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
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
    if (authStatus === "signed-in") onClose();
  }, [authStatus, onClose]);

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

  const googleSignIn = async () => {
    setGoogleBusy(true);
    try {
      await useStore.getState().signInWithGoogle();
    } catch {
      /* error (incl. timeout / abandoned flow) surfaced via authError */
    } finally {
      setGoogleBusy(false);
    }
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
            </button>
            {googleBusy && (
              <p className="auth-hint">
                Finish signing in in the browser tab that just opened. This window updates
                automatically once you approve.
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
          <button className="primary" type="submit" disabled={busy || googleBusy}>
            {busy ? "…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>

        {authError && <div className="auth-error">{authError}</div>}

        <details className="server-config">
          <summary>Server settings</summary>
          <div className="server-config-body">
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="http://localhost:3010"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => void useStore.getState().setServerUrl(urlDraft.trim())}
            >
              Save
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

type SettingsTab =
  | "workspaces"
  | "members"
  | "billing"
  | "access"
  | "mcp"
  | "import-export"
  | "appearance"
  | "updates";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  {
    id: "workspaces",
    label: "Workspaces",
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
 * Workspace settings — a dedicated full page (not a modal): everything about
 * the workspace lives here. Members (roster + join code + invites),
 * Permissions (RBAC locks), and Appearance (theme + item colors).
 */
function WorkspaceSettingsDialog({ onClose }: { onClose: () => void }) {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const billingConfig = useStore((s) => s.billingConfig);

  const [tab, setTab] = useState<SettingsTab>("workspaces");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Billing only appears when the server actually offers it (and the user is
  // signed in — guaranteed here since this whole page requires a session).
  const billingEnabled = billingConfig?.enabled === true;
  const tabs = useMemo(() => {
    if (!billingEnabled) return SETTINGS_TABS;
    const out = [...SETTINGS_TABS];
    const idx = out.findIndex((t) => t.id === "members");
    out.splice(idx >= 0 ? idx + 1 : out.length, 0, BILLING_TAB);
    return out;
  }, [billingEnabled]);

  if (!session) return null;
  const activeOrg =
    organizations.find((o) => o.id === session.activeOrganizationId) ?? null;
  const myMember = members.find((m) => m.userId === session.user.id);
  const canManage = myMember?.role === "owner" || myMember?.role === "admin";
  const activeTab = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div className="settings-title">
          <span className="settings-eyebrow">Workspace settings</span>
          <h1>{activeOrg?.name ?? "Workspace"}</h1>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          ✕
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`menu-item${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              <span className="menu-item-label">{t.label}</span>
            </button>
          ))}
        </nav>

        <section className="settings-content" aria-label={activeTab.label}>
          <h2 className="settings-section-title">{activeTab.label}</h2>
          {tab === "workspaces" ? (
            <WorkspacesTab />
          ) : tab === "members" ? (
            <MembersTab canManage={canManage} />
          ) : tab === "billing" ? (
            <BillingTab canManage={canManage} />
          ) : tab === "access" ? (
            <AccessPanel canManage={canManage} />
          ) : tab === "mcp" ? (
            <McpTab />
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
 * Workspaces: switch between workspaces, create/join, and manage where their
 * local folders live. Each workspace owns one folder under the managed root;
 * switching swaps the sidebar to that workspace's folder and repoints the
 * stable `current` symlink external tools point at.
 */
function WorkspacesTab() {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);

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
  const [actionError, setActionError] = useState<string | null>(null);
  // Free-plan workspace-cap hit while creating — shows an upgrade nudge instead.
  const [limitNudge, setLimitNudge] = useState<{ kind: LimitKind; limit: number | null } | null>(
    null,
  );
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ipc
      .getWorkspaceRoot()
      .then((r) => {
        if (!cancelled) setRoot(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!session) return null;
  const activeOrgId = session.activeOrganizationId;
  // We only know the caller's role for the ACTIVE workspace (members are loaded
  // for it alone). On the active row we can therefore hide Delete from
  // non-owners; on other rows we can't tell, so we show it and let the server
  // enforce owner-only (403, surfaced via actionError). `deleteWorkspace` takes
  // an explicit org id, so deleting a non-active workspace works without first
  // switching to it.
  const isActiveOwner =
    members.find((m) => m.userId === session.user.id)?.role === "owner";
  const canDelete = (orgId: string) =>
    orgId === activeOrgId ? isActiveOwner : true;

  const folderName = (orgId: string): string | null => {
    const p = bound[orgId];
    return p ? (p.split("/").pop() ?? p) : null;
  };

  const switchTo = async (orgId: string) => {
    if (orgId === activeOrgId || busy) return;
    setBusy(true);
    try {
      await useStore.getState().setActiveOrganization(orgId);
      setBound(readOrgVaults());
    } finally {
      setBusy(false);
    }
  };

  // Detach a workspace from this device only (server data untouched).
  const removeLocal = async (orgId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().removeWorkspaceLocally(orgId);
      setBound(readOrgVaults());
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Permanently delete a workspace everywhere (owner only, two-click confirm).
  const deletePermanently = async (orgId: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await useStore.getState().deleteWorkspace(orgId);
      setBound(readOrgVaults());
      setConfirmDelete(null);
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
      // A 402 workspace-cap rejection becomes an upgrade nudge; anything else is
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
      await useStore.getState().joinWorkspace(joinCode);
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
      const picked = await ipc.pickWorkspaceRoot();
      if (picked) setRoot(picked);
    } catch {
      /* picker cancelled/unavailable */
    }
  };

  // Active workspace pinned to the top.
  const ordered = [
    ...organizations.filter((o) => o.id === activeOrgId),
    ...organizations.filter((o) => o.id !== activeOrgId),
  ];

  return (
    <>
      <div className="subhead">In this account ({organizations.length})</div>
      <ul className="member-list workspace-list">
        {ordered.map((o) => {
          const isActive = o.id === activeOrgId;
          const fname = folderName(o.id);
          return (
            <li key={o.id}>
              <span className="menu-swatch" aria-hidden="true">
                {o.name[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="member-name">
                {o.name}
                <span className="muted workspace-folder">
                  {" "}
                  {fname ? `· ${fname}` : "· folder created on first open"}
                </span>
              </span>
              {confirmDelete === o.id ? (
                <span className="workspace-row-actions">
                  <span className="muted">Delete everything?</span>
                  <button
                    className="link-btn"
                    disabled={busy}
                    onClick={() => setConfirmDelete(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="link-btn danger"
                    disabled={busy}
                    onClick={() => void deletePermanently(o.id)}
                  >
                    Delete
                  </button>
                </span>
              ) : (
                <span className="workspace-row-actions">
                  {isActive ? (
                    <span className="member-role">Current</span>
                  ) : (
                    <button
                      className="link-btn"
                      disabled={busy}
                      onClick={() => void switchTo(o.id)}
                    >
                      Switch
                    </button>
                  )}
                  <button
                    className="link-btn"
                    disabled={busy}
                    title="Stop syncing this workspace here; server data is kept"
                    onClick={() => void removeLocal(o.id)}
                  >
                    Remove from device
                  </button>
                  {canDelete(o.id) && (
                    <button
                      className="link-btn danger"
                      disabled={busy}
                      title="Permanently delete this workspace and all its notes for everyone"
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

      <div className="row workspace-actions">
        {creating ? (
          <div className="menu-create-org">
            <input
              autoFocus
              placeholder="Workspace name"
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
              + New workspace
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

      <div className="menu-sep" />
      <div className="subhead">Workspace folder location</div>
      <div className="muted">
        New workspaces get their own folder here. The active workspace is also
        linked at <code>current</code> so tools like Claude Desktop can point at
        one fixed path.
      </div>
      <div className="join-code-row">
        <code className="workspace-root-path" title={root ?? ""}>
          {root ?? "…"}
        </code>
        <button className="link-btn" onClick={() => void changeRoot()}>
          Change…
        </button>
      </div>

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

  // The caller's own role in this workspace, so we mirror the server's rules and
  // only show a Remove button where it would actually succeed: owners can remove
  // anyone but themselves and the (single) owner; admins can remove plain members.
  const myRole = members.find((m) => m.userId === session?.user.id)?.role;
  const canRemove = (m: Member): boolean =>
    canManage &&
    m.userId !== session?.user.id &&
    m.role !== "owner" &&
    (myRole === "owner" || m.role === "member");

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

  // The workspace's shareable join code (owner/admin only; server creates it
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
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
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

      <div className="subhead">In this workspace ({members.length})</div>
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
              <span className={`member-role ${m.role}`}>{m.role}</span>
              {canRemove(m) &&
                (confirmRemoveId === m.userId ? (
                  <>
                    <button
                      className="link-btn danger"
                      disabled={removeBusy}
                      onClick={() => void doRemove(m.userId)}
                    >
                      {removeBusy ? "Removing…" : "Confirm"}
                    </button>
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
 * BillingTab: this workspace's plan + seat usage (spec 04). Facts are visible to
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
        Billing needs an active workspace — create or switch to one first.
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
          <div className="muted">Everything unlimited on this workspace.</div>
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
            <button
              className="secondary billing-action"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void manage()}
            >
              {busy && <span className="btn-spinner" aria-hidden="true" />}
              <span>Manage subscription</span>
            </button>
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
            <li>Doesn't count toward your free workspaces</li>
            <li>Priority support</li>
          </ul>

          {error && <div className="auth-error">{error}</div>}
          {canManage ? (
            <button className="primary billing-action" onClick={() => setUpgradeOpen(true)}>
              Upgrade to Pro
            </button>
          ) : (
            <div className="muted">Ask an owner or admin to upgrade this workspace.</div>
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
 * Inline upgrade nudge shown in the create-workspace / invite-member error slot
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
  const n =
    limit ??
    (kind === "member_limit"
      ? freeLimits?.membersPerWorkspace
      : freeLimits?.workspacesPerUser) ??
    3;
  const message =
    kind === "member_limit"
      ? `Free plan limit reached — this workspace allows ${n} member${n === 1 ? "" : "s"}.`
      : `You have ${n} free workspace${n === 1 ? "" : "s"}. Upgrade a workspace to Pro to create more.`;
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
 * MCP: expose this workspace to AI clients over the Model Context Protocol.
 * The MCP endpoint is part of the same server; a client authenticates with a
 * token minted here and then gets the SAME CRUD access to notes/folders that
 * the signed-in user has (owners/admins see everything; members see what's
 * shared with them). This is where you grab the URL + a token.
 */
function McpTab() {
  const session = useStore((s) => s.session);
  const serverUrl = useStore((s) => s.serverUrl);

  const mcpUrl = `${serverUrl.replace(/\/+$/, "")}/api/mcp`;
  const hasWorkspace = !!session?.activeOrganizationId;

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
    if (!hasWorkspace) {
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
  }, [hasWorkspace]);

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

  if (!hasWorkspace) {
    return (
      <div className="muted perm-empty">
        MCP needs an active workspace — create or switch to one first.
      </div>
    );
  }

  const snippet = justCreated
    ? `claude mcp add --transport http context ${mcpUrl} \\\n  --header "Authorization: Bearer ${justCreated.token}"`
    : "";

  return (
    <>
      <div className="muted">
        Connect any MCP-compatible AI client to this workspace. It gets the same
        access you do — read, search, create, edit and delete notes and folders.
      </div>

      <div className="subhead">Endpoint URL</div>
      <div className="join-code-row">
        <code className="workspace-root-path" title={mcpUrl}>
          {mcpUrl}
        </code>
        <button className="link-btn" onClick={() => void copy(mcpUrl, "url")}>
          {copied === "url" ? "Copied ✓" : "Copy"}
        </button>
      </div>

      <div className="menu-sep" />
      <div className="subhead">Access tokens</div>
      <div className="muted">
        A token authenticates the client and scopes it to you in this workspace.
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
        Every token is a connection into this workspace. Each reaches the same{" "}
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
                  <button
                    className="link-btn danger"
                    disabled={busy}
                    onClick={() => void revoke(t.id)}
                  >
                    Revoke
                  </button>
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
          <button className="primary sm" onClick={() => void installUpdate()}>
            Install &amp; Restart
          </button>
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
      const sources = await ipc.pickFiles();
      if (!sources || sources.length === 0) return null;
      const summary = await ipc.importPaths("", sources);
      await refresh();
      return importSummaryText(summary);
    });

  const importFolder = () =>
    run("folder", async () => {
      const src = await ipc.pickFolder();
      if (!src) return null;
      const summary = await ipc.importPaths("", [src]);
      await refresh();
      return importSummaryText(summary);
    });

  const exportVault = () =>
    run("export", async () => {
      const dest = await ipc.pickFolder();
      if (!dest) return null;
      await ipc.exportPath("", dest);
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
