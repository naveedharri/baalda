import { describe, expect, it } from "vitest";
import { ApiClient } from "../api";
import {
  VaultSyncEngine,
  deriveVaultWsUrl,
  type DocUpdateSink,
  type WebSocketLike,
} from "../sync/vaultSyncEngine";

// Drives the engine through a fake WebSocket + a mocked token fetch + an
// in-memory sink. No real socket, DB, or server (spec 05 §3.3).

function tokenApi(status = 200): ApiClient {
  const impl = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify({ token: "vault-tok", vaultId: "v1" }),
  })) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "http://localhost:3010", token: "sess", fetchImpl: impl });
}

class FakeWs implements WebSocketLike {
  binaryType = "";
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  helloText(): Record<string, unknown> | null {
    const s = this.sent.find((x) => typeof x === "string") as string | undefined;
    return s ? JSON.parse(s) : null;
  }
}

/** Build a server->client binary update frame [docIdLen u16][docId][update]. */
function updateFrame(docId: string, update: number[]): ArrayBuffer {
  const id = new TextEncoder().encode(docId);
  const out = new Uint8Array(2 + id.length + update.length);
  out[0] = (id.length >> 8) & 0xff;
  out[1] = id.length & 0xff;
  out.set(id, 2);
  out.set(update, 2 + id.length);
  return out.buffer;
}

class MemSink implements DocUpdateSink {
  applied: Array<{ docId: string; update: number[] }> = [];
  dropped: string[] = [];
  constructor(
    private known: Record<string, Uint8Array> = {},
    private recent: string[] = [],
  ) {}
  knownDocs() {
    return Object.keys(this.known);
  }
  async stateVector(docId: string) {
    return this.known[docId] ?? null;
  }
  recentDocs() {
    return this.recent;
  }
  async applyUpdate(docId: string, update: Uint8Array) {
    this.applied.push({ docId, update: [...update] });
  }
  drop(docId: string) {
    this.dropped.push(docId);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("deriveVaultWsUrl", () => {
  it("keeps the HTTP port and appends /vault-sync (never bumps to 3011)", () => {
    expect(deriveVaultWsUrl("http://localhost:3010")).toBe("ws://localhost:3010/vault-sync");
    expect(deriveVaultWsUrl("https://api.baalda.com")).toBe("wss://api.baalda.com/vault-sync");
    expect(deriveVaultWsUrl("https://host/prefix/")).toBe("wss://host/prefix/vault-sync");
  });
});

describe("VaultSyncEngine", () => {
  it("sends a hello with the minted token + state-vector manifest + priority", async () => {
    const sink = new MemSink({ A: new Uint8Array([1, 2]) }, ["A"]);
    let ws: FakeWs | null = null;
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
    });
    engine.start();
    ws!.onopen?.(null);
    await tick();

    const hello = ws!.helloText()!;
    expect(hello.t).toBe("hello");
    expect(hello.token).toBe("vault-tok");
    expect(hello.priority).toEqual(["A"]);
    // base64 of [1,2] == "AQI="
    expect((hello.manifest as Record<string, string>).A).toBe("AQI=");
  });

  it("routes a binary update frame to the sink and flips to synced on ready", async () => {
    const sink = new MemSink();
    let ws: FakeWs | null = null;
    let status = "";
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
      onStatus: (s) => (status = s),
    });
    engine.start();
    ws!.onopen?.(null);
    await tick();

    ws!.onmessage?.({ data: updateFrame("noteX", [9, 8, 7]) });
    await tick();
    expect(sink.applied).toEqual([{ docId: "noteX", update: [9, 8, 7] }]);

    ws!.onmessage?.({ data: JSON.stringify({ t: "ready" }) });
    expect(status).toBe("synced");
  });

  it("drops a doc on a drop control frame", async () => {
    const sink = new MemSink();
    let ws: FakeWs | null = null;
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
    });
    engine.start();
    ws!.onopen?.(null);
    await tick();

    ws!.onmessage?.({ data: JSON.stringify({ t: "drop", docId: "gone" }) });
    expect(sink.dropped).toEqual(["gone"]);
  });

  it("stops retrying and reports no-access when the token mint is 403", async () => {
    const sink = new MemSink();
    let ws: FakeWs | null = null;
    let status = "";
    const engine = new VaultSyncEngine({
      api: tokenApi(403),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
      onStatus: (s) => (status = s),
    });
    engine.start();
    ws!.onopen?.(null);
    await tick();
    expect(status).toBe("no-access");
    expect(ws!.closed).toBe(true);
  });

  it("reconnects with jittered backoff after a disconnect", async () => {
    const sink = new MemSink();
    const created: FakeWs[] = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => {
        const w = new FakeWs();
        created.push(w);
        return w;
      },
      random: () => 0, // delay = backoff * 0.5
      reconnect: { baseMs: 1000, maxMs: 30_000 },
      setTimeoutImpl: (fn, ms) => {
        scheduled.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutImpl: () => {},
    });
    engine.start();
    expect(created).toHaveLength(1);

    created[0].onclose?.(null); // disconnect
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(500); // 1000 * 2^0 * 0.5

    scheduled[0].fn(); // fire the reconnect
    expect(created).toHaveLength(2);
  });
});
