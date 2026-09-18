// The upload half of the bulk sync engine: N docs' CRDT state in ONE request,
// in place of one `POST /api/sync-token` + one dedicated `HocuspocusProvider`
// per note (measured at 3.7 notes/second — a 5,000-note vault is ~22 minutes of
// sockets before a byte of the SECOND thousand moves).
//
// Sibling of `ContentUploader`, which is NOT deleted: it stops being the bulk
// path and stays the path for everything that is semantically per-doc — the
// open note, the local-change drain, an item over `BULK_ITEM_MAX_BYTES`, and
// the conflict below.
//
// ── Why this may seed a doc without first pulling it, when `ContentUploader`
//    may not ─────────────────────────────────────────────────────────────────
// `ContentUploader` pulls over a socket and only then calls
// `seedFromFileIfEmpty`, because seeding before the server's state lands is the
// note-doubling bug. There is no socket here, so the invariant is carried by
// two things instead:
//
//   1. we seed ONLY docs the SERVER named as empty (bootstrap `emptyDocs` ∪
//      `ready.empty`) AND whose local doc is empty; and
//   2. the request carries `expectEmpty: true`, which makes the server re-check
//      under its per-doc lock that it still holds no content, and answer
//      `conflict` — applying NOTHING — if it does.
//
// So the server can never merge a file-seed into content it already had. What
// (2) cannot undo is the seed's effect on the LOCAL doc: `seedFromFileIfEmpty`
// inserts into the Y.Text, and the bridge persists every update as it happens,
// so by the time the answer arrives the seed is already in this device's CRDT
// log. Leaving it there and then connecting a provider would merge our
// file-seed with the server's text under two different client ids — the exact
// doubling. So a `conflict` is settled by:
//
//   * releasing the bridge (which flushes; the file is unchanged — the seed CAME
//     from the file), then
//   * DISCARDING this doc's local CRDT (`ipc.clearYjsDoc` via
//     `discardLocalCrdt`), which throws away the seed and nothing else: the
//     doc was empty before we seeded it, and the `.md` on disk — the durable
//     source of truth — is untouched; then
//   * routing the doc to the per-doc `DocSync` path, where the ordinary
//     pull-then-merge runs: the pull lands the server's text into a now-empty
//     doc, `seedFromFileIfEmpty` sees a non-empty doc and inserts nothing, and
//     the file's own bytes are folded back in as a DIFF (`ingestNow`).
//
// Net effect: the text is never doubled (no second insert history) and never
// lost (the file is never written, and its bytes rejoin through the diff).
//
// No streak abort. `ContentUploader.failureStreakLimit` is deliberately not
// carried over — that mechanism is what stranded 613 notes. Per-chunk
// `withRetry` plus per-item failures into the same sink `completeRun` reads.
//
// Injected I/O like `contentUpload.ts`: runs under vitest with no Tauri.

import * as Y from "yjs";
import type { NoteBridge } from "../bridge";
import type { DocPushItem, DocPushResult } from "./bulkTypes";
import { MAX_NOTE_BYTES, crdtBytes, type UploadFailure } from "./contentUpload";
import {
  BATCH_MAX_DECODED_BYTES,
  BATCH_MAX_DOCS,
  BULK_ITEM_MAX_BYTES,
  UPLOAD_CONCURRENCY,
  runPool,
  withRetry,
} from "./pool";
import { nullProgressSink, type SyncProgressSink } from "./progress";
import { bytesToBase64 } from "./vaultProtocol";

/** One note to push. `serverEmpty` is the SERVER's statement, never a guess. */
export interface DocPushWork {
  docId: string;
  relPath: string;
  /** The server holds no content for this doc (bootstrap `emptyDocs` / `ready.empty`). */
  serverEmpty: boolean;
}

export interface DocBatchPushDeps {
  /** Pinned resident bridge (`VaultDocStore.promote`, no file seed). */
  acquire(docId: string, relPath: string): Promise<NoteBridge>;
  /** Flush + retire it (`VaultDocStore.demote`). */
  release(docId: string): Promise<void>;
  /** `POST /api/vaults/:id/docs/batch`. */
  push(items: DocPushItem[]): Promise<DocPushResult[]>;
  /** Read a note's current file text (`ipc.readNote`, epoch-pinned). */
  readFile?(relPath: string): Promise<string>;
  /**
   * Throw away a doc's LOCAL CRDT (`ipc.clearYjsDoc`, epoch-pinned).
   *
   * Called for exactly one case — a `conflict` on a doc THIS run seeded — and
   * never for a doc whose CRDT holds anything but that seed. See the module
   * header. Optional: a host that cannot do it leaves the seed in place and the
   * doc still goes to the merge path, which is the older (doubling-prone)
   * behaviour, so hosts that can, should.
   */
  discardLocalCrdt?(docId: string): Promise<void>;
}

