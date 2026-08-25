import { describe, expect, it } from "vitest";
import { ApiClient } from "../api";
import {
  VaultSyncEngine,
  deriveVaultWsUrl,
  type DocUpdateSink,
  type WebSocketLike,
} from "../sync/vaultSyncEngine";
import {
  decodeVoiceFrame,
  encodeVoiceFrame,
  VOICE_FRAME,
  type VoiceFrame,
} from "../sync/vaultProtocol";

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

/**
 * Wait until the engine's `hello` is actually on the wire.
 *
 * The engine opens its backfill window when it SENDS hello (mint token + build
 * manifest are async), and a real server cannot answer before it has one. Frames
 * delivered ahead of it are live fan-out, which is deliberately uncounted — so a
 * test that skips this measures the wrong thing.
 */
async function awaitHello(ws: FakeWs): Promise<void> {
  for (let i = 0; i < 40 && ws.helloText() === null; i++) await tick();
  if (ws.helloText() === null) throw new Error("hello was never sent");
}

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

  it("announces presence right behind hello — before ready, so the sidebar dots don't wait out the backfill", async () => {
    const sink = new MemSink();
    let ws: FakeWs | null = null;
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
    });
    engine.setPresence({ docId: "D", name: "Ada", color: "#6366f1", status: "online" });
    engine.start();
    ws!.onopen?.(null);
    await awaitHello(ws!);

    // No `ready` has been delivered, yet the announce is already on the wire.
    const texts = ws!.sent
      .filter((x): x is string => typeof x === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(texts.map((t) => t.t)).toEqual(["hello", "presence"]);
    expect(texts[1].docId).toBe("D");

    // A presence CHANGE mid-backfill goes out live too (the old gate held it
    // back until ready).
    engine.setPresence({ docId: "E", name: "Ada", color: "#6366f1", status: "online" });
    const last = ws!.sent[ws!.sent.length - 1];
    expect(JSON.parse(last as string).docId).toBe("E");
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

  it("fires onMemberJoined with the name on a member control frame", async () => {
    const sink = new MemSink();
    let ws: FakeWs | null = null;
    const joined: string[] = [];
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
      onMemberJoined: (name) => joined.push(name),
    });
    engine.start();
    ws!.onopen?.(null);
    await tick();

    ws!.onmessage?.({ data: JSON.stringify({ t: "member", name: "Ada" }) });
    expect(joined).toEqual(["Ada"]);
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

// ---------------------------------------------------------------------------
// Inbound (download) queue — phase 2.
//
// `ws.onmessage` used to be fire-and-forget, so N binary frames started N
// concurrent `NoteBridge.open` + SQLite load + sha256 + atomic write on the main
// thread. That is what made the app stop responding while a large vault backfilled.
// ---------------------------------------------------------------------------

/** A sink whose applies are slow and observable, so overlap is detectable. */
class SlowSink implements DocUpdateSink {
  applied: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  ready = false;
  constructor(private readonly known: Record<string, Uint8Array> = {}) {}
  async whenReady() {
    await tick();
    this.ready = true;
  }
  knownDocs() {
    return Object.keys(this.known);
  }
  async stateVector(docId: string) {
    return this.known[docId] ?? null;
  }
  recentDocs() {
    return [];
  }
  async applyUpdate(docId: string, update: Uint8Array) {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await tick();
    await tick();
    this.applied.push(`${docId}:${[...update].join(",")}`);
    this.inFlight--;
  }
  drop() {}
}

describe("VaultSyncEngine — inbound queue", () => {
  it("applies frames ONE AT A TIME, in arrival order", async () => {
    const sink = new SlowSink();
    let ws: FakeWs | null = null;
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
    });
    engine.start();
    ws!.onopen?.(null);
    await awaitHello(ws!);

    // Ten frames delivered in one burst, exactly as a backfill arrives.
    for (let i = 0; i < 10; i++) {
      ws!.onmessage?.({ data: updateFrame(`d${i % 3}`, [i]) });
    }
    expect(sink.maxInFlight).toBeLessThanOrEqual(1); // never a stampede

    for (let i = 0; i < 60 && !engine.inboundIdle(); i++) await tick();
    expect(sink.maxInFlight).toBe(1);
    expect(sink.applied).toEqual([
      "d0:0", "d1:1", "d2:2", "d0:3", "d1:4",
      "d2:5", "d0:6", "d1:7", "d2:8", "d0:9",
    ]);
    expect(engine.inboundProgress()).toMatchObject({ done: 10, total: 10, queued: 0 });
  });

  it("reports inbound progress as frames land", async () => {
    const sink = new SlowSink();
    let ws: FakeWs | null = null;
    const seen: Array<[number, number]> = [];
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
      onInboundProgress: (done, total) => seen.push([done, total]),
    });
    engine.start();
    ws!.onopen?.(null);
    await awaitHello(ws!);
    ws!.onmessage?.({ data: updateFrame("a", [1]) });
    ws!.onmessage?.({ data: updateFrame("b", [2]) });
    for (let i = 0; i < 40 && !engine.inboundIdle(); i++) await tick();
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  // ── The "Syncing 55/55, climbing" regression ──────────────────────────────
  // The server does not self-exclude `update` fan-out, so a client receives the
  // echo of its own edits. Counting those made the download progress unbounded:
  // one tick per keystroke, on a phase that (see below) could never end.

  it("counts the backfill only — live fan-out never moves the counter", async () => {
    const sink = new MemSink();
    let ws: FakeWs | null = null;
    const seen: Array<[number, number]> = [];
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
      onInboundProgress: (done, total) => seen.push([done, total]),
    });
    engine.start();
    ws!.onopen?.(null);
    await awaitHello(ws!);

    // Two documents of backfill, then the server closes the window.
    ws!.onmessage?.({ data: updateFrame("a", [1]) });
    ws!.onmessage?.({ data: updateFrame("b", [2]) });
    for (let i = 0; i < 40 && !engine.inboundIdle(); i++) await tick();
    ws!.onmessage?.({ data: JSON.stringify({ t: "ready" }) });
    await tick();
    expect(engine.inboundProgress()).toMatchObject({ done: 2, total: 2 });

    // Now type: every keystroke's update comes back to us as live fan-out. It is
    // still applied — it just isn't progress.
    for (let i = 0; i < 25; i++) ws!.onmessage?.({ data: updateFrame("a", [9]) });
    for (let i = 0; i < 60 && !engine.inboundIdle(); i++) await tick();

    expect(engine.inboundProgress()).toMatchObject({ done: 2, total: 2, queued: 0 });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // Applied all the same — excluded from the count, not from the sync.
    expect(sink.applied.length).toBe(27);
  });

  // ── The "never says Synced" regression ────────────────────────────────────
  // `inboundIdle()` requires `!draining`, and the old completion check ran inside
  // the drain loop, where `draining` is true by construction. It could not fire.

  it("signals idle once the backfill has landed, whichever arrives last", async () => {
    // Case 1: `ready` first, then the last frame drains.
    {
      const sink = new MemSink();
      let ws: FakeWs | null = null;
      let idle = 0;
      const engine = new VaultSyncEngine({
        api: tokenApi(),
        vaultId: "v1",
        sink,
        wsFactory: () => (ws = new FakeWs()),
        onInboundIdle: () => idle++,
      });
      engine.start();
      ws!.onopen?.(null);
      await awaitHello(ws!);
      ws!.onmessage?.({ data: updateFrame("a", [1]) });
      ws!.onmessage?.({ data: JSON.stringify({ t: "ready" }) });
      for (let i = 0; i < 40 && !engine.backfillSettled(); i++) await tick();
      expect(engine.backfillSettled()).toBe(true);
      expect(idle).toBeGreaterThan(0);
    }
    // Case 2: the frames drain first and `ready` is the last event. Nothing else
    // is coming, so `ready` itself has to be an edge — this is the ordering that
    // deadlocked the phase.
    {
      const sink = new MemSink();
      let ws: FakeWs | null = null;
      let idle = 0;
      const engine = new VaultSyncEngine({
        api: tokenApi(),
        vaultId: "v1",
        sink,
        wsFactory: () => (ws = new FakeWs()),
        onInboundIdle: () => idle++,
      });
      engine.start();
      ws!.onopen?.(null);
      await awaitHello(ws!);
      ws!.onmessage?.({ data: updateFrame("a", [1]) });
      for (let i = 0; i < 40 && !engine.inboundIdle(); i++) await tick();
      expect(idle).toBe(0); // still backfilling — the vault is still arriving
      expect(engine.backfillSettled()).toBe(false);

      ws!.onmessage?.({ data: JSON.stringify({ t: "ready" }) });
      await tick();
      expect(idle).toBe(1);
      expect(engine.backfillSettled()).toBe(true);
    }
  });

  it("does not call an empty queue mid-backfill 'settled'", async () => {
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
    await awaitHello(ws!);
    ws!.onmessage?.({ data: updateFrame("a", [1]) });
    for (let i = 0; i < 40 && !engine.inboundIdle(); i++) await tick();

    // The queue is empty, but only because document two hasn't arrived yet.
    // `inboundIdle` says yes; the question the download phase must ask says no.
    expect(engine.inboundIdle()).toBe(true);
    expect(engine.backfillSettled()).toBe(false);
  });

  it("applies backpressure past the byte cap: closes the socket, drains, reconnects", async () => {
    const sink = new SlowSink();
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
      inboundQueueMaxBytes: 8, // tiny, so three small frames overflow it
      random: () => 0,
      reconnect: { baseMs: 1000, maxMs: 30_000 },
      setTimeoutImpl: (fn, ms) => {
        scheduled.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutImpl: () => {},
    });
    engine.start();
    created[0].onopen?.(null);
    await tick();

    for (let i = 0; i < 4; i++) {
      created[0].onmessage?.({ data: updateFrame("d", [i, i, i, i]) });
    }
    // The producer is told to stop by closing the socket — never by dropping a
    // frame (a cold apply silently discards an update whose predecessor is
    // missing, so dropping would lose content).
    expect(created[0].closed).toBe(true);
    expect(scheduled).toHaveLength(0); // no reconnect until we've caught up

    for (let i = 0; i < 60 && !engine.inboundIdle(); i++) await tick();
    expect(sink.applied).toHaveLength(4); // nothing dropped
    expect(scheduled).toHaveLength(1); // and the feed resumes
    scheduled[0].fn();
    expect(created).toHaveLength(2);
  });

  it("stop() drops whatever is still queued for the vault being left", async () => {
    const sink = new SlowSink();
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
    for (let i = 0; i < 8; i++) ws!.onmessage?.({ data: updateFrame("d", [i]) });

    engine.stop(); // vault switch
    for (let i = 0; i < 20; i++) await tick();
    // Only the one already in flight when we stopped may have landed.
    expect(sink.applied.length).toBeLessThanOrEqual(1);
    expect(engine.inboundProgress().queued).toBe(0);
  });

  it("waits for the sink's durable manifest before sending hello", async () => {
    const sink = new SlowSink({ A: new Uint8Array([5]) });
    let ws: FakeWs | null = null;
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
    });
    engine.start();
    ws!.onopen?.(null);
    for (let i = 0; i < 5 && !ws!.helloText(); i++) await tick();

    expect(sink.ready).toBe(true); // hello never precedes the manifest load
    expect((ws!.helloText()!.manifest as Record<string, string>).A).toBe("BQ==");
  });
});

