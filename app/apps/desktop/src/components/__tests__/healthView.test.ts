// A render smoke test for the Health page.
//
// React Testing Library is NOT a dependency of this workspace and adding one
// was out of scope, so this drives the page through `react-dom/server` instead:
// no DOM, no store, no Tauri host — exactly the reason the tab was split into a
// container and a pure view. It is written in `.ts` with `createElement` rather
// than `.tsx` because `vitest.config.ts` includes only `src/**/*.test.ts`; a
// `.tsx` suite here would never run.
//
// What it is for: the page is fed by a Rust census, a set of Rust checks and a
// sync-layer fold, and the states that break a renderer are the empty ones — a
// vault with no stats, no counts, no issues and no files. Those are the
// fixtures below. The sections that only exist once something is EXPANDED are
// driven directly (`HealthIssues` with a focus key, `InspectionCard` with a
// result), because a static render runs no effects and dispatches no clicks.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HealthView } from "../HealthTab";
import { HealthIssues } from "../HealthIssues";
import { InspectionCard } from "../HealthInspector";
import { HealthTimeline } from "../HealthTimeline";
import { HealthChecks } from "../HealthChecks";
import type { HealthHandlers } from "../HealthShared";
import { checkActionPlans } from "../../lib/health/checkActions";
import { checkRows } from "../../lib/health/checks";
import type {
  HealthActions,
  HealthExplanation,
  HealthIssue,
  HealthReport,
  NoteInspection,
  SyncLogEntry,
  VaultChecks,
  VaultHealthSnapshot,
  VaultStats,
} from "../../lib/health/types";
import { AUTOMATIC_CHECK_IDS, CHECK_DEFINITIONS } from "../../lib/health/checks";
import { localAttachmentPresence } from "../../lib/health/useVaultHealth";

function actions(): HealthActions {
  return {
    downloadFiles: vi.fn(async () => {}),
    removeServerFile: vi.fn(async () => {}),
    retryLocalFiles: vi.fn(async () => {}),
    deleteLocalFiles: vi.fn(async () => ({ deleted: [], failed: [] })),
    syncNow: vi.fn(async () => {}),
    retryDoc: vi.fn(async () => {}),
    resetHistory: vi.fn(async () => ({ bytesFreed: 0 })),
    reclaimOrphans: vi.fn(async () => ({ docsRemoved: 0, bytesReclaimed: 0 })),
    openNote: vi.fn(),
    reveal: vi.fn(async () => {}),
    deleteNote: vi.fn(async () => {}),
    openUpgrade: vi.fn(),
    requestSignIn: vi.fn(),
    copyDiagnostics: vi.fn(async () => ""),
    exportCopy: vi.fn(async () => null),
    copyIssue: vi.fn(async () => ""),
    reregister: vi.fn(async () => {}),
    contactOwner: vi.fn(async () => ({ owner: null, message: "" })),
    openAccess: vi.fn(),
    inspectNote: vi.fn(
      async (path: string): Promise<NoteInspection> => ({
        path,
        exists: false,
        docId: null,
        state: null,
        pushed: false,
        queued: false,
        diverged: false,
        permanentFailure: null,
        emptyEverywhere: false,
        bytes: null,
        mtime: null,
        historyBytes: null,
        verdict: "No file at that path.",
        issue: null,
      }),
    ),
    emptyTrash: vi.fn(async () => ({ filesRemoved: 0, bytesFreed: 0 })),
    rebuildIndex: vi.fn(async () => {}),
    applyCheckAction: vi.fn(async (plan) => ({
      action: plan.action,
      done: 0,
      total: 0,
      note: null,
      errors: [],
      skipped: [],
      cancelled: false,
    })),
  };
}

function handlers(over: Partial<HealthHandlers> = {}): HealthHandlers {
  return {
    actions: actions(),
    openNote: vi.fn(),
    confirm: vi.fn(),
    runCheck: vi.fn(),
    checkRuns: {},
    now: 1_700_000_000_000,
    ...over,
  };
}

const explanation: HealthExplanation = {
  meaning: "The Remote Vault refused this note because of its size.",
  next: "Nothing — it will not retry until the note is smaller.",
  fixes: ["Split the note in two.", "Move the images into attachments."],
  safety: "only-here",
};

/** The three fields every fixture issue shares, so a test only spells out what
 *  it is actually asserting on. */
const issueBase = {
  explanation,
  facts: [{ label: "Doc id", value: "doc-1", copyable: true }],
  autoRetries: false,
} satisfies Pick<HealthIssue, "explanation" | "facts" | "autoRetries">;

const localReport: HealthReport = {
  verdict: "local",
  headline: "Sync is off for this folder",
  detail: "12 notes live here on this device only.",
  stages: [
    { id: "disk", label: "Files on disk", state: "ok", headline: "12", detail: "d" },
    { id: "index", label: "Local index", state: "ok", headline: "12", detail: "i" },
    { id: "history", label: "Local history", state: "ok", headline: "3", detail: "h" },
    { id: "connection", label: "Connection", state: "off", headline: "Off", detail: "c" },
    { id: "server", label: "Remote Vault", state: "off", headline: "Off", detail: "s" },
  ],
  counts: null,
  issues: [],
  lastSyncedAt: null,
  serverHost: null,
};

