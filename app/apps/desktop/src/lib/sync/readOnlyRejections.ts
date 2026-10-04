/**
 * The server dropped ops this device pushed over a READ-ONLY connection
 * (vault channel `{ t: "rejected", reason: "read_only" }`). Hocuspocus drops
 * them silently, so without this the edit would live only in the local CRDT
 * and the next pull would write the server's text over the file.
 *
 * The server reports ANY sync that carries ops it lacks, and a plain open of a
 * read-only note replays whatever stale ops the local CRDT holds (an old disk
 * ingest, history from before the note became read-only). So the frame alone
 * is not "the user edited": only a note with a real local edit this session
 * ({@link hasLocalEdit}) is told about it, once per note per session, through
 * the transient toast. Its review entry (`keptLocally` + {@link READ_ONLY_DETAIL})
 * stays reachable from Activity but never raises the persistent banner.
 *
 * Keeping the stray ops would repeat the frame on every connect, forever. So a
 * rejected doc is REBASED onto the server, once per doc per session: pull the
 * server's state, save ONE recovery copy to `.context/trash` when the user
 * really edited it or the file differs from the server's text (quietly, with
 * no report, for the second), then replace the local CRDT and the file with the
 * server's state (`replaceLocal`). The open note is never rebased under its
 * editor: its copy is taken at the frame and the rebase runs when it closes
 * ({@link ReadOnlyRejections.closed}). A host without `serverState` /
 * `replaceLocal` keeps the older behaviour: a copy at most once per doc per
 * {@link REJECTION_WINDOW_MS}.
 */
import { hasLocalEdit } from "../bridge/localEdits";
import { markReadOnlyDoc } from "../bridge/readOnlyDocs";
import { toast } from "../toast";
import { reconcileReport } from "./reconcileReport";

export const REJECTION_WINDOW_MS = 60_000;
export const READ_ONLY_DETAIL = "read-only: your edit was not accepted; a copy is in .context/trash";
export const READ_ONLY_TOAST = "This note is read-only for you, so your edit was not saved. A copy is in .context/trash.";

/** Session state. Module state on purpose: the vault channel (and its handler)
 *  is rebuilt on every reconnect and vault switch. */
const announced = new Set<string>();
/** Docs rebased onto the server this session: never again. */
const rebased = new Set<string>();
/** Docs that already have their one recovery copy this session. */
const copied = new Set<string>();
/** Open notes whose rebase waits for the editor to close. */
const pendingOpen = new Set<string>();
const inflight = new Set<string>();

export interface ServerDocState {
  /** The server's full state for the doc (a bootstrap `only` pull). */
  update: Uint8Array;
  /** Its text (`Y.Text("content")`). */
  text: string;
}

export interface ReadOnlyRejectionDeps {
  /** The mapped path for `docId`, or null when this vault no longer maps it. */
  pathOf(docId: string): string | null;
  /** This device's local text for `docId` (open bridge, resident, or CRDT store). */
  localText(docId: string): Promise<string | null>;
  /** `ipc.writeTrashCopy`, epoch-pinned; resolves to the trash-relative path. */
  writeTrashCopy(path: string, stamp: string, content: string): Promise<string>;
  /** Whether the user really edited `docId` this session. Default {@link hasLocalEdit}. */
  userEdited?(docId: string): boolean;
  /** The transient notice. Default: the app's standard auto-fading toast. */
  notify?(text: string): void;
  now?: () => number;
  /** The note's file text (`ipc.readNote`). Falls back to {@link localText}. */
  readFile?(path: string): Promise<string>;
  /** Pull the server's state; null when it cannot (offline, old server, unreadable). */
  serverState?(docId: string): Promise<ServerDocState | null>;
  /**
   * Throw the local CRDT away and start over from the server's state: release
   * and drop the bridge, clear the CRDT store, write `text` to the file (which
   * records the disk base) and re-hydrate from `update`.
   */
  replaceLocal?(docId: string, path: string, update: Uint8Array, text: string): Promise<void>;
  /** The editor holds `docId` now: never rebase under it. */
  isOpen?(docId: string): boolean;
}

export class ReadOnlyRejections {
  private readonly last = new Map<string, number>();
  constructor(private readonly deps: ReadOnlyRejectionDeps) {}

