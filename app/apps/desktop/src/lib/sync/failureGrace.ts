// Which content-push failures are worth a row in Activity / Vault Health.
//
// A timeout or a network error is usually the connection, not the note: the
// next drain or reconcile pushes the doc and the sidebar dot turns green. Such
// a failure is held back until it has repeated `TRANSIENT_FAILURE_ATTEMPTS`
// times or lasted `TRANSIENT_FAILURE_GRACE_MS`. A server refusal (a code from
// the server, a permanent verdict, a typed kind) is shown at once. Any confirmed
// push (`VaultRegistry.markPushed`, on every path) settles the doc, so the
// failure list can never disagree with the synced badge.

import type { UploadFailure } from "./contentUpload";

/** Consecutive transient failures of one doc before it is reported. */
export const TRANSIENT_FAILURE_ATTEMPTS = 3;
/** Continuous transient failure of one doc before it is reported. */
export const TRANSIENT_FAILURE_GRACE_MS = 5 * 60_000;

const TRANSIENT_RE =
  /did not respond|did not acknowledge|fetch failed|failed to fetch|network|timed? ?out|timeout|econn|socket|offline|connection|load failed|\b5\d\d\b|bad gateway|service unavailable|gateway time/i;

/** A failure the connection explains, which an automatic retry can fix. */
export function isTransientFailure(f: Pick<UploadFailure, "reason" | "permanent" | "kind">): boolean {
  if (f.permanent || f.kind) return false;
  return TRANSIENT_RE.test(f.reason);
}

export class FailureGrace {
  private transient = new Map<string, { first: number; count: number }>();
  private settled = new Set<string>();

  /** A failure was just reported for `f.docId`. */
  record(f: Pick<UploadFailure, "docId" | "reason" | "permanent" | "kind">, now: number): void {
    this.settled.delete(f.docId);
    if (!isTransientFailure(f)) {
      this.transient.delete(f.docId);
      return;
    }
    const prev = this.transient.get(f.docId);
    this.transient.set(f.docId, prev ? { first: prev.first, count: prev.count + 1 } : { first: now, count: 1 });
  }

  /** The doc's content was confirmed on the server. */
  settle(docId: string): void {
    this.transient.delete(docId);
    this.settled.add(docId);
  }

  isSettled(docId: string): boolean {
    return this.settled.has(docId);
  }

  /** Should this failure be listed now? Permanent refusals always are. */
  visible(f: Pick<UploadFailure, "docId" | "reason" | "permanent" | "kind">, now: number): boolean {
    if (f.permanent) return true;
    if (this.settled.has(f.docId)) return false;
    if (!isTransientFailure(f)) return true;
    const t = this.transient.get(f.docId);
    // Never seen through `record`: no history to wait on, so say it.
    if (!t) return true;
    return t.count >= TRANSIENT_FAILURE_ATTEMPTS || now - t.first >= TRANSIENT_FAILURE_GRACE_MS;
  }

  clear(): void {
    this.transient.clear();
    this.settled.clear();
  }
}
