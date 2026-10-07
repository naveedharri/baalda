/* The vault-settings dialog and its nine tabs — the whole settings surface of
   the app, split out of `AccountMenu.tsx` so it can load on demand. Nothing
   here is on the first screen: the sidebar footer (identity bar + popovers)
   stays eager, and this chunk lands when someone actually opens settings. */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  type BillingUsage,
  type McpToolInfo,
  type McpTokenRow,
  type MyBillingVault,
  type UnsyncPreview,
  type VaultCheckpoint,
} from "../lib/api";
import { toast } from "../lib/toast";
import { agoFromIso, checkpointTitle, noteCountLabel } from "./versionFormat";
import { authManager } from "../lib/auth/authManager";
import {
  classifyLimitError,
  formatBytes,
  LEGACY_PRO_BENEFITS,
  legacyFreePlanExplanation,
  type LimitKind,
  limitFromError,
  planPillLabel,
  subscriptionStatusLine,
  transferTargets,
  vaultLimitReason,
} from "../lib/billing";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { MembersAccessTab, prefetchRoster } from "./MembersAccessTab";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { useResetLocalCopy } from "./useResetLocalCopy";
import { AiSettingsTab } from "./AiSettingsTab";
// Static, not via ./Face: this module is itself a lazy chunk, so it pays for
// the avatar chunk it is already loading.
import { LimitNudge } from "./LimitNudge";
import { MenuIcon } from "./MenuIcon";
import { SettingsModal } from "./SettingsModal";
import { SettingsCrossLink } from "./SettingsCrossLink";
import { Switch } from "./Switch";
import { ThemeToggle } from "./ThemeToggle";
import { AppearanceRows } from "./AppearanceRows";
import { VaultItemColorsSection } from "./VaultItemColorsSection";
import {
  APPEARANCE_DEFAULTS,
  vaultAppearanceValues,
  type AppearanceKey,
  type AppearanceSettings,
  type ResolvedAppearance,
} from "../lib/appearanceSettings";
import { formatPrice, perLabel, UpgradeDialog } from "./UpgradeDialog";
import { useLocalFolderClasses, useLocalVaults } from "./useVaultLists";
import { visibleFolders } from "../lib/vault/vaultList";
import { VaultIconSettings } from "./VaultIconSettings";
import { AccountVaultsTab } from "./AccountVaultsTab";

// Defined in `lib/settingsTabs.ts` so the store can name a tab without importing
// this component; re-exported here so every existing importer is unchanged.
export type { SettingsTab } from "../lib/settingsTabs";
import type { SettingsTab } from "../lib/settingsTabs";

