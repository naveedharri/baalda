// The vault channel's LIVE-ONLY mode: the one protocol change the bulk engine
// needs, and the reconnect that takes it back off.
//
// Why it exists: the bootstrap route pages the same content down over HTTP with
// a resumable cursor, so leaving the channel's cold backfill on means every doc
// arrives twice — once as a WS frame per doc, once in a page. `mode:
// "live-only"` asks the server to skip `backfill()` and send `ready` anyway,
// because `ready.empty` / `.behind` / `.revoked` are authorities the session
// needs on every connect whether or not anything was backfilled.
//
// Compatibility is the other half: the field is OMITTED rather than sent false
// when the backfill is wanted, so the common frame stays byte-identical to what
// every shipped server already parses, and a server that predates the flag just
// backfills — which is today's behaviour.

import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api";
import { encodeHello } from "../vaultProtocol";
import { VaultSyncEngine, type DocUpdateSink, type WebSocketLike } from "../vaultSyncEngine";

function fakeApi(): ApiClient {
  return {
    vaultSyncToken: vi.fn(async () => ({ token: "tok" })),
    getBaseUrl: () => "http://localhost:3010",
    getClientId: () => "client-1",
  } as unknown as ApiClient;
}

function fakeSink(): DocUpdateSink {
  return {
    whenReady: async () => {},
    knownDocs: () => [],
    stateVector: async () => null,
    recentDocs: () => [],
    applyUpdate: async () => {},
    drop: () => {},
  };
}

/** A socket that records what was sent and lets the test open/close it. */
function fakeSocket() {
  const sent: string[] = [];
  const ws: WebSocketLike = {
    binaryType: "",
    send: (d) => {
      if (typeof d === "string") sent.push(d);
    },
    close: () => {},
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  return { ws, sent, hellos: () => sent.map((s) => JSON.parse(s)).filter((f) => f.t === "hello") };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("hello.mode", () => {
  it("is absent by default — the frame every shipped server already parses", () => {
    const frame = JSON.parse(encodeHello({ token: "t", manifest: {} }));
    expect("mode" in frame).toBe(false);
  });

  it("carries `live-only` when the engine is started for the bulk engine", async () => {
    const sock = fakeSocket();
    const engine = new VaultSyncEngine({
      api: fakeApi(),
      vaultId: "v1",
      sink: fakeSink(),
      liveOnly: true,
      wsFactory: () => sock.ws,
    });
    engine.start();
    sock.ws.onopen?.({});
    await flush();

    expect(engine.isLiveOnly()).toBe(true);
    expect(sock.hellos()).toHaveLength(1);
    expect(sock.hellos()[0].mode).toBe("live-only");
    engine.stop();
  });

  it("is dropped by `reconnect({liveOnly:false})`, which re-handshakes", async () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let n = 0;
    const engine = new VaultSyncEngine({
      api: fakeApi(),
      vaultId: "v1",
      sink: fakeSink(),
      liveOnly: true,
      wsFactory: () => sockets[Math.min(n++, sockets.length - 1)].ws,
      reconnect: { baseMs: 0, maxMs: 0 },
      setTimeoutImpl: (fn) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutImpl: () => {},
    });
    engine.start();
    sockets[0].ws.onopen?.({});
    await flush();
    expect(sockets[0].hellos()[0].mode).toBe("live-only");

    // The bulk phase is over: the manifest now covers what it downloaded, so the
    // next hello asks for an ordinary (≈0-frame) backfill.
    engine.reconnect({ liveOnly: false });
    expect(engine.isLiveOnly()).toBe(false);
    sockets[1].ws.onopen?.({});
    await flush();

    const hello = sockets[1].hellos()[0];
    expect(hello).toBeDefined();
    expect("mode" in hello).toBe(false);
    expect(hello.token).toBe("tok");
    engine.stop();
  });

  it("stays on ONE socket per vault — reconnect reuses the refresh machinery", async () => {
    const sock = fakeSocket();
    const closed: number[] = [];
    const engine = new VaultSyncEngine({
      api: fakeApi(),
      vaultId: "v1",
      sink: fakeSink(),
      liveOnly: true,
      wsFactory: () => {
        closed.push(1);
        return sock.ws;
      },
      setTimeoutImpl: (fn) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutImpl: () => {},
    });
    engine.start();
    sock.ws.onopen?.({});
    await flush();
    engine.reconnect({ liveOnly: false });
    await flush();
    // Two connect attempts in sequence, never two live sockets.
    expect(closed).toHaveLength(2);
    engine.stop();
  });
});
