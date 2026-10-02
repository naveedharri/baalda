import { describe, expect, it } from "vitest";
import {
  isSyncRunActive,
  syncBadgeAction,
  syncBadgeHold,
  syncBadgeLabel,
  syncBadgeTone,
  syncRunPercent,
} from "../Identity";
import type { SyncProgress } from "../../lib/sync/vaultScope";

// The sync pill is the user-facing "is my work safe?" signal. These lock in the
// fix for the bug where it drifted to "Synced · 5m ago" while actively editing:
// pending edits must read "Syncing…", and a fresh flush must read "just now".
describe("syncBadgeLabel", () => {
  const now = 1_000_000_000_000;

  it("counts remaining access cleanup even while the open note is denied", () => {
    const progress: SyncProgress = { phase: "removing", done: 64, total: 130, failed: 0 };
    expect(syncBadgeLabel({ status: "no-access", now, progress })).toBe("Updating access · 66 remaining");
    expect(syncBadgeLabel({ status: "no-access", now, progress: { ...progress, done: 128 } })).toBe("Updating access · 2 remaining");
    expect(syncBadgeTone({ status: "no-access", progress })).toBe("connecting");
    expect(isSyncRunActive(progress)).toBe(true);
  });

  // #258: an interrupted first upload resumes visibly, counting what is left.
  it("names the notes still to upload while their content is missing on the server", () => {
    const progress: SyncProgress = {
      phase: "uploading",
      done: 10,
      total: 500,
      failed: 0,
      notUploaded: 412,
    };
    expect(syncBadgeLabel({ status: "synced", now, progress })).toBe("Uploading · 412 notes left");
    expect(syncBadgeLabel({ status: "synced", now, progress: { ...progress, notUploaded: 1 } })).toBe(
      "Uploading · 1 note left",
    );
    // Nothing missing: the ordinary counter, so a synced vault never reads "Uploading".
    expect(syncBadgeLabel({ status: "synced", now, progress: { ...progress, notUploaded: undefined } })).toBe(
      "Syncing 10/500 updates",
    );
    // Only while uploading: the download half of the run keeps its own counter.
    expect(syncBadgeLabel({ status: "synced", now, progress: { ...progress, phase: "downloading" } })).toBe(
      "Syncing 10/500 updates",
    );
  });

  it("reads 'Retrying…' when the run errored only because the channel never connected", () => {
    const stalled: SyncProgress = { phase: "error", done: 0, total: 0, failed: 0 };
    expect(syncBadgeLabel({ status: "connecting", now, progress: stalled })).toBe("Retrying…");
    expect(syncBadgeLabel({ status: "error", now, progress: stalled })).toBe("Retrying…");
    // Failed NOTES are not a connectivity state: the pill reads Synced (see
    // below); a connected channel with an errored run still reads incomplete.
    expect(
      syncBadgeLabel({ status: "synced", now, progress: { ...stalled, failed: 2 } }),
    ).toBe("Synced");
    expect(syncBadgeLabel({ status: "synced", now, progress: stalled })).toBe("Sync incomplete");
  });

  it("shows Syncing… while local edits are pending, ignoring the timestamp", () => {
    expect(
      syncBadgeLabel({ status: "synced", pending: true, lastSyncedAt: now - 300_000, now }),
    ).toBe("Syncing…");
  });

  it("reads 'Synced · just now' immediately after a flush", () => {
    expect(
      syncBadgeLabel({ status: "synced", pending: false, lastSyncedAt: now, now }),
    ).toBe("Synced · just now");
  });

  it("counts up from the last flush once settled", () => {
    expect(
      syncBadgeLabel({ status: "synced", pending: false, lastSyncedAt: now - 300_000, now }),
    ).toBe("Synced · 5m ago");
  });

  it("falls back to 'Synced' when there is no timestamp yet", () => {
    expect(syncBadgeLabel({ status: "synced", lastSyncedAt: null, now })).toBe("Synced");
  });

  it("maps the non-synced statuses to fixed labels", () => {
    expect(syncBadgeLabel({ status: "read-only", now })).toBe("Read-only");
    expect(syncBadgeLabel({ status: "connecting", now })).toBe("Syncing…");
    expect(syncBadgeLabel({ status: "no-access", now })).toBe("No access");
    expect(syncBadgeLabel({ status: "error", now })).toBe("Retrying…");
    expect(syncBadgeLabel({ status: "offline", now })).toBe("Offline");
    expect(syncBadgeLabel({ status: "offline", enabled: false, now })).toBe("Local only");
  });
});

/** The vault's bulk-run progress is independent of the socket status: these lock
 *  in that a live run is never allowed to read as "Synced". */