const stats: VaultStats = {
  computedAt: 1_700_000_000_000,
  notes: { count: 12, bytes: 4096, empty: 1 },
  folders: 3,
  attachments: { count: 2, bytes: 1024 },
  otherFiles: { count: 4, bytes: 2048 },
  tags: 5,
  links: 9,
  brokenLinks: 2,
  index: { bytes: 65_536, files: 0, extractedTextBytes: 0 },
  history: { docs: 3, updates: 40, bytes: 2048, orphanDocs: 2, orphanBytes: 1024 },
  largestNotes: [{ path: "a/b/big.md", bytes: 12 * 1024 * 1024, mtime: 1_699_000_000_000 }],
  largestFiles: [],
  heaviestHistory: [
    { docId: "doc-1", path: "a/b/big.md", updates: 30, bytes: 1536 },
    { docId: "doc-2", path: null, updates: 10, bytes: 512 },
  ],
  activity: {
    modifiedLast7d: 4,
    modifiedLast30d: 9,
    weeks: [0, 1, 2, 0, 0, 3, 1, 0, 2, 5, 1, 4],
    days: [],
  },
};

function snapshot(over: Partial<VaultHealthSnapshot> = {}): VaultHealthSnapshot {
  return {
    report: localReport,
    inventory: {
      local: { notes: 12, folders: 3, files: 4, total: 19 },
      localReady: true,
      server: null,
      serverState: "unavailable",
      deviceOnlyNotes: [],
      serverOnlyNotes: [],
      deviceOnlyFolders: [],
      serverOnlyFolders: [],
      deviceOnlyFiles: [],
      serverOnlyFiles: [],
    },
    stats,
    statsError: null,
    checks: null,
    log: [],
    loading: false,
    refresh: vi.fn(),
    actions: actions(),
    ...over,
  };
}

const render = (
  s: VaultHealthSnapshot,
  over: Partial<Parameters<typeof HealthView>[0]> = {},
) => renderToStaticMarkup(createElement(HealthView, { snapshot: s, ...over }));

/** Every check reporting zero, so a test only spells out the one it cares
 *  about. Rust always sends all fifteen. */
function allPassing(
  over: Partial<Record<string, VaultChecks["results"][number]>> = {},
): VaultChecks {
  return {
    computedAt: 1_700_000_000_000,
    results: CHECK_DEFINITIONS.map(
      (d) => over[d.id] ?? { id: d.id, count: 0, items: [] },
    ),
  };
}

describe("local attachment detection", () => {
  it("distinguishes hidden attachments, surfaced files, note-only vaults, and unknown reads", () => {
    expect(localAttachmentPresence(1, 0)).toBe(true);
    expect(localAttachmentPresence(0, 1)).toBe(true);
    expect(localAttachmentPresence(0, 0)).toBe(false);
    expect(localAttachmentPresence(null, 0)).toBeNull();
    expect(localAttachmentPresence(0, null)).toBeNull();
  });
});

