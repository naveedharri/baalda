import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import type { BulkAccessResource, MemberActivityEvent, MemberOverview, TeamAccess, TeamAccessMode } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { buildOrgRowsByPath, effectiveTeamMode } from "../lib/accessMode";
import { createAccessSummaryBatcher } from "../lib/accessSummaryBatch";
import { accessResourceType, ancestorPaths, entriesFromServer, rowsFromEntries, type AccessRow } from "../lib/accessTree";
import { resourceIdsByPath } from "../lib/locks";
import { needsAccessConfirm, levelClass, LEVEL_TO_MODE, reduceAccessCopy, tickGrantMode, type ReduceScope, dateWithAgo, GRANT_LABEL, PERSON_LEVEL_LABEL, ROLE_LABEL, splitNotePath } from "../lib/membersAccess";
import { syncManager } from "../lib/sync/docSession";
import { activitySummary, buildTimeline, commonFolder, runNames, type TimelineEntry } from "../lib/memberActivity";
import { relativeTime } from "../lib/health/format";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import { MemberAccessBoard } from "./MemberAccessBoard";
import { useAccessMap, type AccessMap } from "./useAccessMap";
import { ACCESS_MAP_REREAD_MAX } from "../lib/accessBoardLoad";
import { ConfirmDialog } from "./ConfirmDialog";
import { iconForPath } from "./FileTree";
import { MenuSelect } from "./MenuSelect";
import { RoleSelect } from "./RoleSelect";
import { ActivitySkeleton, RowLevelSkeleton, TreeSkeleton } from "./MemberProfileSkeletons";
import { markSelfAccessChange } from "../lib/sync/selfAccessChanges";


/** One batcher for every row of the profile's tree: a render's reads go out as
 * one request, and rows that unmount before the flush are never sent. */
const summaries = createAccessSummaryBatcher({
  many: (orgId, groups, userIds) => authManager.api.resolveAccessSummaries(orgId, groups, userIds),
  one: async (orgId, resources, userIds) => (await authManager.api.resolveAccessSummary(orgId, resources, userIds)).mode,
});

/**
 * One person, as a page inside Vault Settings (it replaces the Members and
 * access table in the content area; the settings sidebar stays). Personal info
 * (name, email, role, joined, last active, status, remove), Access (their
 * vault-wide level plus a per-folder tree) and Activity (what they joined,
 * created, edited and were given, newest first). Every change in the Access
 * tab is applied immediately through the bulk route scoped to this one user.
 */
export type ProfileTab = "info" | "access" | "activity";

/** How the Access tab lays out one person's access; remembered per device. */
export type AccessView = "list" | "board";
export const ACCESS_VIEW_KEY = "context.memberAccess.view";

function readAccessView(): AccessView {
  try {
    return localStorage.getItem(ACCESS_VIEW_KEY) === "list" ? "list" : "board";
  } catch {
    return "board";
  }
}

