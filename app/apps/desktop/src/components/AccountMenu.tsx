import { useEffect, useMemo, useRef, useState } from "react";
import {
  sharePrincipalId,
  sharePrincipalType,
  shareResourceId,
  type McpTokenRow,
} from "../lib/api";
import { ITEM_COLORS, itemColorValue } from "../lib/appearance";
import { authManager } from "../lib/auth/authManager";
import * as ipc from "../lib/ipc";
import type { TreeNode } from "../lib/ipc";
import { resourceIdsByPath } from "../lib/locks";
import { syncManager } from "../lib/sync/docSession";
import {
  checkForUpdate,
  currentVersion,
  installUpdate,
  useUpdateState,
} from "../lib/updater";
import { readOrgVaults, useStore } from "../store";
import { Avatar, SyncBadge } from "./Identity";
import { ThemeToggle } from "./ThemeToggle";

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
        />
      )}
      {membersOpen && <WorkspaceSettingsDialog onClose={() => setMembersOpen(false)} />}
    </div>
  );
}

function AccountPopover({
  onClose,
  onOpenMembers,
}: {
  onClose: () => void;
  onOpenMembers: () => void;
}) {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const pendingInvitations = useStore((s) => s.pendingInvitations);
  const userInvitations = useStore((s) => s.userInvitations);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const serverUrl = useStore((s) => s.serverUrl);

  const [creating, setCreating] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [showServer, setShowServer] = useState(false);
  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [busy, setBusy] = useState(false);

  if (!session) return null;
  const activeOrgId = session.activeOrganizationId;
  const userLabel = session.user.name || session.user.email;

  const createOrg = async () => {
    if (!orgName.trim()) return;
    setBusy(true);
    try {
      await useStore.getState().createOrganization(orgName.trim());
      setOrgName("");
      setCreating(false);
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

      {/* Active workspace pinned to the top — it's the one you're working in. */}
      {[
        ...organizations.filter((o) => o.id === activeOrgId),
        ...organizations.filter((o) => o.id !== activeOrgId),
      ].map((o) => {
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
            <SyncBadge status={syncStatus} enabled={syncEnabled} lastSyncedAt={lastSyncedAt} />
          </div>
        </>
      )}

      <div className="menu-sep" />
      <div className="menu-label">Preferences</div>

      <div className="menu-row">
        <span className="menu-row-label">Appearance</span>
        <ThemeToggle />
      </div>

      <button className="menu-item subtle" onClick={() => setShowServer((v) => !v)}>
        <MenuIcon>
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <path d="M6 6h.01M6 18h.01" />
        </MenuIcon>
        <span className="menu-item-label">Server</span>
        <span className="menu-hint" title={serverUrl}>
          {serverUrl.replace(/^https?:\/\//, "")}
        </span>
      </button>
      {showServer && (
        <div className="menu-create-org">
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="http://localhost:3010"
            spellCheck={false}
          />
          <button
            className="primary sm"
            onClick={() => {
              void useStore.getState().setServerUrl(urlDraft.trim());
              setShowServer(false);
            }}
          >
            Save
          </button>
        </div>
      )}

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
    setBusy(true);
    try {
      await useStore.getState().signInWithGoogle();
    } catch {
      /* error surfaced via authError */
    } finally {
      setBusy(false);
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
              disabled={busy}
            >
              <GoogleGlyph />
              <span>Continue with Google</span>
            </button>
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
          <button className="primary" type="submit" disabled={busy}>
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
  | "permissions"
  | "mcp"
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
    id: "permissions",
    label: "Permissions",
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

/**
 * Workspace settings — a dedicated full page (not a modal): everything about
 * the workspace lives here. Members (roster + join code + invites),
 * Permissions (RBAC locks), and Appearance (theme + item colors).
 */
function WorkspaceSettingsDialog({ onClose }: { onClose: () => void }) {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);

  const [tab, setTab] = useState<SettingsTab>("workspaces");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!session) return null;
  const activeOrg =
    organizations.find((o) => o.id === session.activeOrganizationId) ?? null;
  const myMember = members.find((m) => m.userId === session.user.id);
  const canManage = myMember?.role === "owner" || myMember?.role === "admin";
  const activeTab = SETTINGS_TABS.find((t) => t.id === tab)!;

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
          {SETTINGS_TABS.map((t) => (
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
          ) : tab === "permissions" ? (
            <PermissionsTab canManage={canManage} />
          ) : tab === "mcp" ? (
            <McpTab />
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
    try {
      await useStore.getState().createOrganization(orgName.trim());
      setOrgName("");
      setCreating(false);
      setBound(readOrgVaults());
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
    try {
      await useStore.getState().inviteMember(inviteEmail.trim(), inviteRole);
      setInviteEmail("");
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
            </li>
          );
        })}
      </ul>

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
    </>
  );
}

const LOCK_GLYPH = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

/**
 * Permissions (locks): a lock caps everyone it targets — including admins —
 * at read-only on that folder/note; folder locks inherit to contents. The
 * server enforces it on every sync token, so changes made offline won't sync.
 */
function PermissionsTab({ canManage }: { canManage: boolean }) {
  const session = useStore((s) => s.session);
  const members = useStore((s) => s.members);
  const locks = useStore((s) => s.locks);
  const tree = useStore((s) => s.tree);
  const syncEnabled = useStore((s) => s.syncEnabled);

  const [resourceKey, setResourceKey] = useState("");
  const [principal, setPrincipal] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every synced folder + note, flattened for the picker.
  const resources = useMemo(() => {
    const out: Array<{ key: string; kind: "folder" | "file"; path: string; id: string }> = [];
    const walk = (n: TreeNode, depth: number) => {
      if (n.isDir) {
        const id = syncManager.registry.getFolderId(n.path);
        if (id) out.push({ key: `folder:${id}`, kind: "folder", path: n.path, id });
      } else {
        const m = syncManager.registry.getMapping(n.path);
        if (m) out.push({ key: `file:${m.docId}`, kind: "file", path: n.path, id: m.docId });
      }
      n.children?.forEach((c) => walk(c, depth + 1));
    };
    tree?.children?.forEach((c) => walk(c, 0));
    return out;
  }, [tree]);

  const idToPath = useMemo(() => resourceIdsByPath(tree), [tree]);

  const memberName = (userId: string) => {
    const m = members.find((mm) => mm.userId === userId);
    return m?.user?.name || m?.user?.email || userId;
  };

  if (!syncEnabled) {
    return (
      <div className="muted perm-empty">
        Permissions need sync — sign in and connect this folder to a workspace first.
      </div>
    );
  }

  const lock = async () => {
    const res = resources.find((r) => r.key === resourceKey);
    if (!res) return;
    setBusy(true);
    setError(null);
    try {
      await useStore
        .getState()
        .createLock(res.kind, res.id, principal === "all" ? null : principal);
      setResourceKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (shareId: string) => {
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().removeLock(shareId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {canManage && (
        <>
          <div className="subhead">Lock a folder or note</div>
          <div className="muted">
            Locked items are read-only for whoever the lock targets — admins
            included. Folder locks apply to everything inside.
          </div>
          <div className="row lock-bar">
            <select value={resourceKey} onChange={(e) => setResourceKey(e.target.value)}>
              <option value="">Choose folder or note…</option>
              {resources.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.kind === "folder" ? "📁 " : "📄 "}
                  {r.kind === "file" ? r.path.replace(/\.md$/i, "") : r.path}
                </option>
              ))}
            </select>
            <select value={principal} onChange={(e) => setPrincipal(e.target.value)}>
              <option value="all">Everyone</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user?.name || m.user?.email || m.userId}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={busy || !resourceKey}
              onClick={() => void lock()}
            >
              Lock
            </button>
          </div>
        </>
      )}

      {error && <div className="auth-error">{error}</div>}

      <div className="subhead">Active locks ({locks.length})</div>
      {locks.length === 0 ? (
        <div className="muted">Nothing is locked.</div>
      ) : (
        <ul className="member-list lock-list">
          {locks.map((l) => {
            const path = idToPath.get(shareResourceId(l));
            const isOrg = sharePrincipalType(l) === "org";
            const who = isOrg ? "Everyone" : memberName(sharePrincipalId(l));
            const isMe = !isOrg && sharePrincipalId(l) === session?.user.id;
            return (
              <li key={l.id}>
                <span className={`lock-glyph ${isOrg ? "all" : ""}`}>{LOCK_GLYPH}</span>
                <span className="member-name" title={path ?? shareResourceId(l)}>
                  {path ? path.replace(/\.md$/i, "") : "(unknown item)"}
                </span>
                <span className="member-role">
                  {who}
                  {isMe ? " (you)" : ""}
                </span>
                {canManage && (
                  <button
                    className="link-btn danger"
                    disabled={busy}
                    onClick={() => void unlock(l.id)}
                  >
                    Unlock
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
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
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ name: string; token: string } | null>(
    null,
  );
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!hasWorkspace) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    authManager.api
      .listMcpTokens()
      .then((t) => {
        if (!cancelled) setTokens(t);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
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

      {loading ? (
        <div className="muted">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="muted">No tokens yet.</div>
      ) : (
        <ul className="member-list">
          {tokens.map((t) => (
            <li key={t.id}>
              <span className="menu-swatch" aria-hidden="true">
                ⚙
              </span>
              <span className="member-name">
                {t.name}
                <span className="muted"> · {t.tokenPrefix}</span>
                <span className="muted">
                  {" "}
                  · {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}
                </span>
              </span>
              <button
                className="link-btn danger"
                disabled={busy}
                onClick={() => void revoke(t.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
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

function AppearanceTab() {
  const itemColors = useStore((s) => s.itemColors);

  const colored = Object.entries(itemColors).sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <div className="menu-row">
        <span className="menu-row-label">Theme</span>
        <ThemeToggle />
      </div>

      <div className="subhead">Folder &amp; note colors</div>
      <div className="muted">
        Pick a color from any folder or note's ⋯ menu in the sidebar. Colors are
        saved with this device's vault settings.
      </div>
      <div className="palette-preview" aria-hidden="true">
        {ITEM_COLORS.map((c) => (
          <span key={c.id} className="swatch" style={{ backgroundColor: c.value }} title={c.label} />
        ))}
      </div>

      {colored.length > 0 && (
        <>
          <div className="subhead">Colored items ({colored.length})</div>
          <ul className="member-list">
            {colored.map(([path, colorId]) => (
              <li key={path}>
                <span
                  className="swatch"
                  style={{ backgroundColor: itemColorValue(colorId) }}
                  aria-hidden="true"
                />
                <span className="member-name" title={path}>
                  {path.replace(/\.(md|html?)$/i, "")}
                </span>
                <button
                  className="link-btn"
                  onClick={() => useStore.getState().setItemColor(path, null)}
                >
                  Clear
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
