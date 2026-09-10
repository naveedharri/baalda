import { useEffect, useState } from "react";
import { DEFAULT_SERVER_URL } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { normalizeServerUrl, serverHost } from "../lib/auth/serverChoice";
import { ACTIVITY_STATUSES, type ActivityStatus, writeServerChoice } from "../lib/prefs";
import { checkForUpdate, currentVersion, installUpdate, useUpdateState } from "../lib/updater";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import { serverFailureMessage } from "./serverFailureMessage";
import { SettingsModal } from "./SettingsModal";
import { Switch } from "./Switch";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Account settings — a centered modal over the app (sibling to Vault settings,
 * and sharing its shell in {@link SettingsModal}) for everything that follows
 * the *user* rather than any one vault: profile (name/avatar), activity status,
 * appearance, notifications, the server it syncs against, and app updates.
 * Profile fields are server-backed (Better Auth) so they follow the account
 * across devices; status/notifications/theme/server are device-local
 * preferences.
 */

type AccountTab = "profile" | "status" | "appearance" | "notifications" | "connection" | "about";

const ACCOUNT_TABS: Array<{ id: AccountTab; label: string; icon: React.ReactNode }> = [
  {
    id: "profile",
    label: "Profile",
    icon: (
      <Icon>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </Icon>
    ),
  },
  {
    id: "status",
    label: "Activity status",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      </Icon>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a10 10 0 0 1 0 20 5 5 0 0 1 0-10 5 5 0 0 0 0-10" />
      </Icon>
    ),
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: (
      <Icon>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </Icon>
    ),
  },
  {
    id: "connection",
    label: "Connection",
    icon: (
      <Icon>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <path d="M6 6h.01M6 18h.01" />
      </Icon>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </Icon>
    ),
  },
];

