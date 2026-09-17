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
import type { HealthHandlers } from "../HealthShared";
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
  };
}

function handlers(): HealthHandlers {
  return {
    actions: actions(),
    openNote: vi.fn(),
    confirm: vi.fn(),
    reclaim: vi.fn(async () => {}),
    now: 1_700_000_000_000,
  };
}

const explanation: HealthExplanation = {
  meaning: "The server refused this note because of its size.",
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
    { id: "server", label: "Server", state: "off", headline: "Off", detail: "s" },
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

  it("offers a reclaim button while orphan history exists", () => {
    const html = render(snapshot());
    expect(html).toContain("reclaimable");
    expect(html).toContain("Reclaim");
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
              why: "This note is 12.4 MB; the server accepts up to 10 MB.",
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

describe("HealthView — the pipeline", () => {
  const count = (html: string) => (html.match(/class="health-node"/g) ?? []).length;

  it("shows three cards while the local stages are fine", () => {
    // Nobody opens this page to be told the index has twelve rows. The index
    // and history stages stay out of the way until they are the problem.
    const html = render(snapshot());
    expect(count(html)).toBe(3);
    expect(html).toContain("Files on disk");
    expect(html).toContain("Connection");
    // The model's word is "Server"; the page's is the reader's own vault.
    expect(html).toContain("Remote vault");
    expect(html).not.toContain(">Local index<");
    expect(html).not.toContain(">Local history<");
  });

  it("expands to five, in order, when a local stage needs attention", () => {
    const html = render(
      snapshot({
        report: {
          ...localReport,
          stages: localReport.stages.map((s) =>
            s.id === "index" || s.id === "history" ? { ...s, state: "warn" as const } : s,
          ),
        },
      }),
    );
    expect(count(html)).toBe(5);
    expect(html).toContain("Local index");
    expect(html).toContain("Local history");
    // Surfaced deliberately, and it says so.
    expect(html).toContain("shown because it needs attention");
    expect(html).toContain("data-conditional");
    // Natural position: disk, then index, then history, then connection.
    expect(html.indexOf("Files on disk")).toBeLessThan(html.indexOf("Local index"));
    expect(html.indexOf("Local index")).toBeLessThan(html.indexOf("Local history"));
    expect(html.indexOf("Local history")).toBeLessThan(html.indexOf(">Connection<"));
  });

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
          title: "Not on the server yet",
        },
      ],
    });
    expect(html).toContain("Too large");
    expect(html).toContain("Not on server yet");
    expect(html).toContain("Errors");
    expect(html).toContain("Warnings");
  });

  it("calms down to a single card when there is nothing to report", () => {
    const html = renderIssues({ issues: [] });
    expect(html).toContain("Nothing needs attention");
    expect(html).toContain("Every note the server knows about is confirmed");
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
    verdict: "Synced — the server confirmed this note's content.",
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
    expect(html).toContain("Synced — the server confirmed this note&#x27;s content.");
    expect(html).toContain("On server");
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
    expect(html).not.toContain("On server");
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
        why: "It did not reach the server.",
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
