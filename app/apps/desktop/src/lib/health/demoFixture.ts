// DEV-ONLY: a Health page snapshot that shows every state at once, so the page
// can be reviewed without a vault in every broken shape. Turned on with
// `localStorage["baalda:healthDemo"] = "1"` (or `window.__baaldaHealthDemo(true)`)
// in a dev build; every entry point is guarded by `import.meta.env.DEV`, so a
// production build never reaches it.
//
// The issues are built by the REAL model (`buildHealthReport`) from fake sync
// failures, so the page is exercised with exactly the wording users would see.
// Every action is a console log: nothing here touches disk or a server.

import { CHECK_DEFINITIONS } from "./checks";
import { buildHealthReport, type HealthFailures, type HealthInput } from "./model";
import type {
  HealthActions,
  HealthIssue,
  NoteInspection,
  VaultChecks,
  VaultHealthSnapshot,
  VaultStats,
} from "./types";

export const HEALTH_DEMO_KEY = "baalda:healthDemo";

/** On only in a dev build AND when the storage key is set. `dev` is injectable
 *  for tests; production passes `import.meta.env.DEV`, which Vite folds to
 *  `false` so everything behind it is stripped. */
export function healthDemoEnabled(dev: boolean = import.meta.env.DEV): boolean {
  if (!dev) return false;
  // `VITE_HEALTH_DEMO=1 pnpm run dev:desktop` turns it on without the console.
  if (import.meta.env.VITE_HEALTH_DEMO === "1") return true;
  try {
    return globalThis.localStorage?.getItem(HEALTH_DEMO_KEY) === "1";
  } catch {
    return false;
  }
}