describe("syncBadgeLabel with a bulk sync run", () => {
  const now = 1_000_000_000_000;
  const run = (p: Partial<SyncProgress>): SyncProgress => ({
    phase: "uploading",
    done: 0,
    total: 0,
    failed: 0,
    ...p,
  });

  it("reports counted progress instead of 'Synced' while a run is live", () => {
    // The socket IS synced and the last flush WAS just now — and 372 of 500 notes
    // have still never reached the server. This is the exact lie being fixed.
    expect(
      syncBadgeLabel({
        status: "synced",
        lastSyncedAt: now,
        now,
        progress: run({ phase: "uploading", done: 128, total: 500 }),
      }),
    ).toBe("Syncing 128/500 updates");
  });

  it("clamps a racing counter so it can never read 585/164", () => {
    expect(
      syncBadgeLabel({
        status: "synced",
        now,
        progress: run({ phase: "registering", done: 585, total: 164 }),
      }),
    ).toBe("Syncing 164/164 updates");
  });

  it("counts the registering and downloading phases too, all under one verb", () => {
    expect(
      syncBadgeLabel({
        status: "connecting",
        now,
        progress: run({ phase: "registering", done: 3, total: 40 }),
      }),
    ).toBe("Syncing 3/40 updates");
    // Every phase reads "Syncing" — the per-phase verbs described mechanism,
    // not the user's situation ("Uploading files" on an already-synced vault
    // read as "my vault is being re-sent").
    expect(
      syncBadgeLabel({
        status: "synced",
        now,
        progress: run({ phase: "downloading", done: 9, total: 10 }),
      }),
    ).toBe("Syncing 9/10 updates");
  });

  it("falls back to the indeterminate label when the run has no total yet", () => {
    expect(
      syncBadgeLabel({
        status: "synced",
        now,
        progress: run({ phase: "registering", done: 0, total: 0 }),
      }),
    ).toBe("Syncing…");
  });

  it("reads Synced — never 'N not synced' — when a run ends with failed notes", () => {
    // Per-note failures belong to the Health page. On the pill a finished run
    // is a finished run: no count, no amber, no stuck state.
    const failedRun = run({ phase: "error", done: 500, total: 500, failed: 20 });
    expect(
      syncBadgeLabel({ status: "synced", lastSyncedAt: now, now, progress: failedRun }),
    ).toBe("Synced · just now");
    expect(syncBadgeTone({ status: "synced", progress: failedRun })).toBe("synced");
    expect(
      syncBadgeLabel({ status: "offline", now, noteOpen: false, progress: failedRun }),
    ).toBe("Synced");
    expect(syncBadgeTone({ status: "offline", noteOpen: false, progress: failedRun })).toBe(
      "synced",
    );
    // …and it offers no "See why" button either.
    expect(
      syncBadgeAction({
        running: false,
        phase: failedRun.phase,
        failed: failedRun.failed,
        hasRetry: true,
        hasHealth: true,
      }).kind,
    ).toBe("none");
    // Genuine connectivity states still win over the settled run.
    expect(syncBadgeLabel({ status: "error", now, progress: failedRun })).toBe("Retrying…");
    expect(syncBadgeLabel({ status: "offline", now, progress: failedRun })).toBe("Offline");
    expect(
      syncBadgeLabel({ status: "synced", now, progress: run({ phase: "error" }) }),
    ).toBe("Sync incomplete");
  });

  it("goes back to the connection label once the run is done", () => {
    expect(
      syncBadgeLabel({
        status: "synced",
        lastSyncedAt: now,
        now,
        progress: run({ phase: "done", done: 500, total: 500 }),
      }),
    ).toBe("Synced · just now");
    expect(
      syncBadgeLabel({ status: "offline", enabled: false, now, progress: null }),
    ).toBe("Local only");
  });

  it("lets a grant fact about the open note outrank the run", () => {
    const progress = run({ done: 1, total: 9 });
    expect(syncBadgeLabel({ status: "no-access", now, progress })).toBe("No access");
    expect(syncBadgeLabel({ status: "read-only", now, progress })).toBe("Read-only");
  });

  it("keeps the tone consistent with the words", () => {
    expect(syncBadgeTone({ status: "synced", progress: run({ done: 1, total: 9 }) })).toBe(
      "connecting",
    );
    expect(syncBadgeTone({ status: "synced", progress: run({ phase: "error" }) })).toBe(
      "error",
    );
    expect(syncBadgeTone({ status: "synced", progress: run({ phase: "done" }) })).toBe(
      "synced",
    );
    expect(
      syncBadgeTone({ status: "read-only", progress: run({ done: 1, total: 9 }) }),
    ).toBe("read-only");
    expect(syncBadgeTone({ status: "offline" })).toBe("offline");
  });

  it("knows which phases are live", () => {
    expect(isSyncRunActive(null)).toBe(false);
    expect(isSyncRunActive(run({ phase: "idle" }))).toBe(false);
    expect(isSyncRunActive(run({ phase: "done" }))).toBe(false);
    expect(isSyncRunActive(run({ phase: "error" }))).toBe(false);
    for (const phase of ["registering", "uploading", "downloading"] as const) {
      expect(isSyncRunActive(run({ phase }))).toBe(true);
    }
  });

  it("stays honest with no note open: the label comes from the run alone", () => {
    // The header pill is now mounted vault-wide. With no note open, `status`
    // belongs to a socket that doesn't exist — it must never leak into the label.
    expect(
      syncBadgeLabel({
        status: "offline",
        now,
        noteOpen: false,
        progress: run({ phase: "downloading", done: 128, total: 500 }),
      }),
    ).toBe("Syncing 128/500 updates");
    expect(
      syncBadgeLabel({
        status: "offline",
        now,
        noteOpen: false,
        progress: run({ phase: "done", done: 500, total: 500 }),
      }),
    ).toBe("Synced");
    expect(
      syncBadgeLabel({
        status: "synced",
        now,
        noteOpen: false,
        progress: run({ phase: "error", done: 480, total: 500, failed: 20 }),
      }),
    ).toBe("Synced");
    // Stale grant facts from the last open note don't apply either.
    expect(
      syncBadgeLabel({
        status: "no-access",
        now,
        noteOpen: false,
        progress: run({ phase: "uploading", done: 1, total: 9 }),
      }),
    ).toBe("Syncing 1/9 updates");
  });

  it("keeps the vault-wide tone consistent with the vault-wide words", () => {
    expect(
      syncBadgeTone({
        status: "offline",
        noteOpen: false,
        progress: run({ done: 1, total: 9 }),
      }),
    ).toBe("connecting");
    expect(
      syncBadgeTone({ status: "offline", noteOpen: false, progress: run({ phase: "done" }) }),
    ).toBe("synced");
    expect(
      syncBadgeTone({
        status: "synced",
        noteOpen: false,
        progress: run({ phase: "error", failed: 3 }),
      }),
    ).toBe("synced");
    expect(
      syncBadgeTone({
        status: "no-access",
        noteOpen: false,
        progress: run({ done: 1, total: 9 }),
      }),
    ).toBe("connecting");
  });

  it("floors the bar's percentage and clamps it", () => {
    expect(syncRunPercent(null)).toBeNull();
    expect(syncRunPercent(run({ done: 0, total: 0 }))).toBeNull();
    expect(syncRunPercent(run({ done: 499, total: 500 }))).toBe(99);
    expect(syncRunPercent(run({ done: 500, total: 500 }))).toBe(100);
    // A denominator that shrank mid-run must not overflow the bar.
    expect(syncRunPercent(run({ done: 12, total: 10 }))).toBe(100);
  });
});

