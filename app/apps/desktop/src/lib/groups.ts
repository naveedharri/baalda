import type { AccessGroup, GroupGrant, MemberOverview } from "./api";

/** `/health` feature: access groups (server migration 097). */
export const ACCESS_GROUPS_FEATURE = "access-groups";

/** The colours the server accepts (`groups/service.ts GROUP_COLORS`). */
export const GROUP_COLORS = ["violet", "green", "orange", "blue", "pink", "yellow", "teal", "red"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** A group's colour, or a stable pick from its id when it has none. */
export function groupColor(group: Pick<AccessGroup, "id" | "color">): GroupColor {
  if (group.color && (GROUP_COLORS as readonly string[]).includes(group.color)) return group.color as GroupColor;
  let h = 0;
  for (const ch of group.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/** The next colour for a new group: the least used one, in palette order. */
export function nextGroupColor(groups: ReadonlyArray<Pick<AccessGroup, "id" | "color">>): GroupColor {
  const used = new Map<GroupColor, number>(GROUP_COLORS.map((c) => [c, 0]));
  for (const g of groups) {
    const c = groupColor(g);
    used.set(c, (used.get(c) ?? 0) + 1);
  }
  let best: GroupColor = GROUP_COLORS[0];
  for (const c of GROUP_COLORS) if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
  return best;
}

const lastPart = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * One line saying what a group gives, for the groups list:
 * "Can edit everything", "Can edit Specs and 2 more", "Can view Specs · Can edit Design",
 * "No access yet". `null` grants (plain members) say nothing.
 */
export function groupAccessSummary(grants: readonly GroupGrant[] | null): string | null {
  if (grants === null) return null;
  // A No access row (migration 100) gives nothing: it only stops this group
  // below a folder it otherwise reaches, so it reads as an exception.
  const hidden = grants.filter((g) => g.permission === "denied");
  grants = grants.filter((g) => g.permission !== "denied");
  if (grants.length === 0) return "No access yet";
  const vault = grants.find((g) => g.resourceType === "vault");
  const items = grants.filter((g) => g.resourceType !== "vault");
  const except = hidden.length === 0 ? ""
    : ` except ${hidden[0].path ? lastPart(hidden[0].path) : "an item"}${hidden.length > 1 ? ` and ${hidden.length - 1} more` : ""}`;
  const part = (perm: "edit" | "view") => {
    const list = items.filter((g) => g.permission === perm);
    if (list.length === 0) return null;
    const first = list[0].path ? lastPart(list[0].path) : "an item";
    const verb = perm === "edit" ? "Can edit" : "Can view";
    return list.length === 1 ? `${verb} ${first}` : `${verb} ${first} and ${list.length - 1} more`;
  };
  if (vault) {
    const head = (vault.permission === "edit" ? "Can edit everything" : "Can view everything") + except;
    // Under a vault edit nothing more can add; under a vault view only edits do.
    const extra = vault.permission === "view" ? part("edit") : null;
    return extra ? `${head} · ${extra}` : head;
  }
  return [part("edit"), part("view")].filter(Boolean).join(" · ");
}

/** "3 members" / "1 member, 1 invited". */
export function groupCountLine(group: Pick<AccessGroup, "memberIds" | "invited">): string {
  const base = plural(group.memberIds.length, "member");
  return group.invited.length ? `${base}, ${group.invited.length} invited` : base;
}

/** Groups matching a search, by name or by a member's name or email. */
export function filterGroups(
  query: string,
  groups: readonly AccessGroup[],
  members: readonly Pick<MemberOverview, "userId" | "name" | "email">[],
): AccessGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  const byId = new Map(members.map((m) => [m.userId, m]));
  return groups.filter((g) =>
    g.name.toLowerCase().includes(q) ||
    g.memberIds.some((id) => {
      const m = byId.get(id);
      return !!m && ((m.name ?? "").toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q));
    }),
  );
}

/** The groups a person is in, in list order. */
export function groupsOf(userId: string, groups: readonly AccessGroup[]): AccessGroup[] {
  return groups.filter((g) => g.memberIds.includes(userId));
}

/** A group name the server will take: trimmed, 1–60 characters, not taken (case-insensitive). */
export function groupNameProblem(name: string, groups: readonly Pick<AccessGroup, "id" | "name">[], selfId?: string): string | null {
  const n = name.trim();
  if (!n) return "Give the group a name.";
  if (n.length > 60) return "Keep the name under 60 characters.";
  if (groups.some((g) => g.id !== selfId && g.name.trim().toLowerCase() === n.toLowerCase())) return "A group already has this name.";
  return null;
}

/** Option value prefix for groups inside access menus. */
export const GROUP_OPTION = "group:";
export const isGroupOption = (v: string) => v.startsWith(GROUP_OPTION);
export const groupOptionId = (v: string) => v.slice(GROUP_OPTION.length);

/** True when the group opens the whole vault (a vault-level grant). The
 *  converted "Everyone" groups are like this, and for most people they are
 *  the ONLY way in: the vault itself is Only what's shared. */
export function groupOpensWholeVault(grants: readonly GroupGrant[] | null): boolean {
  return !!grants?.some((g) => g.resourceType === "vault" && (g.permission === "edit" || g.permission === "view"));
}

/** The confirm text for taking one person out of a group. It names the loss
 *  plainly: what the group gave leaves their computer, notes they wrote
 *  included, because an Only what's shared vault gives authors nothing of
 *  their own. Nothing is deleted for the team. */
export function groupRemoveNote(groupName: string, grants: readonly GroupGrant[] | null, who: { self: boolean; name: string }): string {
  const they = who.self ? "you" : who.name;
  const their = who.self ? "your" : "their";
  const computer = who.self ? "this computer" : "their computer";
  if (groupOpensWholeVault(grants)) {
    return `${groupName} opens the whole vault. Without it, ${they} ${who.self ? "keep" : "keeps"} only ${their} own access and other groups: everything else leaves ${computer}, notes ${who.self ? "you" : "they"} wrote included. It stays on the server for the team, and adding ${who.self ? "yourself" : "them"} back returns it.`;
  }
  return `${who.self ? "You lose" : `${who.name} loses`} what ${groupName} gave, notes ${who.self ? "you" : "they"} wrote there included. ${who.self ? "Your" : "Their"} own access and other groups stay, and nothing is deleted for the team.`;
}

/** The confirm text for deleting a group. */
export function groupDeleteNote(groupName: string, grants: readonly GroupGrant[] | null, memberCount: number): string {
  const members = memberCount === 1 ? "Its member keeps" : `Its ${memberCount} members keep`;
  if (groupOpensWholeVault(grants)) {
    return `${groupName} opens the whole vault. ${members} only their own access and other groups: everything else leaves their computers, notes they wrote included. It stays on the server. A new group can give the same access back, but not exactly who saw what before. This can't be undone.`;
  }
  const lose = memberCount === 1 ? "Its member loses" : `Its ${memberCount} members lose`;
  return `${lose} what ${groupName} gave, notes they wrote there included; their own access and other groups stay, and nothing is deleted for the team. This can't be undone.`;
}
