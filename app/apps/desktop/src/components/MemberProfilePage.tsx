import { Fragment, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import type { AccessGroup, MemberActivityEvent, MemberOverview, TeamAccess } from "../lib/api";
import { GroupChip } from "./GroupsPanel";
import { authManager } from "../lib/auth/authManager";
import { activityCache } from "../lib/membersAccessCaches";
import { LEVEL_TO_MODE, dateWithAgo, GRANT_LABEL, ROLE_LABEL, splitNotePath,
  accessSources, everyoneLabel } from "../lib/membersAccess";
import { groupAccessSummary } from "../lib/groups";
import { syncManager } from "../lib/sync/docSession";
import { activitySummary, buildTimeline, commonFolder, runNames, type TimelineEntry } from "../lib/memberActivity";
import { relativeTime } from "../lib/health/format";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import { MemberSkillsTab } from "./skills/MemberSkillsTab";
import { serverFeatures } from "../lib/serverFeatures";
import { SKILL_ACCESS_FEATURE } from "../lib/skills/access";
import { MemberAccessBoard } from "./MemberAccessBoard";
import { useAccessMap, type AccessMap } from "./useAccessMap";
import { MenuSelect } from "./MenuSelect";
import { RoleSelect } from "./RoleSelect";
import { ActivitySkeleton } from "./MemberProfileSkeletons";


/**
 * One person, as a page inside Vault Settings (it replaces the Members and
 * access table in the content area; the settings sidebar stays). Personal info
 * (name, email, role, joined, last active, status, remove), Access (their
 * vault-wide level plus a per-folder tree) and Activity (what they joined,
 * created, edited and were given, newest first). Every change in the Access
 * tab is applied immediately through the bulk route scoped to this one user.
 */
export type ProfileTab = "info" | "access" | "skills" | "activity";

export function MemberProfilePage({
  orgId,
  vaultName,
  member,
  initialTab,
  canAct,
  canSetAccess,
  showAccessTab = true,
  present,
  teamAccess,
  onClose,
  onChanged,
  onItemWritten,
  onRoleChange,
  onRemove,
  onOpenNote,
  groups = null,
  onJoinGroup,
  onLeaveGroup,
  onOpenGroup,
}: {
  /** Every access group of the vault; null when the server has none (feature off). */
  groups?: readonly AccessGroup[] | null;
  /** Add/remove this person (owners/admins who may manage them). */
  onJoinGroup?: (groupId: string) => Promise<void>;
  onLeaveGroup?: (groupId: string) => Promise<void>;
  onOpenGroup?: (groupId: string) => void;
  orgId: string;
  vaultName: string;
  member: MemberOverview;
  initialTab: ProfileTab;
  canAct: boolean;
  /** May the caller change this person's access? Wider than `canAct`: an
   * owner may set their own (see `canSetMemberAccess`). */
  canSetAccess: boolean;
  /** False for plain members: their profile is Personal info and Activity. */
  showAccessTab?: boolean;
  present: boolean;
  teamAccess: TeamAccess | null;
  onClose: () => void;
  /** A vault-wide write: reload the overview so "Across the vault" updates. */
  onChanged: () => Promise<void>;
  /** A per-item write: cheap, debounced side effects only — no reloads. */
  onItemWritten: () => void;
  onRoleChange: (role: "member" | "admin") => Promise<void>;
  onRemove: () => void;
  /** Open a note named by an Activity row; rows are plain text without it. */
  onOpenNote?: (path: string) => void;
}) {
  const isSelf = useStore((s) => s.session?.user.id) === member.userId;
  // Another member's activity is owner/admin-only on the server (403 otherwise),
  // so a plain member gets the tab on their own profile only (#301).
  const showActivityTab = showAccessTab || isSelf;
  const [tab, setTab] = useState<ProfileTab>(
    (initialTab === "access" && !(canSetAccess && showAccessTab)) ||
      (initialTab === "activity" && !showActivityTab)
      ? "info"
      : initialTab,
  );
  const name = member.name || member.email || member.userId;
  const serverUrl = useStore((s) => s.serverUrl);
  const [skillAccess, setSkillAccess] = useState(false);
  useEffect(() => {
    let live = true;
    void serverFeatures(serverUrl, () => authManager.api.getHealth(serverUrl)).then((f) => {
      if (live) setSkillAccess(f.has(SKILL_ACCESS_FEATURE));
    });
    return () => {
      live = false;
    };
  }, [serverUrl]);
  const tabs: readonly ProfileTab[] = [
    "info",
    ...(showAccessTab ? (["access"] as const) : []),
    // Which team skills reach them (owners/admins, like Access; needs migration 062).
    ...(showAccessTab && skillAccess ? (["skills"] as const) : []),
    ...(showActivityTab ? (["activity"] as const) : []),
  ];
  const level = member.access?.level ?? null;
  const vaultFrom = level === null ? null : level === "custom" ? "custom" : LEVEL_TO_MODE[level];

  return (
      <section className="member-profile" aria-label={name}>
        <button type="button" className="link-btn member-profile-back" onClick={onClose}>
          ← People and access
        </button>
        <header className="member-profile-head">
          <Avatar label={name} image={member.image} userId={member.userId} />
          <span className="member-profile-names">
            <span className="member-profile-name">{name}</span>
            {member.email && <span className="muted">{member.email}</span>}
          </span>
        </header>
        {/* One tab is no choice: a plain member on someone else's profile sees
            Personal info alone, so it renders without a tab strip above it. */}
        {tabs.length > 1 && (
        <div className="member-profile-tabs" role="tablist" aria-label="Profile">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              className={`member-profile-tab${t === tab ? " active" : ""}`}
              disabled={t === "access" && !canSetAccess}
              title={t === "access" && !canSetAccess ? "You can't change this person's access" : undefined}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        )}
        {tab === "info" ? (
          <>
            <dl className="member-profile-about">
              <dt>Name</dt>
              <dd>{member.name || "—"}</dd>
              <dt>Email</dt>
              <dd>{member.email || "—"}</dd>
              <dt>Role</dt>
              <dd>
                {canAct && (member.role === "member" || member.role === "admin") ? (
                  <RoleSelect variant="field" value={member.role} ariaLabel={`Role of ${name}`} onSelect={onRoleChange} />
                ) : (
                  ROLE_LABEL[member.role] ?? member.role
                )}
              </dd>
              {groups && (
                <>
                  <dt>Access groups</dt>
                  <dd>
                    <ProfileGroups
                      member={member}
                      groups={groups}
                      onJoin={canSetAccess ? onJoinGroup : undefined}
                      onLeave={canSetAccess ? onLeaveGroup : undefined}
                      onOpen={onOpenGroup}
                    />
                  </dd>
                </>
              )}
              <dt>Joined</dt>
              <dd>{joinedLabel(member)}</dd>
              <dt>Last active</dt>
              <dd>{present ? "Now" : dateWithAgo(member.lastActiveAt, Date.now()) || "—"}</dd>
              <dt>Status</dt>
              <dd>{present ? "Online" : "Away"}</dd>
            </dl>
            {canAct && (
              <div className="vault-local-only-card member-profile-remove">
                <span className="vault-local-only-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="9" cy="8" r="4" />
                    <path d="M2 21a7 7 0 0 1 14 0" />
                    <path d="M17 11h5" />
                  </svg>
                </span>
                <div className="vault-local-only-copy">
                  <strong>Remove from {vaultName}</strong>
                  <span className="field-hint">
                    {name} loses access to {vaultName}, and its folder is removed from their computer. What they
                    wrote stays with the team.
                  </span>
                </div>
                <button className="vault-local-only-action" onClick={onRemove}>
                  Remove
                </button>
              </div>
            )}
          </>
        ) : tab === "access" ? (
          <PersonAccess
            member={member}
            teamAccess={teamAccess}
            groups={groups}
            board={(accessMap) => (
              <MemberAccessBoard
                accessMap={accessMap}
                orgId={orgId}
                vaultId={syncManager.registry.vaultId!}
                member={member}
                isSelf={isSelf}
                canSetAccess={canSetAccess}
                everyoneMode={teamAccess && teamAccess.posture !== "none" ? teamAccess.mode : null}
                personVaultMode={vaultFrom}
                onItemWritten={onItemWritten}
                onChanged={onChanged}
                accessSource={member.access?.ownLevel === undefined ? null : member.access.ownLevel !== null ? "personal" : "group"}
          hasPersonal={!!member.access?.personal || (member.access?.ownLevel ?? null) !== null}
              />
            )}
          />
        ) : tab === "skills" ? (
          <MemberSkillsTab orgId={orgId} userId={member.userId} name={member.name || member.email || "This person"} />
        ) : (
          <PersonActivity orgId={orgId} member={member} vaultName={vaultName} isSelf={isSelf} onOpenNote={onOpenNote} />
        )}
      </section>
  );
}

/** The Groups row: removable chips and "+ Add to group". */
function ProfileGroups({ member, groups, onJoin, onLeave, onOpen }: {
  member: MemberOverview;
  groups: readonly AccessGroup[];
  onJoin?: (groupId: string) => Promise<void>;
  onLeave?: (groupId: string) => Promise<void>;
  onOpen?: (groupId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const mine = groups.filter((g) => g.memberIds.includes(member.userId));
  const others = groups.filter((g) => !g.memberIds.includes(member.userId));
  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await work(); } catch (e) { toast(e instanceof Error ? e.message : String(e), "error"); } finally { setBusy(false); }
  };
  return (
    <span className="profile-groups">
      {mine.length === 0 && !onJoin && <span className="muted">None</span>}
      {mine.map((g) => (
        <GroupChip
          key={g.id}
          group={g}
          onOpen={onOpen ? () => onOpen(g.id) : undefined}
          onRemove={onLeave && !busy ? () => void act(() => onLeave(g.id)) : undefined}
        />
      ))}
      {onJoin && others.length > 0 && (
        <MenuSelect<string>
          value=""
          options={others.map((g) => ({ value: g.id, label: g.name }))}
          onSelect={(id) => void act(() => onJoin(id))}
          disabled={busy}
          caret={false}
          ariaLabel="Add to access group"
          triggerClassName="link-btn profile-groups-add"
          menuClassName="access-menu"
          triggerContent="+ Add to access group"
        />
      )}
    </span>
  );
}

const TAB_LABEL: Record<ProfileTab, string> = { info: "Personal info", access: "Access", skills: "Skills", activity: "Activity" };

const personName = (p: { name: string | null; email: string | null; userId: string }) => p.name || p.email || p.userId;

/** "Sep 12, 2026 (3 weeks ago), invited by Kamil Ali" — the inviter only when the server knows them. */
function joinedLabel(member: MemberOverview): string {
  const date = dateWithAgo(member.joinedAt, Date.now());
  if (!date) return "—";
  return member.invitedBy ? `${date}, invited by ${personName(member.invitedBy)}` : date;
}

type ActivityState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "forbidden" }
  | { status: "ready"; events: MemberActivityEvent[] };

