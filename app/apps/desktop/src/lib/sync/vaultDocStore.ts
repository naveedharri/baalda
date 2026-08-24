// VaultDocStore (spec 05 §3.4) — the bridge-tiering DocUpdateSink the Vault Sync
// Engine writes into. It keeps disk current for every synced doc without holding
// a Y.Doc for all of them:
//
//   • Hot tier  — recently opened/edited docs (LRU, cap HOT_DOC_CAP) hold a
//     resident NoteBridge. A remote update is `applyRemote`d, which egests to the
//     .md and persists via the bridge's own machinery (origin 'remote', not
//     'disk', so it isn't dropped as an echo). `promote`/`demote` are the tier
//     controls: the bulk content upload holds each doc it pushes hot for exactly
//     the duration of that push, which is what guarantees ONE bridge per doc even
//     while the background feed is delivering updates for it.
//   • Cold tier — everything else is NOT resident. A remote update opens a
//     transient headless bridge, applies + flushes to disk + persists, then
//     evicts. Cost is paid only when a cold doc actually changes.
//
// Background egest can't echo-loop: the ingest sides that CAN see a background
// write (the open note's bridge via BridgeManager.handleFileChanged, a resident
// bridge via the session's local-change routing, and this store's own cold
// applies) all run behind the bridge's echo-hash guard, which drops the exact
// bytes egest just wrote. Genuine external writes — an AI editing the vault
// folder directly — take the same ingest paths and DO merge (see
// `SyncManager.handleLocalFileChanged` and `onExternalMerge`).
//
// The manifest is DURABLE (see `ManifestStore`). It used to be in-memory only, so
// the engine's `hello` was empty on every launch and the server re-sent the full
// state of every readable doc — forever, every relaunch.

import * as Y from "yjs";
import { NoteBridge } from "../bridge/noteBridge";
import { createTauriBridgeIO } from "../bridge/adapter";
import type { BridgeIO } from "../bridge/types";
import * as ipc from "../ipc";
import type { DocUpdateSink } from "./vaultSyncEngine";

/** Default resident-doc cap (spec 05 §10; override via opts). */
export const HOT_DOC_CAP = 100;
const RECENT_CAP = 64;
/** How long state-vector writes are coalesced before hitting SQLite. */
const SV_FLUSH_MS = 1_000;

/**
 * Durable home for the per-doc state-vector manifest.
 *
 * Production is the vault's own `.context/index.sqlite` (the `yjs_snapshot`
 * row's `state_vector` column), reached through epoch-pinned IPC — see
 * {@link createIpcManifestStore}. Injected rather than defaulted so the unit
 * tests (and any non-Tauri consumer) get a pure store.
 */
export interface ManifestStore {
  load(): Promise<Array<{ docId: string; stateVector: Uint8Array }>>;
  save(entries: Array<[docId: string, stateVector: Uint8Array]>): Promise<void>;
}

/** A manifest store that forgets everything (the default; tests). */
export const nullManifestStore: ManifestStore = {
  load: async () => [],
  save: async () => {},
};

/** The production manifest store: SQLite via Rust, pinned to one vault epoch so
 *  a write that lands after a vault switch is refused rather than misfiled. */
export function createIpcManifestStore(epoch?: ipc.VaultEpoch): ManifestStore {
  return {
    load: () => ipc.listYjsStateVectors(epoch),
    save: (entries) => ipc.saveYjsStateVectors(entries, epoch),
  };
}

export interface VaultDocStoreOptions {
  /** Resolve a docId to its vault-relative path (from the registry). */
  resolvePath: (docId: string) => string | null;
  io?: BridgeIO;
  hotCap?: number;
  /** A cold apply found (and merged) an EXTERNAL edit on disk — bytes the doc
   *  had never seen, written by something outside the app while no bridge was
   *  alive. The merged ops are local-only until a provider connects, so the
   *  session must schedule a content push for this doc (its own local-change
   *  drain would otherwise see file == doc and skip the network). */
  onExternalMerge?: (docId: string) => void;
  /** Durable manifest. Defaults to {@link nullManifestStore}. */
  manifest?: ManifestStore;
  /** Injected in tests. */
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (h: ReturnType<typeof setTimeout>) => void;
}

interface HotEntry {
  path: string;
  bridge: NoteBridge;
  touch: number;
  /** Pinned by `promote({ pin: true })` — never LRU-evicted while pinned. */
  pinned: boolean;
}

