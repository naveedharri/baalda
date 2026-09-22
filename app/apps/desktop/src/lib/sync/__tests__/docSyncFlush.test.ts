// Batching a doc's outgoing updates — and the flushes that make it safe.
//
// The provider sends one websocket message per `doc.on("update")` by default, so
// an ingest (or a fast typist) is dozens of frames a second, each with its own
// server `onChange` and its own persistence debounce. `flushDelay` merges the
// updates in a window into ONE message.
//
// The risk it introduces is small and sharp: the provider DISCARDS its buffer in
// `onClose`, so anything that takes the connection down while the window is open
// would drop the tail of a burst — the last keystrokes before a note is closed,
// a vault is switched, or the app quits. Every such path therefore flushes
// first, and that is what this file pins. (It is a delay, never a drop: a
// buffered update still counts as unsynced, so `whenFlushed` cannot mistake
// "queued locally" for "acked by the server" and check a note in as pushed.)

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

/** Everything the fake provider was told, in order. */
const captured = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  calls: [] as string[],
  wsStatus: "connected" as string,
}));

vi.mock("@hocuspocus/provider", () => {
  class FakeHocuspocusProvider {
    readonly awareness = { setLocalStateField() {}, destroy() {}, on() {}, off() {} };
    isSynced = false;
    readonly configuration: { websocketProvider: unknown };
    constructor(config: Record<string, unknown>) {
      captured.config = config;
      this.configuration = {
        websocketProvider: {
          get status() {
            return captured.wsStatus;
          },
          connect: () => captured.calls.push("ws.connect"),
          disconnect: () => captured.calls.push("ws.disconnect"),
          on() {},
          off() {},
          webSocket: undefined,
        },
      };
    }
    flushPendingUpdates() {
      captured.calls.push("flush");
    }
    disconnect() {
      captured.calls.push("disconnect");
    }
    destroy() {
      captured.calls.push("destroy");
    }
    on() {}
    off() {}
  }
  return {
    HocuspocusProvider: FakeHocuspocusProvider,
    WebSocketStatus: {
      Disconnected: "disconnected",
      Connecting: "connecting",
      Connected: "connected",
    },
  };
});

import { ApiClient } from "../../api";
import { DocSync, FLUSH_DELAY_MS } from "../syncManager";

function api(): ApiClient {
  const impl = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ token: "tok", readOnly: false }),
  })) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "http://localhost:3010", token: "sess", fetchImpl: impl });
}

const docSync = () =>
  new DocSync({ api: api(), doc: new Y.Doc(), docId: "d1", vaultId: "v1" });

beforeEach(() => {
  captured.config = null;
  captured.calls = [];
  captured.wsStatus = "connected";
});

describe("DocSync — outgoing update batching", () => {
  it("asks the provider for a modest, fixed window", () => {
    docSync();
    expect(captured.config?.flushDelay).toBe(FLUSH_DELAY_MS);
    // Small enough to stay under the badge settle and the local-change debounce.
    expect(FLUSH_DELAY_MS).toBeGreaterThan(0);
    expect(FLUSH_DELAY_MS).toBeLessThanOrEqual(500);
  });

  it("flushes BEFORE tearing the provider down", () => {
    const sync = docSync();
    sync.destroy();
    expect(captured.calls).toEqual(["flush", "destroy"]);
  });

  it("flushes before a reconnect drops the socket (token refresh, ACL change)", () => {
    const sync = docSync();
    sync.refreshAccess();
    // The buffer is discarded by `onClose`, so it has to go out first.
    expect(captured.calls.indexOf("flush")).toBeGreaterThanOrEqual(0);
    expect(captured.calls.indexOf("flush")).toBeLessThan(captured.calls.indexOf("disconnect"));
  });

  it("flushes before anything waits for the server's ack", async () => {
    const sync = docSync();
    const waiter = sync.whenFlushed(10);
    expect(captured.calls).toContain("flush");
    await waiter; // resolves false on the timeout — the wait itself is the point
  });

  it("a destroy after the provider is gone is still safe", () => {
    const sync = docSync();
    sync.destroy();
    expect(() => sync.destroy()).not.toThrow();
    expect(captured.calls).toEqual(["flush", "destroy"]); // once, not twice
  });
});
