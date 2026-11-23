// Pure rules behind the "Members and access" page, kept out of the component
// so the wording and the narrowing rule can be pinned by tests.

import type {
  InvitationOverview,
  Member,
  InviteManyResult,
  MemberAccessLevel,
  MemberOverview,
  MembersOverview,
  TeamAccess,
  TeamAccessMode,
  TeamAccessPosture,
} from "./api";
import { relativeTime } from "./health/format";

/** The three wire modes in the page's words, for the Default access row (wire: team access). */
export const EVERYONE_OPTIONS: ReadonlyArray<{ value: TeamAccessMode; label: string; hint: string }> = [
  { value: "open", label: "Can edit", hint: "Members can open and change every note" },
  { value: "readonly", label: "Can view", hint: "Members can open every note, but not change it" },
  { value: "private", label: "Only what's shared", hint: "Everyone, owners and admins too, sees only what's shared with them or their groups" },
];

/** Default access's third level in its own words: the board and a person's
 * own level keep "No access", where it really means nothing at all. */
export const DEFAULT_PRIVATE_LABEL = "Only what's shared";

/** The Default access row (the vault's team access, the old "Everyone" row). */
export const DEFAULT_ACCESS_TITLE = "Default access";
export const DEFAULT_ACCESS_SUB = "Every member starts here. Access groups and personal settings can change it.";

/** New members: what they get of notes made before they joined. */
export const NEW_MEMBER_OPTIONS: ReadonlyArray<{ value: TeamAccessMode; label: string; hint?: string }> = [
  { value: "open", label: "Can edit" },
  { value: "readonly", label: "Can view" },
  { value: "private", label: "No access", hint: "They start with only new and shared notes" },
];

/** A person's vault-wide level, as their row's dropdown offers it. */
export const PERSON_LEVEL_LABEL: Record<MemberAccessLevel, string> = {
  edit: "Can edit everything",
  view: "Can view everything",
  none: "No access",
  custom: "Custom",
};

export const INVITE_ACCESS_LABEL: Record<TeamAccessMode, string> = {
  open: "Can edit everything",
  readonly: "Can view everything",
  private: "No access",
};

export const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export const LEVEL_TO_MODE: Record<Exclude<MemberAccessLevel, "custom">, TeamAccessMode> = {
  edit: "open",
  view: "readonly",
  none: "private",
};


/**
 * Does this change ask for confirmation first? Only taking access away
 * entirely (to No access) does — that is the one change that removes content
 * from someone's devices. Making something view-only, or widening, applies
 * straight away. Every confirm on the Members and access surfaces uses this.
 */
export function needsAccessConfirm(from: TeamAccessMode | "custom" | null, to: TeamAccessMode): boolean {
  return to === "private" && from !== "private";
}

/** The Everyone row's label. A never-shared vault reads as No access, with a
 * sub-line explaining that authors keep their own notes. */
export function everyoneLabel(mode: TeamAccessMode, posture: TeamAccessPosture): { label: string; sub: string | null } {
  if (posture === "none") return { label: DEFAULT_PRIVATE_LABEL, sub: "Members also keep notes they wrote" };
  const option = EVERYONE_OPTIONS.find((o) => o.value === mode);
  return { label: option?.label ?? DEFAULT_PRIVATE_LABEL, sub: null };
}

/** Case-insensitive name/email filter for the people table. */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}

