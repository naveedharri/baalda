import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// The `.skel-line` shimmer lives with the editor skeleton (as ContentWidthPreview does).
import "./editor.css";
import type {
  AccessGroup,
  AccessDefault,
  InvitationOverview,
  MemberOverview,
  MembersOverview,
  MyBillingAccount,
  TeamAccess,
  TeamAccessMode,
} from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { inviteWithVaultKeys } from "../lib/vaultKeys/runtime";
import { freeLimitOf } from "../lib/billing";
import { rosterCache, type RosterSnapshot } from "../lib/membersAccessCaches";
import { buildInviteLink, isInvitationExpired } from "../lib/inviteLink";
import {
  countLine,
  EVERYONE_OPTIONS,
  DEFAULT_ACCESS_SUB,
  DEFAULT_ACCESS_TITLE,
  accessSources,
  everyoneLabel,
  filterPeople,
  freshViewerRole,
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
  levelOfMode,
  patchedTeamAccess,
  withMemberLevel,
  withNewInvitations,
  withoutInvitation,
  withViewerRole,
} from "../lib/membersAccess";
import { syncManager } from "../lib/sync/docSession";
import { writeTeamAccessCache } from "../lib/teamAccessCache";
import { toast } from "../lib/toast";
import type { SettingsTab } from "../lib/settingsTabs";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import { ConfirmDialog, type ConfirmChange } from "./ConfirmDialog";
import { InvitePeopleDialog } from "./InvitePeopleDialog";
import { PeopleLimitNotice, inviteLimitError, peopleLimitKind } from "./PeopleLimitNotice";
import { MemberProfilePage, type ProfileTab } from "./MemberProfilePage";
import { ProfileSkeleton } from "./MemberProfileSkeletons";
import { canActOnMember, canSetMemberAccess } from "./memberRoles";
import { MenuSelect } from "./MenuSelect";
import { RowActionsMenu, type RowAction } from "./RowActionsMenu";
import { markSelfAccessChange } from "../lib/sync/selfAccessChanges";
import { MemberSelectionBar } from "./MemberSelectionBar";
import { bulkResultLine, chunkIds, headerCheckState, peopleCount, pruneSelection, splitBulkTargets, toggleShown } from "../lib/membersAccess";
import { serverFeatures } from "../lib/serverFeatures";
import { SKILL_ACCESS_FEATURE } from "../lib/skills/access";
import { ACCESS_GROUPS_FEATURE, GROUP_OPTION, groupAccessSummary, groupOptionId, isGroupOption } from "../lib/groups";
import { GroupChip, GroupDialog, GroupPage, GroupsList, useAccessGroups, type GroupTab } from "./GroupsPanel";


/** How long a burst of per-item ticks settles before the shared side effects run. */
export const ITEM_WRITE_SETTLE_MS = 600;

type PersonChoice = TeamAccessMode | "manage" | "custom";

interface Confirm {
  title: string;
  label: string;
  tone: "danger" | "accent";
  body: React.ReactNode;
  apply: () => Promise<void>;
  subtitle?: React.ReactNode;
  change?: ConfirmChange;
  cancelLabel?: string;
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
const rosterKey = (orgId: string, canManage: boolean) =>
  `${authManager.getServerUrl()}|${orgId}|${canManage ? "m" : "p"}`;

/**
 * Warm the roster cache when Vault Settings opens, so the Members tab paints
 * at once (#307). Fills only an empty slot and swallows failures: the tab's
 * own load still runs and stays authoritative.
 */
const prefetching = new Set<string>();
export function prefetchRoster(orgId: string | null, canManage: boolean): void {
  if (!orgId) return;
  const key = rosterKey(orgId, canManage);
  if (rosterCache.has(key) || prefetching.has(key)) return;
  prefetching.add(key);
  void Promise.all([
    authManager.api.getMembersOverview(orgId).catch(() => null),
    canManage ? authManager.api.getTeamAccess(orgId).catch(() => null) : Promise.resolve(null),
    canManage ? authManager.api.getAccessDefault(orgId).catch(() => null) : Promise.resolve(null),
  ]).then(([overview, teamAccess, accessDefault]) => {
    prefetching.delete(key);
    if (!overview || rosterCache.has(key)) return;
    rosterCache.set(key, { overview, teamAccess, accessDefault });
  });
}

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
  const [limitCause, setLimitCause] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // People ticked in the table for a bulk action (user ids; members only).
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [profile, setProfile] = useState<{ userId: string; tab: ProfileTab } | null>(null);
  const loadGen = useRef(0);

