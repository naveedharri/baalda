import { describe, expect, it, vi } from "vitest";
import { shortcutAttention } from "../shortcut";
import type { SkillSummary } from "../types";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const skill = (id: string, over: Partial<SkillSummary> = {}): SkillSummary => ({
  id, orgId: "o", name: id, description: "", delivery: "optional", pinnedVersion: null, latestVersion: 1,
  effectiveVersion: 1, draftRevision: 1, draftDiffers: false, createdAt: "", updatedAt: "", source: null,
  latestPublishedBy: null, latestPublishedAt: "2026-10-25T12:00:00Z", ...over,
});
const base = { orgId: "o", results: [], recentUpdates: [], isOn: () => false, now: NOW };

describe("shortcutAttention", () => {
  it("is quiet when nothing needs a look", () => {
    expect(shortcutAttention({ ...base, skills: null })).toBeNull();
    expect(shortcutAttention({ ...base, skills: [skill("a")], isOn: () => true })).toBeNull();
  });

  it("counts new Optional skills from the last 7 days not installed here", () => {
    const skills = [
      skill("a"),
      skill("b"),
      skill("old", { latestPublishedAt: "2026-10-01T00:00:00Z" }),
      skill("req", { delivery: "required" }),
      skill("v2", { latestVersion: 2 }),
    ];
    expect(shortcutAttention({ ...base, skills })).toBe("2 new team skills to install");
  });

  it("names problems and fresh updates for this vault only", () => {
    const text = shortcutAttention({
      ...base,
      skills: [],
      results: [
        { orgId: "o", skillId: "x", name: "x", target: "claude", state: "edited" },
        { orgId: "other", skillId: "y", name: "y", target: "claude", state: "failed" },
      ],
      recentUpdates: [{ orgId: "o", skillId: "z", at: "2026-10-27T11:00:00Z" }],
    });
    expect(text).toBe("1 skill needs a look on this computer · 1 skill just updated");
  });
});

describe("shortcut New chip", () => {
  const DAY = 24 * 60 * 60_000;

  it("shows for 14 days from its first showing on this computer (v3 key)", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    // Earlier rules' marks (a tab open, a click) no longer hide it.
    store.set("context.skills.shortcutSeen", "1");
    store.set("context.skills.shortcutSeen.v2", "1");
    const { NEW_CHIP_MS, showNewChip } = await import("../shortcut");
    expect(NEW_CHIP_MS).toBe(14 * DAY);
    expect(showNewChip(NOW)).toBe(true);
    expect(store.get("context.skills.newChip.v3")).toBe(String(NOW));
    // Later showings keep the first stamp.
    expect(showNewChip(NOW + 13 * DAY)).toBe(true);
    expect(store.get("context.skills.newChip.v3")).toBe(String(NOW));
    expect(showNewChip(NOW + 14 * DAY)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("without storage it shows for the session", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} });
    const { showNewChip } = await import("../shortcut");
    expect(showNewChip(NOW)).toBe(true);
    vi.unstubAllGlobals();
  });
});