describe("HealthView", () => {
  it("renders a local vault without a sync breakdown", () => {
    const html = render(snapshot());
    expect(html).toContain("Sync is off for this vault.");
    expect(html).toContain("Nothing needs attention");
    // No bar, because there are no counts to put in it.
    expect(html).not.toContain("health-bar-seg");
    // And "Sync now" is dead on a folder with nothing to sync to.
    expect(html).toContain("This folder does not sync");
    expect(html).toContain("disabled");
    // A local vault's empty state says why there is nothing to report.
    expect(html).toContain("Sync is off, so there is nothing to report here");
  });

  it("survives a vault with no census at all", () => {
    const html = render(snapshot({ stats: null, loading: true }));
    expect(html).toContain("is-skeleton");
    expect(html).not.toContain(">Largest<");
  });

  it("shows a stats error inline", () => {
    const html = render(snapshot({ stats: null, loading: false, statsError: "no vault" }));
    expect(html).toContain("no vault");
  });

  it("badges a note over the server's cap", () => {
    const html = render(snapshot());
    expect(html).toContain("over the limit");
    expect(html).toContain("12.0 MB");
  });

  it("counts only text notes as Notes and every other format as Files", () => {
    const html = render(
      snapshot({
        // The raw census intentionally disagrees with the surfaced tree: it
        // also sees unsupported files and folders under hidden attachments/.
        // The comparison must use the supported tree counts below.
        stats: {
          ...stats,
          folders: 9,
          otherFiles: { count: 99, bytes: stats.otherFiles.bytes },
        },
      }),
    );
    // The stat strip is gone; the comparison card carries the numbers.
    expect(html).not.toContain("health-metric");
    // 12 text notes — NOT 12 + 4 standalone files.
    expect(html).toContain('class="health-place-primary">12</strong>');
    expect(html).not.toContain('class="health-place-primary">16</strong>');
    expect(html).toContain(
      '<dt title="PDFs, images, data, and other supported files">Files</dt><dd>4</dd>',
    );
    expect(html).toContain("<dt>Folders</dt><dd>3</dd>");
    expect(html).not.toContain("Other formats");
    expect(html).not.toContain("<dd>9</dd>");
  });

  it("measures Files & attachments on the same basis on both cards", () => {
    const inventory = {
      ...snapshot().inventory,
      server: { notes: 12, folders: 3, files: 4, total: 19 },
      serverState: "current" as const,
    };
    const synced = { ...localReport, verdict: "healthy" as const,
      counts: { total: 12, synced: 12, pending: 0, failed: 0, unsynced: 0, unreported: 0 } };
    // attachments 1024 + other files 2048 = 3 KB; note text, index and
    // history bytes are excluded so a synced vault can match the server.
    const html = render(snapshot({
      report: synced,
      inventory,
      stats: { ...stats, notes: { count: 12, bytes: 9_999_999, empty: 0 } },
      serverStorage: { usedBytes: 3072, limitBytes: null },
    }));
    expect(html.match(/Files &amp; attachments<\/dt><dd>3 KB<\/dd>/g)?.length).toBe(2);

    const capped = render(snapshot({
      report: synced,
      inventory,
      serverStorage: { usedBytes: 3072, limitBytes: 5 * 1024 * 1024 * 1024 },
    }));
    expect(capped).toContain("3 KB of 5.0 GB");

    // Unknown on either side is a dash, never a zero, and never blocks the page.
    const unknown = render(snapshot({ report: synced, inventory, stats: null, serverStorage: null }));
    expect(unknown.match(/Files &amp; attachments<\/dt><dd>—<\/dd>/g)?.length).toBe(2);
    expect(unknown).toContain("Needs attention");
  });

  it("puts Sync now and Refresh beside the page title and drops the status card", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "healthy",
          headline: "All 12 notes are on the Remote Vault",
          detail: "Last confirmed 2 minutes ago · api.baalda.com.",
          counts: { total: 12, synced: 12, pending: 0, failed: 0, unsynced: 0, unreported: 0 },
          serverHost: "api.baalda.com",
        },
      }),
      { title: "Health" },
    );
    expect(html).toMatch(
      /class="health-page-head"><h2 class="settings-section-title">Health<\/h2><div class="health-verdict-actions health-page-actions">.*Sync now.*Refresh/s,
    );
    expect(html).not.toContain("Copy diagnostics");
    expect(html).not.toContain("health-verdict\"");
    expect(html).not.toContain("health-host");
    expect(html).not.toContain("All 12 notes are on the Remote Vault");
    expect(html).not.toContain("Last confirmed");
    expect(html.indexOf("health-page-head")).toBeLessThan(html.indexOf("health-inventory"));
  });

  it("organises advanced diagnostics around clear tools and safe actions", () => {
    const html = render(snapshot({ checks: allPassing() }));
    expect(html).toContain("Advanced diagnostics");
    expect(html).toContain("Run all checks");
    expect(html).toContain("Retry sync");
    expect(html).toContain("Copy report");
    expect(html).toContain("Inspect a note");
    expect(html).toContain("Integrity checks");
    expect(html).toContain("Recent sync activity");
    expect(html).not.toContain("Sync path");
    expect(html).not.toContain("health-pipeline");
    expect(html).toContain(`${CHECK_DEFINITIONS.length} checks passed`);
    expect(html).toContain("Sync retry is unavailable because this vault is local only.");
  });

  it("summarises the number of findings rather than the number of affected checks", () => {
    const html = render(
      snapshot({
        checks: allPassing({
          trash: {
            id: "trash",
            count: 412,
            items: [{ path: "2026-09-16T10-00-00/note.md" }],
          },
        }),
      }),
    );
    expect(html).toContain("412 findings");
    expect(html).not.toContain("1 finding");
  });

  it("separates inventory differences from content confirmation", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "attention",
          counts: {
            total: 12,
            synced: 9,
            pending: 1,
            failed: 0,
            unsynced: 2,
            unreported: 0,
          },
          serverHost: "api.baalda.com",
        },
        inventory: {
          local: { notes: 12, folders: 3, files: 4, total: 19 },
          localReady: true,
          server: { notes: 13, folders: 3, files: 4, total: 20 },
          serverState: "current",
          deviceOnlyNotes: ["Draft.md"],
          serverOnlyNotes: ["Team plan.md", "Archive.md"],
          deviceOnlyFolders: ["Local drafts"],
          serverOnlyFolders: [],
          deviceOnlyFiles: ["diagram.pdf"],
          serverOnlyFiles: ["brief.docx"],
        },
      }),
    );
    // Two groups — where each item lives — not six by type.
    expect(html).toContain("<h4>Only on this computer · 3 items</h4>");
    expect(html).toContain("<h4>Only on the Remote Vault · 3 items</h4>");
    expect((html.match(/health-place-group/g) ?? []).length).toBe(2);
    expect(html).not.toContain("health-inventory-result");
    expect(html).not.toContain("health-difference-breakdown");
    expect(html).not.toContain("Review differences");
    // Notes, then folders, then files, each with its type icon and action.
    const local = html.slice(html.indexOf("Only on this computer"), html.indexOf("Only on the Remote Vault"));
    expect(local.indexOf("Draft.md")).toBeLessThan(local.indexOf("Local drafts"));
    expect(local.indexOf("Local drafts")).toBeLessThan(local.indexOf("diagram.pdf"));
    expect(local).toContain('aria-label="Note"');
    expect(local).toContain('aria-label="Folder"');
    expect(local).toContain('aria-label="File"');
    expect(local.match(/>Open</g)?.length).toBe(1);
    expect(local.match(/>Show</g)?.length).toBe(2);
    const remoteStart = html.indexOf("Only on the Remote Vault");
    const remote = html.slice(remoteStart, html.indexOf("</ul>", remoteStart));
    expect(remote.match(/>Download</g)?.length).toBe(1);
    expect(remote).toContain("Download all");
    expect(remote).toContain("Remove from server");
    expect(remote).not.toContain(">Open<");
    expect(html).toContain('title="Draft.md"');
    expect(html.match(/>Check again</g)?.length).toBe(2);
    // The differences replace the all-clear card.
    expect(html).not.toContain("Nothing needs attention");
    expect(html).toContain("<dt>Folders</dt><dd>3</dd>");
    expect(html).toContain("Current Remote Vault view");
    expect(html).toContain('class="health-place-primary">12</strong>');
    expect(html).toContain('class="health-place-primary">13</strong>');
    // Page copy says "Remote Vault"; the only "server" left is the existing
    // per-file "Remove from server" action, now visible without a toggle.
    expect(html.split("Remove from server").join("")).not.toMatch(/\bserver\b/i);
  });

  it("explains plan-blocked format notes without presenting them as a failed retry", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "healthy",
          headline: "All 6,974 notes are on the Remote Vault",
          counts: {
            total: 6_974,
            synced: 6_974,
            pending: 0,
            failed: 0,
            unsynced: 0,
            unreported: 0,
          },
          serverHost: "api.baalda.com",
        },
        stats: {
          ...stats,
          notes: { count: 6_974, bytes: stats.notes.bytes, empty: 0 },
          otherFiles: { count: 160, bytes: stats.otherFiles.bytes },
        },
        inventory: {
          local: { notes: 6_974, folders: 1, files: 160, total: 7_135 },
          localReady: true,
          server: { notes: 6_974, folders: 1, files: 0, total: 6_975 },
          serverState: "current",
          deviceOnlyNotes: [],
          serverOnlyNotes: [],
          deviceOnlyFolders: [],
          serverOnlyFolders: [],
          deviceOnlyFiles: Array.from({ length: 160 }, (_, i) => `Media/file-${i}.pdf`),
          serverOnlyFiles: [],
        },
      }),
      { standaloneFileSyncBlocked: true, showAttachmentUpgrade: true },
    );

    expect(html).not.toContain(">Healthy<");
    expect(html).not.toContain("All 6,974 notes are on the Remote Vault");
    expect(html).toContain("<h4>Only on this computer · 160 items</h4>");
    expect(html).toContain("PDFs, images and other files need Pro to sync. Notes and folders sync on every plan.");
    expect(html).not.toMatch(/other formats?/i);
    expect(html).toContain("Select all");
    expect(html).not.toContain("Select files");
    expect(html.match(/class="health-pro-tag">Pro</g)?.length).toBe(20);
    expect(html).toContain("Show more (140 remaining)");
    // The container owns the single upgrade CTA in the top attachment banner.
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain(">Check again<");
    expect(html).not.toContain("health-difference-side");
    expect(html).not.toContain("Nothing needs attention");
    expect(html).not.toContain("data-zero");
  });

  it("labels an offline server inventory as cached", () => {
    const html = render(
      snapshot({
        report: { ...localReport, verdict: "offline", counts: { total: 12, synced: 12, pending: 0, failed: 0, unsynced: 0, unreported: 0 } },
        inventory: {
          local: { notes: 12, folders: 3, files: 4, total: 19 },
          localReady: true,
          server: { notes: 12, folders: 3, files: 4, total: 19 },
          serverState: "last-known",
          deviceOnlyNotes: [],
          serverOnlyNotes: [],
          deviceOnlyFolders: [],
          serverOnlyFolders: [],
          deviceOnlyFiles: [],
          serverOnlyFiles: [],
        },
      }),
    );
    expect(html).toContain("Last known Remote Vault view");
    expect(html).toContain("The current Remote Vault contents cannot be confirmed");
    expect(html).toContain("last-known comparison may be out of date");
    expect(html).not.toContain("Notes and folders match");
    expect(html).not.toContain("items Baalda can list");
  });

  const busyInventory = () => ({
    local: { notes: 6974, folders: 1743, files: 0, total: 8717 },
    localReady: true,
    server: { notes: 6974, folders: 1743, files: 0, total: 8717 },
    serverState: "updating" as const,
    deviceOnlyNotes: [], serverOnlyNotes: [], deviceOnlyFolders: [],
    serverOnlyFolders: [], deviceOnlyFiles: [], serverOnlyFiles: [],
  });

  it("does not call a running sync unavailable or flag its placeholders as empty notes", () => {
    const html = render(snapshot({
      report: { ...localReport, verdict: "syncing" },
      stats: { ...stats, notes: { count: 6974, bytes: 4096, empty: 6667 } },
      inventory: busyInventory(),
    }));
    expect(html).toContain("Updating Remote Vault view");
    expect(html).not.toContain("Sync is still updating your local copy");
    expect(html).not.toContain("Counts are provisional until sync finishes");
    expect(html).toContain("Remote counts include only notes you can access");
    expect(html).not.toContain("The Remote Vault is unavailable");
    expect(html).not.toContain("6,667 empty");
    expect(html).not.toContain("Notes and folders match");
  });

  it("only says sync is updating the local copy while a run is actually active", () => {
    const html = render(snapshot({
      report: { ...localReport, verdict: "connecting" },
      inventory: busyInventory(),
    }));
    expect(html).not.toContain("Sync is still updating your local copy");
    expect(html).not.toContain("Counts are provisional until sync finishes");
    expect(html).not.toContain("The Remote Vault is unavailable");
  });

  it("does not invent local counts while the supported-file tree is loading", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "healthy",
          counts: { total: 12, synced: 12, pending: 0, failed: 0, unsynced: 0, unreported: 0 },
        },
        inventory: {
          ...snapshot().inventory,
          local: { notes: 0, folders: 0, files: 0, total: 0 },
          localReady: false,
          server: { notes: 12, folders: 3, files: 4, total: 19 },
          serverState: "current",
        },
      }),
    );

    expect(html).toContain("Still counting notes on this computer");
    expect(html).toContain("supported vault file list is ready");
    expect(html).not.toContain("Notes and folders match");
  });

  it("renders the issue list for a synced vault", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "attention",
          counts: {
            total: 10,
            synced: 6,
            pending: 1,
            failed: 2,
            unsynced: 1,
            unreported: 0,
          },
          serverHost: "api.baalda.com",
          issues: [
            {
              key: "doc-1",
              docId: "doc-1",
              path: "Projects/2026/Research/Interviews/Transcripts/session-seventeen.md",
              kind: "too-large",
              severity: "error",
              title: "Too large to sync",
              why: "This note is 12.4 MB; the Remote Vault accepts up to 10 MB.",
              remedies: ["open", "reveal", "delete"],
              code: null,
              ...issueBase,
            },
          ],
        },
      }),
    );
    expect(html).toContain("Needs attention");
    // The legend chips are the only place these counts appear on screen; the
    // percentage is the bar's accessible name. Saying "6 of 10" above the chips
    // as well was the same number three times on one page.
    expect(html).toContain("Too large to sync");
    // The path is elided in the middle but kept whole in the tooltip.
    expect(html).toContain("…");
    expect(html).toContain(
      'title="Projects/2026/Research/Interviews/Transcripts/session-seventeen.md"',
    );
  });
});