function writeAccessView(view: AccessView) {
  try { localStorage.setItem(ACCESS_VIEW_KEY, view); } catch { /* storage unavailable */ }
}

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
}: {
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
  const tabs: readonly ProfileTab[] = [
    "info",
    ...(showAccessTab ? (["access"] as const) : []),
    ...(showActivityTab ? (["activity"] as const) : []),
  ];
  const level = member.access?.level ?? null;
  const vaultFrom = level === null ? null : level === "custom" ? "custom" : LEVEL_TO_MODE[level];
  const [accessView, setAccessView] = useState<AccessView>(readAccessView);
  const chooseView = (view: AccessView) => { setAccessView(view); writeAccessView(view); };
  // Bumped after a vault-wide write from the header, so the board re-reads.
  const [boardEpoch, setBoardEpoch] = useState(0);
  const viewToggle = <AccessViewToggle value={accessView} onChange={chooseView} />;

  return (
      <section className="member-profile" aria-label={name}>
        <button type="button" className="link-btn member-profile-back" onClick={onClose}>
          ← Members and access
        </button>
        <header className="member-profile-head">
          <Avatar label={name} image={member.image} userId={member.userId} />
          <span className="member-profile-names">
            <span className="member-profile-name">{name}</span>
            {member.email && <span className="muted">{member.email}</span>}
          </span>
        </header>
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
              <dt>Joined</dt>
              <dd>{joinedLabel(member)}</dd>
              <dt>Last active</dt>
              <dd>{present ? "Now" : dateWithAgo(member.lastActiveAt, Date.now()) || "—"}</dd>
              <dt>Status</dt>
              <dd>{present ? "Online" : "Away"}</dd>
            </dl>
            {canAct && (
              <div className="member-profile-remove">
                <button className="link-btn danger" onClick={onRemove}>Remove from {vaultName}</button>
              </div>
            )}
          </>
        ) : tab === "access" ? (
          <PersonAccess
            orgId={orgId}
            member={member}
            teamAccess={teamAccess}
            onChanged={onChanged}
            onItemWritten={onItemWritten}
            viewToggle={viewToggle}
            view={accessView}
            onVaultWide={() => setBoardEpoch((n) => n + 1)}
            board={(accessMap) => (
              <MemberAccessBoard
                accessMap={accessMap}
                key={boardEpoch}
                orgId={orgId}
                vaultId={syncManager.registry.vaultId!}
                member={member}
                isSelf={isSelf}
                canSetAccess={canSetAccess}
                everyoneMode={teamAccess && teamAccess.posture !== "none" ? teamAccess.mode : null}
                personVaultMode={vaultFrom}
                onItemWritten={onItemWritten}
                onChanged={onChanged}
                hideSetEverything
              />
            )}
          />
        ) : (
          <PersonActivity orgId={orgId} member={member} vaultName={vaultName} isSelf={isSelf} onOpenNote={onOpenNote} />
        )}
      </section>
  );
}

const TAB_LABEL: Record<ProfileTab, string> = { info: "Personal info", access: "Access", activity: "Activity" };

/** List (checkbox tree) or Board (three columns): two 28px icon buttons. */
function AccessViewToggle({ value, onChange }: { value: AccessView; onChange: (view: AccessView) => void }) {
  const option = (view: AccessView, label: string, glyph: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === view}
      aria-label={label}
      title={label}
      className={`member-access-view-btn${value === view ? " is-active" : ""}`}
      onClick={() => { if (value !== view) onChange(view); }}
    >
      {glyph}
    </button>
  );
  return (
    <div className="member-access-view" role="radiogroup" aria-label="Access view">
      {option("list", "List view", svg(<><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>))}
      {option("board", "Board view", svg(<><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="4" height="13" rx="1" /></>))}
    </div>
  );
}

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
  const [state, setState] = useState<ActivityState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    authManager.api.getMemberActivity(orgId, member.userId, ACTIVITY_LIMIT)
      .then((events) => { if (live) setState({ status: "ready", events }); })
      .catch((e) => {
        if (!live) return;
        setState(e instanceof ApiError && e.status === 403 ? { status: "forbidden" } : { status: "error" });
      });
    // A person change (or unmount) drops whatever the old request returns.
    return () => { live = false; };
  }, [orgId, member.userId]);

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
      : <>{lead(voice, "created")} <strong>{count}</strong> — {runNames(run.events)}</>;
  }
  return <>{lead(voice, "edited")} <strong>{count}</strong> — {runNames(run.events)}</>;
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

type RowMode = TeamAccessMode | "mixed";

/** A row with no summary this long after queueing stops spinning. */
export const SUMMARY_TIMEOUT_MS = 5000;

const resourceOf = (row: { kind: AccessRow["kind"]; id: string }): BulkAccessResource => ({
  resourceType: row.kind === "folder" ? "folder" : accessResourceType(row.kind),
  resourceId: row.id,
});