export interface DocBatchPusherOptions {
  work: DocPushWork[];
  deps: DocBatchPushDeps;
  /** Record a confirmed push (checkpointed by the registry). */
  markPushed: (docId: string) => void;
  /** Docs to leave alone — the open note, whose editor owns its provider. */
  skip?: (docId: string) => boolean;
  progress?: SyncProgressSink;
  onFailure?: (failure: UploadFailure) => void;
  /** Abandon the run (vault switch). Checked before every doc and every chunk. */
  shouldStop?: () => boolean;
  /** Bridges opened at once while packing. Default {@link UPLOAD_CONCURRENCY}. */
  concurrency?: number;
}

export interface DocBatchPushResult {
  /** Docs the server acknowledged (`applied` + `skipped`). */
  pushed: number;
  /** Docs the server refused because it is no longer empty — for `DocSync`. */
  conflicts: string[];
  /** Docs too big for one batch item — also for `DocSync`, unchanged semantics. */
  oversized: DocPushWork[];
  failures: UploadFailure[];
  cancelled: boolean;
  /** Requests actually sent (tests: packing). */
  requests: number;
}

/** A prepared item: the bytes to send plus what we must remember about them. */
interface Prepared {
  docId: string;
  relPath: string;
  update: Uint8Array;
  /** True ⇒ the update came from the FILE and carries `expectEmpty`. */
  seeded: boolean;
}

export class DocBatchPusher {
  private readonly opts: DocBatchPusherOptions;
  private readonly deps: DocBatchPushDeps;
  private readonly progress: SyncProgressSink;

  private stopped = false;
  private failures: UploadFailure[] = [];
  private conflicts: string[] = [];
  private oversized: DocPushWork[] = [];
  private pushed = 0;
  private requests = 0;

  /** Items packed but not yet sent, and their decoded byte total. */
  private pending: Prepared[] = [];
  private pendingBytes = 0;
  /** Serializes the sends, so two full chunks can never be in flight together. */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(opts: DocBatchPusherOptions) {
    this.opts = opts;
    this.deps = opts.deps;
    this.progress = opts.progress ?? nullProgressSink;
  }

  stop(): void {
    this.stopped = true;
  }

  private shouldStop(): boolean {
    return this.stopped || (this.opts.shouldStop?.() ?? false);
  }

  async run(): Promise<DocBatchPushResult> {
    this.failures = [];
    this.conflicts = [];
    this.oversized = [];
    this.pushed = 0;
    this.requests = 0;
    this.pending = [];
    this.pendingBytes = 0;

    const work = this.opts.work;
    if (work.length === 0) {
      return { pushed: 0, conflicts: [], oversized: [], failures: [], cancelled: false, requests: 0 };
    }
    for (const w of work) this.progress.doc(w.docId, "queued");
    this.progress.flush();

    await runPool(work, (item) => this.prepare(item), {
      concurrency: Math.max(1, this.opts.concurrency ?? UPLOAD_CONCURRENCY),
      shouldStop: () => this.shouldStop(),
    });
    // Whatever is left over goes as a short final request.
    await this.flushPending(true);
    await this.sendChain;
    this.progress.flush();

    return {
      pushed: this.pushed,
      conflicts: [...this.conflicts],
      oversized: [...this.oversized],
      failures: [...this.failures],
      cancelled: this.shouldStop(),
      requests: this.requests,
    };
  }