describe("HealthView — checks", () => {
  it("says so when the checks are not available", () => {
    const html = render(snapshot());
    expect(html).toContain("Checks are not available for this vault.");
  });

  it("renders every check without a second summary or rerun control", () => {
    const html = render(snapshot({ checks: allPassing() }));
    for (const def of CHECK_DEFINITIONS) {
      // Leftover history is reclaimed automatically, so it is never listed.
      if (AUTOMATIC_CHECK_IDS.has(def.id)) expect(html).not.toContain(def.label);
      else expect(html).toContain(def.label);
    }
    expect(html).not.toContain(`All ${CHECK_DEFINITIONS.length} checks passed`);
    expect(html).not.toContain("Re-run file checks");
    expect(html).not.toContain("health-checks-head");
    // A passing row still states what was verified.
    expect(html).toContain("Notes whose file is 0 bytes.");
  });

  it("calls a check Rust never reported not-run rather than passed", () => {
    const results = CHECK_DEFINITIONS.filter((d) => d.id !== "broken-links").map((d) => ({
      id: d.id,
      count: 0,
      items: [],
    }));
    const html = render(
      snapshot({ checks: { computedAt: 1_700_000_000_000, results } }),
    );
    expect(html).toContain("Not run");
    expect(html).toContain('data-state="unknown"');
    // Grey and hollow, never the green tick a real pass gets.
    expect(html).toContain("data-hollow");
  });

  it("counts a failing check and offers its bulk action", () => {
    const checks = allPassing({
      trash: {
        id: "trash",
        count: 412,
        bytes: 5 * 1024 * 1024,
        items: [{ path: "2026-09-16T10-00-00/note.md", bytes: 5 * 1024 * 1024 }],
      },
    });
    const html = render(snapshot({ checks }));
    expect(html).toContain("412");
    expect(html).toContain("5.0 MB");
    expect(html).toContain("Empty trash");
    // The individual finding stays visible without a duplicate summary banner.
    expect(html).not.toContain("Re-run file checks");
  });

  it("offers Delete all on a check whose items can all be deleted", () => {
    const checks = allPassing({
      "empty-notes": {
        id: "empty-notes",
        count: 2,
        items: [{ path: "a.md" }, { path: "b.md" }],
      },
    });
    const html = render(snapshot({ checks }));
    expect(html).toContain("Delete all");
    // It is destructive, and it looks it.
    expect(html).toContain("ghost-pill sm danger");
  });

  it("marks a healable check with the heal button and leaves the others alone", () => {
    const checks = allPassing({
      "stale-index": {
        id: "stale-index",
        count: 1,
        items: [{ path: "a.md", docId: "doc-a" }],
      },
      "case-collisions": {
        id: "case-collisions",
        count: 2,
        items: [{ path: "A.md" }, { path: "a.md" }],
      },
    });
    const html = render(snapshot({ checks }));
    expect(html).toContain("health-heal");
    expect(html).toContain("Rebuild index");
    // Case collisions are a judgement call: instructions, no button.
    expect(html).not.toContain("Rename one of the pair</button>");
  });
});