/** `window.__baaldaHealthDemo(true|false)` in dev builds: set the key, reload. */
export function installHealthDemoToggle(dev: boolean = import.meta.env.DEV): void {
  if (!dev || typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__baaldaHealthDemo = (on: boolean) => {
    try {
      if (on) localStorage.setItem(HEALTH_DEMO_KEY, "1");
      else localStorage.removeItem(HEALTH_DEMO_KEY);
    } catch {
      /* storage blocked */
    }
    window.location.reload();
  };
}

const LONG =
  "Clients/Northwind Traders/2026 engagement/Discovery workshops/Session transcripts/" +
  "Week 14 — procurement and vendor onboarding deep dive (unedited).md";

/** Sync failures of every kind the sync layer reports. */
export const DEMO_FAILURES: HealthFailures = {
  limitCode: "note_limit_reached",
  content: [
    { docId: "d-big", relPath: "Research/Interview dump.md", reason: "note exceeds 10 MB", permanent: true, kind: "too-large" },
    { docId: "d-ro", relPath: "Team/Roadmap 2027.md", reason: "no-access", permanent: true, kind: "no-write-access" },
    { docId: "d-slow", relPath: "Journal/2026-09-24.md", reason: "timed out waiting for the server" },
    { docId: "d-ack", relPath: LONG, reason: "server did not acknowledge the content" },
  ],
  registry: [
    { kind: "orphan", path: "Archive/Old pitch.md", docId: "d-o1", reason: "deleted on the server, but this device never confirmed its content — left on disk", code: null },
    { kind: "orphan", path: "Archive/Q1 retro.md", docId: "d-o2", reason: "access was removed, but this device never confirmed its content upstream — left on disk", code: null },
    { kind: "orphan", path: "Drafts/Untitled 7.md", docId: "d-o3", reason: "deleted on the server, but this device never confirmed its content — left on disk", code: null },
    { kind: "note", path: "Inbox/Meeting notes.md", docId: null, reason: "HTTP 500", code: null },
    { kind: "folder", path: "Projects/Launch", docId: null, reason: "HTTP 409", code: "path_folder_mismatch" },
    { kind: "materialize", path: "Shared/Q3 plan.md", docId: "d-m1", reason: "EACCES: permission denied", code: null },
    { kind: "inbound", path: "Shared/Specs/API.md", docId: "d-i1", reason: "rename target exists", code: null },
    { kind: "inbound-blocked", path: "Shared/Budget.md", docId: "d-b1", reason: "refused: the server listing omitted it but the resolver still grants access — left on disk", code: null },
  ],
};

export const DEMO_STATS: VaultStats = {
  computedAt: Date.now(),
  notes: { count: 1_022, bytes: 18_400_000, empty: 76 },
  folders: 64,
  attachments: { count: 212, bytes: 348_000_000 },
  otherFiles: { count: 41, bytes: 107_200_000 },
  tags: 88,
  links: 3_410,
  brokenLinks: 12,
  index: { bytes: 42_000_000, files: 0, extractedTextBytes: 0 },
  history: { docs: 1_040, updates: 88_000, bytes: 96_000_000, orphanDocs: 18, orphanBytes: 4_200_000 },
  largestNotes: [{ path: "Research/Interview dump.md", bytes: 12 * 1024 * 1024, mtime: Date.now() - 86_400_000 }],
  largestFiles: [{ path: "Media/Launch video.mp4", bytes: 88_000_000, mtime: Date.now() - 3 * 86_400_000 }],
  heaviestHistory: [{ docId: "d-big", path: "Research/Interview dump.md", updates: 9_000, bytes: 22_000_000 }],
  activity: { modifiedLast7d: 41, modifiedLast30d: 180, weeks: [3, 5, 8, 2, 9, 12, 4, 7, 10, 6, 11, 14], days: [] },
};

function demoInput(over: Partial<HealthInput> = {}): HealthInput {
  const mapped = ["Research/Interview dump.md", "Team/Roadmap 2027.md", "Journal/2026-09-24.md", LONG];
  return {
    syncEnabled: true,
    syncStatus: "synced",
    authStatus: "signed-in",
    hasSession: true,
    openFolderIsSynced: true,
    syncProgress: null,
    lastSyncedAt: Date.now() - 5 * 60_000,
    serverUrl: "https://api.baalda.com",
    now: Date.now(),
    docIdByPath: Object.fromEntries(mapped.map((p, i) => [p, `d-map-${i}`])),
    docSyncState: {},
    // Two notes with no mapping and no failure ⇒ "Not on the Remote Vault yet".
    localNotePaths: [...mapped, "Ideas/Half-baked.md", "Ideas/Someday.md"],
    failures: DEMO_FAILURES,
    stats: DEMO_STATS,
    members: [{ role: "owner", user: { name: "Vault Owner", email: "owner@example.com" } }],
    ...over,
  };
}

/** The report, from the real model. `no-access` needs a refused socket, which
 *  rules out every other server-answered kind, so it comes from a second pass. */
export function buildDemoReport(): VaultHealthSnapshot["report"] {
  const report = buildHealthReport(demoInput());
  const denied = buildHealthReport(demoInput({ syncStatus: "no-access" }))
    .issues.filter((i) => i.kind === "no-access");
  const issues: HealthIssue[] = [...report.issues, ...denied];
  return { ...report, issues };
}

function demoChecks(): VaultChecks {
  return {
    computedAt: Date.now(),
    results: CHECK_DEFINITIONS.map((d) =>
      d.id === "empty-notes"
        ? { id: d.id, count: 3, items: [{ path: "Inbox/Untitled.md" }, { path: "Daily/2026-09-20.md" }, { path: LONG }] }
        : { id: d.id, count: 0, items: [] },
    ),
  };
}

/** Every action logs and resolves; nothing reaches disk or the server. */
function demoActions(): HealthActions {
  const log = (name: string) => (...args: unknown[]) => {
    console.info(`[health demo] ${name}`, ...args);
  };
  const logAsync = (name: string) => async (...args: unknown[]) => {
    log(name)(...args);
  };
  return {
    downloadFiles: logAsync("downloadFiles"),
    removeServerFile: logAsync("removeServerFile"),
    retryLocalFiles: logAsync("retryLocalFiles"),
    async deleteLocalFiles(paths) { log("deleteLocalFiles")(paths); return { deleted: [], failed: [] }; },
    syncNow: logAsync("syncNow"),
    retryDoc: logAsync("retryDoc"),
    async resetHistory(docId) { log("resetHistory")(docId); return { bytesFreed: 0 }; },
    async reclaimOrphans() { log("reclaimOrphans")(); return { docsRemoved: 0, bytesReclaimed: 0 }; },
    openNote: log("openNote"),
    reveal: logAsync("reveal"),
    deleteNote: logAsync("deleteNote"),
    openUpgrade: log("openUpgrade"),
    requestSignIn: log("requestSignIn"),
    async copyDiagnostics() { log("copyDiagnostics")(); return ""; },
    async exportCopy(path) { log("exportCopy")(path); return null; },
    async copyIssue(issue) { log("copyIssue")(issue.key); return ""; },
    reregister: logAsync("reregister"),
    async contactOwner() { log("contactOwner")(); return { owner: null, message: "" }; },
    openAccess: log("openAccess"),
    async inspectNote(path): Promise<NoteInspection> {
      log("inspectNote")(path);
      return {
        path, exists: true, docId: null, state: null, pushed: false, queued: false,
        diverged: false, permanentFailure: null, emptyEverywhere: false, bytes: null,
        mtime: null, historyBytes: null, verdict: "Demo data — nothing was inspected.", issue: null,
      };
    },
    async emptyTrash() { log("emptyTrash")(); return { filesRemoved: 0, bytesFreed: 0 }; },
    rebuildIndex: logAsync("rebuildIndex"),
    async applyCheckAction(plan) {
      log("applyCheckAction")(plan.checkId);
      return { action: plan.action, done: 0, total: 0, note: null, errors: [], skipped: [], cancelled: false };
    },
  };
}

export function demoSnapshot(): VaultHealthSnapshot {
  return {
    report: buildDemoReport(),
    inventory: {
      local: { notes: 1_022, folders: 64, files: 41, total: 1_127 },
      localReady: true,
      server: { notes: 1_019, folders: 63, files: 30, total: 1_112 },
      serverState: "current",
      // Half-baked / Someday / LONG also carry issues, so the page lists them
      // under the issue only (`dedupeDifferences`); the rest stay in the group.
      deviceOnlyNotes: [
        "Ideas/Half-baked.md", "Ideas/Someday.md", LONG,
        "Scratch/Call notes.md", "Scratch/Reading list.md",
        "Clients/Northwind Traders/2026 engagement/Discovery workshops/Follow-ups for the finance, legal and procurement teams.md",
      ],
      serverOnlyNotes: ["Team/Offsite agenda.md", "Team/Hiring plan.md", "Clients/Contoso/Kickoff.md"],
      deviceOnlyFolders: ["Ideas", "Scratch/Local only", "Clients/Northwind Traders/2026 engagement"],
      serverOnlyFolders: ["Team/Offsite", "Clients/Contoso", "Clients/Contoso/Contracts"],
      deviceOnlyFiles: ["Media/Launch video.mp4", "Media/Wireframes.fig.pdf", "Finance/Forecast.xlsx", "Media/Team photo.jpg"],
      serverOnlyFiles: ["Clients/Contoso/Contract.pdf", "Team/Org chart.png", "Finance/Q3 actuals.csv"],
    },
    hasLocalAttachments: true,
    stats: DEMO_STATS,
    serverStorage: { usedBytes: 402_000_000, limitBytes: 1024 * 1024 * 1024 },
    statsError: null,
    checks: demoChecks(),
    loading: false,
    log: [],
    refresh: () => console.info("[health demo] refresh"),
    actions: demoActions(),
  };
}