  /**
   * Open one doc, decide what (if anything) it should send, and hand the bytes
   * to the packer. The bridge is released before the request is even built:
   * residency stays at the pool width rather than at a whole chunk.
   */
  private async prepare(item: DocPushWork): Promise<void> {
    const { docId, relPath } = item;
    if (this.shouldStop()) return;
    // Re-checked here and not only when the work list was built: the user can
    // open a note mid-run, and once its editor owns a provider we must not
    // become a second writer on that doc.
    if (this.opts.skip?.(docId)) {
      this.progress.item("ok");
      return;
    }
    this.progress.doc(docId, "syncing");
    let bridge: NoteBridge;
    try {
      bridge = await this.deps.acquire(docId, relPath);
    } catch (e) {
      this.fail(docId, relPath, `open failed: ${msg(e)}`);
      return;
    }
    if (this.shouldStop()) {
      await this.releaseQuietly(docId);
      return;
    }

    try {
      // THE size ceiling, measured the way the server measures it (the encoded
      // state), and BEFORE any seed — a doc can be over the cap with a 0-byte
      // file, which is how four production notes strobed the sync badge.
      const stateBytes = crdtBytes(bridge.doc);
      if (stateBytes > MAX_NOTE_BYTES) {
        this.fail(docId, relPath, sizeReason(stateBytes, "of edit history"), { permanent: true });
        return;
      }

      let seeded = false;
      const localEmpty = bridge.serialize().length === 0;
      if (item.serverEmpty && localEmpty) {
        // Nothing on the server, nothing in the doc: the FILE is the only place
        // this note's text can be. Its size decides whether it belongs in a
        // batch at all — a big file must not be seeded here only to be found
        // oversized a line later, because the seed would then have to be undone.
        const fileText = await this.readFileQuietly(relPath);
        if (this.shouldStop()) return;
        if (fileText != null) {
          const fileBytes = utf8.encode(fileText).byteLength;
          if (fileBytes > MAX_NOTE_BYTES) {
            this.fail(docId, relPath, sizeReason(fileBytes, ""), { permanent: true });
            return;
          }
          if (fileBytes > BULK_ITEM_MAX_BYTES) {
            // Its own socket, unseeded — `ContentUploader` pulls before it seeds.
            this.oversized.push(item);
            this.progress.item("ok");
            return;
          }
          if (fileBytes === 0) {
            // Empty everywhere: nothing to send and nothing to pull. Confirmed
            // by definition (the same settle `SyncManager.settleServerEmpty`
            // makes; this is the belt to its braces).
            this.opts.markPushed(docId);
            this.progress.doc(docId, "synced");
            this.progress.item("ok");
            return;
          }
        }
        seeded = await bridge.seedFromFileIfEmpty();
      }

      const update = Y.encodeStateAsUpdate(bridge.doc);
      if (update.byteLength > MAX_NOTE_BYTES) {
        this.fail(docId, relPath, sizeReason(update.byteLength, "of edit history"), {
          permanent: true,
        });
        return;
      }
      if (update.byteLength > BULK_ITEM_MAX_BYTES) {
        // Oversized AFTER a seed can only mean the file measured small and the
        // doc did not — either way this item leaves the batch. It keeps the
        // seed: the doc is no longer empty, so `ContentUploader`'s
        // `seedFromFileIfEmpty` is a no-op there and the pull still comes first.
        this.oversized.push(item);
        this.progress.item("ok");
        return;
      }
      if (update.byteLength === 0) {
        // A doc with no state at all has nothing to send. (Not markPushed: the
        // server's `ready` remains the authority on what it holds.)
        this.progress.item("ok");
        return;
      }
      this.enqueue({ docId, relPath, update, seeded });
    } catch (e) {
      this.fail(docId, relPath, msg(e));
    } finally {
      await this.releaseQuietly(docId);
    }
  }

  /** Add a prepared item to the open chunk, sending it once it is full. */
  private enqueue(prepared: Prepared): void {
    // Send BEFORE adding when this item would push the chunk over the byte
    // budget: `batch_too_large` is a refusal of the whole request, so the packer
    // must never build one.
    if (
      this.pending.length > 0 &&
      (this.pending.length >= BATCH_MAX_DOCS ||
        this.pendingBytes + prepared.update.byteLength > BATCH_MAX_DECODED_BYTES)
    ) {
      void this.flushPending(false);
    }
    this.pending.push(prepared);
    this.pendingBytes += prepared.update.byteLength;
    if (this.pending.length >= BATCH_MAX_DOCS || this.pendingBytes >= BATCH_MAX_DECODED_BYTES) {
      void this.flushPending(false);
    }
  }

  /** Take the open chunk and queue it behind whatever is already in flight. */
  private flushPending(final: boolean): Promise<void> {
    if (this.pending.length === 0) return final ? this.sendChain : Promise.resolve();
    const chunk = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.sendChain = this.sendChain
      .then(() => this.send(chunk))
      // A listener (or a `markPushed`) that throws must not turn into an
      // unhandled rejection that kills the run's remaining chunks.
      .catch((e) => console.warn("[docs/batch] chunk failed", e));
    return this.sendChain;
  }