  private get canRebase(): boolean {
    return !!(this.deps.serverState && this.deps.replaceLocal);
  }

  /** Handle one frame. Resolves to whether a copy was saved. Never throws. */
  async handle(docId: string): Promise<boolean> {
    if (rebased.has(docId) || inflight.has(docId)) return false;
    // The server just said so: no ingest may take the file into this doc now.
    markReadOnlyDoc(docId, true);
    const now = (this.deps.now ?? Date.now)();
    const prev = this.last.get(docId);
    if (prev !== undefined && now - prev < REJECTION_WINDOW_MS) return false;
    this.last.set(docId, now);
    inflight.add(docId);
    try {
      const path = this.deps.pathOf(docId);
      if (!path) return false;
      if (!this.canRebase || (this.deps.isOpen?.(docId) ?? false)) {
        if (this.canRebase) pendingOpen.add(docId);
        if (this.canRebase && copied.has(docId)) return false;
        const text = await this.deps.localText(docId);
        if (!text || text.trim().length === 0) return false;
        await this.keep(docId, path, text, now);
        return true;
      }
      const server = await this.deps.serverState!(docId);
      if (!server) {
        this.last.delete(docId); // try again on the next frame
        return false;
      }
      let local: string | null = null;
      if (this.deps.readFile) {
        try {
          local = await this.deps.readFile(path);
        } catch {
          local = null;
        }
      }
      if (local == null) local = await this.deps.localText(docId);
      const edited = (this.deps.userEdited ?? hasLocalEdit)(docId);
      const hasText = local != null && local.trim().length > 0;
      let saved = false;
      if (hasText && !copied.has(docId) && (edited || local !== server.text)) {
        // A failed copy throws: the file stays the durable copy, nothing is replaced.
        await this.keep(docId, path, local!, now);
        saved = true;
      }
      await this.deps.replaceLocal!(docId, path, server.update, server.text);
      rebased.add(docId);
      pendingOpen.delete(docId);
      console.info(`[sync] read-only note ${path} rebased onto the server's copy`);
      return saved;
    } catch (e) {
      // Let the next frame (after the window) try again.
      this.last.delete(docId);
      console.warn(`[sync] could not preserve a rejected read-only edit for ${docId}`, e);
      return false;
    } finally {
      inflight.delete(docId);
    }
  }

  /** The editor let go of `docId`: run the rebase its frame had to defer. */
  async closed(docId: string): Promise<boolean> {
    if (!pendingOpen.has(docId)) return false;
    pendingOpen.delete(docId);
    this.last.delete(docId);
    return this.handle(docId);
  }

  /** Save one recovery copy and report it (the toast only for a real edit). */
  private async keep(docId: string, path: string, text: string, now: number): Promise<void> {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const dest = await this.deps.writeTrashCopy(path, stamp, text);
    copied.add(docId);
    const edited = (this.deps.userEdited ?? hasLocalEdit)(docId);
    if (!edited) {
      // Stale ops replayed on open, or a file that drifted: keep the copy, tell nobody.
      console.info(`[sync] read-only sync for ${path} carried old local ops; copy at ${dest}`);
      return;
    }
    if (!announced.has(docId)) {
      announced.add(docId);
      reconcileReport.record({ kind: "keptLocally", docId, path, detail: READ_ONLY_DETAIL });
      (this.deps.notify ?? ((t: string) => toast(t, "neutral")))(READ_ONLY_TOAST);
    }
    console.info(`[sync] read-only push for ${path} was rejected; local copy at ${dest}`);
  }

  clear(): void {
    this.last.clear();
  }
}

/** Test/teardown helper: forget which notes were announced. */
export function resetReadOnlyAnnouncements(): void {
  announced.clear();
  rebased.clear();
  copied.clear();
  pendingOpen.clear();
  inflight.clear();
}

/** Whether `docId` was rebased onto the server this session. */
export function wasRebased(docId: string): boolean {
  return rebased.has(docId);
}

/** A read-only rejection entry: listed in Activity, never on the banner. */
export function isReadOnlyRejection(it: { kind: string; detail?: string }): boolean {
  return it.kind === "keptLocally" && it.detail === READ_ONLY_DETAIL;
}
