import { describe, expect, it } from "vitest";
import {
  SKILLS_PREFS_KEY,
  defaultSkillsPrefs,
  keepMineKey,
  loadSkillsPrefs,
  normalizeServerUrl,
  optInKey,
  saveSkillsPrefs,
  updateSkillsPrefs,
  type PrefsStorage,
} from "../prefs";

function fakeStorage(): PrefsStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const DEFAULTS = { targets: { claude: true, agents: true }, optIns: {}, keepMine: {}, lastRunAt: null };

describe("loadSkillsPrefs", () => {
  it("returns defaults with null storage", () => {
    expect(loadSkillsPrefs(null)).toEqual(DEFAULTS);
  });

  it("returns defaults with empty storage", () => {
    expect(loadSkillsPrefs(fakeStorage())).toEqual(DEFAULTS);
    expect(defaultSkillsPrefs()).toEqual(DEFAULTS);
  });

  it("returns defaults for corrupted JSON and non-object JSON", () => {
    const s = fakeStorage();
    s.map.set(SKILLS_PREFS_KEY, "{not json");
    expect(loadSkillsPrefs(s)).toEqual(DEFAULTS);
    s.map.set(SKILLS_PREFS_KEY, "42");
    expect(loadSkillsPrefs(s)).toEqual(DEFAULTS);
  });

  it("ignores wrong-typed fields and drops non-true map values", () => {
    const s = fakeStorage();
    s.map.set(
      SKILLS_PREFS_KEY,
      JSON.stringify({
        targets: { claude: "no", agents: false },
        optIns: { a: true, b: "true", c: 1, d: false },
        keepMine: ["x"],
        lastRunAt: 5,
      }),
    );
    const p = loadSkillsPrefs(s);
    expect(p.targets).toEqual({ claude: true, agents: false });
    expect(p.optIns).toEqual({ a: true });
    expect(p.keepMine).toEqual({});
    expect(p.lastRunAt).toBeNull();
  });

  it("reads defaults when getItem throws", () => {
    const s: PrefsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(loadSkillsPrefs(s)).toEqual(DEFAULTS);
  });
});

describe("saveSkillsPrefs", () => {
  it("does not throw when setItem throws", () => {
    const s: PrefsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const p = defaultSkillsPrefs();
    expect(() => saveSkillsPrefs(p, s)).not.toThrow();
    expect(saveSkillsPrefs(p, s)).toBe(p);
  });

  it("round-trips through storage", () => {
    const s = fakeStorage();
    const p = defaultSkillsPrefs();
    p.targets.agents = false;
    p.optIns[optInKey("https://x.test", "o1", "s1")] = true;
    p.keepMine[keepMineKey("https://x.test", "o1", "s1", "claude")] = true;
    p.lastRunAt = "2026-10-26T00:00:00Z";
    saveSkillsPrefs(p, s);
    expect(loadSkillsPrefs(s)).toEqual(p);
  });

  it("updateSkillsPrefs reads, changes and saves", () => {
    const s = fakeStorage();
    updateSkillsPrefs((p) => void (p.targets.claude = false), s);
    updateSkillsPrefs((p) => void (p.lastRunAt = "t"), s);
    const p = loadSkillsPrefs(s);
    expect(p.targets.claude).toBe(false);
    expect(p.lastRunAt).toBe("t");
  });
});

describe("keys", () => {
  it("normalizeServerUrl strips trailing slashes and whitespace", () => {
    expect(normalizeServerUrl("  https://api.x.test///  ")).toBe("https://api.x.test");
    expect(normalizeServerUrl(null)).toBe("");
    expect(normalizeServerUrl(undefined)).toBe("");
  });

  it("formats opt-in and keep-mine keys", () => {
    expect(optInKey("https://x.test/", "o", "s")).toBe("https://x.test|o|s");
    expect(keepMineKey("https://x.test", "o", "s", "agents")).toBe("https://x.test|o|s|agents");
  });
});
