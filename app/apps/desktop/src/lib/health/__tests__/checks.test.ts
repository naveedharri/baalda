import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_CHECK_IDS,
  CHECK_ACTIONS,
  CHECK_BY_ID,
  CHECK_DEFINITIONS,
  WHOLE_VAULT_ACTIONS,
  checkRows,
  summarizeChecks,
  withoutAutomaticChecks,
  type CheckAction,
} from "../checks";
import type { VaultCheckId, VaultChecks } from "../types";

/** Every id the contract knows, in the union's order. Kept here so a new id
 *  added to `types.ts` without a definition fails loudly instead of rendering
 *  as nothing. */
const ALL_IDS: VaultCheckId[] = [
  "empty-notes",
  "unreadable-notes",
  "bad-frontmatter",
  "case-collisions",
  "illegal-names",
  "long-paths",
  "stale-index",
  "broken-links",
  "missing-embeds",
  "duplicate-titles",
  "unindexed-markdown",
  "oversized-notes",
  "heavy-history",
  "orphan-history",
  "trash",
];

describe("check definitions", () => {
  it("define every check id exactly once", () => {
    const ids = CHECK_DEFINITIONS.map((d) => d.id).sort();
    expect(ids).toEqual([...ALL_IDS].sort());
    expect(CHECK_BY_ID.size).toBe(ALL_IDS.length);
  });

  it("read as sentences a person can act on", () => {
    for (const d of CHECK_DEFINITIONS) {
      expect(d.label.length).toBeGreaterThan(3);
      expect(d.looksFor.endsWith(".")).toBe(true);
      expect(d.whyItMatters.endsWith(".")).toBe(true);
      expect(d.howToFix.length).toBeGreaterThan(0);
      for (const fix of d.howToFix) expect(fix.endsWith(".")).toBe(true);
    }
  });

  it("only offer reset-history and reclaim where a doc id or orphan set exists", () => {
    expect(CHECK_BY_ID.get("heavy-history")?.itemActions).toContain("reset-history");
    expect(CHECK_BY_ID.get("orphan-history")?.heal).toBe("reclaim");
    expect(CHECK_BY_ID.get("trash")?.bulkActions).toEqual(["empty-trash"]);
    for (const d of CHECK_DEFINITIONS) {
      if (d.id !== "heavy-history") expect(d.itemActions).not.toContain("reset-history");
    }
  });

  it("keeps missing-note links manual while preserving source navigation", () => {
    const def = CHECK_BY_ID.get("broken-links")!;
    expect(def.heal).toBeUndefined();
    expect(def.bulkActions).toBeUndefined();
    expect(def.itemActions).toEqual(["open"]);
    expect(def.howToFix.join(" ")).toContain("fix the link if it is a typo");
    expect(def.howToFix.join(" ")).toContain("create the note yourself");
  });

  it("word every action they offer", () => {
    for (const d of CHECK_DEFINITIONS) {
      for (const a of [...d.itemActions, ...(d.bulkActions ?? []), ...(d.heal ? [d.heal] : [])]) {
        const wording = CHECK_ACTIONS[a];
        expect(wording, `${d.id} → ${a}`).toBeDefined();
        expect(wording.label.length).toBeGreaterThan(2);
        expect(wording.verb.length).toBeGreaterThan(2);
        expect(wording.gerund.endsWith("ing")).toBe(true);
      }
    }
  });

  it("heal only the checks whose fix cannot be wrong", () => {
    const healable = CHECK_DEFINITIONS.filter((d) => d.heal).map((d) => d.id).sort();
    expect(healable).toEqual(
      [
        "heavy-history",
        "illegal-names",
        "orphan-history",
        "stale-index",
        "unindexed-markdown",
      ].sort(),
    );
    // The judgement calls stay manual, and each one SAYS it does — a row that
    // offers no heal must explain the refusal, not leave the reader waiting for
    // a button that never comes.
    for (const id of [
      "bad-frontmatter",
      "case-collisions",
      "long-paths",
      "duplicate-titles",
      "broken-links",
      "missing-embeds",
    ] as const) {
      const def = CHECK_BY_ID.get(id)!;
      expect(def.heal).toBeUndefined();
      expect(def.howToFix.join(" ")).toMatch(
        /Baalda (will not|cannot)|Nothing here is broken|create the note yourself/,
      );
    }
  });

  it("confirm every destructive whole-check action and no additive one", () => {
    const destructive: CheckAction[] = ["delete-all", "reset-history-all", "empty-trash"];
    for (const a of destructive) {
      expect(CHECK_ACTIONS[a].confirm, a).toBeDefined();
      expect(CHECK_ACTIONS[a].confirm?.tone).toBe("danger");
    }
    // Reading the vault, or adding to it, is not worth a dialog.
    for (const a of ["rebuild-index", "reclaim", "sync-now", "export-all"] as CheckAction[]) {
      expect(CHECK_ACTIONS[a].confirm, a).toBeUndefined();
    }
    // A bulk rename is reversible but wide, so it asks — quietly.
    expect(CHECK_ACTIONS["rename-legal"].confirm?.tone).toBe("accent");
  });

  it("keep the whole-vault actions out of the per-item lists", () => {
    for (const d of CHECK_DEFINITIONS) {
      for (const a of d.itemActions) expect(WHOLE_VAULT_ACTIONS.has(a)).toBe(false);
    }
  });
});

