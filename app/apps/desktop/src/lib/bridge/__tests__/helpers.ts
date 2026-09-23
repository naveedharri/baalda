// Shared test doubles for the bridge suites: an in-memory FS, an in-memory
// CRDT persistence store, and a real (Node) sha256. Nothing here touches Tauri.

import { createHash } from "node:crypto";
import type {
  BridgeIO,
  CrdtPersistence,
  YjsPersistedState,
} from "../types";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** In-memory atomic filesystem with write/read counters. */
export class FakeFs {
  private files = new Map<string, string>();
  writeCount = 0;
  readCount = 0;

  constructor(seed?: Record<string, string>) {
    if (seed) for (const [p, c] of Object.entries(seed)) this.files.set(p, c);
  }

  async readFile(path: string): Promise<string> {
    this.readCount++;
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async writeFileAtomic(path: string, content: string): Promise<void> {
    this.writeCount++;
    this.files.set(path, content);
  }

  /** Simulate an out-of-band external edit (AI, git, another editor). */
  externalWrite(path: string, content: string): void {
    this.files.set(path, content);
  }

  get(path: string): string | undefined {
    return this.files.get(path);
  }
}

interface LoggedUpdate {
  /** Monotonic row id, exactly as SQLite's rowid is — the watermark the
   *  bridge's compaction passes back as `upTo`. */
  id: number;
  bytes: Uint8Array;
}

interface DocStore {
  snapshot: Uint8Array | null;
  stateVector: Uint8Array | null;
  updates: LoggedUpdate[];
}

/** In-memory equivalent of the SQLite yjs_updates/yjs_snapshot tables. */
export class FakePersistence implements CrdtPersistence {
  private docs = new Map<string, DocStore>();
  /** Shared across docs, like a SQLite table's rowid sequence. */
  private nextRowId = 0;
  /** Every snapshot ever written, per doc — lets tests assert recovery points. */
  snapshotHistory = new Map<string, Uint8Array[]>();
  /** The `yjs_disk_base` table (#200). */
  diskBases = new Map<string, string>();

  async loadDiskBase(docId: string): Promise<string | null> {
    return this.diskBases.get(docId) ?? null;
  }

  async saveDiskBase(docId: string, sha256: string): Promise<void> {
    this.diskBases.set(docId, sha256);
  }

  private store(docId: string): DocStore {
    let d = this.docs.get(docId);
    if (!d) {
      d = { snapshot: null, stateVector: null, updates: [] };
      this.docs.set(docId, d);
    }
    return d;
  }

  async loadState(docId: string): Promise<YjsPersistedState> {
    const d = this.docs.get(docId);
    if (!d) return { snapshot: null, updates: [], updateCount: 0 };
    return {
      snapshot: d.snapshot,
      updates: d.updates.map((u) => u.bytes),
      updateCount: d.updates.length,
      lastUpdateId: d.updates.length ? d.updates[d.updates.length - 1].id : 0,
    };
  }

  async appendUpdate(docId: string, update: Uint8Array): Promise<number> {
    const id = ++this.nextRowId;
    this.store(docId).updates.push({ id, bytes: update });
    return id;
  }

  /** Truncates only up to `upTo`, like the SQLite store's
   *  `DELETE … WHERE id <= ?`. Omitted ⇒ nothing is deleted. */
  async saveSnapshot(
    docId: string,
    snapshot: Uint8Array,
    stateVector: Uint8Array,
    upTo?: number,
  ): Promise<void> {
    const d = this.store(docId);
    d.snapshot = snapshot;
    d.stateVector = stateVector;
    d.updates = upTo == null ? d.updates : d.updates.filter((u) => u.id > upTo);
    const hist = this.snapshotHistory.get(docId) ?? [];
    hist.push(snapshot);
    this.snapshotHistory.set(docId, hist);
  }

  logLength(docId: string): number {
    return this.docs.get(docId)?.updates.length ?? 0;
  }
  snapshotOf(docId: string): Uint8Array | null {
    return this.docs.get(docId)?.snapshot ?? null;
  }
}

export interface Harness {
  io: BridgeIO;
  fs: FakeFs;
  persistence: FakePersistence;
}

export function makeHarness(seed?: Record<string, string>): Harness {
  const fs = new FakeFs(seed);
  const persistence = new FakePersistence();
  const errors: unknown[] = [];
  const io: BridgeIO = {
    readFile: (p) => fs.readFile(p),
    // Like Rust's `write_note` given a doc id: the write records the disk base.
    writeFileAtomic: async (p, c, docId) => {
      await fs.writeFileAtomic(p, c);
      if (docId) persistence.diskBases.set(docId, sha256Hex(c));
    },
    sha256: sha256Hex,
    persistence,
    onError: (e) => {
      errors.push(e);
    },
  };
  return { io, fs, persistence };
}
