import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { decodeWsUpdate, parseHello } from "../src/sync/vault-protocol.js";
import type { DocDiff } from "../src/yjs/persistence.js";

/**
 * `hello.mode = "live-only"`.
 *
 * A client that is pulling its cold state over the bootstrap HTTP routes does not
 * want the channel's per-doc backfill as well — that would download the whole
 * vault twice. It still wants `ready`, because `empty` and `revoked` are the two
 * lists it ACTS on (seed these from disk; remove these from disk) and they cost
 * one query and no query respectively. Withholding them to save a backfill would
 * trade a download for a stuck vault.
 */

const pubsubs: InMemoryPubSub[] = [];
afterEach(async () => {
  await Promise.all(pubsubs.splice(0).map((p) => p.close()));
});

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<{ binary: boolean; data: unknown }> = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    this.sent.push({ binary: opts?.binary === true, data });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token: "good", ...frame })), false);
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => !s.binary).map((s) => JSON.parse(s.data as string));
  }
  docUpdates(): string[] {
    return this.sent
      .filter((s) => s.binary)
      .map((s) => decodeWsUpdate(s.data as Uint8Array)?.docId)
      .filter((d): d is string => Boolean(d));
  }
}

function channel(empty: string[] = []) {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  const backfilled: string[] = [];
  const ch = new VaultChannel({
    pubsub,
    verifyToken: async () => ({ userId: "u1", vaultId: "v1" }),
    listReadableDocs: async () => new Set(["A", "B"]),
    loadDiff: (async (docId: string) => {
      backfilled.push(docId);
      return {
        update: new Uint8Array([docId.charCodeAt(0)]),
        serverStateVector: new Uint8Array(),
        upToDate: false,
        clientAhead: false,
      } satisfies DocDiff;
    }) as never,
    listEmpty: async () => ({ empty, truncated: false }),
    backfillConcurrency: 4,
  });
  return { ch, backfilled };
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("vault channel hello mode", () => {
  it("parseHello accepts `live-only` and ignores anything else", () => {
    const base = { t: "hello", token: "t", manifest: {} };
    expect(parseHello(JSON.stringify({ ...base, mode: "live-only" }))?.mode).toBe("live-only");
    expect(parseHello(JSON.stringify({ ...base, mode: "everything" }))?.mode).toBeUndefined();
    // Every shipped client, which sends no `mode` at all.
    expect(parseHello(JSON.stringify(base))?.mode).toBeUndefined();
  });

  it("skips the backfill but still sends ready, with `empty` intact", async () => {
    const { ch, backfilled } = channel(["B"]);
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    ws.hello({ manifest: {}, mode: "live-only" });

    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    expect(backfilled).toEqual([]);
    expect(ws.docUpdates()).toEqual([]);
    const ready = ws.controls().find((c) => c.t === "ready")!;
    // The two lists a live-only client still acts on.
    expect(ready.empty).toEqual(["B"]);
  });

  it("still names revoked docs from the client's own manifest", async () => {
    const { ch } = channel();
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    // "GONE" is in the manifest but not in the readable set.
    ws.hello({ manifest: { A: "", GONE: "" }, mode: "live-only" });

    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    const ready = ws.controls().find((c) => c.t === "ready")!;
    expect(ready.revoked).toEqual(["GONE"]);
  });

  it("omitting mode still backfills — older clients are untouched", async () => {
    const { ch, backfilled } = channel();
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    ws.hello({ manifest: {} });

    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    expect(backfilled.sort()).toEqual(["A", "B"]);
    expect(ws.docUpdates().sort()).toEqual(["A", "B"]);
  });

  it("a live-only connection still receives live updates", async () => {
    const { ch } = channel();
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    ws.hello({ manifest: {}, mode: "live-only" });
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));

    await ch.publishDocUpdate("v1", "A", new Uint8Array([9]));
    await waitFor(() => ws.docUpdates().length > 0);
    expect(ws.docUpdates()).toEqual(["A"]);
  });
});
