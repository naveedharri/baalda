import { useEffect, useRef, useState } from "react";
import { DEFAULT_SERVER_URL } from "../lib/api";
import type { AccountSettingsTab } from "../lib/settingsTabs";
import { authManager } from "../lib/auth/authManager";
import { readRecentServers, switchServer } from "../lib/auth/recentServers";
import { normalizeServerUrl, serverHost } from "../lib/auth/serverChoice";
import {
  ACTIVITY_STATUSES,
  STATUS_MOMENTS,
  EDITOR_FONTS,
  type EditorFont,
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
import { updateView } from "../lib/updateView";
import appIcon from "../assets/brand/app-icon.png";
import {
  CHARACTER_PREFIX,
  PROFILE_CHARACTER_SEEDS,
  PROFILE_IMAGE_MAX_CHARS,
  PROFILE_IMAGE_PX,
} from "../lib/profileAvatar";
import { imageFileToSquareDataUrl } from "../lib/squareImage";
import { InstalledAgentsList } from "./DashboardAgentRunner";
import { AccountPlanTab } from "./AccountPlanTab";
import { AccountVaultsTab } from "./AccountVaultsTab";
import { AiToolsTab } from "./skills/AiToolsTab";
import { Avatar } from "./Avatar";
import { serverFailureMessage } from "./serverFailureMessage";
import { SecurityCodeField } from "./SecurityCodeField";
import { VaultKeySection } from "./VaultKeySection";
import { onVaultKeyEvent, vaultKeyStateFor } from "../lib/vaultKeys/runtime";
import { syncManager } from "../lib/sync/docSession";
import { SettingsModal } from "./SettingsModal";
import { SettingsCrossLink } from "./SettingsCrossLink";
import { Switch } from "./Switch";
import { AppearanceRows } from "./AppearanceRows";
import { MenuSelect } from "./MenuSelect";
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
    id: "encryption",
    label: "Encryption",
    icon: (
      <Icon>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
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
    id: "ai-tools",
    label: "AI tools",
    icon: (
      <Icon>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
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
              onOpen={() => useStore.getState().requestSettings("general")}
            />
          )}
        </nav>

        <section key={tab} className="settings-content rd-tab-in" aria-label={activeTab.label}>
          <h2 className="settings-section-title">{activeTab.label}</h2>
          {tab === "profile" ? (
            <ProfileTab />
          ) : tab === "status" ? (
            <StatusTab />
          ) : tab === "plan" ? (
            <AccountPlanTab />
          ) : tab === "vaults" ? (
            <AccountVaultsTab />
          ) : tab === "encryption" ? (
            <EncryptionTab />
          ) : tab === "appearance" ? (
            <AppearanceTab />
          ) : tab === "notifications" ? (
            <NotificationsTab />
          ) : tab === "ai-tools" ? (
            <AiToolsTab />
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
      {/* Settings rows: title + one-line hint on the left, the control on the
          right, so a section title, a label and a value never read alike. */}
      <div className="profile-rows">
        <div className="profile-row">
          <div className="profile-row-label">
            <span className="profile-row-title">Photo</span>
            <span className="profile-row-hint">
              A picture or a character. Teammates see it in the sidebar and on your cursor.
            </span>
          </div>
          <div className="profile-row-control profile-photo-control">
            <Avatar
              label={trimmedName || session.user.email}
              image={trimmedImage || null}
              userId={session.user.id}
            />
            <ProfilePictureActions image={trimmedImage} onChange={changeImage} onError={setError} />
          </div>
        </div>

        <div className="profile-row profile-row-top">
          <div className="profile-row-label">
            <span className="profile-row-title">Character</span>
            <span className="profile-row-hint">Pick one instead of a photo.</span>
          </div>
          <div className="profile-row-control">
            <ProfileCharacterGrid
              label={trimmedName || session.user.email}
              userId={session.user.id}
              image={trimmedImage}
              onChange={changeImage}
            />
          </div>
        </div>

        <div className="profile-row">
          <label className="profile-row-label" htmlFor="profile-display-name">
            <span className="profile-row-title">Display name</span>
            <span className="profile-row-hint">Shown next to your notes and cursor.</span>
          </label>
          <div className="profile-row-control">
            <input
              id="profile-display-name"
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
          </div>
        </div>

        <div className="profile-row profile-row-top">
          <div className="profile-row-label">
            <span className="profile-row-title">Email</span>
            <span className="profile-row-hint">Used to sign in and for invitations.</span>
          </div>
          <div className="profile-row-control">
            <div className="profile-email">
              <span className="profile-email-value">{session.user.email}</span>
              {/* Verification state, live: the confirmation link bounces back
                  into the app (`baalda://verified`), which re-reads the session,
                  so this flips without a reload. `emailVerified` is absent on
                  very old servers: say nothing rather than "not confirmed". */}
              {session.user.emailVerified === true && (
                <span className="profile-pill ok">Confirmed</span>
              )}
              {session.user.emailVerified === false && (
                <span className="profile-pill warn">Not confirmed</span>
              )}
            </div>
            {session.user.emailVerified === false && (
              <span className="profile-row-hint profile-email-hint">
                Check your inbox for the confirmation email.{" "}
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
          </div>
        </div>
      </div>

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
          Use default
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
  // A status moment ("Coffee break") is none of the four options below, which
  // left every radio unticked with no word about what was actually set.
  const moment = STATUS_MOMENTS.find((m) => m.id === activityStatus);

  return (
    <div className="status-tab">
      <p className="muted">
        Your status shows next to your cursor for teammates working in the same note.
      </p>
      {moment && (
        <p className="field-hint">
          Right now: {moment.label}, set from the account menu. Pick a status below to replace it.
        </p>
      )}
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
  const editorFont = useStore((s) => s.editorFont);
  const homeSectionHidden = useStore((s) => s.homeSectionHidden);
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
    <>
    <label className="menu-row toggle-row">
      <span className="menu-row-label">Show Home section
        <span className="field-hint">Turning this off unsets your Home and stops it opening at startup on this device.</span>
      </span>
      <Switch checked={!homeSectionHidden} ariaLabel="Show Home section"
        onChange={(show) => useStore.getState().setHomeSectionHidden(!show)} />
    </label>
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
    <div className="menu-row">
      <span className="menu-row-label">
        Note font
        <span className="field-hint">The typeface notes are written in, on this device.</span>
      </span>
      <MenuSelect<EditorFont>
        value={editorFont}
        options={EDITOR_FONTS.map((f) => ({ value: f.id, label: f.label, hint: f.hint }))}
        onSelect={(f) => useStore.getState().setEditorFont(f)}
        ariaLabel="Note font"
        triggerClassName="role-field-trigger"
      />
    </div>
    </>
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

export function ConnectionTab() {
  const serverUrl = useStore((s) => s.serverUrl);
  const addressInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(serverUrl);
  const [recent, setRecent] = useState(readRecentServers);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(serverUrl);
    // Read only: opening the tab must not reorder the history. Recents are
    // recorded by a switch that actually landed (`switchServer`).
    setRecent(readRecentServers());
  }, [serverUrl]);

  /**
   * Check the address answers BEFORE adopting it. Changing the server is a
   * de-facto sign-out (the session lives under a per-server keychain key), so a
   * typo used to swap a working session for a signed-out app and no message at
   * all — `save` had a `finally` and no `catch`.
   */
  // Compare the normalized address, so "https://x.example/" still selects
  // its recent entry instead of the placeholder.
  const draftUrl = normalizeServerUrl(draft);
  const selectedRecent = draftUrl && recent.includes(draftUrl) ? draftUrl : "";
  const activeUrl = normalizeServerUrl(serverUrl);

  const save = async () => {
    const url = normalizeServerUrl(draft);
    if (!url) {
      setError("That doesn't look like a server address. Try https://notes.example.com");
      return;
    }
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await authManager.api.health(url);
      // Another flow (an invite link's Connect, a sign-in) can take the switch
      // over; then nothing was saved here, so say nothing. The managed/custom
      // choice is written only once the switch landed.
      const switched = await switchServer(url, {
        switchTo: (next) => useStore.getState().setServerUrl(next),
        writeChoice: writeServerChoice,
        defaultUrl: DEFAULT_SERVER_URL,
        previousUrl: serverUrl,
      });
      if (!switched) return;
      setRecent(readRecentServers());
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(serverFailureMessage(e, url));
    } finally {
      setBusy(false);
    }
  };

  // Redesign: two clear choices. Baalda Cloud is the managed server; anything
  // else is "your own", which is the only case that needs an address typed.
  const cloudUrl = normalizeServerUrl(DEFAULT_SERVER_URL);
  const isCloud = draftUrl === cloudUrl;
  const pick = (url: string) => {
    setDraft(url);
    setSaved(false);
    setError(null);
  };

  return (
    <div className="connection-tab conn-b">
      <p className="field-hint">Choose where your notes sync. You sign in separately on each server.</p>
      <div className="conn-options" role="radiogroup" aria-label="Server">
        <button
          type="button"
          role="radio"
          aria-checked={isCloud}
          className={`conn-option${isCloud ? " is-selected" : ""}`}
          disabled={busy}
          onClick={() => pick(DEFAULT_SERVER_URL)}
        >
          <span className="conn-radio" aria-hidden="true" />
          <span className="conn-tile is-cloud" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 18a5 5 0 0 0-1-9.9 7 7 0 0 0-13 3.4A4 4 0 0 0 4 18h13z" /></svg>
          </span>
          <b>Baalda Cloud</b>
          <span className="conn-option-hint">Managed by us. Nothing to set up.</span>
        </button>
        <div
          role="radio"
          aria-checked={!isCloud}
          tabIndex={0}
          className={`conn-option${!isCloud ? " is-selected" : ""}`}
          onClick={() => {
            if (isCloud) pick(selectedRecent && selectedRecent !== cloudUrl ? selectedRecent : "");
            window.setTimeout(() => addressInput.current?.focus(), 0);
          }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
              e.preventDefault();
              if (isCloud) pick("");
              addressInput.current?.focus();
            }
          }}
        >
          <span className="conn-radio" aria-hidden="true" />
          <span className="conn-tile is-own" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>
          </span>
          <b>Your own server</b>
          <span className="conn-option-hint">Self-hosted Baalda. Your data, your machine.</span>
        </div>
      </div>
      {/* Below the two cards, not inside one: growing a card made both
          cards resize and jump whenever the choice flipped. */}
      {!isCloud && (
        <input
          ref={addressInput}
          className="conn-address"
          value={draft}
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="https://notes.example.com"
          aria-label="Server address"
          spellCheck={false}
          autoCapitalize="off"
        />
      )}
      {recent.length > 0 && (
        <div className="conn-recent">
          <span className="conn-recent-label">Recent</span>
          <div className="conn-chips" role="group" aria-label="Recent connections">
            {recent.map((url) => (
              <button
                key={url}
                type="button"
                className={`conn-chip${url === draftUrl ? " is-picked" : ""}${url === activeUrl ? " is-active" : ""}`}
                disabled={busy}
                aria-pressed={url === draftUrl}
                title={url === activeUrl ? `${url} (active)` : url}
                onClick={() => pick(url)}
              >
                {serverHost(url)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="conn-foot">
        <span className="conn-status" role="status">
          {saved ? "Reconnected." : `Connected to ${serverHost(serverUrl)}`}
        </span>
        <button
          type="button"
          className="primary sm"
          disabled={busy || !draft.trim() || normalizeServerUrl(draft) === serverUrl}
          onClick={() => void save()}
        >
          {busy && <span className="btn-spinner" aria-hidden="true" />}
          <span>Connect</span>
        </button>
      </div>
      {error && <div className="auth-error">{error}</div>}
    </div>
  );
}

function AboutTab({ onClose }: { onClose: () => void }) {
  const update = useUpdateState();
  const serverUrl = useStore((s) => s.serverUrl);
  const email = useStore((s) => s.session?.user.email ?? "");
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
  switch (update.phase) {
    case "checking":
      statusText = "Checking for updates…";
      break;
    case "uptodate":
      statusText = "You're on the latest version.";
      break;
    case "available":
      statusText = `Version ${update.version} found. Starting the download…`;
      break;
    case "downloading":
      statusText =
        update.total > 0
          ? `Downloading ${update.version}: ${Math.round((update.downloaded / update.total) * 100)}%`
          : `Downloading ${update.version}…`;
      break;
    case "installing":
      statusText = `Installing ${update.version}…`;
      break;
    case "ready":
      statusText = `Version ${update.version} is installed. Restarting shortly.`;
      break;
    case "pending":
      // The server already runs a newer release than the feed can serve yet;
      // the check retries on its own. Quiet on purpose — nothing is wrong.
      statusText = "An update is on its way.";
      break;
    case "error":
      statusText = `Couldn't check for updates: ${update.message}`;
      break;
    case "failed":
      statusText = `Couldn't install version ${update.version}${update.message ? `: ${update.message}` : ""}`;
      break;
  }

  return (
    <div className="about-tab">
      {/* One card for every update state, so nothing jumps between steps. */}
      <UpdateCard
        view={updateView(update, version)}
        statusText={statusText}
        busy={busy}
        onCheck={() => void checkAndAutoInstall()}
        onRestart={() => void relaunchForUpdate()}
      />

      <div className="profile-rows about-rows">
        <div className="profile-row profile-row-top">
          <div className="profile-row-label">
            <span className="profile-row-title">Installed agents</span>
            <span className="profile-row-hint">Used to update dashboards. Found when Baalda starts.</span>
          </div>
          <div className="profile-row-control">
            <InstalledAgentsList />
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-label">
            <span className="profile-row-title">Server</span>
            <span className="profile-row-hint">Where your notes sync.</span>
          </div>
          <div className="profile-row-control about-inline">
            <span className="about-value">
              <span className="about-live-dot" aria-hidden="true" />
              {serverHost(serverUrl)}
            </span>
          </div>
        </div>
        <div className="profile-row">
          <div className="profile-row-label">
            <span className="profile-row-title">Account</span>
            <span className="profile-row-hint">Signing out keeps your notes on this computer.</span>
          </div>
          <div className="profile-row-control about-inline">
            <span className="about-value">{email}</span>
            <button
              type="button"
              className="about-signout"
              onClick={() => {
                onClose();
                void useStore.getState().signOut();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** About's update card: mark, version and status, the one action, progress. */
function UpdateCard({
  view,
  statusText,
  busy,
  onCheck,
  onRestart,
}: {
  view: ReturnType<typeof updateView>;
  statusText: string | null;
  busy: boolean;
  onCheck: () => void;
  onRestart: () => void;
}) {
  return (
    <div className={`update-card is-${view.tone}`}>
      <div className="update-card-row">
        <img className="update-card-mark is-icon" src={appIcon} alt="" aria-hidden="true" />
        <div className="update-card-text">
          <span className="update-card-title">{view.title}</span>
          <span className="update-card-sub" role="status" aria-live="polite">
            {view.tone === "ok" || view.tone === "ready" ? <span className="update-card-dot" aria-hidden="true" /> : null}
            {view.sub || statusText}
          </span>
        </div>
        {view.tone === "busy" && view.percent === null && <span className="btn-spinner update-card-spin" aria-hidden="true" />}
        {view.action === "restart" ? (
          <button type="button" className="update-card-btn is-ink" onClick={onRestart}>
            Restart now
          </button>
        ) : view.action ? (
          <button type="button" className="update-card-btn" disabled={busy} onClick={onCheck}>
            {view.action === "retry" ? "Try again" : "Check for updates"}
          </button>
        ) : null}
      </div>
      {view.percent !== null && (
        <span className="update-card-bar" aria-hidden="true">
          <b style={{ width: `${view.percent}%` }} />
        </span>
      )}
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

/** What is encrypted and what is not. Plain words, and never "end to end":
 *  the server process sees plaintext while it works (docs/VAULT_KEYS.md). */
const ENCRYPTED = ["Note text", "Version history", "Search index", "Public link tokens"];
const NOT_ENCRYPTED = ["Note titles and folder names", "Attachments and files", "Who is in the vault and their access"];

/** The hero card's words for one vault-key state. */
function encryptionStatus(
  state: string | null | undefined,
  synced: boolean,
): { tone: "on" | "wait" | "off" | "warn"; title: string; detail: string } {
  if (!synced) {
    return { tone: "off", title: "Nothing to show yet", detail: "Open a synced vault to see whether it is encrypted." };
  }
  switch (state) {
    case "ready":
      return {
        tone: "on",
        title: "Encrypted",
        detail: "Note text, history and search are stored encrypted. This computer holds the key.",
      };
    case "waiting-for-teammate":
      return {
        tone: "wait",
        title: "Waiting for the key",
        detail: "A teammate's device shares it automatically, usually within 2 minutes of them being online.",
      };
    case "unkeyed":
      return {
        tone: "off",
        title: "Not encrypted yet",
        detail: "Every vault is encrypted automatically. This one switches over on its own as soon as its key can't be lost.",
      };
    case "needs-account-key":
    case "security-warning":
    case "key-mismatch":
      return {
        tone: "warn",
        title: "Needs attention",
        detail: "This computer cannot use the vault key right now. See the details below.",
      };
    default:
      return {
        tone: "off",
        title: "Not available on this server",
        detail: "This server does not have vault encryption turned on yet.",
      };
  }
}

/**
 * Account Settings → Encryption: everything about vault keys on one page./**
 * Account Settings → Encryption: everything about vault keys on one page.
 * The open vault's status and key actions (the same card Vault Settings →
 * General leads with), this account's security code, and what the key covers.
 */
function EncryptionTab() {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const members = useStore((s) => s.members);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const activeOrg = organizations.find((o) => o.id === session?.activeOrganizationId) ?? null;
  const me = members.find((m) => m.userId === session?.user.id);
  const canManage = me?.role === "owner" || me?.role === "admin";
  const isOwner = me?.role === "owner";

  const [, bump] = useState(0);
  useEffect(() => onVaultKeyEvent(() => bump((n) => n + 1)), []);
  const synced = !!(activeOrg && syncEnabled);
  const status = encryptionStatus(synced ? vaultKeyStateFor(syncManager.registry.vaultId)?.state : null, synced);

  return (
    <div className="encryption-page">
      <section className={`encryption-hero is-${status.tone}`}>
        <span className="encryption-hero-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />
            {status.tone === "on" ? <path d="m8.8 12.2 2.2 2.2 4.3-4.6" /> : <path d="M12 8.5v4M12 15.5h.01" />}
          </svg>
        </span>
        <div className="encryption-hero-text">
          <span className="encryption-hero-vault">{synced ? activeOrg!.name : "No synced vault open"}</span>
          <h3>{status.title}</h3>
          <p>{status.detail}</p>
        </div>
      </section>

      <p className="encryption-lede">
        Notes are encrypted in our database with a key only your team&apos;s devices hold.
        Backups and admin tools see only scrambled text.
      </p>

      {synced && <VaultKeySection vaultName={activeOrg!.name} isOwner={isOwner} canManage={canManage} />}

      {/* Hidden by CSS until this computer has an account key to show. */}
      <div className="encryption-code">
        <div className="subhead">Your security code</div>
        <div className="profile-rows">
          <SecurityCodeField />
        </div>
        <p className="muted encryption-note">
          Teammates compare this code with yours when they share a vault key with you.
        </p>
      </div>

      <div className="subhead">What the key covers</div>
      <div className="encryption-cover">
        <div className="encryption-cover-col">
          <span className="encryption-cover-title is-on">Encrypted</span>
          <ul>
            {ENCRYPTED.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        <div className="encryption-cover-col">
          <span className="encryption-cover-title">Not encrypted</span>
          <ul>
            {NOT_ENCRYPTED.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="muted encryption-note">
        The server reads notes in memory while it works, to index search and keep versions, so
        this is encryption at rest, not end to end.
      </p>
    </div>
  );
}