describe("HealthChecks — a running action", () => {
  const failing = {
    computedAt: 1,
    results: [
      { id: "empty-notes" as const, count: 2, items: [{ path: "a.md" }, { path: "b.md" }] },
    ],
  };
  const row = () => checkRows(failing).find((r) => r.def.id === "empty-notes")!;

  const renderChecks = (over: Partial<HealthHandlers>) =>
    renderToStaticMarkup(
      createElement(HealthChecks, {
        checks: failing,
        loading: false,
        handlers: handlers(over),
      }),
    );

  it("says what it is doing while it runs, and disables the buttons", () => {
    const plan = checkActionPlans(row())[0]!;
    const html = renderChecks({
      checkRuns: { "empty-notes": { plan, running: true, done: 1, total: 2, outcome: null } },
    });
    expect(html).toContain("Deleting 1 of 2…");
    expect(html).toContain("disabled");
  });

  it("reports the result on the row, errors and all", () => {
    const plan = checkActionPlans(row())[0]!;
    const html = renderChecks({
      checkRuns: {
        "empty-notes": {
          plan,
          running: false,
          done: 1,
          total: 2,
          outcome: {
            action: "delete-all",
            done: 1,
            total: 2,
            note: null,
            errors: [{ path: "b.md", reason: "no permission" }],
            skipped: [],
            cancelled: false,
          },
        },
      },
    });
    expect(html).toContain("Deleted 1 of 2 · 1 failed");
    expect(html).toContain("no permission");
    expect(html).toContain('data-state="bad"');
  });
});

