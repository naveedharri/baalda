import { describe, expect, it } from "vitest";
import type { DeviceSkill, SkillLocation } from "../../ipc";
import { countLive, deviceAvailability, deviceItems, groupDeviceSkills, tildePath, usedByText, visibleTo } from "../deviceGrouping";

const entry = (name: string, location: SkillLocation, path: string, over: Partial<DeviceSkill> = {}): DeviceSkill => ({
  name, description: `${name} does things`, path, realPath: path, isSymlink: false, fileCount: 2, totalBytes: 10,
  truncated: false, location, pluginName: null, marketplace: null, pluginVersion: null, enabled: null, managed: null, ...over,
});
const marker = (skillId: string) => ({
  skillId, orgId: "o", serverUrl: "https://x", userId: "u", name: skillId, version: 1, bundleSha256: "h", files: {},
});

describe("deviceItems: one card per skill", () => {
  it("merges Baalda copies of one team skill across folders by skillId", () => {
    const items = deviceItems([
      entry("team-one", "claudePersonal", "/h/.claude/skills/team-one", { managed: marker("s1") }),
      entry("team-one", "agentsPersonal", "/h/.agents/skills/team-one", { managed: marker("s1") }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].locations).toEqual(["claudePersonal", "agentsPersonal"]);
    expect(usedByText(items[0])).toBe("Claude · Codex");
  });

  it("merges a personal skill copied into two folders when name and description match", () => {
    const items = deviceItems([
      entry("mine", "claudePersonal", "/h/.claude/skills/mine"),
      entry("mine", "codexPersonal", "/h/.codex/skills/mine"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].paths).toHaveLength(2);
    expect(items[0].hint).toBeNull();
  });

  it("merges a symlinked folder by its real path", () => {
    const items = deviceItems([
      entry("linked", "agentsPersonal", "/h/.agents/skills/linked"),
      entry("linked", "claudePersonal", "/h/.claude/skills/linked", { realPath: "/h/.agents/skills/linked", isSymlink: true }),
    ]);
    expect(items).toHaveLength(1);
  });

  it("keeps two different skills with one name apart, each with a location hint", () => {
    const items = deviceItems([
      entry("frontend-design", "claudePersonal", "/h/.claude/skills/frontend-design", { description: "Create distinctive UIs" }),
      entry("frontend-design", "agentsPersonal", "/h/.agents/skills/frontend-design", { description: "Guidance for design" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.hint).sort()).toEqual(["~/.agents/skills", "~/.claude/skills"]);
  });

  it("never merges plugin copies with personal ones", () => {
    expect(
      deviceItems([
        entry("pdf", "claudePersonal", "/h/.claude/skills/pdf"),
        entry("pdf", "claudePlugin", "/h/.claude/plugins/x/pdf", { pluginName: "docs" }),
      ]),
    ).toHaveLength(2);
  });
});

describe("tool visibility", () => {
  const items = deviceItems([
    entry("c", "claudePersonal", "/h/.claude/skills/c"),
    entry("a", "agentsPersonal", "/h/.agents/skills/a"),
    entry("x", "codexPersonal", "/h/.codex/skills/x"),
    entry("p", "claudePlugin", "/h/.claude/plugins/p", { pluginName: "pl" }),
    entry("s", "codexSystem", "/h/.codex/skills/.system/s"),
  ]);
  const byName = (n: string) => items.find((i) => i.name === n)!;

  it("follows each tool's folders", () => {
    expect(visibleTo(byName("c"), "claude")).toBe(true);
    expect(visibleTo(byName("c"), "cursor")).toBe(true);
    expect(visibleTo(byName("c"), "codex")).toBe(false);
    expect(visibleTo(byName("a"), "gemini")).toBe(true);
    expect(visibleTo(byName("x"), "gemini")).toBe(false);
    expect(visibleTo(byName("p"), "cursor")).toBe(false);
  });

});

describe("groupDeviceSkills", () => {
  const entries: DeviceSkill[] = [
    entry("team-one", "claudePersonal", "/h/.claude/skills/team-one", { managed: marker("s1") }),
    entry("team-one", "agentsPersonal", "/h/.agents/skills/team-one", { managed: marker("s1") }),
    entry("mine", "agentsPersonal", "/h/.agents/skills/mine"),
    entry("alpha", "codexPersonal", "/h/.codex/skills/alpha"),
    entry("pdf", "claudePlugin", "/h/.claude/plugins/x/pdf", { pluginName: "docs", marketplace: "acme" }),
    entry("lint", "codexPlugin", "/h/.codex/plugins/y/lint", { pluginName: "dev" }),
    entry("org-skill", "claudeSynced", "/h/.claude/skills/synced/o/org-skill"),
    entry("builtin", "codexSystem", "/h/.codex/skills/.system/builtin"),
  ];

  it("groups in a fixed order", () => {
    expect(groupDeviceSkills(entries).map((g) => [g.label, g.items.map((i) => i.name)])).toEqual([
      ["From your team", ["team-one"]],
      ["Your skills", ["alpha", "mine"]],
      ["docs · acme", ["pdf"]],
      ["dev", ["lint"]],
      ["Claude org (claude.ai)", ["org-skill"]],
      ["Codex built-in", ["builtin"]],
    ]);
  });

  it("filters by name or description", () => {
    expect(groupDeviceSkills(entries, "PDF").map((g) => g.label)).toEqual(["docs · acme"]);
    expect(groupDeviceSkills(entries, "nothing")).toEqual([]);
  });
});

describe("disabled plugins", () => {
  const entries = [
    entry("on", "claudePlugin", "/h/p/on", { pluginName: "a", enabled: true }),
    entry("off", "claudePlugin", "/h/p/off", { pluginName: "b", enabled: false }),
    entry("mine", "claudePersonal", "/h/.claude/skills/mine"),
  ];
  it("are hidden by default and shown on request", () => {
    expect(groupDeviceSkills(entries).flatMap((g) => g.items.map((i) => i.name))).toEqual(["mine", "on"]);
    expect(groupDeviceSkills(entries, "", true).flatMap((g) => g.items.map((i) => i.name))).toEqual(["mine", "on", "off"]);
  });
  it("never count", () => {
    expect(countLive(deviceItems(entries))).toBe(2);
  });
});

describe("deviceAvailability", () => {
  it("follows the folders each tool reads, and what is installed", () => {
    const [item] = deviceItems([entry("a", "agentsPersonal", "/h/.agents/skills/a")]);
    const a = deviceAvailability(item, { claude: true, codex: true, cursor: true, gemini: false });
    expect(a.map((x) => [x.tool, x.on, x.reason])).toEqual([
      ["claude", false, "Not in a folder Claude reads"],
      ["codex", true, null],
      ["cursor", true, null],
      ["gemini", false, "Gemini isn't installed"],
    ]);
  });
});

describe("tildePath", () => {
  it("shortens paths under home only", () => {
    expect(tildePath("/Users/a/.claude/skills/x", "/Users/a")).toBe("~/.claude/skills/x");
    expect(tildePath("/opt/x", "/Users/a")).toBe("/opt/x");
    expect(tildePath("/Users/a/x", null)).toBe("/Users/a/x");
  });
});
