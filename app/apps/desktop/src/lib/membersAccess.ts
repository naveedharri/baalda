// Pure rules behind the "Members and access" page, kept out of the component
// so the wording and the narrowing rule can be pinned by tests.

import type {
  InvitationOverview,
  MemberAccessLevel,
  MemberOverview,
  TeamAccessMode,
  TeamAccessPosture,
} from "./api";
import { relativeTime } from "./health/format";

/** The three wire modes in the page's words, for the Everyone row. */
export const EVERYONE_OPTIONS: ReadonlyArray<{ value: TeamAccessMode; label: string; hint: string }> = [
  { value: "open", label: "Can edit", hint: "Read and change every note" },
  { value: "readonly", label: "Can view", hint: "Read only" },
  { value: "private", label: "No access", hint: "Can't open any notes until you change this" },
];

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
  if (posture === "none") return { label: "No access", sub: "Members keep notes they wrote" };
  const option = EVERYONE_OPTIONS.find((o) => o.value === mode);
  return { label: option?.label ?? "No access", sub: null };
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
    title = to === "private" ? "Set everyone to No access?" : "Make the vault view only for everyone?";
  }
  return { title, button, outcome };
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