export function AccountSettings({ onClose }: { onClose: () => void }) {
  const session = useStore((s) => s.session);
  const [tab, setTab] = useState<AccountTab>("profile");

  // Esc, click-away, focus and the backdrop all live in `SettingsModal`.
  if (!session) return null;
  const activeTab = ACCOUNT_TABS.find((t) => t.id === tab)!;
  const userLabel = session.user.name || session.user.email;

  return (
    <SettingsModal label="Account settings" onClose={onClose}>
      <header className="settings-page-header">
        <div className="settings-title">
          <span className="settings-eyebrow">Account settings</span>
          <h1>{userLabel}</h1>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          ✕
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Account sections">
          {ACCOUNT_TABS.map((t) => (
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
          {tab === "profile" ? (
            <ProfileTab />
          ) : tab === "status" ? (
            <StatusTab />
          ) : tab === "appearance" ? (
            <AppearanceTab />
          ) : tab === "notifications" ? (
            <NotificationsTab />
          ) : tab === "connection" ? (
            <ConnectionTab />
          ) : (
            <AboutTab onClose={onClose} />
          )}
        </section>
      </div>
    </SettingsModal>
  );
}

function ProfileTab() {
  const session = useStore((s) => s.session);
  const [name, setName] = useState(session?.user.name ?? "");
  const [image, setImage] = useState(session?.user.image ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(session?.user.name ?? "");
    setImage(session?.user.image ?? "");
  }, [session?.user.name, session?.user.image]);

  if (!session) return null;
  const trimmedName = name.trim();
  const trimmedImage = image.trim();
  const dirty =
    trimmedName !== (session.user.name ?? "") ||
    trimmedImage !== (session.user.image ?? "");

  // Re-sending the confirmation email: its own tiny state so a failure (this
  // server has no email; the provider refused) is said next to the button.
  const [resendBusy, setResendBusy] = useState(false);
  const [resendState, setResendState] = useState<string | null>(null);
  const resendConfirmation = async () => {
    setResendBusy(true);
    setResendState(null);
    try {
      await useStore.getState().resendVerificationEmail();
      setResendState("sent");
    } catch (e) {
      setResendState(e instanceof Error ? e.message : String(e));
    } finally {
      setResendBusy(false);
    }
  };

  const save = async () => {
    if (!trimmedName) {
      setError("Name can't be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await useStore.getState().updateProfile({
        name: trimmedName,
        image: trimmedImage || null,
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-profile">
      <div className="profile-hero">
        <Avatar label={trimmedName || session.user.email} image={trimmedImage || null} />
        <div className="profile-hero-meta">
          <strong>{trimmedName || "—"}</strong>
          <span className="muted">{session.user.email}</span>
        </div>
      </div>

      <label className="field">
        <span className="field-label">Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoComplete="name"
        />
      </label>

      <label className="field">
        <span className="field-label">Avatar image URL</span>
        <input
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="https://…/photo.jpg"
          spellCheck={false}
        />
        <span className="field-hint">
          Paste a link to a photo. Leave blank to use your generated character avatar.
        </span>
      </label>

      <label className="field">
        <span className="field-label">Email</span>
        <input value={session.user.email} disabled readOnly />
        {/* Verification state, live: the confirmation link bounces back into
            the app (`baalda://verified`), which re-reads the session, so this
            flips without a reload. `emailVerified` is absent on very old
            servers — say nothing rather than "not confirmed" then. */}
        {session.user.emailVerified === true && (
          <span className="field-hint">Email confirmed ✓</span>
        )}
        {session.user.emailVerified === false && (
          <span className="field-hint">
            Not confirmed yet — check your inbox for the confirmation email.{" "}
            <button
              type="button"
              className="linkish"
              disabled={resendBusy}
              onClick={() => void resendConfirmation()}
            >
              {resendBusy ? "Sending…" : resendState === "sent" ? "Sent ✓" : "Resend it"}
            </button>
            {resendState && resendState !== "sent" && (
              <span className="update-status error"> {resendState}</span>
            )}
          </span>
        )}
      </label>

      {error && <div className="auth-error">{error}</div>}

      <div className="update-actions">
        <button className="primary sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy && <span className="btn-spinner" aria-hidden="true" />}
          <span>Save changes</span>
        </button>
        {saved && (
          <span className="update-status" role="status">
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}

function StatusTab() {
  const activityStatus = useStore((s) => s.activityStatus);

  return (
    <div className="status-tab">
      <p className="muted">
        Your status shows next to your cursor for teammates working in the same note.
      </p>
      <div className="status-options">
        {ACTIVITY_STATUSES.map((s) => {
          const active = s.id === activityStatus;
          return (
            <button
              key={s.id}
              type="button"
              className={`menu-item${active ? " active" : ""}`}
              role="menuitemradio"
              aria-checked={active}
              onClick={() => useStore.getState().setActivityStatus(s.id as ActivityStatus)}
            >
              <span className={`status-dot ${s.id}`} aria-hidden="true" />
              <span className="menu-item-label">
                {s.label}
                <span className="field-hint">{s.hint}</span>
              </span>
              {active && (
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
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AppearanceTab() {
  return (
    <div className="menu-row">
      <span className="menu-row-label">Theme</span>
      <ThemeToggle />
    </div>
  );
}

function NotificationsTab() {
  const mentionSound = useStore((s) => s.mentionSound);
  return (
    <label className="menu-row toggle-row">
      <span className="menu-row-label">
        Mention chime
        <span className="field-hint">Play a sound when a teammate pings you.</span>
      </span>
      <Switch
        checked={mentionSound}
        ariaLabel="Mention chime"
        onChange={(next) => useStore.getState().setMentionSound(next)}
      />
    </label>
  );
}

function ConnectionTab() {
  const serverUrl = useStore((s) => s.serverUrl);
  const [draft, setDraft] = useState(serverUrl);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(serverUrl), [serverUrl]);

  /**
   * Check the address answers BEFORE adopting it. Changing the server is a
   * de-facto sign-out (the session lives under a per-server keychain key), so a
   * typo used to swap a working session for a signed-out app and no message at
   * all — `save` had a `finally` and no `catch`.
   */
  const save = async () => {
    const url = normalizeServerUrl(draft);
    if (!url) {
      setError("That doesn't look like a server address — try https://notes.example.com");
      return;
    }
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await authManager.api.health(url);
      writeServerChoice(url === DEFAULT_SERVER_URL ? "managed" : "custom");
      await useStore.getState().setServerUrl(url);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(serverFailureMessage(e, url));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-tab">
      <label className="field">
        <span className="field-label">Server URL</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://notes.example.com"
          spellCheck={false}
          autoCapitalize="off"
        />
        <span className="field-hint">
          The Baalda server this device syncs against — currently{" "}
          <strong>{serverHost(serverUrl)}</strong>. Use the managed service or
          point at your own. Your account is per-server, so switching signs you
          in to that server's session instead.
        </span>
      </label>
      <div className="update-actions">
        <button
          className="primary sm"
          disabled={busy || draft.trim() === serverUrl}
          onClick={() => void save()}
        >
          {busy && <span className="btn-spinner" aria-hidden="true" />}
          <span>Save &amp; reconnect</span>
        </button>
        {saved && (
          <span className="update-status" role="status">
            Reconnected.
          </span>
        )}
      </div>
      {error && <div className="auth-error">{error}</div>}
    </div>
  );
}

function AboutTab({ onClose }: { onClose: () => void }) {
  const update = useUpdateState();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void currentVersion().then(setVersion);
  }, []);

  const busy =
    update.phase === "checking" ||
    update.phase === "downloading" ||
    update.phase === "installing";

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
      statusText =
        update.total > 0
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
    <div className="about-tab">
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
        <span className={`update-status${statusError ? " error" : ""}`} role="status" aria-live="polite">
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

      <div className="menu-sep" />
      <button
        className="menu-item danger"
        onClick={() => {
          onClose();
          void useStore.getState().signOut();
        }}
      >
        <Icon>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="M16 17l5-5-5-5M21 12H9" />
        </Icon>
        <span className="menu-item-label">Sign out</span>
      </button>
    </div>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
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

export { AccountSettings as default };
