// A registry pull that keeps failing: no new note or folder can register while
// edits to existing notes keep syncing. Said once, for the whole vault.

import { describe, expect, it } from "vitest";
import { buildHealthReport, PULL_FAILED_ISSUE_KEY, type HealthInput } from "../model";

const NOW = 1_700_000_000_000;

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    syncEnabled: true,
    syncStatus: "synced",
    authStatus: "signed-in",
    hasSession: true,
    openFolderIsSynced: true,
    syncProgress: null,
    lastSyncedAt: NOW - 120_000,
    serverUrl: "https://api.baalda.com",
    now: NOW,
    docIdByPath: {},
    docSyncState: {},
    localNotePaths: [],
    failures: { registry: [], content: [], limitCode: null },
    stats: null,
    ...over,
  };
}

describe("Health — a failing registry pull", () => {
  it("is one vault-wide error issue in plain words, with the last error", () => {
    const report = buildHealthReport(
      input({
        failures: {
          registry: [
            { kind: "pull", path: "", docId: null, reason: "HTTP 502", code: "registry_pull_failed" },
          ],
          content: [],
          limitCode: null,
        },
      }),
    );
    const issues = report.issues.filter((i) => i.key === PULL_FAILED_ISSUE_KEY);
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue.severity).toBe("error");
    expect(issue.path).toBeNull();
    expect(issue.title).toBe("New notes and folder changes aren't syncing");
    expect(issue.why).toContain("can't load the vault's file list (last error: HTTP 502)");
    expect(issue.why).toContain("Edits to existing notes still sync.");
    expect(issue.facts.some((f) => f.label === "Last error" && f.value === "HTTP 502")).toBe(true);
  });

  it("is absent when no pull is failing", () => {
    const report = buildHealthReport(input());
    expect(report.issues.some((i) => i.key === PULL_FAILED_ISSUE_KEY)).toBe(false);
  });
});