describe("HealthIssues", () => {
  const issue: HealthIssue = {
    key: "doc-9",
    docId: "doc-9",
    path: "note.md",
    kind: "too-large",
    severity: "error",
    title: "Too large to sync",
    why: "12.4 MB against a 10 MB cap.",
    remedies: ["reset-history", "open", "copy-details"],
    code: null,
    ...issueBase,
  };

  const renderIssues = (over: Partial<Parameters<typeof HealthIssues>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(HealthIssues, {
        issues: [issue],
        handlers: handlers(),
        syncEnabled: true,
        ...over,
      }),
    );

  it("limits the initial issue list while keeping counts and a focused issue available", () => {
    const issues = Array.from({ length: 1950 }, (_, i) => ({ ...issue, key: `item-${i}`, path: `note-${i}.md` }));
    const html = renderIssues({ issues });
    expect(html).toContain("note-99.md");
    expect(html).not.toContain("note-100.md");
    expect(html).toContain("1850 remaining");
    // No filter box, however long the list: groups and paging carry it.
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain("Filter by name or path");
    const focused = renderIssues({ issues, focusKey: "item-1949" });
    expect(focused).toContain("note-1949.md");
    expect(focused).not.toContain("note-100.md");
  });

  it("renders each issue as one line with no expanded reasoning panel", () => {
    // Even a focused row stays one line: no disclosure, no panel.
    for (const html of [renderIssues(), renderIssues({ focusKey: "doc-9" })]) {
      expect(html).toContain("Too large to sync");
      expect(html).toContain("note.md");
      expect(html).not.toContain("aria-expanded");
      expect(html).not.toContain("health-issue-panel");
      expect(html).not.toContain("What this means");
      expect(html).not.toContain("What Baalda does next");
      expect(html).not.toContain("Where your content is");
      expect(html).not.toContain("Copy Doc id");
      expect(html).not.toContain("Needs you");
      expect(html).not.toContain(explanation.meaning);
      // The long why sentence is only a tooltip, not a painted line.
      expect(html).not.toContain('class="health-why"');
    }
  });

  it("shows only the path on a grouped row — the header names the kind", () => {
    const html = renderIssues();
    expect(html).toContain("<h4>1 note too large to sync</h4>");
    expect(html).toMatch(/health-issue-meta"><span class="health-path" title="note\.md">note\.md/);
    expect(html).not.toContain(">Too large to sync<");
    expect(html).not.toContain(" · Too large");
    expect(html).toContain('title="12.4 MB against a 10 MB cap."');
  });

  it("lays out a no-access row as one sentence and a Contact the owner pill", () => {
    const html = renderIssues({
      issues: [{
        ...issue, key: "vault:no-access", kind: "no-access", docId: null, path: null,
        title: "The Remote Vault refused access", remedies: ["contact-owner", "copy-details"],
      }],
    });
    expect(html).toContain("<h4>No access</h4>");
    expect(html).toContain('class="health-issue-sentence">You don&#x27;t have access to this vault</span>');
    expect(html).toMatch(/class="ghost-pill sm"><span class="async-btn-label">Contact the owner/);
    expect(html).not.toContain("health-owner-card");
    expect(html).not.toContain("Request copied");
  });

  it("shows the primary action, a small Copy details and Ignore on the row", () => {
    const html = renderIssues({ onDismiss: () => {} });
    expect(html).toContain("Reset history");
    expect(html).toContain("Copy details");
    expect(html).toContain(">Ignore<");
    expect(html).toContain('class="health-issue-badge"');
    // Open is not the first remedy and not a second-slot action.
    expect(html).not.toContain(">Open<");
  });

  it("offers Re-register beside the primary action on a left-on-disk row", () => {
    const html = renderIssues({
      issues: [{ ...issue, kind: "left-behind", remedies: ["open", "reveal", "reregister", "delete", "copy-details"] }],
    });
    expect(html).toContain(">Open<");
    expect(html).toContain(">Re-register<");
    expect(html).not.toContain(">Delete<");
  });

  it("only offers the remedies an issue actually carries", () => {
    const html = renderIssues({
      issues: [
        {
          ...issue,
          key: "signed-out",
          docId: null,
          path: null,
          kind: "no-access",
          title: "Signed out",
          why: "Nothing syncs until you sign in.",
          remedies: ["sign-in"],
        },
      ],
      focusKey: "signed-out",
    });
    expect(html).toContain("Sign in");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain(">Delete<");
  });

  it("drops a remedy whose data the issue does not carry", () => {
    // `retry` needs a doc id and `open` needs a path. A button that would throw
    // when pressed is worse than no button.
    const html = renderIssues({
      issues: [{ ...issue, docId: null, path: null, remedies: ["retry", "open"] }],
      focusKey: "doc-9",
    });
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain(">Open<");
  });

  it("names the kinds it is filtering by once there is more than one", () => {
    const html = renderIssues({
      issues: [
        issue,
        {
          ...issue,
          key: "doc-10",
          kind: "unregistered",
          severity: "warn",
          title: "Not on the Remote Vault yet",
        },
      ],
    });
    // One group per kind, in the same group shape as the difference lists.
    expect(html).toContain("<h4>1 note too large to sync</h4>");
    expect(html).toContain("<h4>1 note isn&#x27;t registered</h4>");
    expect((html.match(/health-difference-group health-issue-group/g) ?? []).length).toBe(2);
    expect(html).not.toContain("health-chips");
  });

  it("renders differences and issues as one list with a single all-clear", () => {
    const diff = createElement("div", { className: "health-difference-group" }, "diff group");
    const both = renderIssues({ before: diff, hasOtherItems: true });
    expect((both.match(/class="health-attention-list"/g) ?? []).length).toBe(1);
    expect(both.indexOf("diff group")).toBeLessThan(both.indexOf("Too large to sync"));
    expect(both).not.toContain("Nothing needs attention");

    const onlyDiff = renderIssues({ issues: [], before: diff, hasOtherItems: true });
    expect(onlyDiff).toContain("diff group");
    expect(onlyDiff).not.toContain("Nothing needs attention");

    const none = renderIssues({ issues: [] });
    expect((none.match(/Nothing needs attention/g) ?? []).length).toBe(1);
  });

  it("calms down to a single card when there is nothing to report", () => {
    const html = renderIssues({ issues: [] });
    expect(html).toContain("Nothing needs attention");
    expect(html).toContain("No sync errors reported");
  });
});

describe("InspectionCard", () => {
  const base: NoteInspection = {
    path: "Projects/notes/one.md",
    exists: true,
    docId: "doc-7",
    state: "synced",
    pushed: true,
    queued: false,
    diverged: false,
    permanentFailure: null,
    emptyEverywhere: false,
    bytes: 4096,
    mtime: 1_699_999_000_000,
    historyBytes: 2048,
    verdict: "Synced — the Remote Vault confirmed this note's content.",
    issue: null,
  };
  const card = (over: Partial<NoteInspection> = {}) =>
    renderToStaticMarkup(
      createElement(InspectionCard, {
        result: { ...base, ...over },
        handlers: handlers(),
        onShowIssue: vi.fn(),
      }),
    );

  it("leads with the verdict and lays the facts out underneath", () => {
    const html = card();
    expect(html).toContain("Synced — the Remote Vault confirmed this note&#x27;s content.");
    expect(html).toContain("On Remote Vault");
    expect(html).toContain("Waiting to push");
    expect(html).toContain("Has unsent edits");
    expect(html).toContain("History size");
    expect(html).toContain("doc-7");
    expect(html).toContain("4 KB");
    expect(html).toContain("Copy Doc id");
  });

  it("says there is no file rather than reporting a state for one", () => {
    const html = card({ exists: false });
    expect(html).toContain("There is no file at this path.");
    expect(html).not.toContain("On Remote Vault");
  });

  it("points at the issue row when this note has one", () => {
    const html = card({
      issue: {
        key: "doc-7",
        docId: "doc-7",
        path: base.path,
        kind: "upload-failed",
        severity: "error",
        title: "Couldn't upload",
        why: "It did not reach the Remote Vault.",
        remedies: ["retry"],
        code: null,
        ...issueBase,
      },
    });
    expect(html).toContain("See its entry above");
  });
});

describe("HealthTimeline", () => {
  const day = (y: number, m: number, d: number, h: number, min: number) =>
    new Date(y, m, d, h, min, 0).getTime();
  const now = day(2026, 8, 16, 18, 0);

  const log: SyncLogEntry[] = [
    { at: day(2026, 8, 15, 9, 5), level: "info", event: "connect", message: "older line" },
    {
      at: day(2026, 8, 16, 10, 30),
      level: "warn",
      event: "push-failed",
      message: "middle line",
      path: "a/b.md",
    },
    { at: day(2026, 8, 16, 11, 45), level: "error", event: "retry", message: "newest line" },
  ];

  const render = (entries: SyncLogEntry[] = log) =>
    renderToStaticMarkup(
      createElement(HealthTimeline, { log: entries, now, onInspect: vi.fn() }),
    );

  it("groups by day, newest first, and names today and yesterday", () => {
    const html = render();
    expect(html.indexOf("Today")).toBeLessThan(html.indexOf("Yesterday"));
    expect(html.indexOf("newest line")).toBeLessThan(html.indexOf("middle line"));
    expect(html.indexOf("middle line")).toBeLessThan(html.indexOf("older line"));
  });

  it("stamps each line with its clock time and its level", () => {
    const html = render();
    expect(html).toContain("11:45");
    expect(html).toContain("10:30");
    expect(html).toContain('data-level="error"');
    expect(html).toContain('data-level="warn"');
  });

  it("makes a line that names a path clickable", () => {
    const html = render();
    expect(html).toContain('title="Check a/b.md"');
  });

  it("says nothing has happened rather than drawing an empty frame", () => {
    expect(render([])).toContain("Nothing yet this session");
  });
});


it("shows stored private notes without calling the vault empty or missing locally", () => {
  const base = snapshot();
  const html = render(snapshot({
    report: { ...localReport, verdict: "healthy", counts: {
      total: 0, synced: 0, pending: 0, failed: 0, unsynced: 0, unreported: 0,
    } },
    inventory: { ...base.inventory,
      local: { notes: 0, folders: 0, files: 0, total: 0 },
      server: { notes: 0, folders: 0, files: 0, total: 0 },
      serverStored: { notes: 6974, folders: 1743, files: 0, total: 8717 }, serverState: "current",
    },
  }));
  expect(html).toContain("6,974");
  expect(html).toContain("Stored on server");
  expect(html).not.toContain("This vault is empty");
  expect(html).not.toContain("Notes and folders match");
  expect(html).not.toContain("missing from this computer");
});
it("keeps basic Health separate from the relocated diagnostic tools", () => {
  const overview = renderToStaticMarkup(createElement(HealthView, { snapshot: snapshot(), mode: "overview", onOpenDiagnostics: () => {} }));
  expect(overview).not.toContain("Open Smart diagnostics");
  expect(overview).not.toContain("Integrity checks");
  expect(overview).not.toContain("Inspect a note");
  const diagnostics = renderToStaticMarkup(createElement(HealthView, { snapshot: snapshot(), mode: "diagnostics" }));
  expect(diagnostics).toContain("Checks &amp; repair tools");
  expect(diagnostics).toContain("Integrity checks");
  expect(diagnostics).toContain("Inspect a note");
  expect(diagnostics).toContain("Recent sync activity");
  expect(diagnostics).not.toContain("Needs attention");
});
