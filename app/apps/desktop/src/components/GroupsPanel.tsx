import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ActivitySkeleton } from "./MemberProfileSkeletons";
import { dayLabel } from "../lib/memberActivity";
import { createPortal } from "react-dom";
import type { AccessGroup, AccessGroupsList, GroupActivityEvent, GroupSkill, MemberOverview, TeamAccess } from "../lib/api";
import { ApiError } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  filterGroups,
  groupAccessSummary,
  groupColor,
  groupCountLine,
  groupNameProblem,
  nextGroupColor,
} from "../lib/groups";
import { relativeTime } from "../lib/health/format";
import { canManageMemberAccess, ROLE_LABEL } from "../lib/membersAccess";
import { checkSkillsNow } from "../lib/skills/syncHost";
import { skillDisplayName } from "../lib/skills/display";
import { syncManager } from "../lib/sync/docSession";
import { markSelfAccessChange } from "../lib/sync/selfAccessChanges";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { MemberAccessBoard } from "./MemberAccessBoard";
import { MenuSelect } from "./MenuSelect";
import { RowActionsMenu, type RowAction } from "./RowActionsMenu";
import { Switch } from "./Switch";

/**
 * Access groups (server migration 097) in Vault Settings → Members and access:
 * the Groups list, the New group / Rename dialog, the people picker and one
 * group's page (Members, Access, Skills, Activity).
 *
 * The rules, which every screen here repeats in plain words: a group only
 * ADDS access (someone in two groups gets the higher level), a person's own
 * vault-wide level ignores groups, and per-person No access and locks still
 * apply. A group's access is written through the same bulk route as a
 * person's, with the group audience.
 */

const personName = (m: Pick<MemberOverview, "name" | "email" | "userId">) => m.name || m.email || m.userId;

