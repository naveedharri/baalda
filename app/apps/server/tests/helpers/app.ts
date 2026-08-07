import type { AppDeps } from "../../src/http/app.js";
import type { DocWriter } from "../../src/mcp/doc-writer.js";

/** A DocWriter that records writes in memory — for tests that don't run sync. */
export function memoryDocWriter(): DocWriter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async setContent(_vaultId, docId, content) {
      store.set(docId, content);
    },
    async appendContent(_vaultId, docId, text) {
      store.set(docId, (store.get(docId) ?? "") + text);
    },
    async readContent(_vaultId, docId) {
      return store.get(docId) ?? "";
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
  docWriter: DocWriter & { store: Map<string, string> };
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