export class VaultDocStore implements DocUpdateSink {
  private readonly io: BridgeIO;
  private readonly resolvePath: (docId: string) => string | null;
  private readonly onExternalMerge?: (docId: string) => void;
  private readonly hotCap: number;
  private readonly manifest: ManifestStore;
  private readonly setT: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearT: (h: ReturnType<typeof setTimeout>) => void;

  private readonly hot = new Map<string, HotEntry>();
  /** Last-known state vector per doc we've synced — powers a cheap manifest so
   *  reconnects only pull deltas. Kept even after a hot doc is evicted, and
   *  persisted (coalesced) so a RELAUNCH is incremental too. */
  private readonly svCache = new Map<string, Uint8Array>();
  /** State vectors changed since the last durable write. */
  private readonly dirtySv = new Set<string>();
  private svTimer: ReturnType<typeof setTimeout> | null = null;
  /** Most-recently-touched docIds (tail = newest) for backfill prioritisation. */
  private readonly recent: string[] = [];
  /** Per-doc promise chain so concurrent cold applies for one doc serialise.
   *  Self-clearing: a chain removes its own entry when it settles, so this map
   *  only ever holds *in-flight* work (see `enqueueCold`). That's why `drop()`
   *  leaves it alone — deleting a live entry would let the next update for that
   *  doc run in parallel with the one still writing. */
  private readonly coldChains = new Map<string, Promise<void>>();

  private touchSeq = 0;
  /** The currently-open note, if any: its own Hocuspocus provider syncs it, so
   *  the background feed skips it to avoid two writers on one doc (spec 05 §3.4). */
  private suppressed: string | null = null;
  /** Resolves once the durable manifest has been folded into `svCache`. */
  private readonly hydration: Promise<void>;
  private destroyed = false;

