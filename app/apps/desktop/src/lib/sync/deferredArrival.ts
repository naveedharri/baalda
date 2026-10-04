// Receiving side without placeholders, for SMALL arrivals too.
//
// A teammate's new note, or a grant of a handful of notes, used to land as a
// 0-byte placeholder first and fill in a moment later when the vault channel's
// backfill frame arrived. When the channel is connected and live, the pull now
// DEFERS those placeholders (the same pending map a bootstrap download uses)
// and the first content frame for the doc creates the file WITH its text in one
// create-only write, through the bootstrap apply (`apply_bootstrap_batch`).
// A doc whose content does not arrive within DEFERRED_ARRIVAL_WAIT_MS gets its
// placeholder after all, so nothing stays invisible.

import * as Y from "yjs";
import type { BootstrapEntry, BootstrapOutcome } from "../ipc";
import { MAX_NOTE_BYTES } from "./contentUpload";

/** How long a deferred small arrival may wait for its content (ms). */
export const DEFERRED_ARRIVAL_WAIT_MS = 2000;

/** What the live-arrival predicate needs to know about the session. */
export interface LiveArrivalState {
  serverTooOld: boolean;
  /** The vault channel is connected (`synced`). */
  channelSynced: boolean;
  /** The session is live (channel synced + one completed pull). */
  live: boolean;
  /** The channel skips backfill (the bulk engine pages content over HTTP). */
  liveOnly: boolean;
  /** Docs this device holds a local CRDT for (the store's manifest). */
  held: ReadonlySet<string>;
  /** Docs the server said it holds no state for (`ready.empty`). */
  serverEmpty: ReadonlySet<string>;
}

/**
 * Will the vault channel deliver this doc's content in a moment? `null` when
 * the channel cannot be trusted to (not connected, not live, too old a server,
 * backfill switched off). Otherwise yes for every doc except the ones this
 * device holds CRDT for (today's placeholder + `materializeContent` path) and
 * the ones the server holds nothing for (they need a placeholder to type into).
 */
export function liveArrivalPredicate(s: LiveArrivalState): ((docId: string) => boolean) | null {
  if (s.serverTooOld || !s.channelSynced || !s.live || s.liveOnly) return null;
  return (docId) => !s.held.has(docId) && !s.serverEmpty.has(docId);
}

/**
 * The bootstrap entry for one doc's FULL state, or null when it is not one.
 *
 * A live update for a doc this device has never seen can be an increment whose
 * dependencies are missing; storing that as the snapshot would start the local
 * CRDT from a hole. Such an update (pending structs or deletes), an oversized
 * note, or an unreadable update goes the ordinary cold-apply way instead.
 */
export function fullStateEntry(
  docId: string,
  relPath: string,
  update: Uint8Array,
): BootstrapEntry | null {
  if (update.byteLength > MAX_NOTE_BYTES) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    if (doc.store.pendingStructs || doc.store.pendingDs) return null;
    const content = doc.getText("content").toString();
    if (new TextEncoder().encode(content).byteLength > MAX_NOTE_BYTES) return null;
    return { docId, relPath, content, snapshot: update, stateVector: Y.encodeStateVector(doc) };
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

export interface DeferredCreateDeps {
  /** The deferred path for `docId`, or null when its placeholder is not pending. */
  deferredPathFor(docId: string): string | null;
  /** `ipc.applyBootstrapBatch`, epoch-pinned. */
  applyBatch(entries: BootstrapEntry[]): Promise<BootstrapOutcome[]>;
  /** `registry.markMaterialized`: one owed watcher echo, and clears the pending entry. */
  markMaterialized(relPath: string): void;
  /** The server's copy is now the local CRDT. */
  markPushed(docId: string): void;
}

/**
 * Create a deferred doc's file WITH its content, create-only. Returns the new
 * state vector when the file was written (or already held exactly this text),
 * else null — the caller then takes the ordinary cold-apply path, which merges.
 */
export async function createDeferredWithContent(
  deps: DeferredCreateDeps,
  docId: string,
  path: string,
  update: Uint8Array,
): Promise<Uint8Array | null> {
  const rp = deps.deferredPathFor(docId);
  if (!rp || rp !== path) return null;
  const entry = fullStateEntry(docId, rp, update);
  if (!entry) return null;
  let outcomes: BootstrapOutcome[];
  try {
    outcomes = await deps.applyBatch([entry]);
  } catch (e) {
    console.warn(`[sync] creating ${rp} with its content failed`, e);
    return null;
  }
  const status = outcomes.find((o) => o.docId === docId)?.status;
  if (status !== "written" && status !== "unchanged") return null;
  deps.markMaterialized(rp);
  deps.markPushed(docId);
  return entry.stateVector;
}

/**
 * The bounded wait: one timer that writes every still-deferred placeholder
 * {@link DEFERRED_ARRIVAL_WAIT_MS} after it is armed. Re-arming while armed
 * keeps the earlier deadline, so a stream of pulls cannot starve the flush.
 */
export class DeferredArrivalFlush {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: () => void,
    private readonly setT: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) =>
      setTimeout(fn, ms),
    private readonly clearT: (h: ReturnType<typeof setTimeout>) => void = (h) => clearTimeout(h),
    private readonly waitMs: number = DEFERRED_ARRIVAL_WAIT_MS,
  ) {}

  arm(): void {
    if (this.timer) return;
    this.timer = this.setT(() => {
      this.timer = null;
      this.flush();
    }, this.waitMs);
  }

  /** Flush now (a vault-channel drop): nothing more is coming over it. */
  flushNow(): void {
    this.cancel();
    this.flush();
  }

  cancel(): void {
    if (this.timer) this.clearT(this.timer);
    this.timer = null;
  }

  armed(): boolean {
    return this.timer != null;
  }
}