/** The definitions Health lists: everything the app does not resolve itself. */
const LISTED = CHECK_DEFINITIONS.filter((d) => !AUTOMATIC_CHECK_IDS.has(d.id));

describe("checkRows", () => {
  it("returns every listed definition in order, passed when the count is 0", () => {
    const rows = checkRows(null);
    expect(rows.map((r) => r.def.id)).toEqual(LISTED.map((d) => d.id));
    expect(rows.every((r) => r.passed && r.result.count === 0)).toBe(true);
  });

  it("joins results by id and keeps a missing result as a passed zero", () => {
    const checks: VaultChecks = {
      computedAt: 1,
      results: [
        { id: "empty-notes", count: 2, items: [{ path: "a.md" }, { path: "b.md" }] },
        { id: "trash", count: 5, bytes: 4096, items: [] },
      ],
    };
    const rows = checkRows(checks);
    const empty = rows.find((r) => r.def.id === "empty-notes")!;
    expect(empty.passed).toBe(false);
    expect(empty.result.items).toHaveLength(2);
    const stale = rows.find((r) => r.def.id === "stale-index")!;
    expect(stale.passed).toBe(true);
    expect(rows).toHaveLength(LISTED.length);
  });

  it("never lists leftover edit history: the app reclaims it on its own", () => {
    const checks: VaultChecks = {
      computedAt: 1,
      results: [{ id: "orphan-history", count: 18, bytes: 4_200_000, items: [] }],
    };
    expect(checkRows(checks).some((r) => r.def.id === "orphan-history")).toBe(false);
    expect(summarizeChecks(checkRows(checks)).headline).toBe(`All ${LISTED.length} checks passed`);
    expect(withoutAutomaticChecks(checks).results).toEqual([]);
  });
});

describe("summarizeChecks", () => {
  const failing = (ids: VaultCheckId[]): VaultChecks => ({
    computedAt: 1,
    results: ids.map((id) => ({ id, count: 1, items: [{ path: "x" }] })),
  });

  it("says all passed when nothing fails", () => {
    const s = summarizeChecks(checkRows(null));
    expect(s.headline).toBe(`All ${LISTED.length} checks passed`);
    expect(s.errors + s.warnings + s.infos).toBe(0);
  });

  it("counts failures by the definition's severity", () => {
    const s = summarizeChecks(
      checkRows(failing(["case-collisions", "bad-frontmatter", "trash", "empty-notes"])),
    );
    expect(s.errors).toBe(1);
    expect(s.warnings).toBe(1);
    expect(s.infos).toBe(2);
    expect(s.headline).toBe("2 checks need a look · 2 housekeeping");
  });

  it("calls housekeeping-only failures out separately from problems", () => {
    const s = summarizeChecks(checkRows(failing(["trash"])));
    expect(s.errors + s.warnings).toBe(0);
    expect(s.headline).toBe(
      `${LISTED.length - 1} of ${LISTED.length} checks passed · 1 housekeeping`,
    );
  });

  it("uses the singular for one problem", () => {
    const s = summarizeChecks(checkRows(failing(["unreadable-notes"])));
    expect(s.headline).toBe("1 check needs a look");
  });
});
