import { describe, expect, it } from "vitest";
import { groupSkills, TEAM_GROUP_LABEL } from "../grouping";
import type { SkillOrigin, SkillSummary } from "../types";

const origin = (repo: string, pluginName?: string): SkillOrigin => ({
  repo, ref: null, path: "skills/x", commitSha: "c".repeat(40), treeSha: "t".repeat(40), ...(pluginName ? { pluginName } : {}),
});
const skill = (name: string, source: SkillOrigin | null = null, description = ""): SkillSummary => ({
  id: name, orgId: "o", name, description, delivery: "optional", pinnedVersion: null, latestVersion: 1,
  effectiveVersion: 1, draftRevision: 1, draftDiffers: false, createdAt: "", updatedAt: "", source,
  latestPublishedBy: null, latestPublishedAt: null,
});

describe("groupSkills", () => {
  const all = [
    skill("zeta", origin("zed/skills")),
    skill("beta"),
    skill("gamma", origin("Anthropics/skills")),
    skill("alpha"),
    skill("delta", origin("anthropics/skills")),
    skill("eps", origin("acme/market", "tools")),
  ];

  it("puts the team's own skills first, then sources by name, each sorted", () => {
    const g = groupSkills(all);
    expect(g.map((x) => [x.label, x.skills.map((s) => s.name)])).toEqual([
      [TEAM_GROUP_LABEL, ["alpha", "beta"]],
      ["acme/market · tools", ["eps"]],
      ["Anthropics/skills", ["delta", "gamma"]],
      ["zed/skills", ["zeta"]],
    ]);
    expect(g[0].kind).toBe("team");
    expect(g[2]).toMatchObject({ kind: "source", repo: "Anthropics/skills" });
  });

  it("drops empty groups and filters by name, description or repo", () => {
    expect(groupSkills([skill("a", origin("o/r"))]).map((x) => x.key)).toEqual(["o/r|"]);
    expect(groupSkills(all, "ZED").map((x) => x.label)).toEqual(["zed/skills"]);
    expect(groupSkills([skill("a", null, "Writes PDFs")], "pdf")).toHaveLength(1);
    expect(groupSkills(all, "nothing-matches")).toEqual([]);
  });
});
