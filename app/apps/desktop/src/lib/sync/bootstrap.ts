// The download half of the bulk sync engine: N docs per HTTP page, ONE IPC per
// page, a resumable cursor — in place of the vault channel's cold backfill,
// which was one WS frame + three IPC calls + one SQLite transaction PER DOC and
// had no cursor to resume from.
//
// ── What makes this safe to run twice (and to kill halfway) ──────────────────
// Nothing here writes a file. The runner decodes a page, rebuilds each doc in a
// TRANSIENT `Y.Doc`, and hands the batch to Rust, which decides each doc's fate
// from the FILE and the local CRDT tables rather than from anything this layer
// says (ipc.ts `applyBootstrapBatch`):
//
//   | local CRDT rows | local file            | outcome                       |
//   | none            | missing or 0 bytes    | written                       |
//   | none            | non-empty, same hash  | unchanged (CRDT rows written) |
//   | none            | non-empty, differs    | conflict — NOTHING written    |
//   | any             | any                   | rejected — we cold-apply      |
//
// So a page applied twice writes nothing the second time (every doc now has
// rows ⇒ `rejected` ⇒ a cold apply, which MERGES and is idempotent for state
// the doc already holds), and a doc whose file a human has been editing is
// never overwritten — it comes back `conflict` and goes to the per-doc
// `DocSync` path, where a real pull-then-merge settles it.
//
// The cursor advances ONLY after the IPC returns, so a `kill -9` re-sends the
// last page rather than skipping it. That is the whole resume story: the page
// is idempotent, so re-sending it is free, and the alternative (advancing
// first) loses a page of the vault permanently.
//
// Peak heap is one page (≤4 MiB) plus one transient doc, flat in vault size.
//
// Injected I/O in the style of `contentUpload.ts`: no Tauri, no network, no
// timers of its own, so the whole engine runs under vitest in Node.

import * as Y from "yjs";
import type { BootstrapEntry, BootstrapOutcome } from "../ipc";
import type { BootstrapSession } from "./bulkTypes";
import { decodeBootstrapPage } from "./bootstrapCodec";
import { MAX_NOTE_BYTES, type UploadFailure } from "./contentUpload";
import { withRetry } from "./pool";
import { nullProgressSink, type SyncProgressSink } from "./progress";

/**
 * Resume state, persisted on `VaultSyncConfig.bootstrap` through the registry's
 * existing `Checkpointer` (which writes through the already-atomic
 * `set_vault_config`).
 *
 * `serverVaultId` is the guard every other key in that file has: a cursor into
 * another collection's session names nothing here.
 */
export interface BootstrapResume {
  serverVaultId: string;
  sessionId: string;
  cursor: number;
  docsTotal: number;
  docsDone: number;
  bytesTotal: number;
  bytesDone: number;
}

/** One page as the transport hands it over (`api.fetchBootstrapPage`). */
export interface BootstrapPageBytes {
  bytes: Uint8Array;
  /** `null` ⇒ the session is drained. */
  nextCursor: number | null;
  docs: number;
  uncompressedBytes: number;
}

export interface BootstrapDeps {
  /** `POST /api/vaults/:id/bootstrap`. `have` is subtracted from the download set. */
  createSession(have: string[]): Promise<BootstrapSession>;
  /** `GET …/bootstrap/:sessionId?cursor=`. */
  fetchPage(sessionId: string, cursor: number): Promise<BootstrapPageBytes>;
  /** ONE `ipc.applyBootstrapBatch` per page. */
  applyBatch(entries: BootstrapEntry[]): Promise<BootstrapOutcome[]>;
  /**
   * Merge a doc the batch REFUSED because it already has local CRDT rows
   * (`VaultDocStore.applyUpdate`, which merges and egests through the bridge).
   * Never a write-through: a doc with local history is exactly the doc whose
   * text must not be replaced.
   */
  coldApply(docId: string, update: Uint8Array): Promise<void>;
  /** docIds this device already holds CRDT state for — the session's `have`. */
  haveDocs(): string[] | Promise<string[]>;
  /** A doc whose content is now stored locally (`registry.markPushed`). */
  markPushed(docId: string): void;
  /** One owed watcher echo for a file WE just created (`registry.markMaterialized`). */
  markMaterialized(relPath: string): void;
  loadResume(): BootstrapResume | null;
  /** `null` clears it — the session is drained or void. */
  saveResume(state: BootstrapResume | null): void;
  flushCheckpoint(): Promise<void>;
  /** Injected in tests; honours a 503's `Retry-After`. */
  sleep?(ms: number): Promise<void>;
}

