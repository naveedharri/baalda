// What a team skill looks like on THIS computer, per tool folder and overall:
// the source of the Skills tab's install button (+ / ✓ / !) and its tool-logo
// cluster. Pure, pinned by `__tests__/installState.test.ts`.

import type { SkillTarget } from "../ipc";
import type { SkillTargetResult } from "./syncEngine";

export type TargetState = "installed" | "updating" | "edited" | "keptMine" | "conflict" | "failed" | "off" | "missing";

export type Overall = "installed" | "updating" | "warn" | "bad" | "none";

export const TARGET_LABEL: Record<SkillTarget, string> = {
  claude: "Claude",
  agents: "Codex & other tools",
};

/** Each tool folder's state for one skill. `on` = the folder's switch in AI tools. */
export function targetStates(
  results: readonly SkillTargetResult[],
  on: Record<SkillTarget, boolean>,
  orgId: string,
  skillId: string,
): Record<SkillTarget, TargetState> {
  const one = (target: SkillTarget): TargetState => {
    if (!on[target]) return "off";
    const r = results.find((x) => x.orgId === orgId && x.skillId === skillId && x.target === target);
    if (!r) return "missing";
    return r.state === "upToDate" ? "installed" : r.state;
  };
  return { claude: one("claude"), agents: one("agents") };
}

/** The most important thing to say about the whole skill on this computer. */
export function overallState(states: Record<SkillTarget, TargetState>): Overall {
  const all = Object.values(states);
  if (all.includes("failed")) return "bad";
  if (all.includes("edited") || all.includes("conflict")) return "warn";
  if (all.includes("updating")) return "updating";
  if (all.some((s) => s === "installed" || s === "keptMine")) return "installed";
  return "none";
}

const STATE_TEXT: Record<TargetState, string> = {
  installed: "Installed",
  updating: "Updating",
  edited: "Edited here",
  keptMine: "Your edited copy",
  conflict: "Name taken by another skill",
  failed: "Couldn't install",
  off: "Off",
  missing: "Not installed",
};

/** "Claude: Installed v2" lines for a tooltip. */
export function stateLines(states: Record<SkillTarget, TargetState>, version: number | null): string[] {
  return (Object.keys(states) as SkillTarget[]).map((t) => {
    const s = states[t];
    return `${TARGET_LABEL[t]}: ${STATE_TEXT[s]}${s === "installed" && version !== null ? ` v${version}` : ""}`;
  });
}

// ---- "Available in" (a skill page's line of AI tools) ----------------------

export type AiTool = "claude" | "codex" | "cursor" | "gemini";

export const AI_TOOLS: readonly AiTool[] = ["claude", "codex", "cursor", "gemini"];

export const AI_TOOL_NAME: Record<AiTool, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
};

/** Which Baalda install folders each tool reads (Cursor reads both). */
export const TOOL_TARGETS: Record<AiTool, readonly SkillTarget[]> = {
  claude: ["claude"],
  codex: ["agents"],
  cursor: ["agents", "claude"],
  gemini: ["agents"],
};

export interface ToolAvailability {
  tool: AiTool;
  /** Installed or readable for that tool on this computer. */
  on: boolean;
  /** Why not, for the faded logo's tooltip. */
  reason: string | null;
  /** A note for an available tool's tooltip (Codex: only new chats see it). */
  note?: string;
}

const LIVE: ReadonlySet<TargetState> = new Set(["installed", "keptMine", "updating"]);

/**
 * A team skill per AI tool on this computer. `optedIn` is false for an Optional
 * skill not turned on here; `detected` says which tools are installed at all.
 */
export function teamAvailability(
  states: Record<SkillTarget, TargetState>,
  optedIn: boolean,
  detected: Record<AiTool, boolean>,
): ToolAvailability[] {
  return AI_TOOLS.map((tool) => {
    const targets = TOOL_TARGETS[tool];
    if (!optedIn) return { tool, on: false, reason: "Not on this computer · click + to install" };
    if (!detected[tool]) return { tool, on: false, reason: `${AI_TOOL_NAME[tool]} isn't installed` };
    if (targets.some((t) => LIVE.has(states[t]))) {
      return tool === "codex"
        ? { tool, on: true, reason: null, note: "Installed · new Codex chats pick it up" }
        : { tool, on: true, reason: null };
    }
    const s = targets.map((t) => states[t]);
    const reason = s.includes("edited")
      ? "Edited here"
      : s.includes("conflict")
        ? "Name taken by another skill"
        : s.includes("failed")
          ? "Couldn't install"
          : s.every((x) => x === "off")
            ? `${targets.map((t) => TARGET_LABEL[t]).join(" and ")} folder is off in AI tools`
            : "Not installed yet";
    return { tool, on: false, reason };
  });
}

/** Which AI tools this computer has, from Rust's target detection. */
export function detectedAiTools(targets: readonly { target: SkillTarget; toolInstalled: boolean; detectedTools: string[] }[]): Record<AiTool, boolean> {
  const claude = targets.find((t) => t.target === "claude");
  const agents = targets.find((t) => t.target === "agents");
  const has = (id: string) => !!agents?.detectedTools.includes(id);
  return { claude: !!claude?.toolInstalled, codex: has("codex"), cursor: has("cursor"), gemini: has("gemini") };
}
