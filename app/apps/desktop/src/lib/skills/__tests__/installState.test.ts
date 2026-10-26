import { describe, expect, it } from "vitest";
import { overallState, stateLines, targetStates, teamAvailability } from "../installState";
import type { SkillTargetResult } from "../syncEngine";

const r = (target: "claude" | "agents", state: SkillTargetResult["state"], skillId = "s"): SkillTargetResult => ({
  orgId: "o", skillId, name: "n", target, state,
});

describe("targetStates / overallState", () => {
  it("reads each folder, honouring the folder switches", () => {
    const st = targetStates([r("claude", "upToDate"), r("agents", "edited"), r("claude", "failed", "other")], { claude: true, agents: true }, "o", "s");
    expect(st).toEqual({ claude: "installed", agents: "edited" });
    expect(overallState(st)).toBe("warn");
    expect(targetStates([r("claude", "upToDate")], { claude: true, agents: false }, "o", "s")).toEqual({ claude: "installed", agents: "off" });
  });

  it("ranks failed over edited over updating over installed", () => {
    expect(overallState({ claude: "failed", agents: "edited" })).toBe("bad");
    expect(overallState({ claude: "updating", agents: "installed" })).toBe("updating");
    expect(overallState({ claude: "keptMine", agents: "off" })).toBe("installed");
    expect(overallState({ claude: "missing", agents: "off" })).toBe("none");
  });

  it("writes one tooltip line per tool", () => {
    expect(stateLines({ claude: "installed", agents: "off" }, 2)).toEqual([
      "Claude: Installed v2",
      "Codex & other tools: Off",
    ]);
  });
});

describe("teamAvailability", () => {
  const all = { claude: true, codex: true, cursor: true, gemini: true };
  it("maps folders to tools; Cursor reads both", () => {
    const a = teamAvailability({ claude: "installed", agents: "off" }, true, all);
    expect(a.map((x) => [x.tool, x.on])).toEqual([["claude", true], ["codex", false], ["cursor", true], ["gemini", false]]);
    expect(a[1].reason).toBe("Codex & other tools folder is off in AI tools");
  });
  it("explains why not", () => {
    expect(teamAvailability({ claude: "missing", agents: "missing" }, false, all)[0].reason).toMatch(/Not on this computer/);
    expect(teamAvailability({ claude: "installed", agents: "installed" }, true, { ...all, gemini: false })[3].reason).toBe("Gemini isn't installed");
    expect(teamAvailability({ claude: "edited", agents: "conflict" }, true, all).map((x) => x.reason)).toEqual([
      "Edited here", "Name taken by another skill", "Edited here", "Name taken by another skill",
    ]);
  });
});
