// Creates refused for access, as the user sees them: grouped by reason + folder
// (one Health issue with a count and the file list, not one row per file), and
// the vault-level banner that says so in plain words.

import { describe, expect, it } from "vitest";
import { buildHealthReport, createRefusalIssueKey, type HealthInput, type HealthRegistryFailure } from "../model";
import {
  createRefusalBannerText,
  groupCreateRefusals,
} from "../../sync/createRefusals";
import { createRefusalBanner } from "../../../components/CreateRefusalBanner";

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

const refused = (path: string, code: string | null, kind: HealthRegistryFailure["kind"] = "note"): HealthRegistryFailure => ({
  kind,
  path,
  docId: `id-${path}`,
  reason: "403: Forbidden",
  code,
});

describe("groupCreateRefusals", () => {
  it("groups by code and folder, largest first", () => {
    const groups = groupCreateRefusals([
      refused("Reports/a.md", "no_write_access"),
      refused("Reports/b.md", "no_write_access"),
      refused("Daily/x.md", "no_write_access"),
      refused("top.md", "root_frozen"),
      refused("other.md", "note_deleted"),
      refused("gen.md", null),
      refused("Reports/c.md", "no_write_access", "materialize"),
    ]);
    expect(groups).toEqual([
      { code: "no_write_access", folder: "Reports", paths: ["Reports/a.md", "Reports/b.md"], notes: 2 },
      { code: "no_write_access", folder: "Daily", paths: ["Daily/x.md"], notes: 1 },
      { code: "root_frozen", folder: "", paths: ["top.md"], notes: 1 },
    ]);
  });

  it("lists a path once even when reported twice", () => {
    const groups = groupCreateRefusals([
      refused("Reports/a.md", "no_write_access"),
      refused("reports/A.md", "no_write_access"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].paths).toHaveLength(1);
  });
});

describe("create-refusal banner", () => {
  it("names the folder and asks for edit access", () => {
    const text = createRefusalBannerText(
      groupCreateRefusals([refused("Reports/a.md", "no_write_access"), refused("Reports/b.md", "no_write_access")]),
    );
    expect(text).toEqual({
      lead: "2 new notes on this computer aren't syncing.",
      detail: "You don't have permission to add notes in Reports. Ask an owner to give you edit access.",
    });
  });

  it("says 'at the top of this vault' for the root", () => {
    const text = createRefusalBannerText(groupCreateRefusals([refused("a.md", "no_write_access")]));
    expect(text?.lead).toBe("1 new note on this computer isn't syncing.");
    expect(text?.detail).toContain("at the top of this vault");
  });

  it("is up only while a refusal stands, and Dismiss silences this run", () => {
    const refusals = [refused("Reports/a.md", "no_write_access")];
    expect(createRefusalBanner({ syncEnabled: true, refusals, runToken: 3, dismissedRunToken: null })).not.toBeNull();
    expect(createRefusalBanner({ syncEnabled: true, refusals: [], runToken: 3, dismissedRunToken: null })).toBeNull();
    expect(createRefusalBanner({ syncEnabled: false, refusals, runToken: 3, dismissedRunToken: null })).toBeNull();
    expect(createRefusalBanner({ syncEnabled: true, refusals, runToken: 3, dismissedRunToken: 3 })).toBeNull();
    expect(createRefusalBanner({ syncEnabled: true, refusals, runToken: 4, dismissedRunToken: 3 })).not.toBeNull();
    // Codes that are not access refusals never raise it.
    expect(
      createRefusalBanner({ syncEnabled: true, refusals: [refused("x.md", "note_deleted")], runToken: 1, dismissedRunToken: null }),
    ).toBeNull();
  });
});

describe("Health — creates refused for access", () => {
  it("is one issue per folder with a count and the file list", () => {
    const report = buildHealthReport(
      input({
        failures: {
          registry: [
            refused("Reports/a.md", "no_write_access"),
            refused("Reports/b.md", "no_write_access"),
            refused("Daily/x.md", "no_write_access"),
            refused("top.md", "root_frozen"),
          ],
          content: [],
          limitCode: null,
        },
      }),
    );
    const grouped = report.issues.filter((i) => i.key.startsWith("create-refused:"));
    expect(grouped.map((i) => i.key).sort()).toEqual(
      [
        createRefusalIssueKey("no_write_access", "Reports"),
        createRefusalIssueKey("no_write_access", "Daily"),
        createRefusalIssueKey("root_frozen", ""),
      ].sort(),
    );
    // No per-file rows on top of the groups.
    expect(report.issues.filter((i) => i.path === "Reports/a.md")).toEqual([]);
    const reports = grouped.find((i) => i.key === createRefusalIssueKey("no_write_access", "Reports"))!;
    expect(reports.title).toBe("2 new notes not syncing: no permission to add notes in Reports");
    expect(reports.facts.filter((f) => f.label === "Path").map((f) => f.value)).toEqual([
      "Reports/a.md",
      "Reports/b.md",
    ]);
    expect(reports.remedies).toContain("contact-owner");
    expect(reports.autoRetries).toBe(true);
  });

  it("keeps other registry failures as their own rows", () => {
    const report = buildHealthReport(
      input({
        failures: {
          registry: [refused("gone.md", "note_deleted"), refused("Reports/a.md", "no_write_access")],
          content: [],
          limitCode: null,
        },
      }),
    );
    expect(report.issues.some((i) => i.path === "gone.md" && i.code === "note_deleted")).toBe(true);
    expect(report.issues.some((i) => i.key === createRefusalIssueKey("no_write_access", "Reports"))).toBe(true);
  });
});