  constructor(opts: VaultDocStoreOptions) {
    this.io = opts.io ?? createTauriBridgeIO();
    this.resolvePath = opts.resolvePath;
    this.onExternalMerge = opts.onExternalMerge;
    this.hotCap = opts.hotCap ?? HOT_DOC_CAP;
    this.manifest = opts.manifest ?? nullManifestStore;
    this.setT = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h));
    this.hydration = this.hydrateManifest();
  }

  /** Fold the persisted manifest into the cache. Never rejects: a missing or
   *  unreadable manifest just means the first connection is a full backfill. */
  private async hydrateManifest(): Promise<void> {
    try {
      const rows = await this.manifest.load();
      for (const r of rows) {
        // A live entry always wins: it was computed from a doc we hold open.
        if (!this.svCache.has(r.docId)) this.svCache.set(r.docId, r.stateVector);
      }
    } catch (e) {
      console.warn("[vaultDocStore] manifest load failed", e);
    }
  }

  // ---- DocUpdateSink ----------------------------------------------------

  /** The engine awaits this before building `hello`, so a relaunch's manifest is
   *  the persisted one rather than an empty object. */
  whenReady(): Promise<void> {
    return this.hydration;
  }

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

  /** The doc whose provider is owned elsewhere (the open note), or null. The bulk
   *  upload consults this so it never becomes a second writer on that doc. */
  suppressedDoc(): string | null {
    return this.suppressed;
  }

  async applyUpdate(docId: string, update: Uint8Array): Promise<void> {
    if (docId === this.suppressed) return; // open note: its own provider owns it
    const entry = this.hot.get(docId);
    if (entry) {
      entry.bridge.applyRemote(update);
      entry.touch = ++this.touchSeq;
      this.rememberSv(docId, Y.encodeStateVector(entry.bridge.doc));
      return;
    }
    await this.enqueueCold(docId, update);
  }

  /**
   * Awaited teardown of every writer this store has for one doc: settle any
   * in-flight cold apply, then flush and retire the hot bridge.
   *
   * `drop` below is the fire-and-forget version, which is fine for an ACL change
   * (nothing is about to move the file) and NOT fine before an inbound rename or
   * trash. Two writers would otherwise race the move: `drop` never awaits
   * `retire`, and a cold apply resolved its target path when it STARTED, so it can
   * be mid-`flushEgest` to the old path. Either one lands after the move and
   * recreates the file we just took away — and the watcher then indexes that file
   * under a fresh doc_id, forking the note.
   *
   * The persisted state vector is deliberately left alone: a rename doesn't change
   * content, so the manifest entry stays truthful.
   */
  async release(docId: string): Promise<void> {
    await this.coldChains.get(docId)?.catch(() => {});
    const entry = this.hot.get(docId);
    if (entry) {
      this.hot.delete(docId);
      const i = this.recent.indexOf(docId);
      if (i !== -1) this.recent.splice(i, 1);
      await this.retire(entry.bridge);
    }
  }

  drop(docId: string): void {
    const entry = this.hot.get(docId);
    if (entry) {
      this.hot.delete(docId);
      // Flush any pending write, then tear down — access is gone, so stop syncing.
      void this.retire(entry.bridge);
    }
    this.svCache.delete(docId);
    this.dirtySv.delete(docId);
    const i = this.recent.indexOf(docId);
    if (i !== -1) this.recent.splice(i, 1);
    // coldChains is deliberately untouched: it only holds in-flight work, which
    // must be allowed to finish (and clears itself). A later update for a dropped
    // doc is skipped by `coldApply` once the registry stops resolving its path.
    //
    // The PERSISTED state vector is also left alone on purpose: the local CRDT log
    // for this doc is still on disk, so the manifest entry remains truthful. If
    // access is later re-granted, the server sends a full backfill for a newly
    // readable doc anyway (`refreshAcl`), which is idempotent regardless.
  }

  // ---- Public tier controls ---------------------------------------------

  /**
   * Promote a doc to the hot tier (resident bridge), returning it. Idempotent.
   *
   * `pin` keeps it resident regardless of the LRU cap — used by the bulk content
   * upload, which must not have the bridge it is pushing evicted (and destroyed)
   * from under its provider by a concurrent promote.
   */
  async promote(
    docId: string,
    path: string,
    opts: { seedFromFile?: boolean; markRecent?: boolean; pin?: boolean } = {},
  ): Promise<NoteBridge> {
    const markRecent = opts.markRecent ?? true;
    const existing = this.hot.get(docId);
    if (existing) {
      existing.touch = ++this.touchSeq;
      if (opts.pin) existing.pinned = true;
      if (markRecent) this.markRecent(docId);
      return existing.bridge;
    }
    const bridge = await NoteBridge.open(this.io, {
      docId,
      path,
      seedFromFile: opts.seedFromFile ?? false,
    });
    this.hot.set(docId, {
      path,
      bridge,
      touch: ++this.touchSeq,
      pinned: opts.pin ?? false,
    });
    this.rememberSv(docId, Y.encodeStateVector(bridge.doc));
    if (markRecent) this.markRecent(docId);
    this.evictIfNeeded();
    return bridge;
  }

  /**
   * Counterpart to {@link promote}: flush the doc's pending write, tear its
   * bridge down and leave the hot tier — keeping the manifest entry, which is now
   * up to date.
   *
   * The bulk upload calls this for every doc it finishes, so residency stays at
   * the pool width (4 docs) rather than creeping to `hotCap` over a 500-note run.
   */
  async demote(docId: string): Promise<void> {
    const entry = this.hot.get(docId);
    if (!entry) return;
    this.hot.delete(docId);
    this.rememberSv(docId, Y.encodeStateVector(entry.bridge.doc));
    await this.retire(entry.bridge);
  }

  hotBridge(docId: string): NoteBridge | null {
    return this.hot.get(docId)?.bridge ?? null;
  }

  /** Resident doc count (tests / bounded-residency assertions). */
  hotSize(): number {
    return this.hot.size;
  }

  markRecent(docId: string): void {
    const i = this.recent.indexOf(docId);
    if (i !== -1) this.recent.splice(i, 1);
    this.recent.push(docId);
    if (this.recent.length > RECENT_CAP) this.recent.shift();
  }

  /**
   * Tear everything down (app shutdown / sign-out / vault switch). Drops ALL
   * state the store holds — hot bridges, the manifest cache, the recency list and
   * the suppressed doc — waits for any in-flight cold apply so no transient bridge
   * is left mid-write, and flushes the durable manifest LAST so the next launch
   * starts from the state we actually reached.
   */
  async destroyAll(): Promise<void> {
    this.destroyed = true;
    const entries = [...this.hot.values()];
    const cold = [...this.coldChains.values()];
    this.hot.clear();
    this.coldChains.clear();
    this.recent.length = 0;
    this.suppressed = null;
    await Promise.all([
      ...entries.map((e) => this.retire(e.bridge)),
      ...cold.map((c) => c.catch(() => {})),
    ]);
    // Persist before clearing the cache — this is the write that makes a relaunch
    // incremental instead of a full re-download of every doc.
    await this.flushStateVectors();
    this.svCache.clear();
  }

  // ---- durable manifest --------------------------------------------------

  private rememberSv(docId: string, sv: Uint8Array): void {
    this.svCache.set(docId, sv);
    if (this.destroyed) return;
    this.dirtySv.add(docId);
    if (this.svTimer == null) {
      this.svTimer = this.setT(() => {
        this.svTimer = null;
        void this.flushStateVectors();
      }, SV_FLUSH_MS);
    }
  }

  /** Write every dirty state vector in one batch. Never throws. */
  async flushStateVectors(): Promise<void> {
    if (this.svTimer != null) {
      this.clearT(this.svTimer);
      this.svTimer = null;
    }
    if (this.dirtySv.size === 0) return;
    const entries: Array<[string, Uint8Array]> = [];
    for (const docId of this.dirtySv) {
      const sv = this.svCache.get(docId);
      if (sv) entries.push([docId, sv]);
    }
    this.dirtySv.clear();
    try {
      await this.manifest.save(entries);
    } catch (e) {
      console.warn("[vaultDocStore] manifest save failed", e);
    }
  }

  // ---- internals --------------------------------------------------------

  private enqueueCold(docId: string, update: Uint8Array): Promise<void> {
    const prev = this.coldChains.get(docId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.coldApply(docId, update));
    // The map must hold the SAME promise the guard compares against, otherwise
    // the self-delete never fires and the entry is never reclaimed. The identity
    // check is what keeps an older chain from deleting a newer one enqueued for
    // the same doc while it was still running.
    const chain: Promise<void> = run.finally(() => {
      if (this.coldChains.get(docId) === chain) this.coldChains.delete(docId);
    });
    this.coldChains.set(docId, chain);
    return chain;
  }

  /** In-flight cold applies, for tests/observability. */
  pendingColdDocs(): string[] {
    return [...this.coldChains.keys()];
  }

  /** The live resident bridge for a doc, or null. A PEEK — no open, no LRU
   *  touch, no pin. For routing watcher events into already-hot docs: a
   *  resident bridge's next egest would overwrite an un-ingested external edit,
   *  so the session merges the file in the moment the watcher reports it. */
  peekResident(docId: string): NoteBridge | null {
    return this.hot.get(docId)?.bridge ?? null;
  }

  private async coldApply(docId: string, update: Uint8Array): Promise<void> {
    const path = this.resolvePath(docId);
    if (!path) return; // unknown doc (not yet materialised) — skip; next reconnect retries
    // Transient bridge: hydrate from local CRDT, apply the delta, write, persist,
    // evict. seedFromFile:false — the server feed is the source for background docs.
    const bridge = await NoteBridge.open(this.io, { docId, path, seedFromFile: false });
    try {
      // Fold in any external edit sitting on disk BEFORE the remote delta lands
      // and gets egested: the flush below rewrites the file from the doc, and a
      // file the doc has never ingested (an AI edited it while no bridge was
      // alive) would be silently overwritten. The doc-non-empty guard keeps an
      // unhydrated placeholder on the pull-before-seed path (never a pre-sync
      // seed); converged content makes this a no-op read. A genuine merge is
      // reported up so the session pushes it (see `onExternalMerge`).
      if (bridge.serialize().length > 0 && (await bridge.ingestNow())) {
        this.onExternalMerge?.(docId);
      }
      bridge.applyRemote(update);
      await bridge.flushEgest();
      this.rememberSv(docId, Y.encodeStateVector(bridge.doc));
    } finally {
      bridge.destroy();
    }
  }

  private evictIfNeeded(): void {
    while (this.hot.size > this.hotCap) {
      let lruId: string | null = null;
      let lruTouch = Infinity;
      for (const [id, e] of this.hot) {
        if (e.pinned) continue; // in-flight upload — evicting it would kill its provider's doc
        if (e.touch < lruTouch) {
          lruTouch = e.touch;
          lruId = id;
        }
      }
      if (lruId == null) break;
      const e = this.hot.get(lruId)!;
      this.hot.delete(lruId);
      // Keep the svCache entry so the manifest stays cheap after eviction.
      void this.retire(e.bridge);
    }
  }

  /** Flush a bridge's pending write, then tear it down. Never throws, and always
   *  destroys — a failed flush must not leak the bridge's observers. */
  private async retire(bridge: NoteBridge): Promise<void> {
    try {
      await bridge.flushEgest();
    } catch (e) {
      console.error("[vaultDocStore] flush on retire failed", e);
    }
    bridge.destroy();
  }
}
