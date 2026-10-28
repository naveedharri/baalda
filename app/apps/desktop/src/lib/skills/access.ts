// Who gets a team skill (server migration 062, docs/SKILLS.md "Who gets a
// skill"): the Everyone row plus per-person levels, coloured like vault
// access (Required green, Optional amber, No access grey).

import type { SkillAccessLevel, SkillAudience, SkillSummary } from "./types";

/** `/health` feature: the server knows per-person skill access (migration 062). */
export const SKILL_ACCESS_FEATURE = "skill-access";

export const ACCESS_LABEL: Record<SkillAccessLevel, string> = {
  required: "Required",
  optional: "Optional",
  none: "No access",
};

export const EVERYONE_ACCESS_OPTIONS = [
  { value: "required" as const, label: "Required", hint: "Installed for everyone" },
  { value: "optional" as const, label: "Optional", hint: "Each person turns it on" },
  { value: "none" as const, label: "No access", hint: "Only the people you choose" },
];

/** A person's menu; "everyone" puts them back on the Everyone row. */
export type PersonAccessChoice = SkillAccessLevel | "everyone";
export function personAccessOptions(own: boolean, everyone: SkillAccessLevel) {
  return [
    { value: "required" as const, label: "Required", hint: "Installed for them" },
    { value: "optional" as const, label: "Optional", hint: "They turn it on" },
    { value: "none" as const, label: "No access", hint: "They can't see it" },
    ...(own ? [{ value: "everyone" as const, label: `Same as everyone (${ACCESS_LABEL[everyone]})` }] : []),
  ];
}

/** The vault access pill classes, so a skill level reads like an access level. */
export function accessLevelClass(level: SkillAccessLevel): string {
  return level === "required" ? "is-edit" : level === "optional" ? "is-view" : "is-none";
}

/** The skill's audience in a few words, for cards and the page header. */
export function audienceLine(a: SkillAudience, viewerIn: boolean): string {
  if (a.everyone) return `Everyone · ${a.total}`;
  if (a.count === 0) return "Nobody yet";
  if (viewerIn) return a.count === 1 ? "Only you" : `You and ${a.count - 1} ${a.count === 2 ? "other" : "others"}`;
  return a.count === 1 ? `1 person` : `${a.count} people`;
}

/** What this person's computer gets: their own level, else (an old server) the delivery. */
export function myAccessOf(s: Pick<SkillSummary, "myAccess" | "delivery">): SkillAccessLevel {
  return s.myAccess ?? s.delivery;
}

/** The server knows per-person access (migration 062). */
export function hasSkillAccess(s: Pick<SkillSummary, "sharedWith">): boolean {
  return s.sharedWith !== undefined;
}
