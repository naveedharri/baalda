/**
 * The server dropped ops this device pushed over a READ-ONLY connection
 * (vault channel `{ t: "rejected", reason: "read_only" }`). Hocuspocus drops
 * them silently, so without this the edit would live only in the local CRDT
 * and the next pull would write the server's text over the file.
 *
 * Once per doc per {@link REJECTION_WINDOW_MS}: save the doc's current local
 * text to `.context/trash` and tell the user (reconcile report, `keptLocally`).
 * The server throttles per connection (~5 s); this throttles per doc, so a
 * reconnect storm cannot fill the trash with copies of the same edit.
 */
import { reconcileReport } from "./reconcileReport";

export const REJECTION_WINDOW_MS = 60_000;
export const READ_ONLY_DETAIL = "read-only: your edit was not accepted; a copy is in .context/trash";

export interface ReadOnlyRejectionDeps {
  /** The mapped path for `docId`, or null when this vault no longer maps it. */
  pathOf(docId: string): string | null;
  /** This device's local text for `docId` (open bridge, resident, or CRDT store). */
  localText(docId: string): Promise<string | null>;
  /** `ipc.writeTrashCopy`, epoch-pinned; resolves to the trash-relative path. */
  writeTrashCopy(path: string, stamp: string, content: string): Promise<string>;
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
      reconcileReport.record({ kind: "keptLocally", docId, path, detail: READ_ONLY_DETAIL });
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