/** The groups list, loaded once per (org, enabled) and reloaded on demand. */
export function useAccessGroups(orgId: string | null, enabled: boolean) {
  const [list, setList] = useState<AccessGroupsList | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    if (!orgId || !enabled) return;
    try {
      setList(await authManager.api.listGroups(orgId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [orgId, enabled]);
  useEffect(() => {
    setList(null);
    setFailed(false);
    void reload();
  }, [reload]);
  return { list, failed, reload };
}

export function GroupDot({ group }: { group: Pick<AccessGroup, "id" | "color"> }) {
  return <span className={`group-dot group-c-${groupColor(group)}`} aria-hidden="true" />;
}

/** A small tinted chip with the group's name; removable when `onRemove` is set. */
export function GroupChip({ group, onRemove, onOpen }: {
  group: Pick<AccessGroup, "id" | "color" | "name">;
  onRemove?: () => void;
  onOpen?: () => void;
}) {
  return (
    <span className={`group-chip group-c-${groupColor(group)}`}>
      <svg className="group-chip-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6" />
      </svg>
      {onOpen ? (
        <button type="button" className="group-chip-name" onClick={(e) => { e.stopPropagation(); onOpen(); }}>{group.name}</button>
      ) : (
        <span className="group-chip-name">{group.name}</span>
      )}
      {onRemove && (
        <button type="button" className="group-chip-x" aria-label={`Remove from ${group.name}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
      )}
    </span>
  );
}

/** A few faces, then "+n". */
function AvatarStack({ people }: { people: MemberOverview[] }) {
  const shown = people.slice(0, 4);
  return (
    <span className="group-avatars">
      {shown.map((m) => <Avatar key={m.userId} label={personName(m)} image={m.image} userId={m.userId} />)}
      {people.length > shown.length && <span className="group-avatars-more">+{people.length - shown.length}</span>}
    </span>
  );
}

// ── The list ───────────────────────────────────────────────────────────────

export function GroupsList({ list, failed, members, manage, busy, query, onOpen, onRename, onDelete, onRetry }: {
  list: AccessGroupsList | null;
  /** The toolbar's search text (Members and access owns the search box). */
  query: string;
  failed: boolean;
  members: MemberOverview[];
  manage: boolean;
  busy: boolean;
  onOpen: (group: AccessGroup) => void;
  onRename: (group: AccessGroup) => void;
  onDelete: (group: AccessGroup) => void;
  onRetry: () => void;
}) {
  const groups = list?.groups ?? [];
  const shown = useMemo(() => filterGroups(query, groups, members), [query, groups, members]);
  const byId = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);

  return (
    <div className="groups-list">
      {failed && !list ? (
        <p className="member-activity-empty">Couldn't load groups. <button type="button" className="link-btn" onClick={onRetry}>Try again</button></p>
      ) : !list ? (
        <div className="groups-skel" aria-busy="true" aria-label="Loading groups">
          {[0, 1].map((i) => <span key={i} className="skel-line groups-skel-row" />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="groups-empty">
          <p className="groups-empty-title">No access groups yet</p>
          <p className="muted groups-empty-line">
            Put people in a group (Design, Sales, Contractors) and give the group access once, instead of person by person.
            {manage ? " A group only adds access; it never takes any away. Start with + New access group above." : ""}
          </p>
        </div>
      ) : shown.length === 0 ? (
        <p className="member-activity-empty">No group matches “{query.trim()}”.</p>
      ) : (
        <ul className="groups-rows">
          {shown.map((g) => {
            const people = g.memberIds.map((id) => byId.get(id)).filter((m): m is MemberOverview => !!m);
            const summary = groupAccessSummary(g.grants);
            const actions: RowAction[] = [{ key: "open", label: "Open", onSelect: () => onOpen(g) }];
            if (manage) {
              actions.push({ key: "rename", label: "Rename", onSelect: () => onRename(g) });
              actions.push({ key: "delete", label: "Delete access group", danger: true, separated: true, onSelect: () => onDelete(g) });
            }
            return (
              <li
                key={g.id}
                className="groups-row"
                role="button"
                tabIndex={0}
                aria-label={`Open ${g.name}`}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("button, [role='menu']") || !e.currentTarget.contains(e.target as Node)) return;
                  onOpen(g);
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  onOpen(g);
                }}
              >
                <span className={`groups-row-badge group-c-${groupColor(g)}`} aria-hidden="true">{g.name.trim().charAt(0).toUpperCase()}</span>
                <span className="groups-row-copy">
                  <span className="groups-row-name">
                    {g.name}
                    {g.autoJoin && <span className="groups-row-tag">New members join</span>}
                  </span>
                  <span className="muted">
                    {groupCountLine(g)}
                    {summary ? ` · ${summary}` : ""}
                    {g.skillCount ? ` · ${g.skillCount} ${g.skillCount === 1 ? "skill" : "skills"}` : ""}
                  </span>
                </span>
                <AvatarStack people={people} />
                <RowActionsMenu actions={actions} ariaLabel={`Actions for ${g.name}`} disabled={busy} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal group-dialog" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Checkbox list of people, searchable. */
function PeopleChecklist({ people, picked, onToggle, myUserId }: {
  people: MemberOverview[];
  picked: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  myUserId?: string;
}) {
  const [q, setQ] = useState("");
  const shown = people.filter((m) => {
    const s = q.trim().toLowerCase();
    return !s || (m.name ?? "").toLowerCase().includes(s) || (m.email ?? "").toLowerCase().includes(s);
  });
  return (
    <div className="group-picker">
      {people.length > 6 && (
        <span className="members-access-search">
          <input type="search" placeholder="Name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        </span>
      )}
      <ul className="group-picker-list">
        {shown.map((m) => (
          <li key={m.userId}>
            <label className="group-picker-row">
              <input type="checkbox" checked={picked.has(m.userId)} onChange={() => onToggle(m.userId)} />
              <Avatar label={personName(m)} image={m.image} userId={m.userId} />
              <span className="members-table-names">
                <span className="members-table-name">{personName(m)}{m.userId === myUserId && <span className="muted"> (you)</span>}</span>
                {m.email && m.name && <span className="muted">{m.email}</span>}
              </span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="muted group-picker-none">Nobody matches.</li>}
      </ul>
    </div>
  );
}

/** New group (name, people, auto-join) or Rename (name only). */
export function GroupDialog({ orgId, groups, group, candidates, myUserId, onClose, onSaved }: {
  orgId: string;
  groups: readonly AccessGroup[];
  /** Rename this group; absent = create a new one. */
  group?: AccessGroup;
  /** People who may be added (the caller can manage their access). */
  candidates: MemberOverview[];
  myUserId?: string;
  onClose: () => void;
  onSaved: (groupId: string) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [autoJoin, setAutoJoin] = useState(group?.autoJoin ?? false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const problem = groupNameProblem(name, groups, group?.id);

  const save = async () => {
    setTouched(true);
    if (problem) return;
    setError(null);
    try {
      if (group) {
        await authManager.api.updateGroup(orgId, group.id, { name: name.trim() });
        onSaved(group.id);
      } else {
        const made = await authManager.api.createGroup(orgId, {
          name: name.trim(),
          color: nextGroupColor(groups),
          autoJoin,
          memberIds: [...picked],
        });
        if (myUserId && picked.has(myUserId)) markSelfAccessChange([orgId]);
        onSaved(made.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={group ? "Rename access group" : "New access group"} onClose={onClose}>
      <div className="invite-head">
        <h2 className="confirm-title">{group ? "Rename access group" : "New access group"}</h2>
        <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <label className="group-dialog-field">
        <span className="invite-field-label">Name</span>
        <input
          type="text"
          autoFocus
          className="group-name-input"
          value={name}
          maxLength={60}
          placeholder="Design, Sales, Contractors…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
        />
      </label>
      {touched && problem && <div className="auth-error">{problem}</div>}
      {!group && (
        <>
          <span className="invite-field-label group-dialog-sub">People</span>
          <PeopleChecklist
            people={candidates}
            picked={picked}
            myUserId={myUserId}
            onToggle={(id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          />
          {/* A setting, not another person: a switch row, unlike the People checkboxes. */}
          <label className="group-dialog-setting">
            <span className="group-dialog-setting-text">
              New members join this group
              <small className="muted">Everyone who joins {"the vault"} later is added automatically.</small>
            </span>
            <Switch checked={autoJoin} onChange={setAutoJoin} ariaLabel="New members join this group" />
          </label>
          <p className="field-hint">Pick what it can open on its Access tab. Groups only add access.</p>
        </>
      )}
      {error && <div className="auth-error">{error}</div>}
      <div className="invite-foot">
        <span />
        <div className="confirm-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>Cancel</button>
          <AsyncButton className="primary" spinnerTone="on-accent" onClick={save}>
            {group ? "Save" : picked.size ? `Create with ${picked.size} ${picked.size === 1 ? "person" : "people"}` : "Create access group"}
          </AsyncButton>
        </div>
      </div>
    </Modal>
  );
}

/** Add people to one group. */
export function AddPeopleDialog({ group, candidates, myUserId, onClose, onAdd }: {
  group: AccessGroup;
  candidates: MemberOverview[];
  myUserId?: string;
  onClose: () => void;
  onAdd: (userIds: string[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal label={`Add people to ${group.name}`} onClose={onClose}>
      <div className="invite-head">
        <h2 className="confirm-title">Add people to {group.name}</h2>
        <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {candidates.length === 0 ? (
        <p className="muted">Everyone you can manage is already in this group.</p>
      ) : (
        <PeopleChecklist
          people={candidates}
          picked={picked}
          myUserId={myUserId}
          onToggle={(id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
        />
      )}
      {error && <div className="auth-error">{error}</div>}
      <p className="field-hint group-dialog-note">They get what {group.name} can open, on top of their own access.</p>
      <div className="invite-foot">
        <div className="confirm-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>Cancel</button>
          <AsyncButton
            className="primary"
            spinnerTone="on-accent"
            disabled={picked.size === 0}
            onClick={async () => {
              setError(null);
              try { await onAdd([...picked]); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            }}
          >
            {picked.size >= 2 ? `Add ${picked.size} people` : "Add"}
          </AsyncButton>
        </div>
      </div>
    </Modal>
  );
}

// ── One group ──────────────────────────────────────────────────────────────

export type GroupTab = "members" | "access" | "skills" | "activity";
const TAB_LABEL: Record<GroupTab, string> = { members: "Members", access: "Access", skills: "Skills", activity: "Activity" };

export function GroupPage({
  orgId, vaultName, group, groups, members, myUserId, myRole, manage, skillsEnabled, teamAccess,
  initialTab = "members", onBack, onChanged, onItemWritten, onGrantsChanged, onOpenPerson, onDeleted,
}: {
  orgId: string;
  vaultName: string;
  group: AccessGroup;
  groups: readonly AccessGroup[];
  members: MemberOverview[];
  myUserId?: string;
  myRole?: string;
  manage: boolean;
  /** The server has per-person skill access (and so group skill rows). */
  skillsEnabled: boolean;
  teamAccess: TeamAccess | null;
  initialTab?: GroupTab;
  onBack: () => void;
  /** Membership or access changed: reload groups + roster. */
  onChanged: () => Promise<void>;
  onItemWritten: () => void;
  /** Re-read the groups list only (cheap): after a move on the group's board. */
  onGrantsChanged: () => Promise<void>;
  onOpenPerson: (userId: string) => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<GroupTab>(manage ? initialTab : "members");
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; label: string; body: React.ReactNode; apply: () => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);
  const people = group.memberIds.map((id) => byId.get(id)).filter((m): m is MemberOverview => !!m);
  const canManagePerson = (m: MemberOverview) => manage && canManageMemberAccess(myRole, m.role, m.userId === myUserId);
  const candidates = members.filter((m) => !group.memberIds.includes(m.userId) && canManagePerson(m));
  const includesMe = !!myUserId && group.memberIds.includes(myUserId);
  const tabs: GroupTab[] = manage ? ["members", "access", ...(skillsEnabled ? (["skills"] as const) : []), "activity"] : ["members"];
  const summary = groupAccessSummary(group.grants);

  const selfResources = () => [orgId, ...(group.grants ?? []).map((g) => g.resourceId)];

  const remove = (m: MemberOverview) => {
    const self = m.userId === myUserId;
    setConfirm({
      title: self ? `Leave ${group.name}?` : `Remove ${personName(m)} from ${group.name}?`,
      label: "Remove",
      body: (
        <p className="confirm-note">
          {self ? "You lose" : "They lose"} only what {group.name} gave. {self ? "Your" : "Their"} own access and other groups stay.
        </p>
      ),
      apply: async () => {
        if (self) markSelfAccessChange(selfResources());
        await authManager.api.removeGroupMember(orgId, group.id, m.userId);
        toast(self ? `You left ${group.name}.` : `${personName(m)} is no longer in ${group.name}.`);
        await afterMembership();
      },
    });
  };

  const afterMembership = async () => {
    syncManager.retryHeldRegistrations();
    await onChanged();
  };

  const add = async (userIds: string[]) => {
    if (myUserId && userIds.includes(myUserId)) markSelfAccessChange(selfResources());
    const out = await authManager.api.addGroupMembers(orgId, group.id, userIds);
    setAdding(false);
    toast(out.added === 1 ? `Added 1 person to ${group.name}.` : `Added ${out.added} people to ${group.name}.`);
    await afterMembership();
  };

  const toggleAutoJoin = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await authManager.api.updateGroup(orgId, group.id, { autoJoin: !group.autoJoin });
      toast(!group.autoJoin ? `New members now join ${group.name}.` : `New members no longer join ${group.name}.`);
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const askDelete = () => setConfirm({
    title: `Delete ${group.name}?`,
    label: "Delete access group",
    body: (
      <p className="confirm-note">
        Its {group.memberIds.length === 1 ? "member loses" : `${group.memberIds.length} members lose`} only what {group.name} gave;
        their own access and other groups stay. This can't be undone.
      </p>
    ),
    apply: async () => {
      if (includesMe) markSelfAccessChange(selfResources());
      await authManager.api.deleteGroup(orgId, group.id);
      toast(`Deleted ${group.name}.`);
      onDeleted();
    },
  });

  const headerActions: RowAction[] = manage ? [
    { key: "rename", label: "Rename", onSelect: () => setRenaming(true) },
    { key: "auto", label: group.autoJoin ? "Stop adding new members" : "Add new members automatically", onSelect: () => void toggleAutoJoin() },
    { key: "delete", label: "Delete access group", danger: true, separated: true, onSelect: askDelete },
  ] : [];

  return (
    <section className="member-profile group-page" aria-label={group.name}>
      <button type="button" className="link-btn member-profile-back" onClick={onBack}>← Access groups</button>
      <header className="member-profile-head">
        <span className={`groups-row-badge is-lg group-c-${groupColor(group)}`} aria-hidden="true">{group.name.trim().charAt(0).toUpperCase()}</span>
        <span className="member-profile-names">
          <span className="member-profile-name">{group.name}</span>
          <span className="muted">
            {groupCountLine(group)}{summary ? ` · ${summary}` : ""}{group.autoJoin ? " · New members join" : ""}
          </span>
        </span>
        {people.length > 0 && (
          <span className="group-page-faces" title={people.map(personName).join(", ")}>
            <AvatarStack people={people} />
          </span>
        )}
        {headerActions.length > 0 && (
          <span className="group-page-actions">
            <RowActionsMenu actions={headerActions} ariaLabel={`Actions for ${group.name}`} disabled={busy} />
          </span>
        )}
      </header>
      {/* One tab is no choice: a plain member sees Members alone, so no strip. */}
      {tabs.length > 1 && (
        // The tabs and Members' "+ Add people" share one row, the button as
        // tall as the tab strip. The header already gives the count.
        <div className="group-page-tabsrow">
          <div className="member-profile-tabs" role="tablist" aria-label="Group">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={t === tab} className={`member-profile-tab${t === tab ? " active" : ""}`} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {tab === "members" && manage && (
            <button type="button" className="ghost-pill members-access-toolbar-btn group-page-add" disabled={busy} onClick={() => setAdding(true)}>
              + Add people
            </button>
          )}
        </div>
      )}

      {tab === "members" ? (
        <div className="group-members">
          {people.length === 0 && group.invited.length === 0 ? (
            <p className="member-activity-empty">Nobody is in {group.name} yet.</p>
          ) : (
            <table className="members-table">
              <thead><tr><th>Name</th><th>Role</th><th aria-label="Note" />{manage && <th aria-label="Actions" />}</tr></thead>
              <tbody>
                {people.map((m) => (
                  <tr key={m.userId} className="is-clickable" onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button") || !e.currentTarget.contains(e.target as Node)) return;
                    if (manage) onOpenPerson(m.userId);
                  }}>
                    <td>
                      <span className="members-table-person">
                        <Avatar label={personName(m)} image={m.image} userId={m.userId} />
                        <span className="members-table-names">
                          <span className="members-table-name">{personName(m)}{m.userId === myUserId && <span className="muted"> (you)</span>}</span>
                          {m.email && m.name && <span className="muted">{m.email}</span>}
                        </span>
                      </span>
                    </td>
                    <td>{ROLE_LABEL[m.role] ?? m.role}</td>
                    <td className="muted group-member-note">
                      {m.access?.own ? "Has their own vault-wide access, so this group adds nothing for them" : ""}
                    </td>
                    {manage && (
                      <td className="members-table-actions">
                        {canManagePerson(m) && (
                          <RowActionsMenu
                            ariaLabel={`Actions for ${personName(m)}`}
                            disabled={busy}
                            actions={[
                              { key: "profile", label: "View profile", onSelect: () => onOpenPerson(m.userId) },
                              { key: "remove", label: `Remove from ${group.name}`, danger: true, separated: true, onSelect: () => remove(m) },
                            ]}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {group.invited.map((inv) => (
                  <tr key={inv.invitationId} className="is-invited">
                    <td>
                      <span className="members-table-person">
                        <Avatar label={inv.email} image={null} />
                        <span className="members-table-names">
                          <span className="members-table-name">{inv.email}</span>
                          <span className="muted">Joins {group.name} when they accept</span>
                        </span>
                      </span>
                    </td>
                    <td>Invited</td>
                    <td />
                    {manage && <td />}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="field-hint group-members-note">
            A group only adds access: someone in two groups gets the higher level. A person set to No access somewhere,
            or with their own vault-wide level, keeps that.
          </p>
        </div>
      ) : tab === "access" ? (
        <GroupAccessTab orgId={orgId} group={group} includesMe={includesMe} teamAccess={teamAccess} onGrantsChanged={onGrantsChanged} onItemWritten={onItemWritten} />
      ) : tab === "skills" ? (
        <GroupSkillsTab orgId={orgId} group={group} includesMe={includesMe} onChanged={onChanged} />
      ) : (
        <GroupActivityTab orgId={orgId} group={group} vaultName={vaultName} />
      )}

      {adding && (
        <AddPeopleDialog group={group} candidates={candidates} myUserId={myUserId} onClose={() => setAdding(false)} onAdd={add} />
      )}
      {renaming && (
        <GroupDialog
          orgId={orgId}
          groups={groups}
          group={group}
          candidates={[]}
          myUserId={myUserId}
          onClose={() => setRenaming(false)}
          onSaved={() => { setRenaming(false); void onChanged(); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.label}
          tone="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try { await confirm.apply(); } catch (e) { toast(e instanceof Error ? e.message : String(e), "error"); }
            setConfirm(null);
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
    </section>
  );
}

function GroupAccessTab({ orgId, group, includesMe, teamAccess, onGrantsChanged, onItemWritten }: {
  orgId: string;
  group: AccessGroup;
  includesMe: boolean;
  teamAccess: TeamAccess | null;
  onGrantsChanged: () => Promise<void>;
  onItemWritten: () => void;
}) {
  const vaultId = syncManager.registry.vaultId;
  const vaultGrant = group.grants?.find((g) => g.resourceType === "vault");
  // The board treats `member` as a label only when `group` is set.
  const label: MemberOverview = useMemo(() => ({
    userId: `group:${group.id}`, memberId: "", role: "member", name: group.name, email: null, image: null,
    joinedAt: null, lastActiveAt: null,
  }), [group.id, group.name]);
  if (!vaultId) return <p className="member-activity-empty">Open the vault's folder on this computer to set what {group.name} can open.</p>;
  return (
    <div className="group-access">
      <p className="field-hint group-access-note">
        What {group.name} can open, on top of each member's own access. No access here only means the group adds nothing.
      </p>
      <MemberAccessBoard
        orgId={orgId}
        vaultId={vaultId}
        member={label}
        isSelf={false}
        canSetAccess
        everyoneMode={teamAccess && teamAccess.posture !== "none" ? teamAccess.mode : null}
        personVaultMode={vaultGrant ? (vaultGrant.permission === "edit" ? "open" : "readonly") : null}
        // Each move: the debounced padlock refresh, plus the group's grants
        // (the board's "groups only add" floor reads them). No roster reload.
        onItemWritten={() => { onItemWritten(); void onGrantsChanged(); }}
        onChanged={async () => { onItemWritten(); await onGrantsChanged(); }}
        group={{ id: group.id, name: group.name, grants: group.grants ?? [], includesMe }}
      />
    </div>
  );
}

type SkillLevel = "required" | "optional" | "nothing";
const SKILL_OPTIONS: ReadonlyArray<{ value: SkillLevel; label: string; hint: string }> = [
  { value: "required", label: "Required", hint: "Installs for every member of the group" },
  { value: "optional", label: "Optional", hint: "Members can turn it on" },
  { value: "nothing", label: "Adds nothing", hint: "Each person keeps their own setting" },
];
const SKILL_LEVEL_CLASS: Record<SkillLevel, string> = { required: "is-edit", optional: "is-view", nothing: "is-unset" };

function GroupSkillsTab({ orgId, group, includesMe, onChanged }: {
  orgId: string;
  group: AccessGroup;
  includesMe: boolean;
  onChanged: () => Promise<void>;
}) {
  const [skills, setSkills] = useState<GroupSkill[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setSkills(await authManager.api.getGroupSkills(orgId, group.id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [orgId, group.id]);
  useEffect(() => { void load(); }, [load]);

  const choose = async (s: GroupSkill, level: SkillLevel) => {
    setBusy(s.skillId);
    try {
      await authManager.api.putSkillAccess(orgId, s.skillId, { groups: [{ groupId: group.id, level: level === "nothing" ? null : level }] });
      setSkills((prev) => prev?.map((x) => (x.skillId === s.skillId ? { ...x, level: level === "nothing" ? null : level } : x)) ?? prev);
      if (includesMe) checkSkillsNow();
      const name = skillDisplayName(s.name);
      toast(level === "nothing" ? `${group.name} no longer adds ${name}.` : `${group.name} now gets ${name} as ${level}.`);
      void onChanged();
    } catch (e) {
      toast(`Couldn't change ${skillDisplayName(s.name)}: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  if (failed && !skills) return <p className="member-activity-empty">Couldn't load skills. <button type="button" className="link-btn" onClick={() => void load()}>Try again</button></p>;
  if (!skills) return <div className="skills-access-skel" aria-busy="true" aria-label="Loading skills" />;
  if (skills.length === 0) return <p className="member-activity-empty">This vault has no team skills yet.</p>;
  return (
    <div className="group-skills">
      <ul className="skills-access-people">
        {skills.map((s) => {
          const level: SkillLevel = s.level ?? "nothing";
          return (
            <li key={s.skillId} className="skills-access-person">
              <span className="members-table-names">
                <span className="members-table-name">{skillDisplayName(s.name)}</span>
                <span className="muted">{s.latestVersion ? s.description || `Version ${s.latestVersion}` : "Not published yet"}</span>
              </span>
              <MenuSelect<SkillLevel>
                value={level}
                options={SKILL_OPTIONS}
                onSelect={(l) => void choose(s, l)}
                disabled={busy !== null}
                ariaLabel={`${skillDisplayName(s.name)} for ${group.name}`}
                triggerClassName={`members-access-trigger is-level ${SKILL_LEVEL_CLASS[level]}`}
                menuClassName="access-menu"
              />
            </li>
          );
        })}
      </ul>
      <p className="field-hint skills-access-note group-tab-note">
        A group only adds: members get the higher of the group's level and the Everyone row. Someone set to No access for a
        skill keeps that.
      </p>
    </div>
  );
}

const gGlyph = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const GROUP_GLYPH: Record<GroupActivityEvent["kind"], React.ReactNode> = {
  created: gGlyph(<path d="M12 5v14M5 12h14" />),
  updated: gGlyph(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  deleted: gGlyph(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>),
  memberAdded: gGlyph(<><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M19 8v6M16 11h6" /></>),
  memberRemoved: gGlyph(<><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M16 11h6" /></>),
  accessGranted: gGlyph(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  accessRemoved: gGlyph(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></>),
};

/** "3 people added and 2 access changes in the last 30 days." */
export function groupActivitySummary(events: readonly GroupActivityEvent[], now: number): string | null {
  const since = now - 30 * 86_400_000;
  const recent = events.filter((e) => Date.parse(e.at) >= since);
  const added = recent.filter((e) => e.kind === "memberAdded").length;
  const access = recent.filter((e) => e.kind === "accessGranted" || e.kind === "accessRemoved").length;
  const parts = [
    added ? `${added} ${added === 1 ? "person" : "people"} added` : "",
    access ? `${access} access ${access === 1 ? "change" : "changes"}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} in the last 30 days.` : null;
}

function GroupActivityTab({ orgId, group, vaultName }: { orgId: string; group: AccessGroup; vaultName: string }) {
  const [events, setEvents] = useState<GroupActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    authManager.api.getGroupActivity(orgId, group.id)
      .then((e) => { if (live) setEvents(e); })
      .catch((e) => { if (live) setError(e instanceof ApiError && e.status === 403 ? "Only the vault owner or an admin can see this." : "Couldn't load activity."); });
    return () => { live = false; };
  }, [orgId, group.id]);
  if (error) return <p className="member-activity-empty">{error}</p>;
  if (!events) return <ActivitySkeleton />;
  if (events.length === 0) return <p className="member-activity-empty">No activity yet.</p>;
  const now = Date.now();
  const days: { key: string; label: string; events: GroupActivityEvent[] }[] = [];
  for (const e of events) {
    const d = new Date(Date.parse(e.at));
    d.setHours(0, 0, 0, 0);
    const key = String(d.getTime());
    const last = days[days.length - 1];
    if (last?.key === key) last.events.push(e);
    else days.push({ key, label: dayLabel(d.getTime(), now), events: [e] });
  }
  const summary = groupActivitySummary(events, now);
  return (
    <div className="member-activity">
      {summary && <p className="member-activity-summary">{summary}</p>}
      <ol className="member-activity-trail">
        <li className="member-activity-now"><span className="member-activity-now-dot" aria-hidden="true" />Now</li>
        {days.map((day) => (
          <Fragment key={day.key}>
            <li className="member-activity-day"><span className="member-activity-day-pill">{day.label}</span></li>
            {day.events.map((e, i) => (
              <li key={`${day.key}:${i}`} className={`member-activity-entry${e.kind === "created" ? " is-origin" : ""}`}>
                <span className="member-activity-node" aria-hidden="true">{GROUP_GLYPH[e.kind]}</span>
                <div className="member-activity-body">
                  <p className="member-activity-text">
                    {activityLine(e, group.name, vaultName)}
                    <span className="member-activity-time"> · {relativeTime(Date.parse(e.at), now)}</span>
                  </p>
                </div>
              </li>
            ))}
          </Fragment>
        ))}
      </ol>
    </div>
  );
}

const by = (e: { by: { name: string | null } | null }) => (e.by?.name ? ` by ${e.by.name}` : "");
const itemName = (path: string | null) => (path ? path.split("/").filter(Boolean).pop() ?? path : "an item");

export function activityLine(e: GroupActivityEvent, group: string, vaultName: string): React.ReactNode {
  switch (e.kind) {
    case "created": return <>Access group created{by(e)}</>;
    case "updated": return <>Access group settings changed{by(e)}</>;
    case "deleted": return <>Access group deleted{by(e)}</>;
    case "memberAdded": return <><strong>{e.person.name || e.person.email || "Someone"}</strong> added to {group}{by(e)}</>;
    case "memberRemoved": return <><strong>{e.person.name || e.person.email || "Someone"}</strong> removed from {group}{by(e)}</>;
    case "accessGranted": {
      const what = e.resourceType === "vault" ? <>all of {vaultName}</> : <strong>{itemName(e.path)}</strong>;
      return <>{group} can {e.permission === "edit" ? "edit" : "view"} {what}{by(e)}</>;
    }
    case "accessRemoved": {
      const what = e.resourceType === "vault" ? <>{vaultName} as a whole</> : <strong>{itemName(e.path)}</strong>;
      return <>{group} no longer gives access to {what}{by(e)}</>;
    }
  }
}
