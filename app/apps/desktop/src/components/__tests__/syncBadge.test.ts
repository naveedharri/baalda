import { describe, expect, it } from "vitest";
import {
  isSyncRunActive,
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
    ).toBe("Syncing 128/500");
  });

  it("clamps a racing counter so it can never read 585/164", () => {
    expect(
      syncBadgeLabel({
        status: "synced",
        now,
        progress: run({ phase: "registering", done: 585, total: 164 }),
      }),
    ).toBe("Syncing 164/164");
  });

  it("counts the registering and downloading phases too, all under one verb", () => {
    expect(
      syncBadgeLabel({
        status: "connecting",
        now,
        progress: run({ phase: "registering", done: 3, total: 40 }),
      }),
    ).toBe("Syncing 3/40");
    // Every phase reads "Syncing" — the per-phase verbs described mechanism,
    // not the user's situation ("Uploading files" on an already-synced vault
    // read as "my vault is being re-sent").
    expect(
      syncBadgeLabel({
        status: "synced",
        now,
        progress: run({ phase: "downloading", done: 9, total: 10 }),
      }),
    ).toBe("Syncing 9/10");
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

  it("names the notes left behind when a run ends with failures", () => {
    expect(
      syncBadgeLabel({
        status: "synced",
        lastSyncedAt: now,
        now,
        progress: run({ phase: "error", done: 500, total: 500, failed: 20 }),
      }),
    ).toBe("20 not synced");
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
    ).toBe("Syncing 128/500");
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
    ).toBe("20 not synced");
    // Stale grant facts from the last open note don't apply either.
    expect(
      syncBadgeLabel({
        status: "no-access",
        now,
        noteOpen: false,
        progress: run({ phase: "uploading", done: 1, total: 9 }),
      }),
    ).toBe("Syncing 1/9");
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
    ).toBe("error");
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
