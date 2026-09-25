// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  HEALTH_DEMO_KEY,
  buildDemoReport,
  demoSnapshot,
  healthDemoEnabled,
} from "../demoFixture";
import { actionNeededCount } from "../attention";
import { DEMO_FAILURES } from "../demoFixture";
import type { HealthIssueKind } from "../types";

const EVERY_KIND: HealthIssueKind[] = [
  "too-large",
  "no-write-access",
  "upload-failed",
  "register-failed",
  "limit",
  "unregistered",
  "no-access",
  "left-behind",
  "materialize-failed",
  "inbound-blocked",
];

afterEach(() => localStorage.clear());

describe("Health demo fixture", () => {
  it("builds a report through the real model with every issue kind", () => {
    const report = buildDemoReport();
    const kinds = new Set(report.issues.map((i) => i.kind));
    for (const kind of EVERY_KIND) expect(kinds, kind).toContain(kind);
    expect(report.issues.filter((i) => i.kind === "left-behind")).toHaveLength(3);
    // Leftover history is reclaimed automatically and never listed.
    expect(kinds.has("orphan-history")).toBe(false);
  });

  it("populates every difference group, both cards and a capped server size", () => {
    const s = demoSnapshot();
    for (const list of [
      s.inventory.deviceOnlyNotes, s.inventory.serverOnlyNotes,
      s.inventory.deviceOnlyFolders, s.inventory.serverOnlyFolders,
      s.inventory.deviceOnlyFiles, s.inventory.serverOnlyFiles,
    ]) expect(list.length).toBeGreaterThanOrEqual(3);
    expect(s.serverStorage?.limitBytes).not.toBeNull();
    expect(s.checks?.results.find((r) => r.id === "empty-notes")?.count).toBeGreaterThan(0);
    expect(actionNeededCount(DEMO_FAILURES)).toBe(5);
  });

  it("never switches on outside a dev build", () => {
    localStorage.setItem(HEALTH_DEMO_KEY, "1");
    expect(healthDemoEnabled(false)).toBe(false);
    expect(healthDemoEnabled(true)).toBe(true);
    localStorage.removeItem(HEALTH_DEMO_KEY);
    expect(healthDemoEnabled(true)).toBe(false);
  });
});

import { dedupeDifferences } from "../attention";

describe("Health demo fixture after dedupe", () => {
  it("still fills every difference group and never repeats an issue path", () => {
    const s = demoSnapshot();
    const inv = dedupeDifferences(s.inventory, s.report.issues);
    const issuePaths = new Set(s.report.issues.map((i) => i.path?.toLowerCase()).filter(Boolean));
    for (const list of [
      inv.deviceOnlyNotes, inv.serverOnlyNotes, inv.deviceOnlyFolders,
      inv.serverOnlyFolders, inv.deviceOnlyFiles, inv.serverOnlyFiles,
    ]) {
      expect(list.length).toBeGreaterThanOrEqual(3);
      for (const p of list) expect(issuePaths.has(p.toLowerCase())).toBe(false);
    }
  });
});
