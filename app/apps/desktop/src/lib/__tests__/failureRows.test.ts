// Activity's Failed rows: a transient push failure waits for the automatic
// retries, a server refusal shows at once, and any confirmed push clears the
// doc's row so it never sits beside a green synced dot.
import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
}));
vi.mock("../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../api";
import {
  FailureGrace,
  TRANSIENT_FAILURE_ATTEMPTS,
  TRANSIENT_FAILURE_GRACE_MS,
  isTransientFailure,
} from "../sync/failureGrace";
import { VaultRegistry } from "../sync/registry";
import { retryAction, staleFailureIds } from "../../components/activityRows";

const timeout = { docId: "d1", relPath: "Concepts/A.md", reason: "server did not respond to the initial sync" };
const refusal = { docId: "d2", relPath: "Concepts/B.md", reason: "forbidden" };
const T0 = 1_000_000;

/** What `syncFailures` lists: the failures the grace lets through. */
function rows(grace: FailureGrace, failures: (typeof timeout)[], now: number) {
  return failures.filter((f) => grace.visible(f, now));
}

describe("failure rows", () => {
  it("classifies timeouts and network errors as transient, refusals as real", () => {
    expect(isTransientFailure(timeout)).toBe(true);
    expect(isTransientFailure({ reason: "fetch failed" })).toBe(true);
    expect(isTransientFailure({ reason: "HTTP 502 Bad Gateway" })).toBe(true);
    expect(isTransientFailure(refusal)).toBe(false);
    expect(isTransientFailure({ reason: "server did not respond", permanent: true })).toBe(false);
    expect(isTransientFailure({ reason: "too large to sync", kind: "too-large" })).toBe(false);
  });

  it("a transient failure alone, with retries pending, shows no row", () => {
    const g = new FailureGrace();
    g.record(timeout, T0);
    expect(rows(g, [timeout], T0)).toEqual([]);
    g.record(timeout, T0 + 1_000);
    expect(rows(g, [timeout], T0 + 1_000)).toEqual([]);
  });

  it("a transient failure followed by a successful retry leaves no row", () => {
    const g = new FailureGrace();
    g.record(timeout, T0);
    g.settle(timeout.docId);
    expect(rows(g, [timeout], T0 + TRANSIENT_FAILURE_GRACE_MS * 2)).toEqual([]);
  });

  it("retries exhausted shows one row (by count or by time)", () => {
    const g = new FailureGrace();
    for (let i = 0; i < TRANSIENT_FAILURE_ATTEMPTS; i++) g.record(timeout, T0 + i);
    expect(rows(g, [timeout], T0 + 10)).toHaveLength(1);

    const h = new FailureGrace();
    h.record(timeout, T0);
    expect(rows(h, [timeout], T0 + TRANSIENT_FAILURE_GRACE_MS)).toHaveLength(1);
  });

  it("a server refusal shows a row immediately", () => {
    const g = new FailureGrace();
    g.record(refusal, T0);
    expect(rows(g, [refusal], T0)).toHaveLength(1);
    const big = { ...refusal, reason: "too large to sync", permanent: true, kind: "too-large" as const };
    g.record(big, T0);
    expect(g.visible(big, T0)).toBe(true);
  });

  it("marking pushed clears an existing row, on any path through the registry", () => {
    const g = new FailureGrace();
    const reg = new VaultRegistry({} as ApiClient);
    reg.setPushedListener((id) => g.settle(id));
    g.record(refusal, T0);
    expect(rows(g, [refusal], T0)).toHaveLength(1);
    reg.markPushed(refusal.docId);
    expect(rows(g, [refusal], T0)).toEqual([]);
    // Already marked pushed (a forced local-change push): still settles.
    g.record(refusal, T0 + 1);
    expect(rows(g, [refusal], T0 + 1)).toHaveLength(1);
    reg.markPushed(refusal.docId);
    expect(rows(g, [refusal], T0 + 1)).toEqual([]);
  });

  it("a permanent refusal stays even after the doc is confirmed", () => {
    const g = new FailureGrace();
    const ro = { ...refusal, reason: "edit could not be sent: no write access", permanent: true, kind: "no-write-access" as const };
    g.record(ro, T0);
    g.settle(ro.docId);
    expect(g.visible(ro, T0)).toBe(true);
  });

  it("Retry on an already-pushed doc clears the row without a request", () => {
    const retry = vi.fn();
    const settled = (id: string) => id === "d1";
    const press = (docId: string) => (retryAction(docId, settled) === "clear" ? "cleared" : (retry(docId), "retried"));
    expect(press("d1")).toBe("cleared");
    expect(retry).not.toHaveBeenCalled();
    expect(press("d2")).toBe("retried");
    expect(retry).toHaveBeenCalledWith("d2");
  });

  it("drops logged Failed rows that sync no longer reports for a pushed note", () => {
    const log = [
      { id: "fc:d1", kind: "failed", docId: "d1" },
      { id: "fc:d2", kind: "failed", docId: "d2" },
      { id: "fc:d3", kind: "failed", docId: "d3" },
      { id: "r:x", kind: "restoredFromServer", docId: "d1" },
    ];
    const pushed = new Set(["d1", "d2"]);
    expect(staleFailureIds(log, new Set(["fc:d2"]), (id) => pushed.has(id))).toEqual(["fc:d1"]);
  });
});