export interface BootstrapRunnerOptions {
  /** The server note-collection id (the Postgres `vaults` row). */
  serverVaultId: string;
  deps: BootstrapDeps;
  progress?: SyncProgressSink;
  /** Abandon (vault switch). Checked before every page and before every apply. */
  shouldStop?: () => boolean;
  onFailure?: (failure: UploadFailure) => void;
  /** Hard bound on pages per run, so a server that never drains cannot spin. */
  maxPages?: number;
  /** How many times a `bootstrap_busy` 503 is waited out. Default 5. */
  busyRetries?: number;
}

export interface BootstrapRunResult {
  /** Docs Rust wrote or confirmed (`written` + `unchanged`). */
  applied: number;
  /** Docs that already had local CRDT and were cold-merged instead. */
  merged: number;
  /**
   * Docs whose LOCAL FILE holds something else. Nothing was written; each needs
   * a real pull-then-merge over its own `DocSync`.
   */
  conflicts: string[];
  /** `emptyDocs` from the session — the push side's work list. */
  emptyDocs: string[];
  emptyTruncated: boolean;
  failures: UploadFailure[];
  /** True when a vault switch (or `shouldStop`) ended the run — not a failure. */
  cancelled: boolean;
  docsTotal: number;
  bytesDone: number;
  pages: number;
}

/** The code a bootstrap error carries, if any (`api.bulkErrorCode` shape). */
function codeOf(e: unknown): string | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : null;
}

