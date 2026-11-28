import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupIconFor } from "../lib/groupIcon";
import { ActivitySkeleton } from "./MemberProfileSkeletons";
import { dayLabel } from "../lib/memberActivity";
import { createPortal } from "react-dom";
import type { AccessGroup, AccessGroupsList, GroupActivityEvent, GroupSkill, HeldPerson, MemberOverview, TeamAccess } from "../lib/api";
import { HeldBackDialog, HeldChoices } from "./HeldBackDialog";
import { ApiError } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  defaultGroupName,
  filterGroups,
  groupAccessSummary,
  groupColor,
  groupCountLine,
  groupNameProblem,
  groupDeleteNote,
  groupRemoveNote,
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
import { CheckIcon } from "./CheckIcon";
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

const GroupIconSvg = lazy(() => import("./GroupIconSvg"));

/** The group's square: its icon (from its name) on its own tint; the first letter while the icon loads. */
export function GroupBadge({ group, large = false }: { group: Pick<AccessGroup, "id" | "color" | "name">; large?: boolean }) {
  return (
    <span className={`groups-row-badge${large ? " is-lg" : ""} group-c-${groupColor(group)}`} aria-hidden="true">
      <Suspense fallback={group.name.trim().charAt(0).toUpperCase()}>
        <GroupIconSvg icon={groupIconFor(group)} />
      </Suspense>
    </span>
  );
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
      <span className="group-chip-icon" aria-hidden="true">
        <Suspense fallback={null}><GroupIconSvg icon={groupIconFor(group)} /></Suspense>
      </span>
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

export function GroupsList({ list, failed, members, manage, busy, query, onOpen, onRename, onDelete, onRetry, onCreateForEveryone }: {
  list: AccessGroupsList | null;
  /** "Create a group for everyone" (owners/admins; no automatic group, 2026-11-27). */
  onCreateForEveryone?: () => void;
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
            {manage ? " A group only gives access, and a setting just for a person still decides for them. Start with + New access group above." : ""}
          </p>
          {manage && onCreateForEveryone && (
            <button type="button" className="ghost-pill groups-empty-everyone" disabled={busy} onClick={onCreateForEveryone}>
              Create a group for everyone
            </button>
          )}
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
                <GroupBadge group={g} />
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

function Modal({ label, onClose, children, className, closeOnBackdrop = true }: { label: string; onClose: () => void; children: React.ReactNode; className?: string; closeOnBackdrop?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); if (closeOnBackdrop) onClose(); }}>
      <div className={`modal group-dialog${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Checkbox list of people, searchable. */
function PeopleChecklist({ people, picked, onToggle, onToggleAll, myUserId, grid = false, label }: {
  /** "Select all" on the head line (the people the search shows). */
  onToggleAll?: (userIds: string[], on: boolean) => void;
  /** Cards in a grid (the wide dialogs), easier to scan for many people. */
  grid?: boolean;
  /** The field's name, drawn on the head line with the count, search and Select all. */
  label?: string;
  people: MemberOverview[];
  picked: Set<string>;
  onToggle: (userId: string) => void;
  myUserId?: string;
}) {
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const shown = people.filter((m) => {
    const s = q.trim().toLowerCase();
    return !s || (m.name ?? "").toLowerCase().includes(s) || (m.email ?? "").toLowerCase().includes(s);
  });
  const allOn = shown.length > 0 && shown.every((m) => picked.has(m.userId));
  const some = !allOn && shown.some((m) => picked.has(m.userId));
  const searchIcon = (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
  // One head line (2026-11-28): name and count on the left; a search icon
  // that opens a small field, and Select all, on the right.
  const head = label !== undefined && (
    <div className="group-picker-head">
      <span className="invite-field-label">{label}</span>
      <small className="muted group-picker-count">{picked.size} of {people.length} selected</small>
      <span className="group-picker-tools">
        {people.length > 6 && (searching || q ? (
          <span className="members-access-search group-picker-search is-compact">
            {searchIcon}
            <input
              type="search"
              autoFocus
              placeholder="Find people"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onBlur={() => { if (!q) setSearching(false); }}
              onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }}
              aria-label="Search people"
            />
          </span>
        ) : (
          <button type="button" className="icon-btn group-picker-search-btn" aria-label="Search people" title="Search people" onClick={() => setSearching(true)}>
            {searchIcon}
          </button>
        ))}
        {onToggleAll && shown.length > 1 && (
          <label className="group-picker-all">
            <input
              type="checkbox"
              checked={allOn}
              ref={(el) => { if (el) el.indeterminate = some; }}
              onChange={() => onToggleAll(shown.map((m) => m.userId), !allOn)}
            />
            <span>Select all</span>
          </label>
        )}
      </span>
    </div>
  );
  return (
    <div className="group-picker">
      {head}
      {label === undefined && people.length > 6 && (
        <span className="members-access-search group-picker-search">
          {searchIcon}
          <input type="search" placeholder="Find people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        </span>
      )}
      <ul className={`group-picker-list${grid ? " is-grid" : ""}`}>
        {shown.map((m) => (
          <li key={m.userId}>
            <label className={`group-picker-row${picked.has(m.userId) ? " is-picked" : ""}`}>
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

/** New group (name, people, auto-join, then what it opens) or Rename (name only). */
export function GroupDialog({ orgId, groups, group, candidates, myUserId, onClose, onSaved, forEveryone = false }: {
  orgId: string;
  /** "Create a group for everyone": everyone in, new members join. */
  forEveryone?: boolean;
  groups: readonly AccessGroup[];
  /** Rename this group; absent = create a new one. */
  group?: AccessGroup;
  /** People who may be added (the caller can manage their access). */
  candidates: MemberOverview[];
  myUserId?: string;
  onClose: () => void;
  onSaved: (groupId: string) => void;
}) {
  if (!group) {
    return <NewGroupWizard orgId={orgId} groups={groups} candidates={candidates} myUserId={myUserId} forEveryone={forEveryone} onClose={onClose} onSaved={onSaved} />;
  }
  return <RenameGroupDialog orgId={orgId} groups={groups} group={group} onClose={onClose} onSaved={onSaved} />;
}

function RenameGroupDialog({ orgId, groups, group, onClose, onSaved }: {
  orgId: string;
  groups: readonly AccessGroup[];
  group: AccessGroup;
  onClose: () => void;
  onSaved: (groupId: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const problem = groupNameProblem(name, groups, group.id);
  const save = async () => {
    setTouched(true);
    if (problem) return;
    setError(null);
    try {
      await authManager.api.updateGroup(orgId, group.id, { name: name.trim() });
      onSaved(group.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal label="Rename access group" onClose={onClose}>
      <div className="invite-head">
        <h2 className="confirm-title">Rename access group</h2>
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
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
        />
      </label>
      {touched && problem && <div className="auth-error">{problem}</div>}
      {error && <div className="auth-error">{error}</div>}
      <div className="invite-foot">
        <span />
        <div className="confirm-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>Cancel</button>
          <AsyncButton className="primary" spinnerTone="on-accent" onClick={save}>Save</AsyncButton>
        </div>
      </div>
    </Modal>
  );
}

/**
 * New access group in two steps, in one large dialog that keeps its size
 * (2026-11-28): 1. name and people; 2. what it can open, on the group's own
 * board. Nothing reaches anyone until Create group: step 2 edits a group with
 * nobody in it yet, so its moves change nobody's access. Create group then
 * asks about everyone whose own setting differs from what the group gives
 * (Keep their own / Use the group's), adds the people and applies the
 * choices. Cancel, Escape or the close button at step 2 deletes it again.
 */
function NewGroupWizard({ orgId, groups, candidates, myUserId, forEveryone, onClose, onSaved }: {
  orgId: string;
  groups: readonly AccessGroup[];
  candidates: MemberOverview[];
  myUserId?: string;
  forEveryone: boolean;
  onClose: () => void;
  onSaved: (groupId: string) => void;
}) {
  const [name, setName] = useState(forEveryone ? (groups.some((g) => g.name.trim().toLowerCase() === "everyone") ? "All members" : "Everyone") : "");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(forEveryone ? candidates.map((c) => c.userId) : []));
  const [autoJoin, setAutoJoin] = useState(forEveryone);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // 3 ("own") only when someone's own setting differs from what the group gives.
  const [step, setStep] = useState<"people" | "access" | "own">("people");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  // The group being set up (nobody in it until Create group).
  const [draft, setDraft] = useState<AccessGroup | null>(null);
  const [held, setHeld] = useState<HeldPerson[] | null>(null);
  const [working, setWorking] = useState(false);
  // Closed some other way (Settings shut) before Create group: delete it too.
  const pending = useRef<string | null>(null);
  useEffect(() => () => {
    if (pending.current) void authManager.api.deleteGroup(orgId, pending.current).catch(() => {});
  }, [orgId]);
  // No name typed: "Group N" (2026-11-28), shown as the placeholder.
  const fallbackName = useMemo(() => defaultGroupName(groups.filter((g) => g.id !== draft?.id)), [groups, draft?.id]);
  const finalName = name.trim() || fallbackName;
  const problem = groupNameProblem(finalName, groups.filter((g) => g.id !== draft?.id), draft?.id);
  const byId = useMemo(() => new Map(candidates.map((m) => [m.userId, m])), [candidates]);
  const nameOf = (userId: string) => { const m = byId.get(userId); return m?.name || m?.email || "Someone"; };
  const imageOf = (userId: string) => byId.get(userId)?.image ?? null;
  const count = picked.size;

  const reloadDraft = async (id: string) => {
    const list = await authManager.api.listGroups(orgId);
    const g = list.groups.find((x) => x.id === id) ?? null;
    if (g) setDraft(g);
    return g;
  };

  const next = async () => {
    setTouched(true);
    if (problem) return;
    setError(null);
    try {
      if (!draft) {
        const made = await authManager.api.createGroup(orgId, { name: finalName, color: nextGroupColor(groups), autoJoin: false, memberIds: [] });
        pending.current = made.id;
        const g = await reloadDraft(made.id);
        if (!g) setDraft({ id: made.id, name: finalName, color: null, autoJoin: false, memberIds: [], invited: [], grants: [] } as unknown as AccessGroup);
      } else if (draft.name !== finalName) {
        await authManager.api.updateGroup(orgId, draft.id, { name: finalName });
        await reloadDraft(draft.id);
      }
      setStep("access");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Leaving before Create group: the group was never created for anyone.
  const cancel = () => {
    if (draft) void authManager.api.deleteGroup(orgId, draft.id).catch(() => {});
    pending.current = null;
    onClose();
  };

  const commit = async (useGroups: HeldPerson[]) => {
    if (!draft) return;
    const ids = [...picked];
    if (myUserId && picked.has(myUserId)) markSelfAccessChange([orgId, ...(draft.grants ?? []).map((g) => g.resourceId)]);
    if (ids.length) await authManager.api.addGroupMembers(orgId, draft.id, ids);
    if (useGroups.length) {
      await authManager.api.groupLetDecide(orgId, draft.id, useGroups.map((h) => ({ userId: h.userId, resourceType: h.resourceType, resourceId: h.resourceId })));
    }
    if (autoJoin) await authManager.api.updateGroup(orgId, draft.id, { autoJoin: true });
    pending.current = null;
    syncManager.retryHeldRegistrations();
    toast(ids.length ? `Created ${draft.name} with ${ids.length === 1 ? "1 person" : `${ids.length} people`}.` : `Created ${draft.name}.`);
    onSaved(draft.id);
  };

  const create = async () => {
    if (!draft || working) return;
    setError(null);
    setWorking(true);
    try {
      const list = count
        ? await authManager.api.groupHeld(orgId, draft.id, { addUserIds: [...picked] }).catch(() => [] as HeldPerson[])
        : [];
      if (list.length) { setHeld(list); setChosen(new Set()); setStep("own"); return; }
      await commit([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const placeOf = (type: string, id: string) => type === "vault"
    ? "the whole vault"
    : (draft?.grants ?? []).find((g) => g.resourceId === id)?.path?.split("/").pop() ?? null;
  const STEPS = { people: "Name and people", access: "Access", own: "Their own settings" } as const;
  const stepNo = step === "people" ? 1 : step === "access" ? 2 : 3;
  const close = step === "people" ? onClose : cancel;

  const createLabel = count ? `Create with ${count} ${count === 1 ? "person" : "people"}` : "Create access group";

  return (
    <Modal label="New access group" onClose={close} className="is-wizard" closeOnBackdrop={step === "people"}>
      <div className="invite-head">
        <span className="group-wizard-title">
          <h2 className="confirm-title">New access group</h2>
          <ol className="wizard-steps" aria-label={`Step ${stepNo}`}>
            {(held || step === "own" ? (["people", "access", "own"] as const) : (["people", "access"] as const)).map((s, i) => {
              const n = i + 1;
              const state = n < stepNo ? "done" : n === stepNo ? "current" : "todo";
              return (
                <li key={s} className={`wizard-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                  <span className="wizard-step-dot">{state === "done" ? <CheckIcon size={11} /> : n}</span>
                  <span className="wizard-step-label">{STEPS[s]}</span>
                </li>
              );
            })}
          </ol>
        </span>
        <button type="button" className="invite-close" aria-label="Close" onClick={close}>×</button>
      </div>
      <div className="group-wizard-body">
        {step === "people" ? (
          <>
            <label className="group-dialog-field">
              <span className="invite-field-label">Name</span>
              <input
                type="text"
                autoFocus
                className="group-name-input"
                value={name}
                maxLength={60}
                placeholder={fallbackName}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void next(); } }}
              />
            </label>
            {touched && problem && <div className="auth-error">{problem}</div>}
            <PeopleChecklist
              label="People"
              people={candidates}
              picked={picked}
              myUserId={myUserId}
              grid
              onToggle={(id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
              onToggleAll={(ids, on) => setPicked((p) => { const n = new Set(p); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; })}
            />
            {/* Settings, not more people: switch rows, set apart from the cards. */}
            <div className="group-dialog-settings">
            <label className="group-dialog-setting">
              <span className="group-dialog-setting-text">
                New members join this group
                <small className="muted">Everyone who joins {"the vault"} later is added automatically.</small>
              </span>
              <Switch checked={autoJoin} onChange={setAutoJoin} ariaLabel="New members join this group" />
            </label>
            </div>
          </>
        ) : step === "own" && held && draft ? (
          <>
            <p className="group-wizard-question">Keep theirs, or use the group's?</p>
            <HeldChoices groupName={draft.name} held={held} nameOf={nameOf} imageOf={imageOf} placeOf={placeOf} chosen={chosen} onChosen={setChosen} />
          </>
        ) : draft ? (
          <>
            <p className="field-hint group-wizard-note">
              What {draft.name} can open. <span className="access-board-intro-drag">Drag</span> rows between columns; nothing reaches anyone until you create the group.
            </p>
            <GroupAccessTab
              orgId={orgId}
              group={draft}
              includesMe={false}
              teamAccess={null}
              onGrantsChanged={async () => { await reloadDraft(draft.id); }}
              onItemWritten={() => {}}
              nameOf={nameOf}
              imageOf={imageOf}
              setup
            />
          </>
        ) : null}
      </div>
      {error && <div className="auth-error">{error}</div>}
      <div className="invite-foot">
        {step !== "people" ? (
          <button type="button" className="ghost-pill" onClick={() => { if (step === "own") { setHeld(null); setStep("access"); } else setStep("people"); }}>← Back</button>
        ) : <span />}
        <div className="confirm-actions">
          <button type="button" className="ghost-pill" onClick={close}>Cancel</button>
          {step === "people" ? (
            <AsyncButton className="primary" spinnerTone="on-accent" onClick={next}>Next</AsyncButton>
          ) : step === "own" ? (
            <AsyncButton className="primary" spinnerTone="on-accent" onClick={async () => {
              try { await commit((held ?? []).filter((h) => chosen.has(h.userId))); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            }}>{createLabel}</AsyncButton>
          ) : (
            <AsyncButton className="primary" spinnerTone="on-accent" disabled={!draft} onClick={create}>{createLabel}</AsyncButton>
          )}
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
    <Modal label={`Add people to ${group.name}`} onClose={onClose} className="is-wide">
      <div className="invite-head">
        <h2 className="confirm-title">Add people to {group.name}</h2>
        <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {candidates.length === 0 ? (
        <p className="muted">Everyone you can manage is already in this group.</p>
      ) : (
        <PeopleChecklist
          label="People"
          people={candidates}
          picked={picked}
          myUserId={myUserId}
          grid
          onToggle={(id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          onToggleAll={(ids, on) => setPicked((p) => { const n = new Set(p); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; })}
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
  const [heldAdd, setHeldAdd] = useState<{ userIds: string[]; held: HeldPerson[] } | null>(null);
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
        <p className="confirm-note">{groupRemoveNote(group.name, group.grants ?? null, { self, name: personName(m) })}</p>
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

  const nameOf = (userId: string) => {
    const m = members.find((x) => x.userId === userId);
    return m?.name || m?.email || "Someone";
  };
  const imageOf = (userId: string) => members.find((x) => x.userId === userId)?.image ?? null;
  const placeOf = (type: string, id: string) => type === "vault"
    ? "the whole vault"
    : (group.grants ?? []).find((g) => g.resourceId === id)?.path?.split("/").pop() ?? null;

  const commitAdd = async (userIds: string[], letDecide: HeldPerson[]) => {
    if (myUserId && userIds.includes(myUserId)) markSelfAccessChange(selfResources());
    const out = await authManager.api.addGroupMembers(orgId, group.id, userIds);
    if (letDecide.length) {
      await authManager.api.groupLetDecide(orgId, group.id, letDecide.map((h) => ({
        userId: h.userId, resourceType: h.resourceType, resourceId: h.resourceId,
      })));
    }
    setAdding(false);
    setHeldAdd(null);
    toast(out.added === 1 ? `Added 1 person to ${group.name}.` : `Added ${out.added} people to ${group.name}.`);
    await afterMembership();
  };

  // Ask first (2026-11-27): someone whose own setting keeps what the group
  // gives from reaching them is named before they are added.
  const add = async (userIds: string[]) => {
    const held = await authManager.api.groupHeld(orgId, group.id, { addUserIds: userIds }).catch(() => [] as HeldPerson[]);
    if (held.length) {
      setAdding(false);
      setHeldAdd({ userIds, held });
      return;
    }
    await commitAdd(userIds, []);
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
      <p className="confirm-note">{groupDeleteNote(group.name, group.grants ?? null, group.memberIds.length)}</p>
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
        <GroupBadge group={group} large />
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
            A group only gives access: someone in two groups gets the higher level. A setting just for a person decides
            for them where it applies; adding them asks first.
          </p>
        </div>
      ) : tab === "access" ? (
        <GroupAccessTab orgId={orgId} group={group} includesMe={includesMe} teamAccess={teamAccess} onGrantsChanged={onGrantsChanged} onItemWritten={onItemWritten} nameOf={nameOf} imageOf={imageOf} />
      ) : tab === "skills" ? (
        <GroupSkillsTab orgId={orgId} group={group} includesMe={includesMe} onChanged={onChanged} />
      ) : (
        <GroupActivityTab orgId={orgId} group={group} vaultName={vaultName} />
      )}

      {heldAdd && (
        <HeldBackDialog
          groupName={group.name}
          held={heldAdd.held}
          nameOf={nameOf}
          imageOf={imageOf}
          placeOf={placeOf}
          action={heldAdd.userIds.length === 1 ? "Add 1 person" : `Add ${heldAdd.userIds.length} people`}
          onCancel={() => setHeldAdd(null)}
          onApply={async (chosen) => {
            try { await commitAdd(heldAdd.userIds, chosen); } catch (e) { toast(e instanceof Error ? e.message : String(e), "error"); }
          }}
        />
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

function GroupAccessTab({ orgId, group, includesMe, teamAccess, onGrantsChanged, onItemWritten, nameOf, imageOf, setup = false }: {
  /** Inside the New access group dialog: the wizard says what the board means. */
  setup?: boolean;
  nameOf: (userId: string) => string;
  imageOf?: (userId: string) => string | null;
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
      {!setup && <p className="field-hint group-access-note">
        What {group.name} can open for its members. Where someone has a setting just for them, that decides; a change here asks first. No access here means only that the group gives nothing there; people keep what they get from elsewhere.
      </p>}
      <MemberAccessBoard
        orgId={orgId}
        vaultId={vaultId}
        member={label}
        isSelf={false}
        canSetAccess
        everyoneMode={teamAccess && teamAccess.posture !== "none" ? teamAccess.mode : null}
        personVaultMode={vaultGrant ? (vaultGrant.permission === "edit" ? "open" : "readonly") : null}
        // Each move: the debounced padlock refresh, plus the group's grants
        // (the board's whole-vault confirm and the list summary read them). No roster reload.
        onItemWritten={() => { onItemWritten(); void onGrantsChanged(); }}
        onChanged={async () => { onItemWritten(); await onGrantsChanged(); }}
        group={{ id: group.id, name: group.name, grants: group.grants ?? [], includesMe }}
        nameOf={nameOf}
        imageOf={imageOf}
        hideIntro={setup}
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
        A group only adds: members get the highest level their groups give. Someone set to No access for a
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
