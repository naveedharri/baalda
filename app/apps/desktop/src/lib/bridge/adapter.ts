// Production wiring: maps the bridge's injected I/O to `ipc.ts` (Tauri) and a
// Web Crypto SHA-256, plus a small manager that owns the currently-open note's
// bridge and routes watcher events into it.

import * as ipc from "../ipc";
import { NoteBridge } from "./noteBridge";
import type { BridgeIO } from "./types";

/** SHA-256 hex via the Web Crypto API (available in the Tauri webview). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the production BridgeIO backed by Rust commands. */
export function createTauriBridgeIO(): BridgeIO {
  return {
    readFile: (path) => ipc.readNote(path),
    // write_note performs the atomic temp-file+rename AND re-indexes in Rust,
    // so egest gets FTS/backlink refresh for free — no separate reindex hook.
    writeFileAtomic: (path, content) => ipc.writeNote(path, content),
    sha256: sha256Hex,
    persistence: {
      loadState: async (docId) => {
        const s = await ipc.loadYjsState(docId);
        return {
          snapshot: s.snapshot ? new Uint8Array(s.snapshot) : null,
          updates: s.updates.map((u) => new Uint8Array(u)),
          updateCount: s.updateCount,
        };
      },
      appendUpdate: (docId, update) => ipc.appendYjsUpdate(docId, update),
      saveSnapshot: (docId, snapshot, stateVector) =>
        ipc.saveYjsSnapshot(docId, snapshot, stateVector),
    },
  };
}

/**
 * Owns the bridge for the currently-open note. The editor opens a note through
 * this; the watcher subscription funnels `file-changed` events into the live
 * bridge's debounced ingest.
 */
export class BridgeManager {
  private io: BridgeIO;
  private current: { path: string; docId: string; bridge: NoteBridge } | null =
    null;

  /**
   * Serialises open/close so the slot has exactly one writer at a time.
   *
   * A fast note switch calls `openNote(B)` while `openNote(A)` is still awaiting
   * `NoteBridge.open` (React runs the old effect's cleanup — which only fires
   * `closeCurrent()` — before the new effect body). Without a queue the two
   * opens interleave and the later assignment silently overwrites the earlier
   * one, dropping a fully-wired bridge without `destroy()`. Worse, two
   * concurrent opens of the SAME doc_id both see an empty CRDT log and both
   * seed from the file, so the note's persisted history ends up containing the
   * file's text twice (two client ids ⇒ the inserts merge instead of dedupe).
   */
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped per `openNote` call: only the newest request may install a bridge. */
  private generation = 0;

  constructor(io: BridgeIO = createTauriBridgeIO()) {
    this.io = io;
  }

  /** Run `fn` after every previously-queued open/close, whatever their outcome. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Swallow on the chain only — the caller still sees the real outcome.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async openNote(
    path: string,
    docId: string,
    opts: { seedFromFile?: boolean } = {},
  ): Promise<NoteBridge> {
    const gen = ++this.generation;
    return this.enqueue(async () => {
      if (this.current?.path === path && this.current.docId === docId) {
        return this.current.bridge;
      }
      await this.closeCurrentNow();
      const bridge = await NoteBridge.open(this.io, {
        docId,
        path,
        seedFromFile: opts.seedFromFile,
      });
      if (gen !== this.generation) {
        // A newer openNote was requested while we were opening. Never install a
        // stale bridge over the newest slot: retire this one ourselves so it
        // can't outlive its request. The caller is a React effect that has
        // already been cleaned up (`cancelled`), so it drops the return value.
        await this.retire(bridge);
        return bridge;
      }
      this.current = { path, docId, bridge };
      return bridge;
    });
  }

  /** Route a watcher event: ingest if it targets the open note. */
  handleFileChanged(path: string): void {
    if (this.current?.path === path) this.current.bridge.ingest();
  }

  currentBridge(): NoteBridge | null {
    return this.current?.bridge ?? null;
  }

  currentPath(): string | null {
    return this.current?.path ?? null;
  }

  /**
   * Close the open note. Queued behind any in-flight open, so closing during a
   * note switch can't no-op on an empty slot and leave that bridge resident.
   */
  async closeCurrent(): Promise<void> {
    // A close supersedes any *pending* open (there is nothing to show it in).
    this.generation++;
    await this.enqueue(() => this.closeCurrentNow());
  }

  /** Unqueued close — only call from inside the queue. */
  private async closeCurrentNow(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    await this.retire(cur.bridge);
  }

  /** Flush a bridge's pending write, then tear it down. Never throws. */
  private async retire(bridge: NoteBridge): Promise<void> {
    try {
      await bridge.flushEgest();
    } catch (e) {
      console.error("[bridge] flush on close failed", e);
    }
    bridge.destroy();
  }
}

/** Process-wide singleton used by the UI. */
export const bridgeManager = new BridgeManager();
