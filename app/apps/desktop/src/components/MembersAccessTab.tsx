import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// The `.skel-line` shimmer lives with the editor skeleton (as ContentWidthPreview does).
import "./editor.css";
import type {
  AccessDefault,
  InvitationOverview,
  MemberOverview,
  MembersOverview,
  TeamAccess,
  TeamAccessMode,
} from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { buildInviteLink, isInvitationExpired } from "../lib/inviteLink";
import {
  countLine,
  EVERYONE_OPTIONS,
  everyoneLabel,
  filterPeople,
  invitationAccessLabel,
  needsAccessConfirm,
  LEVEL_TO_MODE,
  levelClass,
  lastActiveLabel,
  NEW_MEMBER_OPTIONS,
  PERSON_LEVEL_LABEL,
  reduceAccessCopy,
  ROLE_LABEL,
  shortDate,
  presentUserIds,
} from "../lib/membersAccess";
import { syncManager } from "../lib/sync/docSession";
import { writeTeamAccessCache } from "../lib/teamAccessCache";
import { toast } from "../lib/toast";
import type { SettingsTab } from "../lib/settingsTabs";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { InvitePeopleDialog } from "./InvitePeopleDialog";
import { MemberProfilePage, type ProfileTab } from "./MemberProfilePage";
import { ProfileSkeleton } from "./MemberProfileSkeletons";
import { canActOnMember, canSetMemberAccess } from "./memberRoles";
import { MenuSelect } from "./MenuSelect";
import { RowActionsMenu, type RowAction } from "./RowActionsMenu";
import { markSelfAccessChange } from "../lib/sync/selfAccessChanges";


/** How long a burst of per-item ticks settles before the shared side effects run. */
export const ITEM_WRITE_SETTLE_MS = 600;

type PersonChoice = TeamAccessMode | "manage" | "custom";

interface Confirm {
  title: string;
  label: string;
  tone: "danger" | "accent";
  body: React.ReactNode;
  apply: () => Promise<void>;
}

/**
 * Settings → Members and access: one table of people with their role, their
 * vault-wide access and when they were last around, under the two vault-level
 * rows (Everyone, New members). Plain members see the roster read-only.
 *
 * The Everyone row writes ONLY through `PUT team-access` — never through the
 * bulk route with an org audience — because that endpoint is what clears the
 * per-folder team rows in the same transaction.
 */
/**
 * The last roster answer per (server, org, manager view), kept in memory for
 * the session so a revisit paints at once and re-fetches behind it (#307).
 * Never persisted and never used to authorise anything: the fresh answer
 * replaces it as soon as it lands.
 */
type RosterSnapshot = { overview: MembersOverview | null; teamAccess: TeamAccess | null; accessDefault: AccessDefault | null };
const rosterCache = new Map<string, RosterSnapshot>();
const rosterKey = (orgId: string, canManage: boolean) =>
  `${authManager.getServerUrl()}|${orgId}|${canManage ? "m" : "p"}`;