  /** One request. Never throws: every item's outcome is recorded. */
  private async send(chunk: Prepared[]): Promise<void> {
    if (this.shouldStop()) return;
    this.requests++;
    const items: DocPushItem[] = chunk.map((p) => ({
      docId: p.docId,
      update: bytesToBase64(p.update),
      // ONLY for a doc we seeded from the file. Sending it for a merge of
      // existing CRDT state would make the server refuse legitimate ops.
      ...(p.seeded ? { expectEmpty: true } : {}),
    }));
    const out = await withRetry(() => this.deps.push(items), {
      isTerminal: isTerminalPushError,
      shouldStop: () => this.shouldStop(),
    });
    if (!out.ok) {
      // The whole chunk failed: a transport failure says nothing about any one
      // note, so each is reported (and retried by the next run) individually.
      for (const p of chunk) this.fail(p.docId, p.relPath, reasonOf(out.error));
      return;
    }
    const byDocId = new Map(out.value.map((r) => [r.docId, r]));
    for (const p of chunk) {
      const res = byDocId.get(p.docId);
      if (!res) {
        this.fail(p.docId, p.relPath, "the server did not answer for this note");
        continue;
      }
      await this.settle(p, res);
    }
  }

  private async settle(p: Prepared, res: DocPushResult): Promise<void> {
    switch (res.status) {
      case "applied":
      case "skipped":
        // `skipped` = the merge captured no new update, i.e. the server already
        // held this state. Confirmed just as firmly as `applied`.
        this.opts.markPushed(p.docId);
        this.progress.doc(p.docId, "synced");
        this.progress.item("ok");
        this.pushed++;
        return;
      case "conflict": {
        // The server is not empty after all. Nothing was applied there; undo the
        // seed HERE and let the per-doc path do the real merge — see the header.
        this.conflicts.push(p.docId);
        if (p.seeded && this.deps.discardLocalCrdt) {
          try {
            await this.deps.discardLocalCrdt(p.docId);
          } catch (e) {
            // The seed survives; the merge path still runs, which is the older
            // behaviour. Worth a line, never worth failing the run.
            console.warn(`[docs/batch] couldn't discard the seed for ${p.docId}`, e);
          }
        }
        this.progress.doc(p.docId, "queued");
        this.progress.item("ok");
        return;
      }
      case "denied":
        // A read-only grant. Retrying cannot help and must not be attempted on
        // every `ready` — permanent for this session, like the read-only case
        // `ContentUploader` records.
        this.fail(p.docId, p.relPath, "edit could not be sent: no write access", {
          permanent: true,
        });
        return;
      case "too_large":
        this.fail(p.docId, p.relPath, sizeReason(p.update.byteLength, "of edit history"), {
          permanent: true,
        });
        return;
      default:
        this.fail(p.docId, p.relPath, res.error ?? res.code ?? "the server refused this note");
        return;
    }
  }

  private async readFileQuietly(relPath: string): Promise<string | null> {
    if (!this.deps.readFile) return null;
    try {
      return await this.deps.readFile(relPath);
    } catch {
      return null; // unreadable ⇒ let the normal path decide (and report)
    }
  }

  private async releaseQuietly(docId: string): Promise<void> {
    try {
      await this.deps.release(docId);
    } catch (e) {
      console.warn(`[docs/batch] release failed for ${docId}`, e);
    }
  }

  private fail(
    docId: string,
    relPath: string,
    reason: string,
    opts: { permanent?: boolean } = {},
  ): void {
    const failure: UploadFailure = {
      docId,
      relPath,
      reason,
      ...(opts.permanent ? { permanent: true } : {}),
    };
    this.failures.push(failure);
    try {
      this.opts.onFailure?.(failure);
    } catch (e) {
      console.warn("[docs/batch] failure listener threw", e);
    }
    this.progress.doc(docId, "error");
    this.progress.item("failed");
    // Deliberately NO failure streak: see the module header.
  }
}

const utf8 = new TextEncoder();

/** 4xx other than 429 cannot be fixed by sending the same bytes again. */
function isTerminalPushError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return false;
  if (status === 429) return false;
  return status >= 400 && status < 500;
}

function sizeReason(bytes: number, what: string): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const cap = Math.round(MAX_NOTE_BYTES / (1024 * 1024));
  return `too large to sync (${mb} MB${what ? " " + what : ""}; the limit is ${cap} MB)`;
}

function reasonOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return code;
  return msg(e);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
