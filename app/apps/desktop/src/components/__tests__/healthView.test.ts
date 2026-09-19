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
import { CHECK_DEFINITIONS } from "../../lib/health/checks";
import { localAttachmentPresence } from "../../lib/health/useVaultHealth";

function actions(): HealthActions {
  return {
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
    reclaim: vi.fn(async () => {}),
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
  attachments: { count: 0, bytes: 0 },
  otherFiles: { count: 0, bytes: 0 },
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

const render = (s: VaultHealthSnapshot) =>
  renderToStaticMarkup(createElement(HealthView, { snapshot: s }));

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
    expect(html).toContain("Local only");
    expect(html).toContain("Sync is off for this folder");
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

  it("keeps the overview to four useful metrics", () => {
    const html = render(snapshot());
    expect((html.match(/class="health-metric"/g) ?? []).length).toBe(4);
    expect(html).toContain("Total items");
    expect(html).toContain("Stored locally");
    expect(html.indexOf("health-metrics")).toBeLessThan(html.indexOf("health-verdict"));
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
    expect(html).toContain("6 item paths differ");
    expect(html).toContain("Review differences");
    expect(html).toContain("9 of 12 notes have confirmed content on the Remote Vault");
    expect(html).toContain("Current Remote Vault view");
    expect(html).not.toMatch(/\bserver\b/i);
  });

  it("labels an offline server inventory as cached", () => {
    const html = render(
      snapshot({
        report: { ...localReport, verdict: "offline", counts: { total: 12, synced: 12, pending: 0, failed: 0, unsynced: 0, unreported: 0 } },
        inventory: {
          local: { notes: 12, folders: 3, files: 4, total: 19 },
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
    expect(html).toContain("The same item paths are present in both places");
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

describe("HealthView — verdict details", () => {
  it("sets the server host as a chip instead of ending a sentence in it", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          verdict: "healthy",
          detail: "Last confirmed 2 minutes ago · api.baalda.com.",
          serverHost: "api.baalda.com",
        },
      }),
    );
    expect(html).toContain('class="health-host"');
    expect(html).toContain("Last confirmed 2 minutes ago.");
    expect(html).not.toContain("ago · api.baalda.com");
  });
});

describe("HealthView — checks", () => {
  it("says so when the checks are not available", () => {
    const html = render(snapshot());
    expect(html).toContain("Checks are not available for this vault.");
  });

  it("renders every check and summarises them", () => {
    const html = render(snapshot({ checks: allPassing() }));
    for (const def of CHECK_DEFINITIONS) expect(html).toContain(def.label);
    expect(html).toContain(`All ${CHECK_DEFINITIONS.length} checks passed`);
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
    expect(html).toContain("1 not run");
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
    // One check failing, and it is housekeeping rather than a fault.
    expect(html).toContain("housekeeping");
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
        onRefresh: vi.fn(),
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

  it("keeps the reasoning collapsed until the row is opened", () => {
    const html = renderIssues();
    expect(html).toContain("Too large to sync");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Where your content is");
    expect(html).not.toContain(explanation.meaning);
  });

  it("lays out the whole argument once the row is open", () => {
    const html = renderIssues({ focusKey: "doc-9" });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("What this means");
    expect(html).toContain(explanation.meaning);
    expect(html).toContain("What Baalda does next");
    expect(html).toContain(explanation.next);
    expect(html).toContain("What you can do");
    for (const fix of explanation.fixes) expect(html).toContain(fix);
    // Where the content is, in the model's own words — never re-derived here.
    expect(html).toContain("Where your content is");
    expect(html).toContain("On this device only");
    // And the facts table, with a copy button on the copyable row.
    expect(html).toContain("Doc id");
    expect(html).toContain("doc-9");
    expect(html).toContain("Copy Doc id");
  });

  it("tags a row by whether it will fix itself, inside the panel", () => {
    // The collapsed row is dot, title, path, one line of why and one button.
    // The tag belongs to "what Baalda does next", so it lives with it.
    expect(renderIssues()).not.toContain("Needs you");
    expect(renderIssues({ focusKey: "doc-9" })).toContain("Needs you");
    expect(
      renderIssues({ issues: [{ ...issue, autoRetries: true }], focusKey: "doc-9" }),
    ).toContain("Retries by itself");
  });

  it("keeps the collapsed row to one line of cause and one button", () => {
    const html = renderIssues();
    // The primary remedy only — the rest of the row's buttons are in the panel.
    expect(html).toContain("Reset history");
    expect(html).not.toContain("Copy details");
    expect(html).toContain('class="health-issue-badge"');
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
    expect(html).toContain("Too large");
    expect(html).toContain("Not uploaded yet");
    expect(html).toContain("Errors");
    expect(html).toContain("Warnings");
  });

  it("calms down to a single card when there is nothing to report", () => {
    const html = renderIssues({ issues: [] });
    expect(html).toContain("Nothing needs attention");
    expect(html).toContain("Every note the Remote Vault knows about is confirmed");
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
