import { useEffect, useRef, useState } from "react";
import { DEFAULT_SERVER_URL } from "../lib/api";
import type { AccountSettingsTab } from "../lib/settingsTabs";
import { authManager } from "../lib/auth/authManager";
import { normalizeServerUrl, serverHost } from "../lib/auth/serverChoice";
import {
  ACTIVITY_STATUSES,
  type ActivityStatus,
  writeServerChoice,
} from "../lib/prefs";
import type { PropertiesMode } from "../lib/editor/frontmatter";
import {
  checkAndAutoInstall,
  currentVersion,
  relaunchForUpdate,
  useUpdateState,
} from "../lib/updater";
import { useStore } from "../store";
import {
  CHARACTER_PREFIX,
  PROFILE_CHARACTER_SEEDS,
  PROFILE_IMAGE_MAX_CHARS,
  PROFILE_IMAGE_PX,
} from "../lib/profileAvatar";
import { imageFileToSquareDataUrl } from "../lib/squareImage";
import { AccountPlanTab } from "./AccountPlanTab";
import { AccountVaultsTab } from "./AccountVaultsTab";
import { Avatar } from "./Avatar";
import { serverFailureMessage } from "./serverFailureMessage";
import { SettingsModal } from "./SettingsModal";
import { SettingsCrossLink } from "./SettingsCrossLink";
import { Switch } from "./Switch";
import { AppearanceRows } from "./AppearanceRows";
import { useShallow } from "zustand/react/shallow";
import {
  appearanceSource,
  type AppearanceKey,
  type AppearanceSettings,
} from "../lib/appearanceSettings";
import type { EditorMeasure } from "../lib/prefs";

/**
 * Account settings — a centered modal over the app (sibling to Vault settings,
 * and sharing its shell in {@link SettingsModal}) for everything that follows
 * the *user* rather than any one vault: profile (name/avatar), activity status,
 * appearance, notifications, the server it syncs against, and app updates.
 * Profile fields are server-backed (Better Auth) so they follow the account
 * across devices; status/notifications/theme/server are device-local
 * preferences.
 */

