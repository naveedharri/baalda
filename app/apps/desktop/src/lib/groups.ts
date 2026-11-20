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
  if (grants.length === 0) return "No access yet";
  const vault = grants.find((g) => g.resourceType === "vault");
  const items = grants.filter((g) => g.resourceType !== "vault");
  const part = (perm: "edit" | "view") => {
    const list = items.filter((g) => g.permission === perm);
    if (list.length === 0) return null;
    const first = list[0].path ? lastPart(list[0].path) : "an item";
    const verb = perm === "edit" ? "Can edit" : "Can view";
    return list.length === 1 ? `${verb} ${first}` : `${verb} ${first} and ${list.length - 1} more`;
  };
  if (vault) {
    const head = vault.permission === "edit" ? "Can edit everything" : "Can view everything";
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