/** What the pill offers after a run stops. Only a run that could not proceed
 *  (the channel never connected) offers anything, and it EXPLAINS before it
 *  retries. Failed notes are the Health page's and never reach the pill. */
describe("syncBadgeAction", () => {
  const base = { running: false, hasRetry: true, hasHealth: true };

  it("offers nothing for a run that ended with failed notes (the pill reads Synced)", () => {
    expect(syncBadgeAction({ ...base, phase: "error", failed: 12 })).toEqual({
      kind: "none",
      cta: "",
    });
  });

  it("offers 'See why' over 'Sync now' when the run could not proceed", () => {
    const a = syncBadgeAction({ ...base, phase: "error", failed: 0 });
    expect(a.kind).toBe("explain");
    expect(a.cta).toBe("See why");
  });

  it("still explains when the run failed without naming a single note", () => {
    // The download watchdog: nothing individually failed, the app never reached
    // the server. Health is still where the situation is described.
    const a = syncBadgeAction({ ...base, phase: "error", failed: 0 });
    expect(a.title).toBe("Sync didn't finish — open Health to see why");
  });

  it("falls back to the retry when the caller has no Health page to open", () => {
    const a = syncBadgeAction({ ...base, hasHealth: false, phase: "error", failed: 0 });
    expect(a).toEqual({ kind: "retry", cta: "Sync now", title: "Click to sync now" });
  });

  it("offers nothing while a run is live, or on any non-terminal phase", () => {
    expect(syncBadgeAction({ ...base, running: true, phase: "error" }).kind).toBe("none");
    for (const phase of ["idle", "registering", "uploading", "downloading", "done"]) {
      expect(syncBadgeAction({ ...base, phase }).kind).toBe("none");
    }
    expect(syncBadgeAction({ ...base, phase: null }).kind).toBe("none");
  });

  it("offers nothing when the caller gave no action at all", () => {
    expect(
      syncBadgeAction({ running: false, phase: "error", hasRetry: false, hasHealth: false })
        .kind,
    ).toBe("none");
  });
});