type AccountTab = AccountSettingsTab;

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
    id: "plan",
    label: "Plan & Billing",
    icon: (
      <Icon>
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </Icon>
    ),
  },
  {
    id: "vaults",
    label: "Vaults",
    icon: (
      <Icon>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
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

export function AccountSettings({
  onClose,
  initialTab,
}: {
  onClose: () => void;
  initialTab?: AccountSettingsTab;
}) {
  const session = useStore((s) => s.session);
  const [tab, setTab] = useState<AccountTab>(initialTab ?? "profile");
  const vaultOpen = useStore((s) => s.vault !== null);

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
          {vaultOpen && (
            <SettingsCrossLink
              label="Vault settings"
              onOpen={() => {
                onClose();
                useStore.getState().requestSettings("general");
              }}
            />
          )}
        </nav>

        <section className="settings-content" aria-label={activeTab.label}>
          <h2 className="settings-section-title">{activeTab.label}</h2>
          {tab === "profile" ? (
            <ProfileTab />
          ) : tab === "status" ? (
            <StatusTab />
          ) : tab === "plan" ? (
            <AccountPlanTab />
          ) : tab === "vaults" ? (
            <AccountVaultsTab />
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // While the name field has focus, a session refresh (our own save landing)
  // must not overwrite what is still being typed.
  const nameFocused = useRef(false);

  useEffect(() => {
    if (!nameFocused.current) setName(session?.user.name ?? "");
  }, [session?.user.name]);
  useEffect(() => {
    setImage(session?.user.image ?? "");
  }, [session?.user.image]);

  // Everything saves as you go — no Save button. Only the changed field is
  // sent; Better Auth's update-user takes a partial.
  // The last name sent, so the blur save and the pause save never both go out.
  const lastSentName = useRef<string | null>(null);
  const persist = async (patch: { name?: string; image?: string | null }) => {
    if (patch.name !== undefined) {
      if (patch.name === lastSentName.current) return;
      lastSentName.current = patch.name;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await useStore.getState().updateProfile(patch);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      // A failed name save may be retried with the same text.
      if (patch.name !== undefined) lastSentName.current = null;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // The name saves a moment after typing stops (or on blur, below).
  const savedName = session?.user.name ?? "";
  const nameDraft = name.trim();
  useEffect(() => {
    if (nameDraft === savedName) return;
    if (!nameDraft) {
      setError("Name can't be empty.");
      return;
    }
    const timer = window.setTimeout(() => void persist({ name: nameDraft }), 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameDraft, savedName]);

  // A picture pick or upload saves at once.
  const changeImage = (next: string) => {
    setImage(next);
    void persist({ image: next.trim() || null });
  };

  if (!session) return null;
  const trimmedName = name.trim();
  const trimmedImage = image.trim();

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

  return (
    <div className="account-profile">
      {/* The picture is chosen right where it's shown: upload / reset beside
          the big avatar, the character gallery just under it. */}
      <div className="profile-hero">
        <Avatar
          label={trimmedName || session.user.email}
          image={trimmedImage || null}
          userId={session.user.id}
        />
        <div className="profile-hero-meta">
          <strong>{trimmedName || "—"}</strong>
          <span className="muted">{session.user.email}</span>
        </div>
        <ProfilePictureActions image={trimmedImage} onChange={changeImage} onError={setError} />
      </div>
      <ProfileCharacterGrid
        label={trimmedName || session.user.email}
        userId={session.user.id}
        image={trimmedImage}
        onChange={changeImage}
      />

      <label className="field">
        <span className="field-label">Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => {
            nameFocused.current = true;
          }}
          onBlur={() => {
            nameFocused.current = false;
            // Leaving the field saves now rather than after the pause.
            if (nameDraft && nameDraft !== savedName) void persist({ name: nameDraft });
          }}
          placeholder="Your name"
          autoComplete="name"
        />
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

      <span className="update-status profile-save-status" role="status" aria-live="polite">
        {saving ? "Saving…" : saved ? "Saved" : ""}
      </span>
    </div>
  );
}

/**
 * Profile → picture, in the same style as a vault's icon picker: your default
 * character (seeded by your name), one of the preset characters, or an
 * uploaded photo. A pick saves straight away.
 */
function ProfilePictureActions({
  image,
  onChange,
  onError,
}: {
  /** The form's image value: "" = default character. */
  image: string;
  onChange: (image: string) => void;
  onError: (message: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (file: File) => {
    try {
      onError(null);
      onChange(await imageFileToSquareDataUrl(file, PROFILE_IMAGE_PX, PROFILE_IMAGE_MAX_CHARS));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="profile-hero-actions">
      {image && (
        <button type="button" className="link-btn" onClick={() => onChange("")}>
          Reset
        </button>
      )}
      <button type="button" className="secondary sm" onClick={() => fileRef.current?.click()}>
        Upload image
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}

function ProfileCharacterGrid({
  label,
  userId,
  image,
  onChange,
}: {
  label: string;
  userId: string;
  image: string;
  onChange: (image: string) => void;
}) {
  return (
    <div className="profile-characters">
      <span className="field-label">Or pick a character</span>
      <div className="profile-character-grid" role="radiogroup" aria-label="Character">
        <button
          type="button"
          className={`profile-character-option${image === "" ? " active" : ""}`}
          role="radio"
          aria-checked={image === ""}
          title="Your default character"
          onClick={() => onChange("")}
        >
          <Avatar label={label} userId={userId} image={null} />
        </button>
        {PROFILE_CHARACTER_SEEDS.map((seed) => {
          const value = CHARACTER_PREFIX + seed;
          return (
            <button
              key={seed}
              type="button"
              className={`profile-character-option${image === value ? " active" : ""}`}
              role="radio"
              aria-checked={image === value}
              onClick={() => onChange(value)}
            >
              <Avatar label={label} image={value} />
            </button>
          );
        })}
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
  const overrides = useStore((s) => s.appearanceOverrides);
  const vaultAppearance = useStore((s) => s.vaultAppearance);
  const orgId = useStore((s) =>
    s.vault && s.syncEnabled ? (s.session?.activeOrganizationId ?? null) : null,
  );
  const values = useStore(
    useShallow((s) => ({
      theme: s.themeMode,
      autoColors: s.automaticItemColors,
      contentWidth: s.editorMeasure,
      textSize: s.editorFontSize,
      lineNumbers: s.lineNumbers,
      properties: s.propertiesMode,
    })),
  );
  // A synced vault always has a value for every row (a key it never saved is
  // the app default), so treat it as present even before its row has loaded.
  const vault = orgId ? (vaultAppearance[orgId] ?? {}) : null;
  const set = <K extends AppearanceKey>(key: K, value: AppearanceSettings[K] | undefined) => {
    const st = useStore.getState();
    // The legacy setters also keep the old per-key storage current.
    if (key === "autoColors") st.setAutomaticItemColors(value as boolean);
    else if (key === "contentWidth") st.setEditorMeasure(value as EditorMeasure);
    else if (key === "textSize") st.setEditorFontSize(value as number);
    else if (key === "lineNumbers") st.setLineNumbers(value as boolean);
    else if (key === "properties") st.setPropertiesMode(value as PropertiesMode);
    else st.setAppearanceOverride(key, value);
  };
  return (
    <AppearanceRows
      mode="personal"
      values={values}
      onChange={set}
      trailing={(key) => {
        const source = appearanceSource(key, overrides, vault);
        if (source === "vault") return <span className="appearance-tag">Vault default</span>;
        if (source === "personal" && vault) {
          return (
            <button
              type="button"
              className="link-btn appearance-clear"
              onClick={(e) => {
                e.preventDefault();
                useStore.getState().setAppearanceOverride(key, undefined);
              }}
            >
              Reset to vault default
            </button>
          );
        }
        return null;
      }}
    />
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

  // Updates install themselves, so this button only kicks off the same silent
  // path the launch check and the poll use — there is no Install step to offer.
  const busy =
    update.phase === "checking" ||
    update.phase === "available" ||
    update.phase === "downloading" ||
    update.phase === "installing" ||
    update.phase === "ready";

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
      statusText = `Version ${update.version} found — starting the download…`;
      break;
    case "downloading":
      statusText =
        update.total > 0
          ? `Downloading ${update.version} — ${Math.round((update.downloaded / update.total) * 100)}%`
          : `Downloading ${update.version}…`;
      break;
    case "installing":
      statusText = `Installing ${update.version}…`;
      break;
    case "ready":
      statusText = `Version ${update.version} is installed — restarting shortly.`;
      break;
    case "pending":
      // The server already runs a newer release than the feed can serve yet;
      // the check retries on its own. Quiet on purpose — nothing is wrong.
      statusText = "An update is on its way.";
      break;
    case "error":
      statusText = `Couldn't check for updates: ${update.message}`;
      statusError = true;
      break;
    case "failed":
      statusText = `Couldn't install version ${update.version}${update.message ? `: ${update.message}` : ""}`;
      statusError = true;
      break;
  }

  return (
    <div className="about-tab">
      {/* One row: version + status on the left, the action on the right. The
          status line is always rendered (empty when idle) so a check never
          shifts the row; the button keeps a fixed width for the same reason. */}
      <div className="about-update-row">
        <div className="about-update-text">
          <div className="about-version">
            <span className="menu-row-label">Current version</span>
            <span className="mono">{version ?? "…"}</span>
          </div>
          <span className={`update-status${statusError ? " error" : ""}`} role="status" aria-live="polite">
            {statusText}
          </span>
        </div>
        {/* The one moment worth an accent button: the bytes are in and we are
            holding the restart for a pause in typing. Someone who is done can
            take it now. (The check button is disabled in this phase anyway.) */}
        {update.phase === "ready" ? (
          <button className="primary sm about-update-btn" onClick={() => void relaunchForUpdate()}>
            Restart now
          </button>
        ) : (
          <button
            className="secondary sm about-update-btn"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void checkAndAutoInstall()}
          >
            {busy && <span className="btn-spinner" aria-hidden="true" />}
            <span>{update.phase === "checking" ? "Checking…" : busy ? "Updating…" : "Check for updates"}</span>
          </button>
        )}
      </div>

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