// Sections that only make sense once the vault is synced to an org. On a
// local vault they're shown but locked, with a "Turn on sync" gate.
//
// Billing is deliberately NOT one of them (#109). Someone working in a local
// folder can still own vaults that are billing, and a subscription left behind
// by a DELETED vault has to be reachable from somewhere or the money is
// unrecoverable. Only the per-vault card at the top of that tab needs a synced
// vault, and it says so itself.
const TEAM_TABS = new Set<SettingsTab>([
  "members",
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

/** The AI (Beta) page is hidden for now; flip to bring it back. Anything that
 *  asks for the "ai" tab while it is hidden lands on General instead. */
const SHOW_AI_TAB = false;

const AI_TAB: { id: SettingsTab; label: string; icon: React.ReactNode } = {
  id: "ai", label: "AI", icon: <MenuIcon><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></MenuIcon>,
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
    label: "Members and access",
    icon: (
      <MenuIcon>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
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
 * Vault settings — a centered modal over the app (sharing its shell with
 * Account settings via {@link SettingsModal}): everything about the vault lives
 * here. Members (roster + join code + invites), Permissions (RBAC locks), and
 * Appearance (theme + item colors).
 */
export function VaultSettingsDialog({
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

  const visibleTab = (t: SettingsTab): SettingsTab =>
    (!SHOW_AI_TAB && t === "ai") || (t === "vaults" && session) ? "general" : t;
  const [tab, setTabRaw] = useState<SettingsTab>(visibleTab(initialTab ?? "general"));
  /** Bumped when the active nav item is clicked again, so a tab can return to its first page. */
  const [tabReset, setTabReset] = useState(0);
  const setTab = (t: SettingsTab) => setTabRaw(visibleTab(t));

  // Esc, click-away, focus and the backdrop all live in `SettingsModal`.
  const activeOrg =
    organizations.find((o) => o.id === session?.activeOrganizationId) ?? null;
  // Is the vault we're looking at actually syncing to an org? A local
  // vault (signed out, or an unsynced local folder) shows a reduced page
  // with the team sections locked behind "Turn on sync".
  const isSynced = syncEnabled && !!activeOrg;
  const billingEnabled = billingConfig?.enabled === true;
  // Team model: the plan lives on the account (Account Settings → Plan &
  // Billing), so this vault's page shows its usage. Same tab id, so a
  // `requestSettings("billing")` deep link still lands here.
  const teamBilling = billingConfig?.model === "team";

  // The vault list lives in Account Settings → Vaults (2026-10-07). Only a
  // signed-out app with local folders keeps it here: it has no account page.
  // Signed out every stamped folder is hidden there (`visibleFolders`), so the
  // tab appears only when an unstamped local folder remains to list.
  const localClasses = useLocalFolderClasses(session ? [] : locals, []);
  const showVaults =
    !session &&
    localClasses.resolved &&
    visibleFolders(locals, localClasses.classes).length > 0;
  const tabs = useMemo(() => {
    const out = SHOW_AI_TAB ? [GENERAL_TAB, AI_TAB] : [GENERAL_TAB];
    if (showVaults) out.push(...SETTINGS_TABS);
    else out.push(...SETTINGS_TABS.filter((t) => t.id !== "vaults"));
    if (billingEnabled) {
      const idx = out.findIndex((t) => t.id === "members");
      out.splice(
        idx >= 0 ? idx + 1 : out.length,
        0,
        teamBilling ? { ...BILLING_TAB, label: "Usage" } : BILLING_TAB,
      );
    }
    return out;
  }, [showVaults, billingEnabled, teamBilling]);

  // Warm the Members tab's roster as the dialog opens (#307); paint only.
  useEffect(() => {
    const orgId = session?.activeOrganizationId ?? null;
    const me = members.find((m) => m.userId === session?.user.id);
    if (!orgId || !me) return;
    prefetchRoster(orgId, me.role === "owner" || me.role === "admin");
  }, [session, members]);

  if (!session && !vault) return null;
  const myMember = members.find((m) => m.userId === session?.user.id);
  const canManage = myMember?.role === "owner" || myMember?.role === "admin";
  // Stricter than `canManage`: making a vault local only destroys the server
  // copy for everyone, so an admin may not do it (the server agrees — 403
  // `owner_only`) and the control simply isn't drawn for them.
  const isOwner = myMember?.role === "owner";
  const activeTab = tabs.find((t) => t.id === tab) ?? tabs[0];
  const lockedTab = TEAM_TABS.has(activeTab.id) && !isSynced;
  // Render what the nav shows: a requested tab that is not offered yet (the
  // signed-out Vaults list before the recents load) paints the first tab.
  const shown = activeTab.id;

  return (
    <SettingsModal
      label={isSynced ? "Vault settings" : "Local vault settings"}
      onClose={onClose}
    >
      <header className="settings-page-header">
        <div className="settings-title">
          <span className="settings-eyebrow">
            {isSynced ? "Vault settings" : "Local vault"}
          </span>
          {/* The session's active org outlives a switch to a local folder, so
              its name only titles the dialog while that vault is the synced one. */}
          <h1>{(isSynced ? activeOrg?.name : null) ?? vault?.name ?? "Vault"}</h1>
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
                className={`menu-item${t.id === "ai" ? " settings-ai-item" : ""}${tab === t.id ? " active" : ""}${locked ? " locked" : ""}`}
                onClick={() => {
                  // Re-clicking the active item resets its sub-pages (#308).
                  if (tab === t.id) setTabReset((n) => n + 1);
                  else setTab(t.id);
                }}
                title={locked ? "Turn on sync to unlock" : undefined}
              >
                {t.icon}
                <span className="menu-item-label">{t.id === "ai" ? "AI (Beta)" : t.label}</span>
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
          {session && (
            <SettingsCrossLink
              label="Account settings"
              onOpen={() => {
                onClose();
                useStore.getState().requestAccountSettings("profile");
              }}
            />
          )}
        </nav>

        <section className="settings-content" aria-label={activeTab.label}>
          {/* Members and access swaps its title for a back link while a profile
              is open. */}
          {!(shown === "members" && !lockedTab) && <h2 className="settings-section-title">{activeTab.label}</h2>}
          {shown === "general" ? (
            <GeneralTab
              isSynced={isSynced}
              canManage={canManage}
              isOwner={isOwner}
              activeOrgName={activeOrg?.name ?? null}
              onRequestSignIn={onRequestSignIn}
            />
          ) : shown === "ai" ? (
            <AiSettingsTab onClose={onClose} onGoToGeneral={() => setTab("general")} />
          ) : lockedTab ? (
            <SyncGate label={activeTab.label} onGoToSync={() => setTab("general")} />
          ) : shown === "vaults" ? (
            <AccountVaultsTab />
          ) : shown === "members" ? (
            <MembersAccessTab
              canManage={canManage}
              onOpenTab={setTab}
              onCloseSettings={onClose}
              resetToken={tabReset}
            />
          ) : shown === "billing" ? (
            <BillingTab canManage={canManage} isSynced={isSynced} />
          ) : shown === "mcp" ? (
            <McpTab />
          ) : shown === "versioning" ? (
            <VersioningTab canManage={canManage} />
          ) : shown === "import-export" ? (
            <ImportExportTab />
          ) : (
            <AppearanceTab canManage={canManage} isSynced={isSynced} />
          )}
        </section>
      </div>
    </SettingsModal>
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
  isOwner,
  activeOrgName,
  onRequestSignIn,
}: {
  isSynced: boolean;
  /** Owner/admin — the only roles that may flip a vault-wide latch. */
  canManage: boolean;
  /** Owner alone — the only role that may destroy the server copy. */
  isOwner: boolean;
  activeOrgName: string | null;
  onRequestSignIn?: () => void;
}) {
  const vault = useStore((s) => s.vault);
  const authStatus = useStore((s) => s.authStatus);
  // The sidebar paints before the session restore finishes, so this page can be
  // open while we still don't know whether anyone is signed in.
  const authPending = authStatus === "unknown";
  const activeOrgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  // Same identity the sidebar switcher keys its icons on.
  const iconIdentity =
    isSynced && activeOrgId ? `org:${activeOrgId}` : vault ? `local:${vault.path}` : null;

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
      if (kind) {
        const limit = limitFromError(e);
        setLimitNudge({ kind, limit });
        // Team model: the refusal IS the upgrade moment, so the plan comparison
        // opens at once; the nudge stays behind it for after a close.
        const st = useStore.getState();
        if (kind === "vault_limit" && st.billingConfig?.model === "team") {
          st.requestUpgradeDialog({
            reason: vaultLimitReason(limit ?? st.billingConfig.freeLimits?.vaultsPerUser ?? 1),
          });
        }
      } else {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        // The inline line can be scrolled out of view, and the button simply
        // returns to idle — which reads as "nothing happened". A sticky toast is
        // always visible (#85).
        toast(`Couldn't turn on sync — ${message}`, "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {iconIdentity && (
        <>
          {/* One icon per vault. A synced vault's belongs to the org: members see
              the owner's picker with every action disabled. */}
          <VaultIconSettings
            identity={iconIdentity}
            name={(isSynced ? activeOrgName : null) ?? vault?.name ?? ""}
            canEdit={!isSynced || canManage}
          />
          {/* A synced vault's next row (Freeze vault root) brings its own divider. */}
          {!isSynced && <div className="menu-sep" />}
        </>
      )}
      {!isSynced && (
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
              Enables live collaboration and lets you invite people. Everyone in the
              vault can edit by default; you choose who sees what.
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
              {/* Disabled while the session restore runs: its answer decides
                  whether this button turns sync on or raises a sign-in card,
                  and pressing it in between would do the wrong one. */}
              <button
                className="primary"
                disabled={busy || authPending}
                onClick={() => void turnOn()}
              >
                {busy
                  ? "…"
                  : authPending
                    ? "Checking your account…"
                    : authStatus === "signed-in"
                      ? "Turn on sync"
                      : "Sign in to turn on"}
              </button>
            </div>
            {!authPending && authStatus !== "signed-in" && (
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

      {isSynced && canManage && <FreezeRootRow canManage={canManage} />}

      <div className="menu-sep" />
      <div className="subhead">Folder on disk</div>
      <div className="join-code-row">
        <code className="vault-root-path" title={vault?.path ?? ""}>
          {vault?.path ?? "—"}
        </code>
      </div>

      {isSynced && isOwner && <UnsyncDangerZone />}

      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

/**
 * The mirror of "Turn on sync": take the vault back off the server and keep the
 * folder. Owner-only, at the bottom of the page, behind a type-the-name confirm
 * — the three things that stop a mis-click on the one action in this dialog that
 * destroys other people's access.
 *
 * The counts come from the preview call rather than from anything this device
 * knows: what matters is what the SERVER is about to lose (edit history, version
 * checkpoints, public links, MCP tokens), none of which the local index can see.
 */
function UnsyncDangerZone() {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const orgName = useStore(
    (s) =>
      s.organizations.find((o) => o.id === s.session?.activeOrganizationId)?.name ?? null,
  );
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const serverUrl = useStore((s) => s.serverUrl);
  const [preview, setPreview] = useState<UnsyncPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const reset = useResetLocalCopy();

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    authManager.api
      .getUnsyncPreview(orgId)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      // A preview that won't load must not hide the control: the confirm asks
      // again, and the server is the gate either way.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (!orgId || !orgName) return null;
  const folder = vaultPath ? (vaultPath.split("/").pop() ?? vaultPath) : null;

  return (
    <>
      <div className="menu-sep" />
      <div className="subhead">Danger zone</div>
      {reset.available && (
        <div className="vault-local-only-card">
          <span className="vault-local-only-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
            </svg>
          </span>
          <div className="vault-local-only-copy">
            <strong>Reset local copy</strong>
            <span className="field-hint">
              Delete {folder ? <>the <strong>{folder}</strong> folder</> : "this vault's folder"} on this
              device and download a fresh copy from {serverHost(serverUrl)}. Nothing changes for your team.
            </span>
          </div>
          <button className="vault-local-only-action" onClick={reset.start}>
            Reset
          </button>
        </div>
      )}
      <div className="vault-local-only-card">
        <span className="vault-local-only-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 2.5 20h19L12 3Z" />
            <path d="M12 9v5M12 17h.01" />
          </svg>
        </span>
        <div className="vault-local-only-copy">
          <strong>Make this vault local only</strong>
          <span className="field-hint">
            {folder ? (
              <>
                Keep the <strong>{folder}</strong> folder on this device and remove its synced copy
                from {serverHost(serverUrl)}.
              </>
            ) : (
              <>Keep the local folder on this device and remove its synced copy from {serverHost(serverUrl)}.</>
            )}{" "}
            {preview ? (
              <>
                The server copy of {preview.notes} note{plural(preview.notes)} and {preview.files} file
                {plural(preview.files)}, version history, and sharing will be deleted.{" "}
                {preview.members > 0
                  ? `${preview.members} teammate${plural(preview.members)} lose access.`
                  : "No teammates currently have access."}
              </>
            ) : (
              "Checking what will be removed…"
            )}
          </span>
        </div>
        <button className="vault-local-only-action" onClick={() => setConfirming(true)}>
          Make local only
        </button>
      </div>
      {reset.dialog}
      {confirming && (
        <UnsyncConfirmDialog
          orgId={orgId}
          orgName={orgName}
          folderName={folder}
          seed={preview}
          onCancel={() => setConfirming(false)}
          onDone={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** "1 note" / "2 notes", without reaching for a formatting library. */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** Just the host of the server URL — the whole URL is noise inside a sentence. */
function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/**
 * The confirm for "make local only".
 *
 * Wraps the shared `ConfirmDialog` rather than replacing it, and uses its
 * `confirmDisabled` for a type-the-vault-name gate: this is the one action in
 * the app that destroys data for people who are not at the keyboard, so there is
 * deliberately no path from a single click to done.
 *
 * On failure the dialog STAYS OPEN so the server's reason (403 `owner_only`, a
 * 409 `name_mismatch`, the 502 a refusing billing provider produces) has
 * somewhere to show, with a sticky error toast beside it — a destructive path
 * must never look like a success (#85). Nothing was destroyed in that case: the
 * store only touches this device once the server has answered.
 */
export function UnsyncConfirmDialog({
  orgId,
  orgName,
  folderName,
  seed,
  onCancel,
  onDone,
}: {
  orgId: string;
  orgName: string;
  folderName: string | null;
  /** An already-loaded preview, so the page and the dialog don't both count. */
  seed?: UnsyncPreview | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const serverUrl = useStore((s) => s.serverUrl);
  const [preview, setPreview] = useState<UnsyncPreview | null>(seed ?? null);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (seed) return;
    let cancelled = false;
    setLoading(true);
    authManager.api
      .getUnsyncPreview(orgId)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, seed]);

  const run = async () => {
    setError(null);
    try {
      await useStore.getState().unsyncVault(orgId, orgName);
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(`Couldn't make the vault local only — ${message}`, "error");
    }
  };

  const teamBilling = useStore((s) => s.billingConfig?.model === "team");
  // On Team-model servers billing belongs to the owner's account, not the
  // vault, so removing a vault never ends a subscription.
  const sub = teamBilling ? null : (preview?.subscription ?? null);

  return (
    <ConfirmDialog
      title={`Make ${orgName} local only?`}
      confirmLabel="Make local only"
      // The name has to match exactly. The server re-checks it too (409
      // `name_mismatch`), so a slip here can't get past either gate.
      confirmDisabled={loading || typed.trim() !== orgName}
      onCancel={onCancel}
      onConfirm={run}
    >
      <p>
        Your files stay where they are.{" "}
        {folderName ? (
          <>
            <strong>{folderName}</strong> on this device keeps every note and
            attachment as ordinary files.
          </>
        ) : (
          "This device keeps every note and attachment as ordinary files."
        )}
      </p>
      <p>
        <strong>Deleted from {serverHost(serverUrl)}, permanently:</strong>
      </p>
      {loading && !preview ? (
        <p className="muted">Counting what would be deleted…</p>
      ) : preview ? (
        <ul className="confirm-list">
          <li>
            {preview.notes} note{plural(preview.notes)} and {preview.files} file
            {plural(preview.files)}, with all of their edit history
            {preview.checkpoints > 0
              ? ` and ${preview.checkpoints} version checkpoint${plural(preview.checkpoints)}`
              : ""}
          </li>
          {preview.members > 0 && (
            <li>
              {preview.members} teammate{plural(preview.members)} lose access
              immediately; their own local copies are kept
            </li>
          )}
          {preview.publicLinks > 0 && (
            <li>
              {preview.publicLinks} public share link{plural(preview.publicLinks)} stop
              working
            </li>
          )}
          {preview.mcpTokens > 0 && (
            <li>
              {preview.mcpTokens} MCP token{plural(preview.mcpTokens)} stop working — AI
              clients lose access
            </li>
          )}
        </ul>
      ) : null}
      {sub && (
        <p>
          {sub.currentPeriodEnd
            ? `Pro ends on ${formatDate(sub.currentPeriodEnd)} — until then you can move the subscription to another vault from Billing.`
            : "Pro ends when the current period does — until then you can move the subscription to another vault from Billing."}
        </p>
      )}
      <p>This cannot be undone. Teammates cannot get the vault back from us.</p>
      <label className="confirm-type">
        <span>
          Type <strong>{orgName}</strong> to confirm
        </span>
        <input
          autoFocus
          value={typed}
          spellCheck={false}
          placeholder={orgName}
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      {error && <div className="auth-error">{error}</div>}
    </ConfirmDialog>
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
        <Switch
          checked={rootFrozen}
          disabled={!canManage || busy}
          ariaLabel="Freeze vault root"
          title={canManage ? undefined : "Only an owner or admin can change this"}
          onChange={(next) => void flip(next)}
        />
      </label>
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

/** One stat tile on the team-mode Usage tab. */
interface UsageTile {
  key: string;
  caption: string;
  value: string;
  sub: string;
  meter?: { used: number; limit: number } | null;
}

/** "1.2 MB" → { value: "1.2", unit: "MB" }; plain bytes read as "bytes". */
function splitBytes(n: number): { value: string; unit: string } {
  const [value, unit] = formatBytes(n).split(" ");
  return { value, unit: unit === "B" ? "bytes" : unit };
}

/**
 * Team model: the active vault's billing card. A user owns exactly one billing
 * account (`billing/accounts.ts`), so the only destination a move can have is
 * the caller's own account: an owner whose vault is billed on a co-owner's
 * account gets "Move to my account". There is no picker because the server
 * accepts no other destination (`POST /billing/orgs/:orgId/move` requires the
 * caller to own both the vault and the destination account).
 */
function TeamVaultBillingCard({
  orgId,
  isSynced,
  vaultName,
  isOwner,
  plan,
  vaultAccountId,
  onMoved,
}: {
  orgId: string | null;
  isSynced: boolean;
  vaultName: string | null;
  isOwner: boolean;
  plan: "free" | "pro" | "team";
  vaultAccountId: string | null;
  onMoved: () => Promise<unknown>;
}) {
  // Only an owner can move, so only an owner needs (or lazily creates) their account.
  const [myAccountId, setMyAccountId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitNudge, setLimitNudge] = useState<{ kind: LimitKind; limit: number | null } | null>(
    null,
  );

  // This vault's usage, read from the account it is billed on (any member may
  // read it with `orgId`). `undefined` = loading, `null` = unavailable.
  const [usage, setUsage] = useState<BillingUsage | null | undefined>(undefined);

  useEffect(() => {
    if (!isOwner) return;
    let live = true;
    authManager.api
      .getBillingAccount()
      .then((a) => { if (live) setMyAccountId(a.id); })
      .catch(() => {});
    return () => { live = false; };
  }, [isOwner, orgId]);

  useEffect(() => {
    if (!orgId) {
      setUsage(null);
      return;
    }
    let live = true;
    setUsage(undefined);
    authManager.api
      .getBillingUsage({ orgId })
      .then((u) => { if (live) setUsage(u); })
      .catch(() => { if (live) setUsage(null); });
    return () => { live = false; };
  }, [orgId, vaultAccountId]);

  const usageRow = usage?.vaults.find((v) => v.orgId === orgId) ?? null;
  const isFree = plan === "free";

  const elsewhere = isOwner && !!myAccountId && !!vaultAccountId && vaultAccountId !== myAccountId;
  const label = vaultName ?? "this vault";

  const runMove = async () => {
    if (!orgId || !myAccountId) return;
    setError(null);
    setLimitNudge(null);
    try {
      await authManager.api.moveVault(orgId, myAccountId);
      setConfirming(false);
      await onMoved();
      toast(`${vaultName ?? "The vault"} is now on your account.`);
    } catch (e) {
      const body = e instanceof ApiError && e.body && typeof e.body === "object"
        ? (e.body as Record<string, unknown>)
        : null;
      const code = body ? (body.code ?? body.error) : null;
      if (e instanceof ApiError && e.status === 400 && code === "same_account") {
        // Already there (another device moved it): just catch up.
        setConfirming(false);
        await onMoved();
        return;
      }
      if (e instanceof ApiError && e.status === 409 && code === "vault_limit_reached") {
        setConfirming(false);
        setLimitNudge({
          kind: "vault_limit",
          limit: typeof body?.limit === "number" ? body.limit : null,
        });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(`Couldn't move the vault — ${message}`, "error");
    }
  };

  // Tiles: the four counts always; on Free, People carries a meter against the
  // account's ceiling and a Synced vaults tile joins only when a vault limit exists.
  const loading = usage === undefined;
  const syncedVaults = usage ? (usage.totals.vaults ?? usage.vaults.length) : 0;
  const bytes = usageRow ? splitBytes(usageRow.storageBytes) : null;
  const tiles: UsageTile[] = [
    {
      key: "people",
      caption: "People",
      value: loading ? "…" : String(usageRow?.people ?? 0),
      sub:
        isFree && usage?.limits.people != null
          ? `of ${usage.limits.people} on this account`
          : (usageRow?.people ?? 0) === 1 ? "person" : "people",
      meter:
        isFree && usage?.limits.people != null && usageRow
          ? { used: usageRow.people, limit: usage.limits.people }
          : null,
    },
    {
      key: "notes",
      caption: "Notes",
      value: loading ? "…" : String(usageRow?.notes ?? 0),
      sub: "in this vault",
    },
    {
      key: "attachments",
      caption: "Attachments",
      value: loading ? "…" : (bytes?.value ?? "0"),
      sub: bytes?.unit ?? "bytes",
    },
    {
      key: "files",
      caption: "Files",
      value: loading ? "…" : String(usageRow?.files ?? 0),
      sub: "in this vault",
    },
  ];
  const freeBase = useStore.getState().billingConfig?.free?.syncedVaults ?? null;
  if (isFree && usage?.limits.vaults != null) {
    tiles.push({
      key: "vaults",
      caption: "Synced vaults",
      value: String(syncedVaults),
      sub:
        freeBase != null && usage.limits.vaults > freeBase
          ? `of ${usage.limits.vaults} on this account · includes vaults you had before`
          : `of ${usage.limits.vaults} on this account`,
      meter: { used: syncedVaults, limit: usage.limits.vaults },
    });
  }
  const pill = planPillLabel({ plan, status: isFree ? "none" : "active" });

  return (
    <>
      <div className="billing-card vault-usage">
        <div className="vault-usage-head">
          <span className={`billing-status ${isSynced ? "active" : "none"}`}>
            {isSynced ? "Synced" : "Not syncing on this computer"}
          </span>
        </div>
        {loading || (usageRow && usage) ? (
          <div className="vault-usage-tiles">
            {tiles.map((t) => {
              const full = !!t.meter && t.meter.limit > 0 && t.meter.used >= t.meter.limit;
              const pct = t.meter && t.meter.limit > 0
                ? Math.min(100, Math.round((t.meter.used / t.meter.limit) * 100))
                : 0;
              return (
                <div key={t.key} className="vault-usage-tile">
                  <span className="vault-usage-caption">{t.caption}</span>
                  <span className="vault-usage-value">{t.value}</span>
                  <span className="vault-usage-sub">{t.sub}</span>
                  {t.meter && !loading && (
                    <div
                      className={`vault-usage-meter${full ? " is-full" : ""}`}
                      role="meter"
                      aria-label={t.caption}
                      aria-valuemin={0}
                      aria-valuemax={t.meter.limit}
                      aria-valuenow={t.meter.used}
                    >
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="muted">Usage isn't available for this vault right now.</div>
        )}
        <div className="vault-usage-footer">
          <div className="vault-usage-footer-label">
            <span>
              {!isOwner
                ? "This vault is on its owner's account"
                : elsewhere
                  ? "This vault is billed on another account"
                  : "This vault is on your account"}
            </span>
            <span className={`billing-status ${isFree ? "none" : "active"}`}>{pill}</span>
          </div>
          <button
            className="secondary billing-action"
            onClick={() => useStore.getState().requestAccountSettings("plan")}
          >
            Open Plan &amp; Billing
          </button>
        </div>
        {elsewhere && (
          <div className="vault-usage-footer">
            <span className="vault-usage-footer-label">
              Bill it on your own account instead.
            </span>
            <button
              className="secondary billing-action"
              onClick={() => {
                setError(null);
                setLimitNudge(null);
                setConfirming(true);
              }}
            >
              Move to my account
            </button>
          </div>
        )}
        {error && <div className="auth-error">{error}</div>}
        {limitNudge && (
          <LimitNudge
            kind={limitNudge.kind}
            limit={limitNudge.limit}
            onUpgrade={() => useStore.getState().requestAccountSettings("plan")}
          />
        )}
        {confirming && (
          <ConfirmDialog
            tone="accent"
            title={`Move ${label} to your account?`}
            confirmLabel="Move to my account"
            onCancel={() => setConfirming(false)}
            onConfirm={runMove}
          >
            <p>
              Its people and limits will count on your account from now on, and it
              stops counting on the account it is on today. Notes, members and access
              stay exactly as they are.
            </p>
          </ConfirmDialog>
        )}
      </div>
    </>
  );
}

/**
 * BillingTab: the current vault's plan and seats, then every subscription the
 * signed-in user can act on (spec 04, #109/#110).
 *
 * Three sections, in the order someone reaching for this page needs them:
 * this vault (what am I on?), all my vaults (what am I paying for?), and
 * subscriptions from deleted vaults (what am I paying for that no longer
 * exists?). Facts are visible to every member; each action is gated to the
 * role the server will actually accept — Upgrade and Manage for owners and
 * admins, Transfer for owners only, because it changes who pays for what.
 *
 * Only the first section needs a synced vault; the other two are account-wide,
 * which is why this tab is no longer in TEAM_TABS.
 */
function BillingTab({ canManage, isSynced }: { canManage: boolean; isSynced: boolean }) {
  const billingConfig = useStore((s) => s.billingConfig);
  const orgBilling = useStore((s) => s.orgBilling);
  const myBilling = useStore((s) => s.myBilling);
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);

  // The vault the upgrade dialog should charge: the active one from the card
  // at the top, or any owned free vault picked out of the list below.
  const [upgradeOrg, setUpgradeOrg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A transfer being set up: the source row's Transfer was clicked and the
  // dialog is open. `targetOrgId` is the pick, null until one is made (or the
  // only eligible vault, pre-picked). It moves money between vaults, so the
  // dialog is where both the choice AND the confirmation happen — never a
  // popover that fires on the first click.
  const [transfer, setTransfer] = useState<{
    sourceOrgId: string;
    sourceLabel: string;
    targetOrgId: string | null;
  } | null>(null);
  // An orphaned subscription waiting on a "cancel now" confirmation.
  const [cancelling, setCancelling] = useState<{ orgId: string; label: string } | null>(
    null,
  );

  // Refresh this vault's seats AND the account-wide list whenever the tab opens.
  useEffect(() => {
    void useStore.getState().refreshOrgBilling();
    void useStore.getState().refreshMyBilling();
  }, []);

  const refreshAll = async () => {
    await Promise.all([
      useStore.getState().refreshMyBilling(),
      useStore.getState().refreshOrgBilling(),
    ]);
  };

  /** Open a vault's provider portal in the OS browser (owner/admin). */
  const openPortal = async (portalOrgId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await authManager.api.getBillingPortalUrl(portalOrgId);
      await ipc.openExternal(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Both confirmed actions leave their dialog OPEN on failure and report into
  // it, rather than closing over an error nobody sees. Neither re-throws — the
  // dialog's own AsyncButton has finished reporting by then.
  const runTransfer = async () => {
    if (!transfer || !transfer.targetOrgId) return;
    const { sourceOrgId, targetOrgId } = transfer;
    const targetName = vaults.find((v) => v.orgId === targetOrgId)?.name ?? "the vault";
    setError(null);
    try {
      await authManager.api.transferSubscription(sourceOrgId, targetOrgId);
      setTransfer(null);
      await refreshAll();
      toast(`Pro moved to ${targetName}.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(`Couldn't move the subscription — ${message}`, "error");
    }
  };

  const runCancelNow = async () => {
    if (!cancelling) return;
    const { orgId: target, label } = cancelling;
    setError(null);
    try {
      await authManager.api.cancelSubscription(target, "now");
      setCancelling(null);
      await refreshAll();
      toast(`Subscription for ${label} canceled.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(`Couldn't cancel the subscription — ${message}`, "error");
    }
  };

  if (!billingConfig?.enabled) {
    return (
      <div className="muted perm-empty">Billing isn't enabled on this server.</div>
    );
  }

  // Team model: billing lives on the owner's account (Account Settings → Plan &
  // Billing); this tab (labelled Usage) shows the vault's own usage. No per-vault subscription list and no transfer here.
  if (billingConfig.model === "team") {
    const row = myBilling?.vaults.find((v) => v.orgId === orgId) ?? null;
    const src = orgBilling ?? row;
    return (
      <TeamVaultBillingCard
        orgId={orgId}
        isSynced={isSynced}
        vaultName={row?.name ?? null}
        isOwner={row?.role === "owner"}
        plan={src?.accountPlan ?? src?.plan ?? "free"}
        vaultAccountId={src?.accountId ?? null}
        onMoved={refreshAll}
      />
    );
  }

  const vaults = myBilling?.vaults ?? [];
  const orphaned = myBilling?.orphaned ?? [];
  const freeLimits = myBilling?.freeLimits ?? null;

  /**
   * The Transfer control for one row. It opens the transfer dialog, where the
   * eligible destinations are laid out with their seats and plan and the move
   * is confirmed in the same place. With exactly one eligible vault it is
   * pre-picked, so the common case is still one click plus a confirm.
   *
   * No eligible vault ⇒ a disabled control that says why, rather than a menu
   * with nothing in it.
   */
  const transferControl = (sourceOrgId: string, sourceLabel: string) => {
    const targets = transferTargets(vaults, sourceOrgId);
    if (targets.length === 0) {
      return (
        <button
          className="link-btn"
          disabled
          title="Nowhere to move it — you need another vault you own that isn't already on Pro."
        >
          Transfer
        </button>
      );
    }
    return (
      <button
        type="button"
        className="link-btn"
        disabled={busy}
        aria-label={`Move ${sourceLabel}'s subscription to another vault`}
        onClick={() => {
          setError(null);
          setTransfer({
            sourceOrgId,
            sourceLabel,
            targetOrgId: targets.length === 1 ? targets[0].orgId : null,
          });
        }}
      >
        Transfer
      </button>
    );
  };

  /**
   * The transfer dialog body: the eligible destinations as selectable cards.
   * Each card carries what the reader weighs when choosing — the vault's
   * seats, and that it is on Free today — instead of a bare name.
   */
  const renderTransferDialog = () => {
    if (!transfer) return null;
    const targets = transferTargets(vaults, transfer.sourceOrgId);
    const target = targets.find((t) => t.orgId === transfer.targetOrgId) ?? null;
    // Owned vaults that are NOT offered, so the list's gaps are explained.
    const skipped = vaults.filter(
      (v) => v.orgId !== transfer.sourceOrgId && v.role === "owner" && !targets.includes(v),
    ).length;
    return (
      <ConfirmDialog
        tone="accent"
        title={`Move Pro from ${transfer.sourceLabel}`}
        confirmLabel={target ? `Move Pro to ${target.name}` : "Move subscription"}
        confirmDisabled={!target}
        onCancel={() => setTransfer(null)}
        onConfirm={runTransfer}
      >
        <p>
          Choose the vault that becomes Pro. It keeps the same billing period and
          price. <strong>{transfer.sourceLabel}</strong> drops to Free — its members
          and notes stay, but its attachments stop syncing. Every local copy remains
          available on its device.
        </p>
        <div className="transfer-targets" role="radiogroup" aria-label="Destination vault">
          {targets.map((t) => {
            const used = t.seats.members + t.seats.pendingInvitations;
            const selected = t.orgId === transfer.targetOrgId;
            return (
              <button
                key={t.orgId}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`upgrade-plan-card transfer-target${selected ? " selected" : ""}`}
                onClick={() => setTransfer({ ...transfer, targetOrgId: t.orgId })}
              >
                <span className="transfer-target-name">{t.name}</span>
                <span className="transfer-target-meta">
                  {used} of {t.seats.limit ?? "∞"} member{used === 1 ? "" : "s"} · Free
                </span>
              </button>
            );
          })}
        </div>
        {skipped > 0 && (
          <p className="transfer-targets-note">
            Only vaults you own that aren't already on Pro are listed.
          </p>
        )}
        {error && <div className="auth-error">{error}</div>}
      </ConfirmDialog>
    );
  };

  /** Section 1 — the vault currently open. A plain render helper, NOT a nested
   *  component: a component declared in here would remount its whole subtree
   *  on every state change of this page. */
  const renderVaultCard = () => {
    if (!isSynced || !orgId) {
      // A card, not a bare line: this slot holds the Pro/Free card in every
      // other state, and a naked sentence there left the tab starting on
      // nothing and the Subscriptions list looking like the whole page.
      return (
        <div className="billing-card">
          <div className="muted">
            This vault isn't synced, so it has no plan of its own. The vaults on
            your account are listed below.
          </div>
        </div>
      );
    }
    if (!orgBilling) return <div className="muted">Loading…</div>;

    if (orgBilling.plan === "pro") {
      return (
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
          <div className="muted">
            Attachment sync is active across devices and with your team.
          </div>
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
          {canManage ? (
            <AsyncButton
              className="secondary billing-action"
              disabled={busy}
              onClick={() => openPortal(orgId)}
            >
              Manage subscription
            </AsyncButton>
          ) : (
            <div className="muted">Ask an owner or admin to manage the subscription.</div>
          )}
        </div>
      );
    }

    const { members, pendingInvitations, limit } = orgBilling.seats;
    const used = members + pendingInvitations;
    return (
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
        <div className="muted">{legacyFreePlanExplanation(billingConfig.freeLimits)}</div>
        <ul className="upgrade-features">
          {LEGACY_PRO_BENEFITS.map((benefit) => (
            <li key={benefit}>{benefit}</li>
          ))}
        </ul>

        {canManage ? (
          <button className="primary billing-action" onClick={() => setUpgradeOrg(orgId)}>
            Upgrade to Pro
          </button>
        ) : (
          <div className="muted">Ask an owner or admin to upgrade this vault.</div>
        )}
      </div>
    );
  };

  /** One row of section 2. */
  const renderVaultRow = (v: MyBillingVault) => {
    const seatsUsed = v.seats.members + v.seats.pendingInvitations;
    // One meta line, not three: renewal + price (already joined by
    // `subscriptionStatusLine`), then seats, then who pays when that isn't the
    // reader. A row is a name and a fact line, so the list scans vertically.
    const meta = [
      subscriptionStatusLine(v, LINE_FORMAT),
      `${seatsUsed} of ${v.seats.limit ?? "∞"} member${seatsUsed === 1 ? "" : "s"}`,
      !v.canManage && v.billingOwner ? `Billed to ${v.billingOwner.name}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li key={v.orgId} className="billing-sub-row">
        <span className="billing-sub-name">
          <span className="billing-sub-title">
            <span className="billing-sub-vault">{v.name}</span>
            {/* A pill, not muted trailing text: it labels the row the reader
                arrived from, so it has to survive the name's ellipsis. */}
            {v.orgId === orgId && <span className="member-role">Current</span>}
          </span>
          {meta && <span className="billing-sub-meta">{meta}</span>}
        </span>
        {/* Owner is the default for a vault you are billed for, and the row
            already carries Current + plan pills plus up to three actions — so
            the role pill only appears when the role is worth saying. */}
        {v.role !== "owner" && <span className={`member-role ${v.role}`}>{v.role}</span>}
        <span className={`billing-status ${v.status}`}>{planPillLabel(v)}</span>
        <span className="vault-row-actions">
          {v.canManage && v.plan === "free" && (
            <AsyncButton
              className="link-btn"
              disabled={busy}
              onClick={() => setUpgradeOrg(v.orgId)}
            >
              Upgrade
            </AsyncButton>
          )}
          {v.canManage && v.plan === "pro" && (
            <AsyncButton
              className="link-btn"
              disabled={busy}
              onClick={() => openPortal(v.orgId)}
            >
              Manage
            </AsyncButton>
          )}
          {v.canTransfer && transferControl(v.orgId, v.name)}
        </span>
      </li>
    );
  };

  return (
    <>
      {renderVaultCard()}

      {/* ---- 2. Every vault on the account ---- */}
      <div className="subhead">Subscriptions</div>
      {vaults.length === 0 ? (
        <div className="muted perm-empty">
          {myBilling ? "No vaults on this account yet." : "Loading…"}
        </div>
      ) : (
        <ul className="member-list">{vaults.map(renderVaultRow)}</ul>
      )}

      {/* ---- 3. Tombstones: paid time that outlived its vault ---- */}
      {orphaned.length > 0 && (
        <>
          <div className="subhead">From deleted vaults</div>
          <div className="billing-section-note">
            These subscriptions belonged to vaults that were deleted. They still
            bill until they end — move one to a vault to use the time you've paid
            for, or cancel it now.
          </div>
          <ul className="member-list">
            {orphaned.map((o) => {
              const label = o.orgName ?? "Deleted vault";
              // Same two-line shape as a live vault row: the name leads, and
              // when it was deleted is a fact on the meta line, not a
              // parenthetical that competes with the name for the ellipsis.
              const meta = [
                `Deleted ${formatDate(o.deletedAt)}`,
                subscriptionStatusLine(o, LINE_FORMAT),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={o.orgId} className="billing-sub-row">
                  <span className="billing-sub-name">
                    <span className="billing-sub-title">
                      <span className="billing-sub-vault">{label}</span>
                    </span>
                    <span className="billing-sub-meta">{meta}</span>
                  </span>
                  <span className={`billing-status ${o.status}`}>
                    {o.status === "past_due" ? "Past due" : "Pro"}
                  </span>
                  <span className="vault-row-actions">
                    {transferControl(o.orgId, label)}
                    <AsyncButton
                      className="link-btn danger"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setCancelling({ orgId: o.orgId, label });
                      }}
                    >
                      Cancel now
                    </AsyncButton>
                    <AsyncButton
                      className="link-btn"
                      disabled={busy}
                      onClick={() => openPortal(o.orgId)}
                    >
                      Manage
                    </AsyncButton>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* ---- 4. What the free tier allows ---- */}
      {freeLimits && (
        <div className="menu-row settings-footer-row">
          <span className="menu-row-label">Free vaults</span>
          <span>
            {freeLimits.freeVaultsUsed} of {freeLimits.vaultsPerUser} used
          </span>
        </div>
      )}

      {error && <div className="auth-error">{error}</div>}

      {upgradeOrg && (
        <UpgradeDialog orgId={upgradeOrg} onClose={() => setUpgradeOrg(null)} />
      )}

      {renderTransferDialog()}

      {cancelling && (
        <ConfirmDialog
          title={`Cancel the subscription for ${cancelling.label}?`}
          confirmLabel="Cancel subscription"
          cancelLabel="Keep it"
          onCancel={() => setCancelling(null)}
          onConfirm={runCancelNow}
        >
          <p>
            Billing stops now and the rest of the period is given up. There is no
            vault left to use it on, so nothing else is lost.
          </p>
          <p>
            If you'd rather keep the time you've paid for, move it to another vault
            instead.
          </p>
          {error && <div className="auth-error">{error}</div>}
        </ConfirmDialog>
      )}
    </>
  );
}

/** Compact absolute date for renewal/period-end lines. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * How a subscription row writes its date and price. Both formatters already
 * exist — reused here rather than re-implemented so `lib/billing.ts` can stay
 * pure and there is exactly one definition of how we print money.
 */
const LINE_FORMAT = {
  date: formatDate,
  price: (amount: number, currency: string, interval: "month" | "year" | null) =>
    `${formatPrice({ amount, currency })}${interval ? perLabel(interval) : ""}`,
};

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
            <AsyncButton className="primary" onClick={create}>
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
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // Otherwise the button just returns to idle and the user clicks again,
      // minting duplicate tokens on a server that is actually failing (#85).
      toast(`Couldn't create the MCP token — ${message}`, "error");
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
        access you do: read, search, create, edit and delete notes and folders.
        Owners and admins can also manage the team's access from the same chat —
        ask Claude or ChatGPT to share a folder with someone, make it view only,
        or set what new members see.
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

function AppearanceTab({ canManage, isSynced }: { canManage: boolean; isSynced: boolean }) {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const settings = useStore((s) => (orgId ? s.vaultAppearance[orgId] : undefined)) ?? EMPTY_APPEARANCE;
  // Sliders fire on every pixel of a drag: apply locally at once, PUT once
  // the thumb rests for 300 ms. Everything else saves on change.
  const pending = useRef<{ timer: number; settings: AppearanceSettings } | null>(null);

  useEffect(() => {
    if (orgId && isSynced) void useStore.getState().loadVaultAppearance(orgId);
  }, [orgId, isSynced]);
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function save(next: AppearanceSettings) {
    if (!orgId) return;
    useStore.getState().saveVaultAppearance(orgId, next).catch((e: unknown) => {
      // The change was applied optimistically and has just been rolled back:
      // say so, with the server's reason, so a refused save is never silent.
      const body = e instanceof ApiError ? (e.body as { error?: string; key?: string } | undefined) : undefined;
      const reason =
        body?.error === "invalid_appearance"
          ? `the server refused ${body.key ? `"${body.key}"` : "a value"}`
          : e instanceof Error
            ? e.message
            : String(e);
      toast(`Couldn't save the vault's appearance, so it was put back: ${reason}.`, "error");
    });
  }
  function flush() {
    const p = pending.current;
    if (!p) return;
    window.clearTimeout(p.timer);
    pending.current = null;
    save(p.settings);
  }
  // Every save is the whole, concrete object: a key an older row never saved
  // is written as the app default it was already showing.
  const change = <K extends AppearanceKey>(key: K, value: ResolvedAppearance[K]) => {
    if (!orgId) return;
    const next: AppearanceSettings = {
      ...vaultAppearanceValues(useStore.getState().vaultAppearance[orgId]),
      [key]: value,
    };
    if (key === "contentWidth" || key === "textSize") {
      useStore.getState().receiveVaultAppearance(orgId, next); // optimistic
      if (pending.current) window.clearTimeout(pending.current.timer);
      pending.current = { settings: next, timer: window.setTimeout(flush, 300) };
      return;
    }
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    save(next);
  };
  const resetToDefaults = () => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    save({ ...APPEARANCE_DEFAULTS });
  };

  return (
    <>
      {isSynced && orgId ? (
        <>
          <div className="subhead appearance-defaults-head">
            Defaults for everyone in this vault
            {!canManage && <span className="appearance-tag">Set by the vault owner</span>}
          </div>
          <div className="muted">
            People can still override these in their own Appearance settings.
          </div>
          <AppearanceRows
            mode="vault"
            values={vaultAppearanceValues(settings)}
            onChange={change}
            readOnly={!canManage}
          />
          {canManage && (
            <button className="link-btn" onClick={resetToDefaults}>
              Reset to defaults
            </button>
          )}
        </>
      ) : (
        <div className="menu-row">
          <span className="menu-row-label">Theme</span>
          <ThemeToggle />
        </div>
      )}

      <VaultItemColorsSection />
    </>
  );
}

const EMPTY_APPEARANCE: AppearanceSettings = {};