export function filterPeople(
  query: string,
  members: readonly MemberOverview[],
  invitations: readonly InvitationOverview[],
): { members: MemberOverview[]; invitations: InvitationOverview[] } {
  return {
    members: members.filter((m) => matchesQuery(query, m.name, m.email)),
    invitations: invitations.filter((i) => matchesQuery(query, i.email)),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "4 people · 1 invite pending", or "1 person found" while searching. */
export function countLine(query: string, people: number, invites: number): string {
  if (query.trim()) return `${plural(people + invites, "person", "people")} found`;
  const base = plural(people, "person", "people");
  return invites > 0 ? `${base} · ${plural(invites, "invite", "invites")} pending` : base;
}

/**
 * Who is in the vault right now. The vault channel's presence lists OTHER
 * peers only, so the signed-in user counts as present whenever their own
 * vault channel is connected.
 */
export function presentUserIds(
  peers: ReadonlyArray<{ userId: string }>,
  selfId: string | null | undefined,
  vaultStatus: string,
): Set<string> {
  const ids = new Set(peers.map((p) => p.userId));
  if (selfId && (vaultStatus === "synced" || vaultStatus === "read-only")) ids.add(selfId);
  return ids;
}

/** The Last active column: "Now" when present on the vault channel. */
export function lastActiveLabel(present: boolean, lastActiveAt: string | null, now: number): string {
  if (present) return "Now";
  if (!lastActiveAt) return "—";
  const ms = Date.parse(lastActiveAt);
  if (!Number.isFinite(ms)) return "—";
  const rel = relativeTime(ms, now);
  return rel === "just now" ? "Now" : rel.charAt(0).toUpperCase() + rel.slice(1);
}

export function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Sep 12, 2026" — the profile's Joined and Last active rows. */
export function fullDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Sep 12, 2026 (3 days ago)" — the profile's Joined and Last active rows. */
export function dateWithAgo(iso: string | null, now: number): string {
  const date = fullDate(iso);
  if (!date) return "";
  const ms = Date.parse(iso!);
  const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = startOfDay(now);
  const ago = ms < today && ms >= startOfDay(today - 1) ? "yesterday" : relativeTime(ms, now);
  return `${date} (${ago})`;
}

/** How a grant reads in the Activity tab, in the Access tab's own words. */
export const GRANT_LABEL: Record<"edit" | "view" | "readonly" | "denied" | "locked", string> = {
  edit: "Can edit",
  view: "Can view",
  readonly: "Can view",
  denied: "No access",
  locked: "View only",
};

/** A note path's display name and its parent folders: "A/B/Note.md" → { name: "Note", folders: ["A", "B"] }. */
export function splitNotePath(path: string): { name: string; folders: string[] } {
  const parts = path.split("/").filter(Boolean);
  const file = parts.pop() ?? path;
  const dot = file.lastIndexOf(".");
  return { name: dot > 0 ? file.slice(0, dot) : file, folders: parts };
}

/** The Access column's static text for an invitation row. */
export function invitationAccessLabel(access: TeamAccessMode | null): string {
  return access ? INVITE_ACCESS_LABEL[access] : "Default";
}

/** Split typed or pasted text into addresses on commas, whitespace and semicolons. */
export function splitEmails(text: string): string[] {
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * What ticking "can open" on one folder or note grants a person: their own
 * vault-wide level when it is Can edit or Can view, else Everyone's level when
 * that is one of those, else Can edit. Never a silent default to view — that
 * read as the tick taking edit rights away.
 */
export function tickGrantMode(
  personVaultMode: TeamAccessMode | "custom" | null,
  everyoneMode: TeamAccessMode | null,
): TeamAccessMode {
  if (personVaultMode === "open" || personVaultMode === "readonly") return personVaultMode;
  if (everyoneMode === "open" || everyoneMode === "readonly") return everyoneMode;
  return "open";
}

/** What a confirm about taking access away is about. */
export type ReduceScope =
  | { kind: "item"; name: string }
  | { kind: "person"; name: string; self: boolean }
  | { kind: "everyone" };

/** Said when access is removed outright. */
export const REMOVAL_SENTENCE =
  "Content they can no longer read is removed from their devices on the next sync. The server copy is kept and can be restored by granting access again.";
const REMOVAL_SENTENCE_SELF =
  "Content you can no longer read is removed from your devices on the next sync. The server copy is kept and can be restored by granting access again.";

/**
 * Title, button and outcome sentence for a confirm that lowers access to
 * Can view or No access. Plain words that name the result — never "narrow",
 * never a bare "Apply".
 */
export function reduceAccessCopy(
  scope: ReduceScope,
  to: "readonly" | "private",
): { title: string; button: string; outcome: string } {
  const self = scope.kind === "person" && scope.self;
  const button = to === "private" ? "Remove access" : "Make view only";
  const outcome = to === "private"
    ? (self ? REMOVAL_SENTENCE_SELF : REMOVAL_SENTENCE)
    : (self ? "You can still read it but no longer edit." : "They can still read it but no longer edit.");
  let title: string;
  if (scope.kind === "item") {
    title = to === "private" ? `Remove access to “${scope.name}”?` : `Make “${scope.name}” view only?`;
  } else if (scope.kind === "person") {
    title = to === "private"
      ? (scope.self ? "Remove your access to this vault?" : `Remove ${scope.name}'s access to this vault?`)
      : (scope.self ? "Make yourself view only across the vault?" : `Make ${scope.name} view only across the vault?`);
  } else {
    title = to === "private" ? `Set default access to ${DEFAULT_PRIVATE_LABEL}?` : "Set default access to Can view?";
  }
  return { title, button, outcome };
}

/** The before/after line an access confirm shows (ConfirmDialog `change`). */
export function accessChangeFor(
  scope: ReduceScope,
  from: TeamAccessMode | "custom" | null,
  to: TeamAccessMode,
): { who: string; sub?: string; from: TeamAccessMode | "custom" | null; to: TeamAccessMode } {
  if (scope.kind === "everyone") return { who: DEFAULT_ACCESS_TITLE, sub: "Every member starts here", from, to };
  if (scope.kind === "person") {
    return scope.self ? { who: "You", sub: scope.name, from, to } : { who: scope.name, from, to };
  }
  return { who: scope.name, from, to };
}

/** Colour class for a level pill: green edit, amber view, grey none, neutral mixed. */
export function levelClass(level: TeamAccessMode | MemberAccessLevel | "mixed" | null | undefined): string {
  switch (level) {
    case "open":
    case "edit":
      return "is-edit";
    case "readonly":
    case "view":
      return "is-view";
    case "private":
    case "none":
      return "is-none";
    case "mixed":
    case "custom":
      return "is-mixed";
    default:
      return "";
  }
}

// -- Roster patches after a write (#307) --
// Paint-only: the tab patches what it shows at once, then refreshes once from
// the server, which stays authoritative.

/** The person level a vault-wide write of `mode` sets. */
export function levelOfMode(mode: TeamAccessMode): MemberAccessLevel {
  return mode === "open" ? "edit" : mode === "readonly" ? "view" : "none";
}

/** The roster with one member's vault-wide level replaced. */
export function withMemberLevel(ov: MembersOverview, userId: string, level: MemberAccessLevel): MembersOverview {
  return {
    ...ov,
    members: ov.members.map((m) => (m.userId === userId && m.access ? { ...m, access: { level } } : m)),
  };
}

/** The Everyone row after `PUT team-access`: the mode, its posture, no org overrides left. */
export function patchedTeamAccess(t: TeamAccess, mode: TeamAccessMode): TeamAccess {
  const posture: TeamAccessPosture = mode === "open" ? "edit" : mode === "readonly" ? "view" : "sealed";
  return { ...t, mode, posture, overrides: [] };
}

/** The roster without a revoked invitation. */
export function withoutInvitation(ov: MembersOverview, invitationId: string): MembersOverview {
  return { ...ov, invitations: ov.invitations.filter((i) => i.id !== invitationId) };
}

/** The roster with the invitations a send just created (or renewed), newest first. */
export function withNewInvitations(
  ov: MembersOverview,
  results: readonly InviteManyResult[],
  sent: { role: string; access: TeamAccessMode | null; groupIds?: string[] },
  nowIso: string,
): MembersOverview {
  const added: InvitationOverview[] = results
    .filter((r): r is InviteManyResult & { invitationId: string } => !r.error && !!r.invitationId)
    .map((r) => ({
      id: r.invitationId,
      email: r.email,
      role: sent.role,
      status: "pending",
      createdAt: nowIso,
      expiresAt: null,
      access: sent.access,
      ...(sent.groupIds?.length ? { groupIds: sent.groupIds } : {}),
    }));
  if (!added.length) return ov;
  const emails = new Set(added.map((i) => i.email.toLowerCase()));
  return { ...ov, invitations: [...added, ...ov.invitations.filter((i) => !emails.has(i.email.toLowerCase()))] };
}

/**
 * May a viewer with `viewerRole` change the ACCESS of a member with
 * `targetRole`? The one rule the UI asks, mirrored by the server's
 * `permissions/access-management.ts canManageMemberAccess`:
 *
 *   - owner: anyone, themselves included (their own row is the way back in
 *     after narrowing the whole vault);
 *   - admin: everyone except the owner (plain members, other admins and
 *     themselves) — decided 2026-10-09; role changes and removal keep the
 *     stricter matrix where an admin never touches another admin;
 *   - member: nobody.
 */
export function canManageMemberAccess(
  viewerRole: string | null | undefined,
  targetRole: string | null | undefined,
  isSelf: boolean,
): boolean {
  if (viewerRole === "owner") return true;
  if (viewerRole === "admin") return isSelf || targetRole === "member" || targetRole === "admin";
  return false;
}

/**
 * The signed-in viewer's role in this vault, from the FRESHEST authority.
 * The store's `members` list is read when the vault opens, so a promotion
 * made after that (an owner making someone admin) leaves it stale for the
 * rest of the session; the roster overview is re-read every time the tab
 * opens. Its own row wins, then the server's `canManage` (a manager row we
 * somehow lack still means owner/admin), then the store's role.
 */
export function freshViewerRole(
  overview: Pick<MembersOverview, "members" | "canManage"> | null | undefined,
  myUserId: string | undefined,
  storedRole: string | undefined,
): string | undefined {
  const mine = overview && myUserId ? overview.members.find((m) => m.userId === myUserId)?.role : undefined;
  if (mine) return mine;
  if (overview && !overview.canManage && (storedRole === "owner" || storedRole === "admin")) return "member";
  return storedRole;
}

/** May this role see the manager view (Everyone row, Invite, Access column)? */
export function roleManages(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * The store's member list with the viewer's role in `orgId` set to `role`.
 * Returns the SAME array when nothing changes, so a caller can skip the
 * store write; adds the row when the store never learned it.
 */
export function withViewerRole(
  members: readonly Member[],
  orgId: string,
  userId: string,
  role: string,
  memberId?: string,
): Member[] {
  const i = members.findIndex((m) => m.organizationId === orgId && m.userId === userId);
  if (i >= 0) {
    if (members[i].role === role) return members as Member[];
    const next = members.slice();
    next[i] = { ...members[i], role };
    return next;
  }
  return [...members, { id: memberId ?? `${orgId}:${userId}`, organizationId: orgId, userId, role }];
}

// ── Selecting people for a bulk action ─────────────────────────────────────

/** The header checkbox: nothing, some or all of the shown selectable rows. */
export function headerCheckState(shownSelectable: readonly string[], selected: ReadonlySet<string>): "none" | "some" | "all" {
  const on = shownSelectable.filter((id) => selected.has(id)).length;
  if (on === 0) return "none";
  return on === shownSelectable.length ? "all" : "some";
}

/** Header click: all shown selectable rows on, or (when all are on) off; rows not shown keep their tick. */
export function toggleShown(shownSelectable: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const all = headerCheckState(shownSelectable, selected) === "all";
  for (const id of shownSelectable) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** Drop ticks for people who are no longer in the roster (removed, left). Same set back when nothing changed. */
export function pruneSelection(selected: ReadonlySet<string>, present: Iterable<string>): ReadonlySet<string> {
  const keep = new Set(present);
  for (const id of selected) if (!keep.has(id)) {
    return new Set([...selected].filter((x) => keep.has(x)));
  }
  return selected;
}

/**
 * Split a selection for one action: who it applies to, who already has it
 * (nothing to do) and who this person may not change.
 */
export function splitBulkTargets<T>(
  selected: readonly T[],
  allowed: (t: T) => boolean,
  alreadyDone: (t: T) => boolean = () => false,
): { apply: T[]; unchanged: T[]; notAllowed: T[] } {
  const out = { apply: [] as T[], unchanged: [] as T[], notAllowed: [] as T[] };
  for (const t of selected) {
    if (!allowed(t)) out.notAllowed.push(t);
    else if (alreadyDone(t)) out.unchanged.push(t);
    else out.apply.push(t);
  }
  return out;
}

export const peopleCount = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/** The toast after a bulk action: "3 people can now view everything. 1 skipped: you can't change the owner." */
export function bulkResultLine(done: string, split: { apply: unknown[]; unchanged: unknown[]; notAllowed: unknown[] }): string {
  const parts = [done];
  if (split.unchanged.length) parts.push(`${peopleCount(split.unchanged.length)} already had it.`);
  if (split.notAllowed.length) parts.push(`${peopleCount(split.notAllowed.length)} skipped: you can't change ${split.notAllowed.length === 1 ? "them" : "those people"}.`);
  return parts.join(" ");
}

/** Run requests in slices of at most `size` ids (the server's per-call caps). */
export function chunkIds<T>(ids: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// ── Where a person's access comes from ─────────────────────────────────────

/** One of a person's access groups, with what it gives (`groupAccessSummary`). */
export interface AccessSourceGroup {
  name: string;
  /** null for a caller who can't see grants; "No access yet" for a group that gives nothing. */
  summary: string | null;
}

/**
 * Where one person's vault-wide access comes from, in plain words: a short
 * label for the Access column and the full lines for its tooltip and the
 * profile. Mirrors the resolver without asking it: a person with their OWN
 * vault-wide level (`access.own`) ignores default access and groups;
 * everyone else starts at default access and their groups add to it.
 */
export function accessSources(input: {
  level: MemberAccessLevel;
  own: boolean;
  isSelf?: boolean;
  /** Default access as the row shows it ("No access"); null until known. */
  defaultLabel: string | null;
  groups: readonly AccessSourceGroup[];
}): { short: string; lines: string[]; sentence: string } {
  const who = input.isSelf ? "you" : "them";
  if (input.own) {
    const head = input.level === "custom"
      ? `Set just for ${who}, with some folders or notes set differently.`
      : `Set just for ${who}: ${PERSON_LEVEL_LABEL[input.level]}.`;
    const tail = input.groups.length ? "Default access and access groups don't change it." : "Default access doesn't change it.";
    return {
      short: `Set just for ${who}`,
      lines: [head, input.groups.length ? "Default access and access groups don't change this." : "Default access doesn't change this."],
      sentence: `Set just for ${who}. ${tail}`,
    };
  }
  const giving = input.groups.filter((g) => g.summary && g.summary !== "No access yet");
  const lines: string[] = [];
  if (input.defaultLabel) lines.push(`Default access: ${input.defaultLabel}.`);
  for (const g of giving) lines.push(`${g.name} group: ${g.summary}.`);
  if (input.level === "custom" && giving.length === 0) lines.push(`Some folders or notes are set differently for ${who}.`);
  const short = giving.length === 0
    ? (input.level === "custom" ? "Default, with changes" : "Default access")
    : giving.length === 1
      ? `Default + ${giving[0].name}`
      : `Default + ${giving.length} groups`;
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const from = [
    input.defaultLabel ? `default access (${lower(input.defaultLabel)})` : "default access",
    ...(giving.length > 2
      ? [`${giving.length} access groups`]
      : giving.map((g) => `the ${g.name} group (${lower(g.summary!)})`)),
  ];
  const changed = input.level === "custom" && giving.length === 0 ? ", with some folders or notes set differently" : "";
  const sentence = `From ${from.join(" and ")}${changed}. Choosing a level here sets it just for ${who}.`;
  return { short, lines, sentence };
}