describe("VaultSyncEngine voice", () => {
  /** Bring an engine up to `ready` with a voice listener attached. */
  async function readyEngine(): Promise<{
    engine: VaultSyncEngine;
    ws: FakeWs;
    heard: VoiceFrame[];
    sink: MemSink;
  }> {
    const sink = new MemSink();
    const heard: VoiceFrame[] = [];
    let ws: FakeWs | null = null;
    const engine = new VaultSyncEngine({
      api: tokenApi(),
      vaultId: "v1",
      sink,
      wsFactory: () => (ws = new FakeWs()),
      onVoice: (f) => heard.push(f),
    });
    engine.start();
    ws!.onopen?.(null);
    await awaitHello(ws!);
    ws!.onmessage?.({ data: JSON.stringify({ t: "ready" }) });
    await tick();
    return { engine, ws: ws!, heard, sink };
  }

  it("advertises the voice capability in hello", async () => {
    const { ws } = await readyEngine();
    expect(ws.helloText()!.caps).toContain("voice");
  });

  it("surfaces an inbound chunk without routing it through the doc sink", async () => {
    const { ws, heard, sink } = await readyEngine();

    const frame = encodeVoiceFrame(
      { s: "tx1", n: 0, u: "ada", m: "Ada", c: "#6366f1", fmt: "pcm16", sr: 16000 },
      new Uint8Array([1, 2, 3]),
    );
    ws.onmessage?.({ data: frame.buffer.slice(0) });
    await tick();

    expect(heard).toHaveLength(1);
    expect(heard[0].header.u).toBe("ada");
    expect(heard[0].header.m).toBe("Ada");
    expect(heard[0].audio).toEqual(new Uint8Array([1, 2, 3]));
    // Critically: it must NOT be mistaken for a doc update.
    expect(sink.applied).toHaveLength(0);
  });

  it("still routes doc updates correctly alongside voice traffic", async () => {
    const { ws, heard, sink } = await readyEngine();

    ws.onmessage?.({ data: updateFrame("doc-a", [7, 8]) });
    ws.onmessage?.({
      data: encodeVoiceFrame({ s: "tx1", n: 0, u: "ada" }, new Uint8Array([1])).buffer.slice(0),
    });
    ws.onmessage?.({ data: updateFrame("doc-b", [9]) });
    for (let i = 0; i < 10 && sink.applied.length < 2; i++) await tick();

    expect(sink.applied.map((a) => a.docId)).toEqual(["doc-a", "doc-b"]);
    expect(heard).toHaveLength(1);
  });

  it("ignores an inbound chunk with no speaker stamped on it", async () => {
    const { ws, heard } = await readyEngine();
    // `u` absent — unattributable, so it can't be shown or grouped.
    ws.onmessage?.({
      data: encodeVoiceFrame({ s: "tx1", n: 0 }, new Uint8Array([1])).buffer.slice(0),
    });
    await tick();
    expect(heard).toHaveLength(0);
  });

  it("copies audio off the socket buffer so playback can outlive the callback", async () => {
    const { ws, heard } = await readyEngine();
    const frame = encodeVoiceFrame({ s: "tx1", n: 0, u: "ada" }, new Uint8Array([42, 43]));
    const buf = frame.buffer.slice(0) as ArrayBuffer;
    ws.onmessage?.({ data: buf });
    await tick();

    // Scribble over the received buffer the way a reused socket buffer would.
    new Uint8Array(buf).fill(0);
    expect(heard[0].audio).toEqual(new Uint8Array([42, 43]));
  });

  it("sends a chunk once ready and refuses before the channel is live", async () => {
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
    await awaitHello(ws!);

    // Not ready yet: dropped rather than queued — late audio is worthless.
    expect(engine.sendVoice({ s: "tx1", n: 0 }, new Uint8Array([1]))).toBe(false);

    ws!.onmessage?.({ data: JSON.stringify({ t: "ready" }) });
    await tick();
    expect(engine.sendVoice({ s: "tx1", n: 0, fmt: "pcm16", sr: 16000 }, new Uint8Array([1, 2]))).toBe(
      true,
    );

    const binary = ws!.sent.filter((s) => typeof s !== "string") as ArrayBufferView[];
    expect(binary).toHaveLength(1);
    const decoded = decodeVoiceFrame(new Uint8Array(binary[0] as Uint8Array));
    expect(decoded).toBeNull(); // outbound frames carry no `u` — the server stamps it
    // ...but the raw framing is intact and the server will accept it.
    expect((binary[0] as Uint8Array)[0]).toBe(VOICE_FRAME);
  });
});
