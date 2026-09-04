// Production wiring: maps the bridge's injected I/O to `ipc.ts` (Tauri) and a
// Web Crypto SHA-256, plus a small manager that owns the currently-open note's
// bridge and routes watcher events into it.

import * as ipc from "../ipc";
import { currentVaultEpoch } from "../sync/vaultScope";
import { dismissToast, toast } from "../toast";
import { NoteBridge } from "./noteBridge";
import type { BridgeIO } from "./types";

/**
 * One sticky "couldn't save" toast per note with a failing egest, dismissed the
 * moment a write lands. Module-level so every bridge (the open note's and the
 * background store's) shares the same de-duplication.
 */
const saveFailureToasts = new Map<string, number>();

function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

/** An egest write failed. Surface it once (sticky), keep it until it recovers. */
export function reportSaveFailure(relPath: string, err: unknown, attempt: number): void {
  if (saveFailureToasts.has(relPath)) return;
  const id = toast(
    `Couldn't save "${baseName(relPath)}" to disk — ${errorText(err)}. Your text is kept and the save will be retried.`,
    "error",
  );
  saveFailureToasts.set(relPath, id);
  if (attempt > 1) console.warn(`[bridge] save still failing for ${relPath} (attempt ${attempt})`);
}

/** A write landed after failures: clear the warning. */
export function reportSaveRecovered(relPath: string): void {
  const id = saveFailureToasts.get(relPath);
  if (id == null) return;
  saveFailureToasts.delete(relPath);
  dismissToast(id);
  toast(`Saved "${baseName(relPath)}"`, "success");
}

/** SHA-256 hex via the Web Crypto API (available in the Tauri webview). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build the production BridgeIO backed by Rust commands.
 *
 * `epoch` pins every disk/CRDT call to ONE vault (see `state::Inner::vault_epoch`).
 * It matters most on teardown: closing a note flushes its pending egest, and that
 * flush can land *after* Rust has swapped to another vault — writing note A's
 * text over the same relative path in vault B (both vaults have `Welcome.md`).
 * Pass the epoch that was current when the bridge was opened; Rust then refuses
 * the write instead of putting it in the wrong folder. Omit it only where no
 * vault identity is knowable (tests inject their own IO anyway).
 */
export function createTauriBridgeIO(epoch?: ipc.VaultEpoch): BridgeIO {
  return {
    readFile: (path) => ipc.readNote(path, epoch),
    // write_note performs the atomic temp-file+rename AND re-indexes in Rust,
    // so egest gets FTS/backlink refresh for free — no separate reindex hook.
    writeFileAtomic: (path, content) => ipc.writeNote(path, content, epoch),
    sha256: sha256Hex,
    // A failed write is the one bridge error a person must see (#81): the .md is
    // the durable copy, and "nothing happened" is how it would otherwise read.
    onWriteFailed: reportSaveFailure,
    onWriteRecovered: reportSaveRecovered,
    persistence: {
      loadState: async (docId) => {
        const s = await ipc.loadYjsState(docId, epoch);
        return {
          snapshot: s.snapshot ? new Uint8Array(s.snapshot) : null,
          updates: s.updates.map((u) => new Uint8Array(u)),
          updateCount: s.updateCount,
        };
      },
      appendUpdate: (docId, update) => ipc.appendYjsUpdate(docId, update, epoch),
      saveSnapshot: (docId, snapshot, stateVector) =>
        ipc.saveYjsSnapshot(docId, snapshot, stateVector, epoch),
    },
  };
}

/**
 * Owns the bridge for the currently-open note. The editor opens a note through
 * this; the watcher subscription funnels `file-changed` events into the live
 * bridge's debounced ingest.
 */
export class BridgeManager {
  /** Injected IO (tests). When absent, production IO is built per `openNote` so
   *  it can be pinned to the vault epoch that open ran under. */
  private readonly io: BridgeIO | null;
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

  constructor(io?: BridgeIO) {
    this.io = io ?? null;
  }

  /**
   * The IO a newly-opened note should use. Production builds a fresh one pinned
   * to the CURRENT vault epoch, so the bridge (and every later flush/persist it
   * does, including the one on close) is bound to the vault it was opened in.
   */
  private ioForOpen(): BridgeIO {
    return this.io ?? createTauriBridgeIO(currentVaultEpoch());
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
    // Captured before the queue wait: this is the vault the *request* was made
    // in, which is the vault whose file the caller means.
    const io = this.ioForOpen();
    return this.enqueue(async () => {
      if (this.current?.path === path && this.current.docId === docId) {
        return this.current.bridge;
      }
      await this.closeCurrentNow();
      const bridge = await NoteBridge.open(io, {
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