  // Access groups (server migration 097): shown only when the server has them.
  const [features, setFeatures] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    void serverFeatures(serverUrl, () => authManager.api.getHealth(serverUrl)).then((f) => { if (live) setFeatures(f); });
    return () => { live = false; };
  }, [serverUrl]);
  const groupsOn = features.has(ACCESS_GROUPS_FEATURE);
  const groupsState = useAccessGroups(orgId, groupsOn);
  const groups: AccessGroup[] = groupsState.list?.groups ?? [];
  const [listView, setListView] = useState<"people" | "groups">("people");
  const [groupPage, setGroupPage] = useState<{ id: string; tab: GroupTab } | null>(null);
  const [groupDialog, setGroupDialog] = useState<{ rename?: AccessGroup } | null>(null);

  // `canManage` comes from the store's member list, read when the vault
  // opened; the overview is re-read on every open, so once it has answered
  // its `canManage` is the authority (a promotion made after launch, #admin).
  const manage = overview ? overview.canManage : canManage;
  const seatAccount = useSeatAccount(orgId, manage);

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
    setGroupPage(null);
    void reload();
    return () => { loadGen.current++; };
  }, [orgId, canManage, reload]);

  // Teach the store the viewer's fresh role, so every other Vault Settings tab
  // (and this tab's `canManage` prop, which re-fetches the Everyone and New
  // members rows) follows a promotion or demotion made after the vault opened.
  useEffect(() => {
    if (!overview || !orgId || !myUserId) return;
    const current = useStore.getState().members ?? [];
    const stored = current.find((m) => m.userId === myUserId)?.role;
    const fresh = freshViewerRole(overview, myUserId, stored);
    if (!fresh || fresh === stored) return;
    const memberId = overview.members.find((m) => m.userId === myUserId)?.memberId;
    const next = withViewerRole(current, orgId, myUserId, fresh, memberId);
    if (next !== current) useStore.setState({ members: next });
  }, [overview, orgId, myUserId]);

  // Clicking the already-active "Members and access" item returns to the
  // first page of the tab: the roster, search cleared.
  useEffect(() => {
    if (resetToken === 0) return;
    setProfile(null);
    setGroupPage(null);
    setQuery("");
  }, [resetToken]);

  /** Everything that must follow an access write. */
  const afterAccessWrite = async () => {
    cancelSideEffects();
    syncManager.retryHeldRegistrations();
    await Promise.all([useStore.getState().refreshLocks(), reload(), groupsState.reload()]);
  };

  // ── Groups ──────────────────────────────────────────────────────────────
  const openGroup = (id: string, tab: GroupTab = "members") => {
    setProfile(null);
    setGroupPage({ id, tab });
  };
  const joinGroup = async (userId: string, groupId: string) => {
    if (!orgId) return;
    if (userId === myUserId) markSelfAccessChange([orgId]);
    await authManager.api.addGroupMembers(orgId, groupId, [userId]);
    toast(`Added to ${groups.find((g) => g.id === groupId)?.name ?? "the group"}.`);
    await afterAccessWrite();
  };
  const leaveGroup = async (userId: string, groupId: string) => {
    if (!orgId) return;
    if (userId === myUserId) markSelfAccessChange([orgId]);
    await authManager.api.removeGroupMember(orgId, groupId, userId);
    toast(`Removed from ${groups.find((g) => g.id === groupId)?.name ?? "the group"}.`);
    await afterAccessWrite();
  };
  const askDeleteGroup = (g: AccessGroup) => setConfirm({
    title: `Delete ${g.name}?`,
    label: "Delete access group",
    tone: "danger",
    apply: () => run(async () => {
      if (!orgId) return;
      if (myUserId && g.memberIds.includes(myUserId)) markSelfAccessChange([orgId]);
      await authManager.api.deleteGroup(orgId, g.id);
      toast(`Deleted ${g.name}.`);
      await afterAccessWrite();
    }),
    body: (
      <p className="confirm-note">
        Its members lose only what {g.name} gave; their own access and other groups stay. This can't be undone.
      </p>
    ),
  });
  /** New members menu: a group toggles whether new members join it. */
  const toggleAutoJoin = (g: AccessGroup) => run(async () => {
    if (!orgId) return;
    await authManager.api.updateGroup(orgId, g.id, { autoJoin: !g.autoJoin });
    toast(!g.autoJoin ? `New members now join ${g.name}.` : `New members no longer join ${g.name}.`);
    await groupsState.reload();
  });

  /**
   * Patch the roster on screen (and its session cache) right after a write,
   * then refresh once in the background so the server stays authoritative
   * (#307). Paint only: no write ever reads this state to decide anything.
   */
  const patchRoster = (patch: (prev: RosterSnapshot) => RosterSnapshot) => {
    if (!orgId) return;
    const key = rosterKey(orgId, canManage);
    const prev = rosterCache.get(key) ?? { overview, teamAccess, accessDefault };
    const next = patch(prev);
    rosterCache.set(key, next);
    setOverview(next.overview);
    setTeamAccess(next.teamAccess);
    setAccessDefault(next.accessDefault);
  };
  /** The one background refresh after a patched write. */
  const refreshBehind = () => {
    cancelSideEffects();
    syncManager.retryHeldRegistrations();
    void useStore.getState().refreshLocks();
    void reload();
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
    setLimitCause(null);
    try {
      await work();
    } catch (cause) {
      if (peopleLimitKind(cause)) { setLimitCause(cause); return; }
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
    patchRoster((r) => ({ ...r, teamAccess: r.teamAccess ? patchedTeamAccess(r.teamAccess, mode) : r.teamAccess }));
    refreshBehind();
    toast(`${DEFAULT_ACCESS_TITLE}: ${EVERYONE_OPTIONS.find((o) => o.value === mode)?.label}`);
  });

  const chooseEveryone = (mode: TeamAccessMode) => {
    if (!teamAccess) return;
    if (mode === teamAccess.mode && teamAccess.overrides.length === 0 && teamAccess.posture !== "none") return;
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
      subtitle: <>People set by name keep their own setting.</>,
      change: {
        who: DEFAULT_ACCESS_TITLE,
        sub: `Every member of ${vaultName} starts here`,
        from: teamAccess.posture === "none" ? "private" : teamAccess.mode,
        to: mode,
      },
      cancelLabel: "Keep as is",
      body: <p className="confirm-note">{copy.outcome}</p>,
    });
  };

  // ── New members ─────────────────────────────────────────────────────────
  const chooseDefault = (mode: TeamAccessMode) => run(async () => {
    if (!orgId || accessDefault?.mode === mode) return;
    const next = await authManager.api.setAccessDefault(orgId, mode);
    setAccessDefault(next);
    patchRoster((r) => ({ ...r, accessDefault: next }));
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
    patchRoster((r) => ({
      ...r,
      overview: r.overview ? withMemberLevel(r.overview, m.userId, levelOfMode(mode)) : r.overview,
    }));
    refreshBehind();
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
    const self = m.userId === myUserId;
    const copy = reduceAccessCopy({ kind: "person", name: displayName(m), self }, choice);
    setConfirm({
      title: copy.title,
      label: copy.button,
      tone: choice === "private" ? "danger" : "accent",
      apply: () => writePerson(m, choice),
      subtitle: (
        <>
          This applies across {vaultName}
          {self ? ", and owners and admins are not exempt." : ", just for them. Default access and their groups no longer change it."}
        </>
      ),
      change: {
        who: self ? "You" : displayName(m),
        sub: self ? displayName(m) : m.email ?? undefined,
        avatar: <Avatar label={displayName(m)} image={m.image} userId={m.userId} />,
        from: from === null ? null : from,
        to: choice,
      },
      cancelLabel: self ? "Keep my access" : "Keep as is",
      body: <p className="confirm-note">{copy.outcome}</p>,
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

  // ── Bulk actions on the ticked people ──────────────────────────────────
  const pickedMembers = () => members.filter((m) => selected.has(m.userId));
  const clearSelection = () => setSelected(new Set());
  const namesLine = (list: MemberOverview[]) => {
    const names = list.map(displayName);
    return names.length <= 4 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  };
  const refreshAfterBulk = async () => {
    await useStore.getState().refreshVault().catch(() => {});
    await reload();
  };

  const bulkAccess = (mode: TeamAccessMode) => {
    const want = mode === "open" ? "edit" : mode === "readonly" ? "view" : "none";
    const split = splitBulkTargets(pickedMembers(), canSetAccess, (m) => m.access?.level === want);
    if (split.apply.length === 0) { toast(bulkResultLine("Nothing to change.", split)); return; }
    const apply = () => run(async () => {
      if (!orgId) return;
      const ids = split.apply.map((m) => m.userId);
      if (myUserId && ids.includes(myUserId)) markSelfAccessChange([orgId]);
      try {
        for (const chunk of chunkIds(ids, 100)) {
          await authManager.api.setBulkAccess(orgId, {
            resources: [{ resourceType: "vault", resourceId: orgId }],
            audience: { type: "users", userIds: chunk },
            mode,
          });
        }
      } finally {
        await reload();
        refreshBehind();
      }
      clearSelection();
      toast(bulkResultLine(`${peopleCount(ids.length)}: ${PERSON_LEVEL_LABEL[want]}.`, split));
    });
    if (mode !== "private") { void apply(); return; }
    setConfirm({
      title: `No access for ${peopleCount(split.apply.length)}?`,
      label: "Set to No access",
      tone: "danger",
      apply,
      subtitle: <>This applies across {vaultName}, just for these people. Default access and their groups no longer change it.</>,
      cancelLabel: "Keep as is",
      body: <p className="confirm-note">{namesLine(split.apply)} will not open anything in {vaultName} until someone gives them access again.</p>,
    });
  };

  const bulkRole = (role: "member" | "admin") => {
    const split = splitBulkTargets(pickedMembers(), canAct, (m) => m.role === role);
    if (split.apply.length === 0) { toast(bulkResultLine("Nothing to change.", split)); return; }
    void run(async () => {
      if (!orgId) return;
      let done = 0;
      try {
        for (const m of split.apply) {
          await authManager.api.updateMemberRole(orgId, m.userId, role);
          done += 1;
        }
      } catch (cause) {
        throw new Error(`Changed ${done} of ${split.apply.length}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        await refreshAfterBulk();
      }
      clearSelection();
      toast(bulkResultLine(`${peopleCount(done)} now ${role === "admin" ? "admins" : "members"}.`, split));
    });
  };

  const bulkRemove = () => {
    const split = splitBulkTargets(pickedMembers(), canAct);
    if (split.apply.length === 0) { toast(bulkResultLine("Nobody to remove.", split)); return; }
    setConfirm({
      title: `Remove ${peopleCount(split.apply.length)} from ${vaultName}?`,
      label: "Remove",
      tone: "danger",
      apply: () => run(async () => {
        if (!orgId) return;
        let done = 0;
        try {
          for (const m of split.apply) {
            await authManager.api.removeMember(orgId, m.userId);
            done += 1;
          }
        } catch (cause) {
          throw new Error(`Removed ${done} of ${split.apply.length}: ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally {
          await refreshAfterBulk();
        }
        clearSelection();
        toast(bulkResultLine(`Removed ${peopleCount(done)}.`, split));
      }),
      body: <p>{namesLine(split.apply)} lose access on all their devices right away. You can invite them again later.</p>,
    });
  };

  const bulkAddToGroup = (groupId: string) => {
    const split = splitBulkTargets(pickedMembers(), canSetAccess, (m) => (m.groupIds ?? []).includes(groupId));
    const name = groups.find((g) => g.id === groupId)?.name ?? "the group";
    if (split.apply.length === 0) { toast(bulkResultLine(`Nobody new to add to ${name}.`, split)); return; }
    void run(async () => {
      if (!orgId) return;
      const ids = split.apply.map((m) => m.userId);
      if (myUserId && ids.includes(myUserId)) markSelfAccessChange([orgId]);
      try {
        for (const chunk of chunkIds(ids, 500)) await authManager.api.addGroupMembers(orgId, groupId, chunk);
      } finally {
        await afterAccessWrite();
      }
      clearSelection();
      toast(bulkResultLine(`Added ${peopleCount(ids.length)} to ${name}.`, split));
    });
  };

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
    const [result] = await inviteWithVaultKeys(orgId, {
      emails: [inv.email],
      role: inv.role === "admin" ? "admin" : "member",
      access: inv.groupIds?.length ? null : inv.access,
      ...(inv.groupIds?.length ? { groupIds: inv.groupIds } : {}),
    });
    await reload();
    const limit = result?.error ? inviteLimitError(result.error) : null;
    if (limit) setLimitCause(limit);
    else if (result?.error) setError(result.error);
    else toast(result?.emailed ? `Invitation emailed to ${inv.email}` : `Invitation renewed. Copy its link for ${inv.email}`);
  });

  const askRevoke = (inv: InvitationOverview) => setConfirm({
    title: `Revoke the invitation to ${inv.email}?`,
    label: "Revoke",
    tone: "danger",
    apply: () => run(async () => {
      await authManager.api.cancelInvitation(inv.id);
      patchRoster((r) => ({ ...r, overview: r.overview ? withoutInvitation(r.overview, inv.id) : r.overview }));
      void reload();
      void useStore.getState().refreshVault();
    }),
    body: <p>Its link stops working. You can invite them again later.</p>,
  });

  // ── Render ──────────────────────────────────────────────────────────────
  const members = overview?.members ?? [];
  const invitations = (overview?.invitations ?? []).filter((i) => i.status === "pending");
  const shown = useMemo(() => filterPeople(query, members, invitations), [query, members, invitations]);
  const myRole = members.find((m) => m.userId === myUserId)?.role;
  useEffect(() => {
    setSelected((s) => pruneSelection(s, members.map((m) => m.userId)));
  }, [members]);
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
  // Where each person's access comes from (the Access column's second line).
  const sourceOf = (m: MemberOverview) => m.access ? accessSources({
    level: m.access.level,
    own: !!m.access.own,
    isSelf: m.userId === myUserId,
    defaultLabel: everyone?.label ?? null,
    groups: groupsOn
      ? groups.filter((g) => (m.groupIds ?? []).includes(g.id)).map((g) => ({ name: g.name, summary: groupAccessSummary(g.grants) }))
      : [],
  }) : null;

  // A profile asked for before the roster has arrived: hold its layout.
  if (profile && orgId && !overview) {
    return <div className="members-access"><ProfileSkeleton /></div>;
  }

  const selectable = (m: MemberOverview) => canSetAccess(m) || canAct(m);
  const shownSelectable = shown.members.filter(selectable).map((m) => m.userId);
  const selectedMembers = pickedMembers();
  const selecting = manage && listView === "people" && selected.size > 0;

  const groupNow = groupPage ? groups.find((g) => g.id === groupPage.id) ?? null : null;
  if (groupPage && orgId && groupsOn && !groupsState.list) {
    return <div className="members-access"><ProfileSkeleton /></div>;
  }
  if (groupPage && groupNow && orgId) {
    return (
      <div className="members-access">
        <GroupPage
          key={groupNow.id}
          orgId={orgId}
          vaultName={vaultName}
          group={groupNow}
          groups={groups}
          members={members}
          myUserId={myUserId}
          myRole={myRole}
          manage={manage}
          skillsEnabled={features.has(SKILL_ACCESS_FEATURE)}
          teamAccess={teamAccess}
          initialTab={groupPage.tab}
          onBack={() => { setGroupPage(null); setListView("groups"); void afterAccessWrite(); }}
          onChanged={afterAccessWrite}
          onItemWritten={scheduleSideEffects}
          onGrantsChanged={groupsState.reload}
          onOpenPerson={(userId) => { setGroupPage(null); setProfile({ userId, tab: "info" }); }}
          onDeleted={() => { setGroupPage(null); setListView("groups"); void afterAccessWrite(); }}
        />
      </div>
    );
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
          groups={groupsOn ? groups : null}
          onJoinGroup={(groupId) => joinGroup(profileMember.userId, groupId)}
          onLeaveGroup={(groupId) => leaveGroup(profileMember.userId, groupId)}
          onOpenGroup={manage ? (groupId) => openGroup(groupId) : undefined}
          onOpenNote={onCloseSettings ? (path) => {
            onCloseSettings();
            void useStore.getState().openNoteByPath(path);
          } : undefined}
        />
        {confirm && (
          <ConfirmDialog
            title={confirm.title}
            subtitle={confirm.subtitle}
            change={confirm.change}
            cancelLabel={confirm.cancelLabel}
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
      <div className="members-access-header">
        <h2 className="settings-section-title">Members and access</h2>
        {manage && (
          <button className="primary members-invite-btn" onClick={() => setInviteOpen(true)}>Invite people</button>
        )}
      </div>
      <p className="members-access-intro">Owners and admins can always manage access.</p>
      {error && <div className="auth-error">{error}</div>}
      {limitCause != null && <PeopleLimitNotice error={limitCause} canManageBilling={myRole === "owner"} ownerName={ownerName(members)} freeLimit={seatAccount ? freeLimitOf(seatAccount) : null} />}

      {manage && (
        <div className="members-access-rows">
          <div className="members-access-row">
            <span className="members-access-row-icon" aria-hidden="true">
              <PeopleIcon />
            </span>
            <span className="members-access-row-copy">
              <span className="members-access-row-title">{DEFAULT_ACCESS_TITLE}</span>
              <span className="muted">{everyone?.sub ?? DEFAULT_ACCESS_SUB}</span>
            </span>
            {teamAccess ? (
              <MenuSelect<string>
                value={teamAccess.posture === "none" ? "none" : teamAccess.mode}
                options={[
                  ...EVERYONE_OPTIONS,
                  ...(groupsOn ? groups.map((g, i) => ({
                    value: `${GROUP_OPTION}${g.id}`,
                    label: g.name,
                    hint: groupAccessSummary(g.grants) ?? undefined,
                    section: i === 0 ? "Access groups add to this" : undefined,
                  })) : []),
                ]}
                onSelect={(v) => {
                  if (isGroupOption(v)) openGroup(groupOptionId(v), "access");
                  else chooseEveryone(v as TeamAccessMode);
                }}
                disabled={busy}
                ariaLabel={`Default access for members of ${vaultName}`}
                triggerClassName={`members-access-trigger is-level ${levelClass(teamAccess.posture === "none" ? "private" : teamAccess.mode)}`}
                menuClassName="access-menu"
                triggerContent={everyone?.label}
              />
            ) : (
              <PillSkeleton label={`Loading default access for ${vaultName}`} />
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
              <MenuSelect<string>
                value={accessDefault.mode}
                options={[
                  ...NEW_MEMBER_OPTIONS,
                  ...(groupsOn ? groups.map((g, i) => ({
                    value: `${GROUP_OPTION}${g.id}`,
                    label: g.name,
                    hint: i === 0 ? "New members join the ticked groups" : undefined,
                    section: i === 0 ? "Also join access groups" : undefined,
                    checked: g.autoJoin,
                  })) : []),
                ]}
                triggerContent={(() => {
                  const label = NEW_MEMBER_OPTIONS.find((o) => o.value === accessDefault.mode)?.label ?? accessDefault.mode;
                  const joined = groupsOn ? groups.filter((g) => g.autoJoin).length : 0;
                  return <span className="role-trigger-label">{joined ? `${label} + ${joined} ${joined === 1 ? "group" : "groups"}` : label}</span>;
                })()}
                onSelect={(v) => {
                  if (isGroupOption(v)) {
                    const g = groups.find((x) => x.id === groupOptionId(v));
                    if (g) void toggleAutoJoin(g);
                  } else void chooseDefault(v as TeamAccessMode);
                }}
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

      <div className={`members-access-slot${selecting ? " is-selecting" : ""}`}>
      {groupsOn ? (
        <div className="members-access-toolbar">
          <div className="members-access-switch" role="tablist" aria-label="Show">
            {(["people", "groups"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={listView === v}
                className={`members-access-switch-btn${listView === v ? " is-active" : ""}`}
                onClick={() => { setListView(v); setQuery(""); setSelected(new Set()); }}
              >
                {v === "people" ? "People" : "Access groups"}
                <span className="members-access-switch-count">
                  {v === "people" ? (overview ? members.length + invitations.length : "") : (groupsState.list ? groups.length : "")}
                </span>
              </button>
            ))}
          </div>
          <span className="members-access-search">
            <SearchIcon />
            <input
              type="search"
              aria-label={listView === "groups" ? "Search access groups" : "Search people"}
              placeholder={listView === "groups" ? "Find access groups" : "Find people"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
          {listView === "groups" && manage && (
            <button type="button" className="ghost-pill members-access-toolbar-btn" disabled={busy} onClick={() => setGroupDialog({})}>
              + New access group
            </button>
          )}
        </div>
      ) : (
        <div className="members-access-legacy-head">
          <div className="members-access-list-heading">
            <h3>People</h3>
            <span className="members-access-count muted">
              {overview ? countLine(query, shown.members.length, shown.invitations.length) : <span className="skel-line members-skel-count" aria-hidden="true" />}
            </span>
          </div>
          <label className="members-access-search-field">
            <span className="members-access-search-label">Search this list</span>
            <span className="members-access-search">
              <SearchIcon />
              <input
                type="search"
                placeholder="Name or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
          </label>
        </div>
      )}
      {manage && listView === "people" && (
        <MemberSelectionBar
          shown={selecting}
          count={selectedMembers.length}
          groups={groupsOn ? groups : []}
          busy={busy}
          canAccess={selectedMembers.some(canSetAccess)}
          canRole={selectedMembers.some(canAct)}
          onAddToGroup={bulkAddToGroup}
          onAccess={bulkAccess}
          onRole={bulkRole}
          onRemove={bulkRemove}
          onClear={clearSelection}
        />
      )}
      </div>

      {groupsOn && listView === "groups" ? (
        <GroupsList
          list={groupsState.list}
          failed={groupsState.failed}
          members={members}
          manage={manage}
          busy={busy}
          query={query}
          onOpen={(g) => openGroup(g.id)}
          onRename={(g) => setGroupDialog({ rename: g })}
          onDelete={askDeleteGroup}
          onRetry={() => void groupsState.reload()}
        />
      ) : (<>
      {!overview && <TableSkeleton manage={manage} groups={groupsOn} />}

      {overview && (
        <table className={`members-table${manage ? " has-select" : ""}`}>
          <thead>
            <tr>
              {manage && (
                <th className="members-select-cell">
                  <HeaderCheck
                    state={headerCheckState(shownSelectable, selected)}
                    disabled={shownSelectable.length === 0}
                    onToggle={() => setSelected(toggleShown(shownSelectable, selected))}
                  />
                </th>
              )}
              <th>Name</th>
              <th>Role</th>
              {groupsOn && <th>Access groups</th>}
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
                  className={`is-clickable${selected.has(m.userId) ? " is-selected" : ""}`}
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
                  {manage && (
                    <td className="members-select-cell">
                      <input
                        type="checkbox"
                        className="members-check"
                        checked={selected.has(m.userId)}
                        disabled={!selectable(m)}
                        title={selectable(m) ? undefined : "You can't change this person"}
                        aria-label={`Select ${name}`}
                        onChange={() => setSelected((s) => {
                          const next = new Set(s);
                          if (next.has(m.userId)) next.delete(m.userId); else next.add(m.userId);
                          return next;
                        })}
                      />
                    </td>
                  )}
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
                  {groupsOn && (
                    <td>
                      <GroupChips ids={m.groupIds ?? []} groups={groups} onOpen={manage ? (id) => openGroup(id) : undefined} />
                    </td>
                  )}
                  {manage && (
                    <td>
                      <span className="members-access-cell" title={sourceOf(m)?.lines.join("\n")}>
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
                      </span>
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
                  {manage && <td className="members-select-cell" />}
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
                  {groupsOn && (
                    <td>
                      <GroupChips ids={inv.groupIds ?? []} groups={groups} onOpen={manage ? (id) => openGroup(id) : undefined} />
                    </td>
                  )}
                  {manage && <td>{inv.groupIds?.length ? "Their groups" : invitationAccessLabel(inv.access)}</td>}
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
      </>)}

      {groupDialog && orgId && (
        <GroupDialog
          orgId={orgId}
          groups={groups}
          group={groupDialog.rename}
          candidates={members.filter((m) => canSetAccess(m))}
          myUserId={myUserId}
          onClose={() => setGroupDialog(null)}
          onSaved={(id) => {
            const made = !groupDialog.rename;
            setGroupDialog(null);
            void afterAccessWrite();
            if (made) openGroup(id, "access");
          }}
        />
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
          subtitle={confirm.subtitle}
          change={confirm.change}
          cancelLabel={confirm.cancelLabel}
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
          vaultName={vaultName}
          newMembersAccess={accessDefault?.mode ?? null}
          onNewMembersAccess={manage ? (mode) => void chooseDefault(mode) : undefined}
          canManageBilling={myRole === "owner"}
          seatAccount={seatAccount}
          ownerName={ownerName(members)}
          groups={groupsOn ? groups : []}
          onClose={() => setInviteOpen(false)}
          onInvited={(results, sent) => {
            const limit = results.map((r) => (r.error ? inviteLimitError(r.error) : null)).find((x) => x != null);
            if (limit) setLimitCause(limit);
            patchRoster((r) => ({
              ...r,
              overview: r.overview ? withNewInvitations(r.overview, results, sent, new Date().toISOString()) : r.overview,
            }));
            void reload();
          }}
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
/**
 * The vault's billing account for the quiet seat line above the roster
 * (owner/admin only). Silent on any failure or when billing is off or not
 * on the Team model: the line simply does not show.
 */
function useSeatAccount(orgId: string | null, enabled: boolean): MyBillingAccount | null {
  const [account, setAccount] = useState<MyBillingAccount | null>(null);
  useEffect(() => {
    setAccount(null);
    if (!orgId || !enabled) return;
    let live = true;
    void (async () => {
      try {
        const config = await authManager.api.getBillingConfig();
        if (!config.enabled || config.model !== "team") return;
        const acct = await authManager.api.getBillingAccount({ orgId });
        if (live) setAccount(acct);
      } catch {
        // Fail silently: the seat line is informational.
      }
    })();
    return () => {
      live = false;
    };
  }, [orgId, enabled]);
  return account;
}

/** A person's (or invitation's) groups as small chips; "—" when none. */
function GroupChips({ ids, groups, onOpen }: { ids: readonly string[]; groups: readonly AccessGroup[]; onOpen?: (id: string) => void }) {
  const mine = groups.filter((g) => ids.includes(g.id));
  if (mine.length === 0) return <span className="muted">None</span>;
  const shown = mine.slice(0, 2);
  return (
    <span className="group-chips">
      {shown.map((g) => <GroupChip key={g.id} group={g} onOpen={onOpen ? () => onOpen(g.id) : undefined} />)}
      {mine.length > shown.length && <span className="muted group-chips-more" title={mine.slice(2).map((g) => g.name).join(", ")}>+{mine.length - shown.length}</span>}
    </span>
  );
}

/** The vault owner's display name for the seat line, or null. */
function ownerName(members: MemberOverview[]): string | null {
  const owner = members.find((m) => m.role === "owner");
  return owner ? owner.name || owner.email || null : null;
}

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

/** The table's select-all box; `indeterminate` is a property, never an attribute. */
function HeaderCheck({ state, disabled, onToggle }: { state: "none" | "some" | "all"; disabled: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "some"; }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="members-check"
      checked={state === "all"}
      disabled={disabled}
      aria-label={state === "all" ? "Clear selection" : "Select everyone shown"}
      onChange={onToggle}
    />
  );
}

function TableSkeleton({ manage, groups = false }: { manage: boolean; groups?: boolean }) {
  return (
    <table className="members-table members-table-skeleton" aria-busy="true" aria-label="Loading people">
      <thead>
        <tr>
          {manage && <th className="members-select-cell" />}
          <th>Name</th>
          <th>Role</th>
          {groups && <th>Access groups</th>}
          {manage && <th>Access</th>}
          <th>Last active</th>
          {manage && <th aria-label="Actions" />}
        </tr>
      </thead>
      <tbody aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <tr key={i}>
            {manage && <td className="members-select-cell" />}
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
            {groups && <td><span className="skel-line members-skel-role" /></td>}
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
