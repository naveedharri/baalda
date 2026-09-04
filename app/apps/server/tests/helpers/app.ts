import type { AppDeps } from "../../src/http/app.js";
import { revisionOf, type DocActor, type DocWriter, type TextOp } from "../../src/mcp/doc-writer.js";

/** One recorded write, so a test can assert WHO the server said wrote it. */
export interface RecordedWrite {
  vaultId: string;
  docId: string;
  content: string;
  actor: DocActor | undefined;
}

export type MemoryDocWriter = DocWriter & {
  store: Map<string, string>;
  /** Every setContent/appendContent, in order. */
  writes: RecordedWrite[];
};

/** A DocWriter that records writes in memory — for tests that don't run sync. */
export function memoryDocWriter(): MemoryDocWriter {
  const store = new Map<string, string>();
  const writes: RecordedWrite[] = [];
  return {
    store,
    writes,
    async editContent(vaultId, docId, plan: (current: string) => TextOp[], actor) {
      let text = store.get(docId) ?? "";
      for (const op of plan(text)) {
        if (op.index < 0 || op.deleteLength < 0 || op.index + op.deleteLength > text.length) {
          throw new Error(`edit out of range: index ${op.index}, delete ${op.deleteLength}, length ${text.length}`);
        }
        text = text.slice(0, op.index) + op.insert + text.slice(op.index + op.deleteLength);
      }
      store.set(docId, text);
      writes.push({ vaultId, docId, content: text, actor });
      return { revision: revisionOf(text), content: text };
    },
    async setContent(vaultId, docId, content, actor) {
      store.set(docId, content);
      writes.push({ vaultId, docId, content, actor });
    },
    async appendContent(vaultId, docId, text, actor) {
      const next = (store.get(docId) ?? "") + text;
      store.set(docId, next);
      writes.push({ vaultId, docId, content: next, actor });
    },
    async readContent(_vaultId, docId) {
      return store.get(docId) ?? "";
    },
    // Mirrors production: null = the store has never seen this doc's content,
    // which capture paths must treat as "skip", never as "empty note".
    async peekContent(_vaultId, docId) {
      return store.get(docId) ?? null;
    },
  };
}

/**
 * Default AppDeps for route tests that don't care about sync/MCP writes.
 *
 * The broadcast hooks default to no-ops rather than being left off: `AppDeps`
 * requires `onRegistryChanged` precisely because an app built without it writes
 * rows that no running client ever hears about, and a helper that quietly omitted
 * it would hand every test the broken wiring by default. Tests that want to
 * ASSERT on broadcasts should use `recordingAppDeps` instead.
 */
export function testAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    disconnectDoc: () => {},
    docWriter: memoryDocWriter(),
    onRegistryChanged: () => {},
    onAclChanged: () => {},
    ...overrides,
  };
}

export interface RecordingAppDeps {
  deps: AppDeps;
  /** Every registry broadcast, in order. `originId` is the client to skip. */
  registryBroadcasts: Array<{ vaultId: string; originId: string | null }>;
  /** Vault ids whose ACL changed (share create/revoke, member removal). */
  aclBroadcasts: string[];
  /** Docs whose live sync sockets were force-closed. */
  disconnected: Array<{ vaultId: string; docId: string }>;
  docWriter: MemoryDocWriter;
  /** Clear all recordings (call from `beforeEach`). */
  reset(): void;
}

/**
 * `testAppDeps` plus capture of everything the app announces to the outside
 * world. Several suites hand-rolled these same three arrays; a broadcast that
 * doesn't fire is invisible to a running app, so asserting on them is the only
 * way to test that half of a write.
 */
export function recordingAppDeps(overrides: Partial<AppDeps> = {}): RecordingAppDeps {
  const registryBroadcasts: RecordingAppDeps["registryBroadcasts"] = [];
  const aclBroadcasts: string[] = [];
  const disconnected: RecordingAppDeps["disconnected"] = [];
  const docWriter = memoryDocWriter();
  return {
    registryBroadcasts,
    aclBroadcasts,
    disconnected,
    docWriter,
    reset() {
      registryBroadcasts.length = 0;
      aclBroadcasts.length = 0;
      disconnected.length = 0;
      docWriter.store.clear();
      docWriter.writes.length = 0;
    },
    deps: {
      docWriter,
      disconnectDoc: (vaultId, docId) => disconnected.push({ vaultId, docId }),
      onRegistryChanged: (vaultId, originId) => registryBroadcasts.push({ vaultId, originId }),
      onAclChanged: (vaultId) => aclBroadcasts.push(vaultId),
      ...overrides,
    },
  };
}