const ACTIVITY_LIMIT = 50;

/** Mounted only while the Activity tab is shown, so it loads on first view. */
function PersonActivity({ orgId, member, vaultName, isSelf, onOpenNote }: {
  orgId: string;
  member: MemberOverview;
  vaultName: string;
  isSelf: boolean;
  onOpenNote?: (path: string) => void;
}) {
  const cacheKey = `${authManager.getServerUrl()}|${orgId}|${member.userId}`;
  const [state, setState] = useState<ActivityState>(() => {
    const seen = activityCache.get(cacheKey);
    return seen ? { status: "ready", events: seen } : { status: "loading" };
  });
  useEffect(() => {
    let live = true;
    const seen = activityCache.get(cacheKey);
    setState(seen ? { status: "ready", events: seen } : { status: "loading" });
    authManager.api.getMemberActivity(orgId, member.userId, ACTIVITY_LIMIT)
      .then((events) => {
        activityCache.set(cacheKey, events);
        if (live) setState({ status: "ready", events });
      })
      .catch((e) => {
        // A failed refresh keeps a previously loaded timeline on screen.
        if (!live || activityCache.has(cacheKey)) return;
        setState(e instanceof ApiError && e.status === 403 ? { status: "forbidden" } : { status: "error" });
      });
    // A person change (or unmount) drops whatever the old request returns.
    return () => { live = false; };
  }, [orgId, member.userId, cacheKey]);

  if (state.status === "loading") return <ActivitySkeleton />;
  if (state.status === "forbidden") {
    return (
      <p className="member-activity-empty">
        Only the vault owner or an admin can see another member's activity.
      </p>
    );
  }
  if (state.status === "error") return <p className="member-activity-empty">Couldn't load activity.</p>;
  const now = Date.now();
  const days = buildTimeline(state.events, now, { at: member.joinedAt, invitedBy: member.invitedBy ?? null });
  if (days.length === 0) return <p className="member-activity-empty">No activity yet.</p>;
  const voice: Voice = { isSelf, vaultName, onOpenNote };
  const summary = activitySummary(state.events, member.joinedAt, now, ACTIVITY_LIMIT);
  return (
    <div className="member-activity">
      {summary && <p className="member-activity-summary">{summary}</p>}
      <ol className="member-activity-trail">
        <li className="member-activity-now"><span className="member-activity-now-dot" aria-hidden="true" />Now</li>
        {days.map((day) => (
          <Fragment key={day.key}>
            <li className="member-activity-day"><span className="member-activity-day-pill">{day.label}</span></li>
            {day.entries.map((entry, i) => (
              <TimelineItem key={`${day.key}:${i}`} entry={entry} voice={voice} now={now} />
            ))}
          </Fragment>
        ))}
      </ol>
    </div>
  );
}

