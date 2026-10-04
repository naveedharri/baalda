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
 * Either way the local text is saved to `.context/trash` at most once per doc
 * per {@link REJECTION_WINDOW_MS}, so nothing is lost. The server throttles per
 * connection (~5 s); this throttles per doc, so a reconnect storm cannot fill
 * the trash with copies of the same edit.
 */
import { hasLocalEdit } from "../bridge/localEdits";
import { toast } from "../toast";
import { reconcileReport } from "./reconcileReport";

export const REJECTION_WINDOW_MS = 60_000;
export const READ_ONLY_DETAIL = "read-only: your edit was not accepted; a copy is in .context/trash";
export const READ_ONLY_TOAST = "This note is read-only for you, so your edit was not saved. A copy is in .context/trash.";

/** Notes already announced this session. Module state on purpose: the vault
 *  channel (and its handler) is rebuilt on every reconnect and vault switch. */
const announced = new Set<string>();

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
}

export class ReadOnlyRejections {
  private readonly last = new Map<string, number>();
  constructor(private readonly deps: ReadOnlyRejectionDeps) {}

  /** Handle one frame. Resolves to whether a copy was saved. Never throws. */
  async handle(docId: string): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    const prev = this.last.get(docId);
    if (prev !== undefined && now - prev < REJECTION_WINDOW_MS) return false;
    this.last.set(docId, now);
    try {
      const path = this.deps.pathOf(docId);
      if (!path) return false;
      const text = await this.deps.localText(docId);
      if (!text || text.trim().length === 0) return false;
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      const dest = await this.deps.writeTrashCopy(path, stamp, text);
      const edited = (this.deps.userEdited ?? hasLocalEdit)(docId);
      if (!edited) {
        // Stale ops replayed on open: keep the copy, tell nobody.
        console.info(`[sync] read-only sync for ${path} carried old local ops; copy at ${dest}`);
        return true;
      }
      if (!announced.has(docId)) {
        announced.add(docId);
        reconcileReport.record({ kind: "keptLocally", docId, path, detail: READ_ONLY_DETAIL });
        (this.deps.notify ?? ((t: string) => toast(t, "neutral")))(READ_ONLY_TOAST);
      }
      console.info(`[sync] read-only push for ${path} was rejected; local copy at ${dest}`);
      return true;
    } catch (e) {
      // Let the next frame (after the window) try again.
      this.last.delete(docId);
      console.warn(`[sync] could not preserve a rejected read-only edit for ${docId}`, e);
      return false;
    }
  }

  clear(): void {
    this.last.clear();
  }
}

/** Test/teardown helper: forget which notes were announced. */
export function resetReadOnlyAnnouncements(): void {
  announced.clear();
}

/** A read-only rejection entry: listed in Activity, never on the banner. */
export function isReadOnlyRejection(it: { kind: string; detail?: string }): boolean {
  return it.kind === "keptLocally" && it.detail === READ_ONLY_DETAIL;
}