// #273: a vault-wide hold outranks every per-note/per-run state, in every badge
// that renders through SyncBadge — Vault Settings once read "Synced · 9m ago"
// while the tab-bar pill said "Sync paused".
describe("syncBadgeHold", () => {
  const now = 1_000_000_000_000;

  it("is null when nothing holds sync", () => {
    expect(syncBadgeHold({ now })).toBeNull();
    expect(syncBadgeHold({ enabled: true, pause: null, now })).toBeNull();
  });

  it("reads a neutral Paused while the vault folder is missing (#228)", () => {
    const hold = syncBadgeHold({ rootMissing: true, enabled: true, pause: { until: null }, now });
    expect(hold).toEqual({
      tone: "offline",
      label: "Paused",
      title: "Sync is paused until the vault folder is back",
    });
  });

  it("reads an amber Sync paused while the shrink brake holds writes (#252)", () => {
    const hold = syncBadgeHold({ enabled: true, pause: { until: now + 10 * 60_000 }, now });
    expect(hold?.tone).toBe("connecting");
    expect(hold?.label).toBe("Sync paused");
    expect(hold?.title).toContain("(in about 10 min)");
    expect(syncBadgeHold({ enabled: true, pause: { until: null }, now })?.title).not.toContain("(in ");
  });

  it("ignores a brake on a vault whose sync is off", () => {
    expect(syncBadgeHold({ enabled: false, pause: { until: null }, now })).toBeNull();
  });
});

// New notes the server refused for access stay local until access changes, and
// a refused create may or may not have been re-asked (and so counted as
// `failed`) in the run that just ended. Either way the pill must not read
// "Synced" over them.
describe("a run with held create refusals", () => {
  const now = 1_000_000_000_000;
  const asked: SyncProgress = { phase: "error", done: 3, total: 3, failed: 2, refused: 2 };
  const skipped: SyncProgress = { phase: "error", done: 0, total: 0, failed: 0, refused: 2 };

  it("reads the same whether or not the refusals were re-asked this run", () => {
    for (const progress of [asked, skipped]) {
      expect(syncBadgeLabel({ status: "synced", now, progress })).toBe("Sync incomplete");
      expect(syncBadgeTone({ status: "synced", progress })).toBe("error");
      expect(
        syncBadgeAction({ running: false, phase: "error", failed: progress.failed, refused: 2, hasRetry: true, hasHealth: true }).kind,
      ).toBe("explain");
    }
  });

  it("still reads Synced for ordinary failed notes", () => {
    const progress: SyncProgress = { phase: "error", done: 3, total: 3, failed: 2 };
    expect(syncBadgeLabel({ status: "synced", now, progress, lastSyncedAt: now })).toBe("Synced · just now");
  });
});

// A registry pull that keeps failing strands every new note and folder, so the
// pill must not read "Synced" over it — even when the run also had ordinary
// failed notes, which on their own read "Synced".
describe("a run whose registry pull keeps failing", () => {
  const now = 1_000_000_000_000;
  const withFailed: SyncProgress = { phase: "error", done: 3, total: 3, failed: 2, pullFailing: true };
  const alone: SyncProgress = { phase: "error", done: 0, total: 0, failed: 0, pullFailing: true };

  it("reads Sync incomplete and offers the Health explanation", () => {
    for (const progress of [withFailed, alone]) {
      expect(syncBadgeLabel({ status: "synced", now, progress })).toBe("Sync incomplete");
      expect(syncBadgeTone({ status: "synced", progress })).toBe("error");
      expect(
        syncBadgeAction({
          running: false,
          phase: "error",
          failed: progress.failed,
          pullFailing: true,
          hasRetry: true,
          hasHealth: true,
        }).kind,
      ).toBe("explain");
    }
  });

  it("reads Synced again once the stamp is gone", () => {
    const progress: SyncProgress = { phase: "error", done: 3, total: 3, failed: 2 };
    expect(syncBadgeLabel({ status: "synced", now, progress, lastSyncedAt: now })).toBe("Synced · just now");
  });
});