function PersonAccess({ orgId, member, teamAccess, onChanged, onItemWritten, viewToggle, view = "list", board, onVaultWide }: {
  orgId: string;
  member: MemberOverview;
  teamAccess: TeamAccess | null;
  onChanged: () => Promise<void>;
  onItemWritten: () => void;
  /** The List/Board switch, placed at the end of the "Across the vault" row. */
  viewToggle?: React.ReactNode;
  /** Board view keeps this header row and shows `board` in place of the tree. */
  view?: AccessView;
  board?: React.ReactNode | ((map: AccessMap) => React.ReactNode);
  /** A vault-wide write from the header landed. */
  onVaultWide?: () => void;
}) {
  const isSelf = useStore((s) => s.session?.user.id) === member.userId;
  const locks = useStore((s) => s.locks);
  const denies = useStore((s) => s.denies);
  const tree = useStore((s) => s.tree);
  // ONE load shared by List and Board: on a server with `access-board` it
  // carries every row's mode too, so neither view reads summaries on open.
  const map = useAccessMap(syncManager.registry.vaultId, member.userId);
  const serverTree = map.tree;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Every row's mode lives here, keyed by row key, so a write can update the
  // affected rows in place instead of re-reading the whole tree (which made
  // every row flash a spinner after each tick).
  const [modes, setModes] = useState<ReadonlyMap<string, RowMode>>(() => new Map());
  const inflight = useRef(new Set<string>());
  // Rows still unanswered this long after their read was queued show "—"
  // ("Couldn't load") instead of spinning forever.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const live = useRef(true);
  // Set true on EVERY mount: StrictMode runs mount → cleanup → mount, and a
  // ref only cleared in the cleanup stayed false for good — every read was then
  // queued as cancelled and every row spun forever.
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; button: string; outcome: string; danger: boolean; apply: () => Promise<void> } | null>(null);

  useEffect(() => { if (map.error) setError(map.error); }, [map.error]);
  // Seed during render so the first frame with a tree has its modes.
  const [seededSeq, setSeededSeq] = useState(0);
  if (map.seq !== seededSeq) {
    setSeededSeq(map.seq);
    if (map.modes) {
      setModes(new Map(map.modes));
      setFailed(new Set());
    }
  }

  const entries = useMemo(() => (serverTree ? entriesFromServer(serverTree) : []), [serverTree]);
  const rows = useMemo(() => rowsFromEntries(entries, expanded), [entries, expanded]);
  const orgRowsByPath = useMemo(
    () => buildOrgRowsByPath(entries, resourceIdsByPath(tree), teamAccess?.overrides ?? null, locks, denies),
    [entries, tree, teamAccess, locks, denies],
  );
  /** Read summaries for these rows; existing values stay on screen meanwhile. */
  const readModes = (targets: ReadonlyArray<{ key: string; kind: AccessRow["kind"]; id: string }>) => {
    for (const row of targets) {
      if (inflight.current.has(row.key)) continue;
      inflight.current.add(row.key);
      const markFailed = () => {
        if (!live.current) return;
        setFailed((prev) => (prev.has(row.key) ? prev : new Set(prev).add(row.key)));
      };
      const timer = window.setTimeout(markFailed, SUMMARY_TIMEOUT_MS);
      summaries
        .read(orgId, resourceOf(row), [member.userId], () => !live.current)
        .then((m) => {
          if (!live.current) return;
          setModes((prev) => new Map(prev).set(row.key, m));
          setFailed((prev) => {
            if (!prev.has(row.key)) return prev;
            const next = new Set(prev);
            next.delete(row.key);
            return next;
          });
        })
        .catch(markFailed)
        .finally(() => {
          window.clearTimeout(timer);
          inflight.current.delete(row.key);
        });
    }
  };

  // Visible rows with no answer yet (first paint, a folder just expanded).
  // The board reads its own summaries, so the tree's wait for the list view.
  useEffect(() => {
    if (view !== "list") return;
    readModes(rows.filter((row) => !modes.has(row.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, view]);

  const overrideIds = useMemo(() => new Set((teamAccess?.overrides ?? []).map((o) => o.resourceId)), [teamAccess]);

  const apply = async (resource: BulkAccessResource, mode: TeamAccessMode, what: string, path: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isSelf) markSelfAccessChange([resource.resourceId]);
      await authManager.api.setBulkAccess(orgId, {
        resources: [resource],
        audience: { type: "users", userIds: [member.userId] },
        mode,
      });
      if (!live.current) return;
      // Optimistic: the written item and everything under it now read `mode`
      // (the whole tree for a vault-wide write). Then re-ask the server for
      // just that subtree plus its ancestors, whose roll-up may have changed.
      const affected = entries.filter((e) => path === null || e.path === path || e.path.startsWith(`${path}/`));
      const keys = new Set(affected.map((e) => accessRowKey(e)));
      setModes((prev) => {
        // Vault-wide: every answer is stale. Visible rows get the optimistic
        // value and a re-read below; collapsed ones re-read when expanded.
        const next = path === null ? new Map<string, RowMode>() : new Map(prev);
        const visible = new Set(rows.map((r) => r.key));
        for (const key of keys) if (path !== null || visible.has(key)) next.set(key, mode);
        return next;
      });
      const ancestors = path === null ? new Set<string>() : new Set(ancestorPaths(path));
      const reread = rows.filter((row) => keys.has(row.key) || ancestors.has(row.path));
      // A vault-wide or large write reloads the whole map once (when the
      // server has it); a small one re-reads the affected rows.
      if (map.complete && (path === null || keys.size + ancestors.size > ACCESS_MAP_REREAD_MAX)) await map.reload();
      // In board view the tree is hidden: forget its answers so the list
      // re-reads everything when it is shown again.
      else if (view === "list") readModes(reread);
      else setModes(new Map());
      if (path === null) {
        await onChanged();
        onVaultWide?.();
      } else onItemWritten();
      toast(`${what}: ${mode === "open" ? "Can edit" : mode === "readonly" ? "Can view" : "No access"}`);
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const guarded = (from: TeamAccessMode | "custom" | null, to: TeamAccessMode, run: () => Promise<void>, scope: ReduceScope) => {
    if (to === "open" || !needsAccessConfirm(from, to)) return void run();
    setConfirm({ ...reduceAccessCopy(scope, to), danger: to === "private", apply: run });
  };

  const level = member.access?.level ?? null;
  const vaultFrom = level === null ? null : level === "custom" ? "custom" : LEVEL_TO_MODE[level];
  // A never-shared vault (posture none) grants Everyone nothing to inherit.
  const tickMode = tickGrantMode(vaultFrom, teamAccess && teamAccess.posture !== "none" ? teamAccess.mode : null);

  return (
    <div className="member-profile-access">
      {error && <div className="auth-error">{error}</div>}
      <div className="members-access-row">
        <span className="members-access-row-copy">
          <span className="members-access-row-title">Across the vault</span>
          <span className="muted">{isSelf ? "Your" : "Their"} setting wins over the default setting</span>
        </span>
        <MenuSelect<TeamAccessMode | "custom">
          value={vaultFrom ?? "custom"}
          options={[
            { value: "open", label: PERSON_LEVEL_LABEL.edit },
            { value: "readonly", label: PERSON_LEVEL_LABEL.view },
            { value: "private", label: PERSON_LEVEL_LABEL.none },
          ]}
          triggerContent={level ? PERSON_LEVEL_LABEL[level] : "—"}
          disabled={busy}
          ariaLabel="Access across the vault"
          triggerClassName={`member-access-pill is-lg ${levelClass(level)}`}
                menuClassName="access-menu"
          onSelect={(mode) => {
            if (mode === "custom") return;
            guarded(vaultFrom, mode, () => apply({ resourceType: "vault", resourceId: orgId }, mode, "Whole vault", null), { kind: "person", name: member.name || member.email || member.userId, self: isSelf });
          }}
        />
        {viewToggle}
      </div>
      {view === "board" ? (
        <div className="member-access-board-pane">{typeof board === "function" ? board(map) : board}</div>
      ) : !serverTree ? (
        error ? null : <TreeSkeleton />
      ) : (
        <ul className="member-access-tree" role="tree">
          {rows.map((row) => {
            const team = teamAccess
              ? effectiveTeamMode({ vaultMode: teamAccess.mode, path: row.path, ancestors: ancestorPaths(row.path), orgRowsByPath }).mode
              : null;
            const locked = [...ancestorPaths(row.path), row.path].some((p) => orgRowsByPath.get(p)?.has("locked"));
            return (
              <PersonAccessRow
                key={row.key}
                row={row}
                mode={modes.get(row.key) ?? null}
                failed={failed.has(row.key)}
                teamMode={team}
                tickMode={tickMode}
                locked={locked}
                setForEveryone={overrideIds.has(row.id)}
                expanded={expanded.has(row.path)}
                disabled={busy}
                onToggleExpand={() => setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.path)) next.delete(row.path); else next.add(row.path);
                  return next;
                })}
                onChoose={(from, mode) => guarded(
                  from,
                  mode,
                  () => apply(resourceOf(row), mode, row.name, row.path),
                  { kind: "item", name: row.name },
                )}
              />
            );
          })}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.button}
          tone={confirm.danger ? "danger" : "accent"}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { await confirm.apply(); setConfirm(null); }}
        >
          <p>{confirm.outcome}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function PersonAccessRow({ row, mode, failed, teamMode, tickMode, locked, setForEveryone, expanded, disabled, onToggleExpand, onChoose }: {
  row: AccessRow;
  /** null until the server has answered for this row. */
  mode: RowMode | null;
  /** Unanswered past SUMMARY_TIMEOUT_MS, or the read failed. */
  failed: boolean;
  teamMode: TeamAccessMode | null;
  /** What a tick grants — see `tickGrantMode`. */
  tickMode: TeamAccessMode;
  locked: boolean;
  setForEveryone: boolean;
  expanded: boolean;
  disabled: boolean;
  onToggleExpand: () => void;
  onChoose: (from: TeamAccessMode | "custom" | null, mode: TeamAccessMode) => void;
}) {
  const checked = mode !== null && mode !== "private";
  const from = mode === "mixed" ? "custom" : mode;
  const inherited = mode !== null && mode !== "mixed" && teamMode === mode;
  return (
    <li
      className={`member-access-row${inherited ? " is-inherited" : ""}`}
      role="treeitem"
      aria-expanded={row.kind === "folder" ? expanded : undefined}
      style={{ paddingLeft: `${8 + row.depth * 16}px` }}
    >
      <span className="member-access-main">
        {row.expandable ? (
          <button
            type="button"
            className={`member-access-twisty${expanded ? " is-open" : ""}`}
            aria-label={expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
            onClick={onToggleExpand}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        ) : (
          <span className="member-access-twisty" aria-hidden="true" />
        )}
        <label className="member-access-check">
          <input
            type="checkbox"
            aria-label={`${row.name}: can open`}
            checked={checked}
            disabled={disabled || mode === null}
            onChange={(e) => onChoose(from, e.target.checked ? tickMode : "private")}
          />
        </label>
        <span className="member-access-icon" aria-hidden="true">{rowGlyph(row)}</span>
        <span className="member-access-name">{row.name}</span>
      </span>
      <span className="member-access-notes">
        {setForEveryone && <span className="member-access-tag">Set for everyone</span>}
        {mode === null ? (
          failed ? <span className="member-access-note" title="Couldn't load">—</span> : <RowLevelSkeleton />
        ) : inherited ? (
          <span className="member-access-note">Same as everyone</span>
        ) : null}
        {checked && locked && mode === "readonly" && <span className="member-access-note">View (locked)</span>}
      </span>
      <span className="member-access-level">
        {checked && !(locked && mode === "readonly") && (
          <MenuSelect<TeamAccessMode | "mixed">
            value={mode ?? "readonly"}
            options={[{ value: "open", label: "Can edit" }, { value: "readonly", label: "Can view" }]}
            triggerContent={mode === "mixed" ? "Mixed" : mode === "open" ? "Can edit" : "Can view"}
            disabled={disabled}
            ariaLabel={`${row.name}: level`}
            triggerClassName={`member-access-pill ${levelClass(mode)}`}
            menuClassName="access-menu"
            onSelect={(m) => { if (m !== "mixed" && m !== mode) onChoose(from, m); }}
          />
        )}
      </span>
    </li>
  );
}

/** The same key `rowsFromEntries` gives a row. */
const accessRowKey = (e: { kind: AccessRow["kind"]; id: string }) => `${e.kind}:${e.id}`;

const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

function rowGlyph(row: AccessRow): React.ReactNode {
  if (row.kind === "folder") return svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />);
  if (row.kind === "file") return iconForPath(row.path);
  return svg(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></>);
}