interface Voice {
  isSelf: boolean;
  vaultName: string;
  onOpenNote?: (path: string) => void;
}

function TimelineItem({ entry, voice, now }: { entry: TimelineEntry; voice: Voice; now: number }) {
  const [open, setOpen] = useState(false);
  const kind = entry.type === "run" ? entry.kind : entry.event.kind;
  const at = entry.type === "run" ? entry.events[0].at : entry.event.at;
  const origin = entry.type === "event" && entry.origin;
  return (
    <li className={`member-activity-entry${origin ? " is-origin" : ""}`}>
      <span className="member-activity-node" aria-hidden="true">{ACTIVITY_GLYPH[kind]}</span>
      <div className="member-activity-body">
        <p className="member-activity-text">
          {entry.type === "run" ? runSentence(entry, voice) : activitySentence(entry.event, voice)}
          <span className="member-activity-time"> · {relativeTime(Date.parse(at), now)}</span>
        </p>
        {entry.type === "run" && (
          <>
            <button type="button" className="link-btn member-activity-disclose" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? "Show less" : "Show all"}
            </button>
            {open && (
              <ul className="member-activity-run">
                {entry.events.map((e, i) => (
                  <li key={`${e.docId}:${i}`}>
                    <NoteName path={e.path} voice={voice} />
                    <span className="member-activity-time"> · {relativeTime(Date.parse(e.at), now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** A note's name in bold; a link that opens it when the host allows. */
function NoteName({ path, voice }: { path: string; voice: Voice }) {
  const name = splitNotePath(path).name;
  return voice.onOpenNote ? (
    <button type="button" className="member-activity-note" onClick={() => voice.onOpenNote?.(path)}><strong>{name}</strong></button>
  ) : (
    <strong>{name}</strong>
  );
}

/** "You edited" for the viewer, "Edited" for anyone else. */
const lead = (voice: Voice, verb: string) => (voice.isSelf ? `You ${verb}` : verb.charAt(0).toUpperCase() + verb.slice(1));

function runSentence(run: Extract<TimelineEntry, { type: "run" }>, voice: Voice): React.ReactNode {
  const count = `${run.events.length} notes`;
  if (run.kind === "created") {
    const folder = commonFolder(run.events);
    return folder
      ? <>{lead(voice, "created")} <strong>{count}</strong> in {folder}</>
      : <>{lead(voice, "created")} <strong>{count}</strong>: {runNames(run.events)}</>;
  }
  return <>{lead(voice, "edited")} <strong>{count}</strong>: {runNames(run.events)}</>;
}

/** One activity entry's sentence, told from the member's side, the item in bold. */
export function activitySentence(event: MemberActivityEvent, voice: Voice): React.ReactNode {
  switch (event.kind) {
    case "joined":
      return <>{lead(voice, event.rejoined ? "rejoined" : "joined")} {voice.vaultName}{event.invitedBy ? `, invited by ${personName(event.invitedBy)}` : ""}</>;
    case "edited":
      return <>{lead(voice, "edited")} <NoteName path={event.path} voice={voice} /></>;
    case "created": {
      const { folders } = splitNotePath(event.path);
      return <>{lead(voice, "created")} <NoteName path={event.path} voice={voice} />{folders.length ? ` in ${folders.join(" › ")}` : ""}</>;
    }
    case "accessGranted": {
      const item = event.resourceType === "vault"
        ? null
        : event.path
          ? (event.resourceType === "folder" ? event.path.split("/").filter(Boolean).pop() ?? event.path : splitNotePath(event.path).name)
          : "an item";
      if (event.permission === "denied") {
        return <>{lead(voice, "lost")} access to {item ? <strong>{item}</strong> : "the vault"}</>;
      }
      return (
        <>
          {lead(voice, "got")} <strong>{GRANT_LABEL[event.permission]}</strong>{" "}
          {item ? <>on <strong>{item}</strong></> : "across the vault"}
          {event.by ? ` from ${personName(event.by)}` : ""}
        </>
      );
    }
  }
}

const glyph = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const ACTIVITY_GLYPH: Record<MemberActivityEvent["kind"], React.ReactNode> = {
  edited: glyph(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  created: glyph(<path d="M12 5v14M5 12h14" />),
  accessGranted: glyph(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>),
  joined: glyph(<><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0" /><path d="M19 8v6M16 11h6" /></>),
};

/** A row with no summary this long after queueing stops spinning. */
export const SUMMARY_TIMEOUT_MS = 5000;

/**
 * One person's access: where it comes from, then the board (the only view
 * since 2026-11-27; the List view and its toggle were removed).
 */
function PersonAccess({ member, teamAccess, groups = null, board }: {
  member: MemberOverview;
  teamAccess: TeamAccess | null;
  /** Every access group of the vault, for "Where this comes from"; null when groups are off. */
  groups?: readonly AccessGroup[] | null;
  board: (map: AccessMap) => React.ReactNode;
}) {
  const isSelf = useStore((s) => s.session?.user.id) === member.userId;
  // ONE load for the board: on a server with `access-board` it carries every
  // row's mode too, so the board reads no summaries on open.
  const map = useAccessMap(syncManager.registry.vaultId, member.userId);
  const sources = member.access ? accessSources({
    level: member.access.level,
    own: !!member.access.own,
    ownDecides: member.access.ownLevel !== undefined,
    isSelf,
    defaultLabel: teamAccess ? everyoneLabel(teamAccess.mode, teamAccess.posture).label : null,
    groups: (groups ?? [])
      .filter((g) => g.memberIds.includes(member.userId))
      .map((g) => ({ name: g.name, summary: groupAccessSummary(g.grants) })),
  }) : null;
  return (
    <div className="member-profile-access">
      {sources?.sentence ? <p className="member-access-sources muted">{sources.sentence}</p> : null}
      <div className="member-access-board-pane">{board(map)}</div>
    </div>
  );
}


