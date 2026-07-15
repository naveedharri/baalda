// VaultDocStore (spec 05 §3.4) — the bridge-tiering DocUpdateSink the Vault Sync
// Engine writes into. It keeps disk current for every synced doc without holding
// a Y.Doc for all of them:
//
//   • Hot tier  — recently opened/edited docs (LRU, cap HOT_DOC_CAP) hold a
//     resident NoteBridge. A remote update is `applyRemote`d, which egests to the
//     .md and persists via the bridge's own machinery (origin 'remote', not
//     'disk', so it isn't dropped as an echo).
//   • Cold tier — everything else is NOT resident. A remote update opens a
//     transient headless bridge, applies + flushes to disk + persists, then
//     evicts. Cost is paid only when a cold doc actually changes.
//
// Background egest can't echo-loop: only the OPEN note ingests file changes
// (BridgeManager.handleFileChanged), so a background write to a closed note's
// .md has no ingest side to react to it.

import * as Y from "yjs";
import { NoteBridge } from "../bridge/noteBridge";
import { createTauriBridgeIO } from "../bridge/adapter";
import type { BridgeIO } from "../bridge/types";
import type { DocUpdateSink } from "./vaultSyncEngine";

/** Default resident-doc cap (spec 05 §10; override via opts). */
export const HOT_DOC_CAP = 100;
const RECENT_CAP = 64;

export interface VaultDocStoreOptions {
  /** Resolve a docId to its vault-relative path (from the registry). */
  resolvePath: (docId: string) => string | null;
  io?: BridgeIO;
  hotCap?: number;
}

interface HotEntry {
  path: string;
  bridge: NoteBridge;
  touch: number;
}

export class VaultDocStore implements DocUpdateSink {
  private readonly io: BridgeIO;
  private readonly resolvePath: (docId: string) => string | null;
  private readonly hotCap: number;

  private readonly hot = new Map<string, HotEntry>();
  /** Last-known state vector per doc we've synced — powers a cheap manifest so
   *  reconnects only pull deltas. Kept even after a hot doc is evicted. */
  private readonly svCache = new Map<string, Uint8Array>();
  /** Most-recently-touched docIds (tail = newest) for backfill prioritisation. */
  private readonly recent: string[] = [];
  /** Per-doc promise chain so concurrent cold applies for one doc serialise. */
  private readonly coldChains = new Map<string, Promise<void>>();

  private touchSeq = 0;
  /** The currently-open note, if any: its own Hocuspocus provider syncs it, so
   *  the background feed skips it to avoid two writers on one doc (spec 05 §3.4). */
  private suppressed: string | null = null;

  constructor(opts: VaultDocStoreOptions) {
    this.io = opts.io ?? createTauriBridgeIO();
    this.resolvePath = opts.resolvePath;
    this.hotCap = opts.hotCap ?? HOT_DOC_CAP;
  }

  // ---- DocUpdateSink ----------------------------------------------------

  knownDocs(): string[] {
    return [...this.svCache.keys()];
  }

  async stateVector(docId: string): Promise<Uint8Array | null> {
    const entry = this.hot.get(docId);
    if (entry) return Y.encodeStateVector(entry.bridge.doc);
    return this.svCache.get(docId) ?? null;
  }

  recentDocs(): string[] {
    return [...this.recent].reverse(); // newest first
  }

  /** Mark the open note (or null). Updates for it are handled by its editor's
   *  Hocuspocus provider, so the background feed ignores them. */
  setSuppressedDoc(docId: string | null): void {
    this.suppressed = docId;
  }

  async applyUpdate(docId: string, update: Uint8Array): Promise<void> {
    if (docId === this.suppressed) return; // open note: its own provider owns it
    const entry = this.hot.get(docId);
    if (entry) {
      entry.bridge.applyRemote(update);
      entry.touch = ++this.touchSeq;
      this.svCache.set(docId, Y.encodeStateVector(entry.bridge.doc));
      return;
    }
    await this.enqueueCold(docId, update);
  }

  drop(docId: string): void {
    const entry = this.hot.get(docId);
    if (entry) {
      this.hot.delete(docId);
      // Flush any pending write, then tear down — access is gone, so stop syncing.
      void entry.bridge.flushEgest().finally(() => entry.bridge.destroy());
    }
    this.svCache.delete(docId);
    const i = this.recent.indexOf(docId);
    if (i !== -1) this.recent.splice(i, 1);
  }

  // ---- Public tier controls (used by the open-note path, Phase E) -------

  /** Promote a doc to the hot tier (resident bridge), returning it. Idempotent. */
  async promote(
    docId: string,
    path: string,
    opts: { seedFromFile?: boolean } = {},
  ): Promise<NoteBridge> {
    const existing = this.hot.get(docId);
    if (existing) {
      existing.touch = ++this.touchSeq;
      this.markRecent(docId);
      return existing.bridge;
    }
    const bridge = await NoteBridge.open(this.io, {
      docId,
      path,
      seedFromFile: opts.seedFromFile ?? false,
    });
    this.hot.set(docId, { path, bridge, touch: ++this.touchSeq });
    this.svCache.set(docId, Y.encodeStateVector(bridge.doc));
    this.markRecent(docId);
    this.evictIfNeeded();
    return bridge;
  }

  hotBridge(docId: string): NoteBridge | null {
    return this.hot.get(docId)?.bridge ?? null;
  }

  markRecent(docId: string): void {
    const i = this.recent.indexOf(docId);
    if (i !== -1) this.recent.splice(i, 1);
    this.recent.push(docId);
    if (this.recent.length > RECENT_CAP) this.recent.shift();
  }

  /** Tear everything down (app shutdown / sign-out). */
  async destroyAll(): Promise<void> {
    const entries = [...this.hot.values()];
    this.hot.clear();
    await Promise.all(
      entries.map((e) => e.bridge.flushEgest().finally(() => e.bridge.destroy())),
    );
  }

  // ---- internals --------------------------------------------------------

  private enqueueCold(docId: string, update: Uint8Array): Promise<void> {
    const prev = this.coldChains.get(docId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.coldApply(docId, update));
    this.coldChains.set(
      docId,
      next.finally(() => {
        if (this.coldChains.get(docId) === next) this.coldChains.delete(docId);
      }),
    );
    return next;
  }

  private async coldApply(docId: string, update: Uint8Array): Promise<void> {
    const path = this.resolvePath(docId);
    if (!path) return; // unknown doc (not yet materialised) — skip; next reconnect retries
    // Transient bridge: hydrate from local CRDT, apply the delta, write, persist,
    // evict. seedFromFile:false — the server feed is the source for background docs.
    const bridge = await NoteBridge.open(this.io, { docId, path, seedFromFile: false });
    try {
      bridge.applyRemote(update);
      await bridge.flushEgest();
      this.svCache.set(docId, Y.encodeStateVector(bridge.doc));
    } finally {
      bridge.destroy();
    }
  }

  private evictIfNeeded(): void {
    while (this.hot.size > this.hotCap) {
      let lruId: string | null = null;
      let lruTouch = Infinity;
      for (const [id, e] of this.hot) {
        if (e.touch < lruTouch) {
          lruTouch = e.touch;
          lruId = id;
        }
      }
      if (lruId == null) break;
      const e = this.hot.get(lruId)!;
      this.hot.delete(lruId);
      // Keep the svCache entry so the manifest stays cheap after eviction.
      void e.bridge.flushEgest().finally(() => e.bridge.destroy());
    }
  }
}