function retryAfterOf(e: unknown): number | null {
  const ms = (e as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
}

const utf8 = new TextEncoder();
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A session the server no longer has (410). Recoverable: the runner opens a new
 * one with a FRESH `have`, which is strictly smaller than the first (everything
 * already applied is now held locally), so the restart re-downloads only the
 * remainder.
 */
const SESSION_EXPIRED = "session_expired";
const BOOTSTRAP_BUSY = "bootstrap_busy";

export class BootstrapRunner {
  private readonly opts: BootstrapRunnerOptions;
  private readonly deps: BootstrapDeps;
  private readonly progress: SyncProgressSink;
  private readonly sleep: (ms: number) => Promise<void>;

  private stopped = false;
  private failures: UploadFailure[] = [];
  private conflicts: string[] = [];
  private applied = 0;
  private merged = 0;
  private pages = 0;

  constructor(opts: BootstrapRunnerOptions) {
    this.opts = opts;
    this.deps = opts.deps;
    this.progress = opts.progress ?? nullProgressSink;
    this.sleep = opts.deps.sleep ?? defaultSleep;
  }

  /** Cancel the run (vault switch / teardown). */
  stop(): void {
    this.stopped = true;
  }

  private shouldStop(): boolean {
    return this.stopped || (this.opts.shouldStop?.() ?? false);
  }

  /**
   * Download the vault.
   *
   * Throws only what the caller must act on: a `server_too_old` from the
   * transport (terminal — see `docSession`). Everything else is recorded as a
   * per-doc failure or retried.
   */
  async run(): Promise<BootstrapRunResult> {
    this.failures = [];
    this.conflicts = [];
    this.applied = 0;
    this.merged = 0;
    this.pages = 0;

    let session = await this.openSession();
    if (this.shouldStop()) return this.result(session, session.bytesDone, true);
    let cursor = session.cursor;
    let docsDone = session.docsDone;
    let bytesDone = session.bytesDone;
    const maxPages = this.opts.maxPages ?? 10_000;

    // The download phase's denominator. The runner never stamps the phase —
    // `docSession.beginDownloadPhase` owns it — it only grows the total and
    // ticks it, so the bootstrap and the vault channel share one counter.
    const remaining = Math.max(0, session.docsTotal - docsDone);
    if (remaining > 0) this.progress.addTotal(remaining);
    this.progress.bytes?.(bytesDone, session.bytesTotal);

    try {
      while (this.pages < maxPages) {
        if (this.shouldStop()) return this.result(session, bytesDone, true);
        let page: BootstrapPageBytes;
        try {
          page = await this.fetchPage(session.sessionId, cursor);
        } catch (e) {
          if (codeOf(e) === SESSION_EXPIRED) {
            // A fresh `have` makes the new session smaller than the old one.
            session = await this.openSession({ fresh: true, previous: session });
            cursor = session.cursor;
            continue;
          }
          throw e;
        }
        this.pages++;
        if (this.shouldStop()) return this.result(session, bytesDone, true);

        const docs = decodeBootstrapPage(page.bytes);
        const entries: BootstrapEntry[] = [];
        for (const doc of docs) {
          const entry = this.toEntry(doc.docId, doc.relPath, doc.update);
          if (entry) entries.push(entry);
          else docsDone++; // permanently refused; still one unit of the total
        }
        if (entries.length > 0) {
          if (this.shouldStop()) return this.result(session, bytesDone, true);
          const outcomes = await this.deps.applyBatch(entries);
          await this.settle(entries, outcomes, docs);
          docsDone += entries.length;
        }

        // ONLY NOW. A crash between the apply and this line re-sends the page,
        // which the eligibility table makes a no-op; a crash the other way round
        // would lose it.
        bytesDone += page.uncompressedBytes;
        cursor = page.nextCursor ?? cursor;
        this.progress.bytes?.(bytesDone, session.bytesTotal);
        if (page.nextCursor == null) {
          this.deps.saveResume(null); // drained
          await this.deps.flushCheckpoint();
          return this.result(session, bytesDone, false);
        }
        this.deps.saveResume({
          serverVaultId: this.opts.serverVaultId,
          sessionId: session.sessionId,
          cursor,
          docsTotal: session.docsTotal,
          docsDone,
          bytesTotal: session.bytesTotal,
          bytesDone,
        });
      }
      return this.result(session, bytesDone, false);
    } finally {
      this.progress.flush();
    }
  }

  /**
   * Resume the session recorded for THIS collection, or open a new one.
   *
   * `emptyDocs` is deliberately not persisted: it is the push side's work list
   * and the vault channel re-states it on every connect (`ready.empty`), so a
   * resumed run simply has none and loses nothing.
   */
  private async openSession(opts: { fresh?: boolean; previous?: OpenSession } = {}): Promise<OpenSession> {
    if (!opts.fresh) {
      const saved = this.deps.loadResume();
      if (saved && saved.serverVaultId === this.opts.serverVaultId) {
        return {
          sessionId: saved.sessionId,
          cursor: saved.cursor,
          docsTotal: saved.docsTotal,
          docsDone: saved.docsDone,
          bytesTotal: saved.bytesTotal,
          bytesDone: saved.bytesDone,
          emptyDocs: [],
          emptyTruncated: false,
        };
      }
    }
    const have = await this.deps.haveDocs();
    const created = await this.deps.createSession(have);
    // A restart keeps what the previous session already accounted for, so the
    // progress bar does not jump backwards mid-download.
    const carriedDocs = opts.previous?.docsDone ?? 0;
    const carriedBytes = opts.previous?.bytesDone ?? 0;
    const session: OpenSession = {
      sessionId: created.sessionId,
      cursor: 0,
      docsTotal: (created.docs ?? 0) + carriedDocs,
      docsDone: carriedDocs,
      bytesTotal: (created.bytes ?? 0) + carriedBytes,
      bytesDone: carriedBytes,
      emptyDocs: created.emptyDocs ?? [],
      emptyTruncated: created.emptyTruncated === true,
    };
    this.deps.saveResume({
      serverVaultId: this.opts.serverVaultId,
      sessionId: session.sessionId,
      cursor: 0,
      docsTotal: session.docsTotal,
      docsDone: session.docsDone,
      bytesTotal: session.bytesTotal,
      bytesDone: session.bytesDone,
    });
    return session;
  }

  /**
   * One page, with the two server answers that are instructions rather than
   * failures handled here: 503 `bootstrap_busy` is waited out (`Retry-After`),
   * 410 `session_expired` is re-thrown for the caller's restart. Everything else
   * gets the ordinary bounded retry.
   */
  private async fetchPage(sessionId: string, cursor: number): Promise<BootstrapPageBytes> {
    const busyLimit = Math.max(1, this.opts.busyRetries ?? 5);
    for (let busy = 0; busy <= busyLimit; busy++) {
      const out = await withRetry(() => this.deps.fetchPage(sessionId, cursor), {
        // A 410 and a 404 are verdicts, not flakiness — do not burn the budget.
        isTerminal: (e) =>
          codeOf(e) === SESSION_EXPIRED ||
          codeOf(e) === BOOTSTRAP_BUSY ||
          codeOf(e) === "server_too_old",
        shouldStop: () => this.shouldStop(),
      });
      if (out.ok) return out.value;
      if (codeOf(out.error) === BOOTSTRAP_BUSY && busy < busyLimit) {
        await this.sleep(retryAfterOf(out.error) ?? 1000 * (busy + 1));
        if (this.shouldStop()) throw out.error;
        continue;
      }
      throw out.error;
    }
    throw new Error("bootstrap: server stayed busy");
  }

  /**
   * Rebuild one doc in a transient `Y.Doc` and turn it into a batch entry, or
   * `null` when it is permanently refused.
   *
   * The doc is destroyed before the next one is built, which is what keeps the
   * peak heap at one page + one doc however big the vault is.
   */
  private toEntry(docId: string, relPath: string, update: Uint8Array): BootstrapEntry | null {
    if (update.byteLength > MAX_NOTE_BYTES) {
      this.fail(docId, relPath, sizeReason(update.byteLength, "of edit history"));
      return null;
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, update);
      const content = doc.getText("content").toString();
      const bytes = utf8.encode(content).byteLength;
      if (bytes > MAX_NOTE_BYTES) {
        this.fail(docId, relPath, sizeReason(bytes, ""));
        return null;
      }
      return {
        docId,
        relPath,
        content,
        // The update IS the snapshot: Rust stores it verbatim as the doc's
        // `yjs_snapshot`, so the local CRDT starts life byte-identical to the
        // server's merged state.
        snapshot: update,
        stateVector: Y.encodeStateVector(doc),
      };
    } catch (e) {
      this.fail(docId, relPath, `could not read the server's copy: ${msg(e)}`, false);
      return null;
    } finally {
      doc.destroy();
    }
  }

  /** Apply the batch's verdicts: mark, merge, or hand to the conflict path. */
  private async settle(
    entries: BootstrapEntry[],
    outcomes: BootstrapOutcome[],
    docs: ReadonlyArray<{ docId: string; relPath: string; update: Uint8Array }>,
  ): Promise<void> {
    const byDocId = new Map(outcomes.map((o) => [o.docId, o]));
    const updateOf = new Map(docs.map((d) => [d.docId, d.update]));
    for (const entry of entries) {
      const outcome = byDocId.get(entry.docId);
      if (!outcome) {
        // Rust answered nothing for this doc. "No answer" removes nothing and
        // claims nothing — the doc stays unpushed and the next `ready` re-queues it.
        this.fail(entry.docId, entry.relPath, "the local store did not answer for this note", false);
        continue;
      }
      switch (outcome.status) {
        case "written":
        case "unchanged": {
          // The CRDT rows are stored either way, so the server's copy is here.
          this.deps.markPushed(entry.docId);
          // One owed watcher echo for the file we just created, so the sync
          // layer does not read our own write as an external edit.
          this.deps.markMaterialized(entry.relPath);
          this.progress.doc(entry.docId, "synced");
          this.progress.item("ok");
          this.applied++;
          break;
        }
        case "rejected": {
          // This doc already has local CRDT. The batch wrote NOTHING; the merge
          // path owns it (Yjs merges, so applying state we already hold is free).
          const update = updateOf.get(entry.docId);
          if (update) {
            try {
              await this.deps.coldApply(entry.docId, update);
              this.merged++;
              this.progress.item("ok");
              break;
            } catch (e) {
              this.fail(entry.docId, entry.relPath, `merge failed: ${msg(e)}`, false);
              break;
            }
          }
          this.progress.item("ok");
          break;
        }
        case "conflict": {
          // The file on disk holds something the server's copy does not. Nothing
          // was written. A real pull-then-merge over this doc's own `DocSync` is
          // the only correct settlement, and it is the caller's job.
          this.conflicts.push(entry.docId);
          this.progress.doc(entry.docId, "queued");
          this.progress.item("ok");
          break;
        }
      }
    }
    this.progress.flush();
  }

  private result(
    session: OpenSession,
    bytesDone: number,
    cancelled: boolean,
  ): BootstrapRunResult {
    return {
      applied: this.applied,
      merged: this.merged,
      conflicts: [...this.conflicts],
      emptyDocs: session.emptyDocs,
      emptyTruncated: session.emptyTruncated,
      failures: [...this.failures],
      cancelled,
      docsTotal: session.docsTotal,
      bytesDone,
      pages: this.pages,
    };
  }

  private fail(docId: string, relPath: string, reason: string, permanent = true): void {
    const failure: UploadFailure = { docId, relPath, reason, ...(permanent ? { permanent: true } : {}) };
    this.failures.push(failure);
    try {
      this.opts.onFailure?.(failure);
    } catch (e) {
      console.warn("[bootstrap] failure listener threw", e);
    }
    this.progress.doc(docId, "error");
    this.progress.item("failed");
  }
}

interface OpenSession {
  sessionId: string;
  cursor: number;
  docsTotal: number;
  docsDone: number;
  bytesTotal: number;
  bytesDone: number;
  emptyDocs: string[];
  emptyTruncated: boolean;
}

function sizeReason(bytes: number, what: string): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const cap = Math.round(MAX_NOTE_BYTES / (1024 * 1024));
  return `too large to sync (${mb} MB${what ? " " + what : ""}; the limit is ${cap} MB)`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