export function MembersAccessTab({ canManage, onOpenTab, onCloseSettings, resetToken = 0 }: {
  canManage: boolean;
  /** Bumped when the active nav item is clicked again: back to the roster (#308). */
  resetToken?: number;
  /** Switch the settings dialog to another page (the MCP hint uses it). */
  onOpenTab?: (tab: SettingsTab) => void;
  /** Close the settings dialog, so a note opened from a profile is visible. */
  onCloseSettings?: () => void;
}) {
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const presence = useStore((s) => s.vaultPresence);
  const vaultStatus = useStore((s) => s.vaultSyncStatus);
  const serverUrl = useStore((s) => s.serverUrl);
  const orgId = session?.activeOrganizationId ?? null;
  const myUserId = session?.user.id;
  const vaultName = organizations.find((o) => o.id === orgId)?.name ?? "this vault";

  const [overview, setOverview] = useState<MembersOverview | null>(null);
  const [teamAccess, setTeamAccess] = useState<TeamAccess | null>(null);
  const [accessDefault, setAccessDefault] = useState<AccessDefault | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [profile, setProfile] = useState<{ userId: string; tab: ProfileTab } | null>(null);
  const loadGen = useRef(0);

  const manage = canManage && (overview?.canManage ?? canManage);

  const reload = useCallback(async () => {
    const mine = ++loadGen.current;
    if (!orgId) return;
    const [ov, team, joining] = await Promise.all([
      authManager.api.getMembersOverview(orgId).catch(() => null),
      canManage ? authManager.api.getTeamAccess(orgId).catch(() => null) : Promise.resolve(null),
      canManage ? authManager.api.getAccessDefault(orgId).catch(() => null) : Promise.resolve(null),
    ]);
    // A slower, older response must never overwrite a newer one.
    if (mine !== loadGen.current) return;
    if (ov) setOverview(ov);
    if (team) {
      setTeamAccess(team);
      writeTeamAccessCache(authManager.getServerUrl(), orgId, team.mode);
    }
    if (joining) setAccessDefault(joining);
    const prev = rosterCache.get(rosterKey(orgId, canManage));
    rosterCache.set(rosterKey(orgId, canManage), {
      overview: ov ?? prev?.overview ?? null,
      teamAccess: team ?? prev?.teamAccess ?? null,
      accessDefault: joining ?? prev?.accessDefault ?? null,
    });
    if (!ov || (canManage && (!team || !joining))) {
      setError("Couldn't load everything on this page. Check your connection and reopen it.");
    }
  }, [orgId, canManage]);

  useEffect(() => {
    loadGen.current++;
    // A roster seen earlier this session paints at once; the reload refreshes it.
    const seen = orgId ? rosterCache.get(rosterKey(orgId, canManage)) : undefined;
    setOverview(seen?.overview ?? null);
    setTeamAccess(seen?.teamAccess ?? null);
    setAccessDefault(seen?.accessDefault ?? null);
    setError(null);
    setConfirm(null);
    setProfile(null);
    void reload();
    return () => { loadGen.current++; };
  }, [orgId, canManage, reload]);

  // Clicking the already-active "Members and access" item returns to the
  // first page of the tab: the roster, search cleared.
  useEffect(() => {
    if (resetToken === 0) return;
    setProfile(null);
    setQuery("");
  }, [resetToken]);

  /** Everything that must follow an access write. */
  const afterAccessWrite = async () => {
    cancelSideEffects();
    syncManager.retryHeldRegistrations();
    await Promise.all([useStore.getState().refreshLocks(), reload()]);
  };

  // Per-item writes from the profile page: retry held registrations and
  // refresh the sidebar padlocks ONCE after a burst of ticks, not per row, and
  // reload nothing (the page updates its own rows; the overview reloads when
  // the page is left).
  const sideEffectsTimer = useRef<number | null>(null);
  const cancelSideEffects = () => {
    if (sideEffectsTimer.current !== null) window.clearTimeout(sideEffectsTimer.current);
    sideEffectsTimer.current = null;
  };
  const runSideEffects = () => {
    sideEffectsTimer.current = null;
    syncManager.retryHeldRegistrations();
    void useStore.getState().refreshLocks();
  };
  const scheduleSideEffects = () => {
    cancelSideEffects();
    sideEffectsTimer.current = window.setTimeout(runSideEffects, ITEM_WRITE_SETTLE_MS);
  };
  // Leaving the tab with a burst still pending: run it now rather than drop it.
  useEffect(() => () => {
    if (sideEffectsTimer.current !== null) {
      window.clearTimeout(sideEffectsTimer.current);
      runSideEffects();
    }
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // ── Everyone ────────────────────────────────────────────────────────────
  const writeEveryone = (mode: TeamAccessMode) => run(async () => {
    if (!orgId) return;
    markSelfAccessChange([orgId]); // Everyone includes the signed-in user
    await authManager.api.setTeamAccess(orgId, mode);
    await afterAccessWrite();
    toast(`Everyone in ${vaultName}: ${EVERYONE_OPTIONS.find((o) => o.value === mode)?.label}`);
  });

  const chooseEveryone = (mode: TeamAccessMode) => {
    if (!teamAccess) return;
    if (mode === teamAccess.mode && teamAccess.overrides.length === 0 && teamAccess.posture !== "none") return;
    const label = EVERYONE_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
    if (!needsAccessConfirm(teamAccess.posture === "none" ? "private" : teamAccess.mode, mode)) {
      void writeEveryone(mode);
      return;
    }
    if (mode === "open") return;
    const copy = reduceAccessCopy({ kind: "everyone" }, mode);
    setConfirm({
      title: copy.title,
      label: copy.button,
      tone: mode === "private" ? "danger" : "accent",
      apply: () => writeEveryone(mode),
      body: (
        <>
          <p>Every member gets <strong>{label}</strong> unless they have their own setting. People set by name keep theirs.</p>
          <p>{copy.outcome}</p>
        </>
      ),
    });
  };

  // ── New members ─────────────────────────────────────────────────────────
  const chooseDefault = (mode: TeamAccessMode) => run(async () => {
    if (!orgId || accessDefault?.mode === mode) return;
    const next = await authManager.api.setAccessDefault(orgId, mode);
    setAccessDefault(next);
    toast(`New members: ${NEW_MEMBER_OPTIONS.find((o) => o.value === next.mode)?.label}`);
  });

  // ── One person ──────────────────────────────────────────────────────────
  const writePerson = (m: MemberOverview, mode: TeamAccessMode) => run(async () => {
    if (!orgId) return;
    if (m.userId === myUserId) markSelfAccessChange([orgId]);
    await authManager.api.setBulkAccess(orgId, {
      resources: [{ resourceType: "vault", resourceId: orgId }],
      audience: { type: "users", userIds: [m.userId] },
      mode,
    });
    await afterAccessWrite();
    toast(`${displayName(m)}: ${PERSON_LEVEL_LABEL[mode === "open" ? "edit" : mode === "readonly" ? "view" : "none"]}`);
  });

  const choosePerson = (m: MemberOverview, choice: PersonChoice) => {
    if (choice === "custom") return;
    if (choice === "manage") {
      setProfile({ userId: m.userId, tab: "access" });
      return;
    }
    const level = m.access?.level ?? null;
    const from = level === null ? null : level === "custom" ? "custom" : LEVEL_TO_MODE[level];
    if (from === choice) return;
    if (!needsAccessConfirm(from, choice)) {
      void writePerson(m, choice);
      return;
    }
    if (choice === "open") return;
    const copy = reduceAccessCopy({ kind: "person", name: displayName(m), self: m.userId === myUserId }, choice);
    setConfirm({
      title: copy.title,
      label: copy.button,
      tone: choice === "private" ? "danger" : "accent",
      apply: () => writePerson(m, choice),
      body: (
        <>
          <p>
            {m.userId === myUserId
              ? "This replaces your own settings across the vault. Your setting wins over the default setting, and owners and admins are not exempt."
              : `This replaces ${displayName(m)}'s own settings across the vault. Their setting wins over the default setting.`}
          </p>
          <p>{copy.outcome}</p>
        </>
      ),
    });
  };

  const changeRole = (m: MemberOverview, role: "member" | "admin") => run(async () => {
    await useStore.getState().updateMemberRole(m.userId, role);
    await reload();
  });

  const askRemove = (m: MemberOverview) => setConfirm({
    title: `Remove ${displayName(m)} from ${vaultName}?`,
    label: "Remove",
    tone: "danger",
    apply: () => run(async () => {
      await useStore.getState().removeMember(m.userId);
      await reload();
    }),
    body: <p>They lose access on all their devices right away. You can invite them again later.</p>,
  });

  // ── Invitations ─────────────────────────────────────────────────────────
  const copyLink = async (inv: InvitationOverview) => {
    const link = buildInviteLink(serverUrl, inv.id);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied");
    } catch { /* clipboard unavailable */ }
  };

  const resend = (inv: InvitationOverview) => run(async () => {
    if (!orgId) return;
    const [result] = await authManager.api.inviteMany(orgId, {
      emails: [inv.email],
      role: inv.role === "admin" ? "admin" : "member",
      access: inv.access,
    });
    await reload();
    if (result?.error) setError(result.error);
    else toast(result?.emailed ? `Invitation emailed to ${inv.email}` : `Invitation renewed — copy its link for ${inv.email}`);
  });

  const askRevoke = (inv: InvitationOverview) => setConfirm({
    title: `Revoke the invitation to ${inv.email}?`,
    label: "Revoke",
    tone: "danger",
    apply: () => run(async () => {
      await authManager.api.cancelInvitation(inv.id);
      await Promise.all([reload(), useStore.getState().refreshVault()]);
    }),
    body: <p>Its link stops working. You can invite them again later.</p>,
  });

  // ── Render ──────────────────────────────────────────────────────────────
  const members = overview?.members ?? [];
  const invitations = (overview?.invitations ?? []).filter((i) => i.status === "pending");
  const shown = useMemo(() => filterPeople(query, members, invitations), [query, members, invitations]);
  const myRole = members.find((m) => m.userId === myUserId)?.role;
  const presentIds = useMemo(() => presentUserIds(presence, myUserId, vaultStatus), [presence, myUserId, vaultStatus]);
  const now = Date.now();
  const profileMember = profile ? members.find((m) => m.userId === profile.userId) ?? null : null;

  const canAct = (m: MemberOverview) =>
    canActOnMember({ canManage: manage, myUserId, myRole, target: { userId: m.userId, role: m.role } });
  const canSetAccess = (m: MemberOverview) =>
    canSetMemberAccess({ canManage: manage, myUserId, myRole, target: { userId: m.userId, role: m.role } });

  // The Everyone row shows nothing current until the server has answered; a
  // cached mode only paints the trigger as a hint, it never authorises a write.
  const everyone = teamAccess ? everyoneLabel(teamAccess.mode, teamAccess.posture) : null;

  // A profile asked for before the roster has arrived: hold its layout.
  if (profile && orgId && !overview) {
    return <div className="members-access"><ProfileSkeleton /></div>;
  }

  if (profile && profileMember && orgId) {
    return (
      <div className="members-access">
        <MemberProfilePage
          key={`${profile.userId}:${profile.tab}`}
          orgId={orgId}
          vaultName={vaultName}
          member={profileMember}
          initialTab={profile.tab}
          canAct={canAct(profileMember)}
          canSetAccess={canSetAccess(profileMember)}
          showAccessTab={manage}
          present={presentIds.has(profileMember.userId)}
          teamAccess={teamAccess}
          onClose={() => { setProfile(null); void reload(); }}
          onChanged={afterAccessWrite}
          onItemWritten={scheduleSideEffects}
          onRoleChange={(role) => changeRole(profileMember, role)}
          onRemove={() => { setProfile(null); askRemove(profileMember); }}
          onOpenNote={onCloseSettings ? (path) => {
            onCloseSettings();
            void useStore.getState().openNoteByPath(path);
          } : undefined}
        />
        {confirm && (
          <ConfirmDialog
            title={confirm.title}
            confirmLabel={confirm.label}
            tone={confirm.tone}
            onCancel={() => setConfirm(null)}
            onConfirm={async () => {
              await confirm.apply();
              setConfirm(null);
            }}
          >
            {confirm.body}
          </ConfirmDialog>
        )}
      </div>
    );
  }

  return (
    <div className="members-access">
      <h2 className="settings-section-title">Members and access</h2>
      <p className="members-access-intro">Owners and admins can always manage access.</p>
      {error && <div className="auth-error">{error}</div>}

      {manage && (
        <div className="members-access-rows">
          <div className="members-access-row">
            <span className="members-access-row-icon" aria-hidden="true">
              <PeopleIcon />
            </span>
            <span className="members-access-row-copy">
              <span className="members-access-row-title">Everyone in {vaultName}</span>
              <span className="muted">{everyone?.sub ?? "Default for every member"}</span>
            </span>
            {teamAccess ? (
              <MenuSelect
                value={teamAccess.posture === "none" ? ("none" as TeamAccessMode) : teamAccess.mode}
                options={EVERYONE_OPTIONS}
                onSelect={chooseEveryone}
                disabled={busy}
                ariaLabel={`Access for everyone in ${vaultName}`}
                triggerClassName={`members-access-trigger is-level ${levelClass(teamAccess.posture === "none" ? "private" : teamAccess.mode)}`}
                menuClassName="access-menu"
                triggerContent={everyone?.label}
              />
            ) : (
              <PillSkeleton label={`Loading access for everyone in ${vaultName}`} />
            )}
          </div>
          <div className="members-access-row">
            <span className="members-access-row-icon" aria-hidden="true">
              <ClockIcon />
            </span>
            <span className="members-access-row-copy">
              <span className="members-access-row-title">New members</span>
              <span className="muted">For notes made before they joined</span>
            </span>
            {accessDefault ? (
              <MenuSelect
                value={accessDefault.mode}
                options={NEW_MEMBER_OPTIONS}
                onSelect={(m) => void chooseDefault(m)}
                disabled={busy}
                ariaLabel="Access for new members"
                triggerClassName={`members-access-trigger is-level ${levelClass(accessDefault.mode)}`}
                menuClassName="access-menu"
              />
            ) : (
              <PillSkeleton label="Loading access for new members" />
            )}
          </div>
        </div>
      )}

      <div className="members-access-toolbar">
        <label className="members-access-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Find people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find people"
          />
        </label>
        {manage && (
          <button className="primary" onClick={() => setInviteOpen(true)}>Invite people</button>
        )}
      </div>

      <div className="members-access-count muted">
        {overview ? countLine(query, shown.members.length, shown.invitations.length) : <span className="skel-line members-skel-count" aria-hidden="true" />}
      </div>

      {!overview && <TableSkeleton manage={manage} />}

      {overview && (
        <table className="members-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              {manage && <th>Access</th>}
              <th>Last active</th>
              {manage && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {shown.members.map((m) => {
              const name = displayName(m);
              const isMe = m.userId === myUserId;
              const actions: RowAction[] = [
                { key: "profile", label: "View profile", onSelect: () => setProfile({ userId: m.userId, tab: "info" }) },
              ];
              if (canSetAccess(m)) {
                actions.push({ key: "access", label: "Manage access", onSelect: () => setProfile({ userId: m.userId, tab: "access" }) });
              }
              if (canAct(m)) {
                actions.push(m.role === "admin"
                  ? { key: "role", label: "Make member", onSelect: () => changeRole(m, "member") }
                  : { key: "role", label: "Make admin", onSelect: () => changeRole(m, "admin") });
                actions.push({ key: "remove", label: `Remove from ${vaultName}`, danger: true, separated: true, onSelect: () => askRemove(m) });
              }
              return (
                <tr
                  key={m.userId}
                  className="is-clickable"
                  tabIndex={0}
                  role="button"
                  aria-label={`Open profile of ${name}`}
                  onClick={(e) => { if (isRowOwnClick(e)) setProfile({ userId: m.userId, tab: "info" }); }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    setProfile({ userId: m.userId, tab: "info" });
                  }}
                >
                  <td>
                    <span className="members-table-person">
                      <Avatar label={name} image={m.image} userId={m.userId} />
                      <span className="members-table-names">
                        <span className="members-table-name">{name}{isMe && <span className="muted"> (you)</span>}</span>
                        {m.email && m.name && <span className="muted">{m.email}</span>}
                      </span>
                    </span>
                  </td>
                  <td>{ROLE_LABEL[m.role] ?? m.role}</td>
                  {manage && (
                    <td>
                      {m.access && canSetAccess(m) ? (
                        <MenuSelect<PersonChoice>
                          value={m.access.level === "custom" ? "custom" : LEVEL_TO_MODE[m.access.level]}
                          options={[
                            { value: "open", label: PERSON_LEVEL_LABEL.edit },
                            { value: "readonly", label: PERSON_LEVEL_LABEL.view },
                            { value: "private", label: PERSON_LEVEL_LABEL.none },
                            { value: "manage", label: "Manage access…" },
                          ]}
                          onSelect={(c) => choosePerson(m, c)}
                          disabled={busy}
                          ariaLabel={`Access for ${name}`}
                          triggerClassName={`members-access-trigger is-level ${levelClass(m.access.level)}`}
                menuClassName="access-menu"
                          triggerContent={PERSON_LEVEL_LABEL[m.access.level]}
                        />
                      ) : m.access ? (
                        <span>{PERSON_LEVEL_LABEL[m.access.level]}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                  <td>{lastActiveLabel(presentIds.has(m.userId), m.lastActiveAt, now)}</td>
                  {manage && (
                    <td className="members-table-actions">
                      <RowActionsMenu actions={actions} ariaLabel={`Actions for ${name}`} disabled={busy} />
                    </td>
                  )}
                </tr>
              );
            })}
            {shown.invitations.map((inv) => {
              const expired = isInvitationExpired(inv.expiresAt ?? undefined);
              return (
                <tr key={inv.id} className="is-invited">
                  <td>
                    <span className="members-table-person">
                      <Avatar label={inv.email} image={null} />
                      <span className="members-table-names">
                        <span className="members-table-name">{inv.email}</span>
                        <span className="muted">
                          {expired ? "Invite expired" : `Invite sent ${shortDate(inv.createdAt)}`}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td>Invited</td>
                  {manage && <td>{invitationAccessLabel(inv.access)}</td>}
                  <td>Not joined yet</td>
                  {manage && (
                    <td className="members-table-actions">
                      <RowActionsMenu
                        ariaLabel={`Actions for the invitation to ${inv.email}`}
                        disabled={busy}
                        actions={[
                          { key: "resend", label: "Resend", onSelect: () => resend(inv) },
                          { key: "copy", label: "Copy link", onSelect: () => copyLink(inv) },
                          { key: "revoke", label: "Revoke", danger: true, separated: true, onSelect: () => askRevoke(inv) },
                        ]}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Only people who can manage access, and only on a synced vault — this
          tab is behind the sync gate, so reaching it means synced. */}
      {manage && onOpenTab && (
        <p className="members-access-mcp-hint">
          <TerminalIcon />
          <span>
            Tip: you can also manage access by chatting with Claude or ChatGPT through MCP.{" "}
            <button type="button" className="link-btn" onClick={() => onOpenTab("mcp")}>Set it up →</button>
          </span>
        </p>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.label}
          tone={confirm.tone}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await confirm.apply();
            setConfirm(null);
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
      {inviteOpen && orgId && (
        <InvitePeopleDialog
          orgId={orgId}
          onClose={() => setInviteOpen(false)}
          onInvited={() => void reload()}
        />
      )}
    </div>
  );
}

/** Controls inside a row keep their own clicks. */
const ROW_CONTROLS = 'button, [role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], input, select, textarea, a, label, .row-more';

/**
 * Is this click on the row itself rather than on one of its controls? Menus
 * and confirms are portalled to <body>, and React still bubbles their clicks
 * up to this row — so anything outside the row's own DOM is ignored too.
 */
export function isRowOwnClick(e: { target: EventTarget | null; currentTarget: EventTarget & Element }): boolean {
  const target = e.target;
  if (!(target instanceof Element) || !e.currentTarget.contains(target)) return false;
  const control = target.closest(ROW_CONTROLS);
  return !control || control === e.currentTarget;
}

export function displayName(m: Pick<MemberOverview, "name" | "email" | "userId">): string {
  return m.name || m.email || m.userId;
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </svg>
  );
}

/**
 * Placeholders that hold the final layout while the server answers: no text
 * and no mode until the state is authoritative, and nothing that jumps when it
 * arrives. They borrow the editor skeleton's `.skel-line` shimmer.
 */
function PillSkeleton({ label }: { label: string }) {
  return <span className="skel-line members-skel-pill" role="status" aria-busy="true" aria-label={label} />;
}

function TableSkeleton({ manage }: { manage: boolean }) {
  return (
    <table className="members-table members-table-skeleton" aria-busy="true" aria-label="Loading people">
      <thead>
        <tr>
          <th>Name</th>
          <th>Role</th>
          {manage && <th>Access</th>}
          <th>Last active</th>
          {manage && <th aria-label="Actions" />}
        </tr>
      </thead>
      <tbody aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <tr key={i}>
            <td>
              <span className="members-table-person">
                <span className="skel-line members-skel-avatar" />
                <span className="members-skel-names">
                  <span className="skel-line members-skel-name" />
                  <span className="skel-line members-skel-email" />
                </span>
              </span>
            </td>
            <td><span className="skel-line members-skel-role" /></td>
            {manage && <td><span className="skel-line members-skel-access" /></td>}
            <td><span className="skel-line members-skel-time" /></td>
            {manage && <td />}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The MCP tab's own glyph (VaultSettingsDialog), so the hint points at it. */
function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
