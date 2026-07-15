import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { decodeWsUpdate } from "../src/sync/vault-protocol.js";
import type { DocDiff } from "../src/yjs/persistence.js";

// Exercises the relay logic (backfill -> ready -> live fanout -> acl drop) with a
// fake socket + injected deps and the real in-memory pub/sub. No DB, no network.

type Sent = { kind: "text"; value: unknown } | { kind: "binary"; bytes: Uint8Array };

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Sent[] = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({ kind: "binary", bytes: data as Uint8Array });
    else this.sent.push({ kind: "text", value: JSON.parse(data as string) });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string, manifest: Record<string, string> = {}, priority?: string[]): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest, priority })), false);
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.kind === "text").map((s) => (s as { value: Record<string, unknown> }).value);
  }
  updates(): Array<{ docId: string; update: Uint8Array }> {
    return this.sent
      .filter((s) => s.kind === "binary")
      .map((s) => decodeWsUpdate((s as { bytes: Uint8Array }).bytes)!)
      .filter(Boolean);
  }
}

function diffFor(docId: string): DocDiff {
  return { update: new Uint8Array([docId.charCodeAt(0)]), serverStateVector: new Uint8Array(), upToDate: false };
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const pubsubs: InMemoryPubSub[] = [];
function channelWith(readable: () => Set<string>): { channel: VaultChannel; pubsub: InMemoryPubSub } {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  const channel = new VaultChannel({
    pubsub,
    verifyToken: async (token: string) => {
      if (token !== "good") throw new Error("bad token");
      return { userId: "u1", vaultId: "v1" };
    },
    listReadableDocs: async () => readable(),
    loadDiff: async (docId: string) => diffFor(docId),
    backfillConcurrency: 4,
  });
  return { channel, pubsub };
}

afterEach(async () => {
  await Promise.all(pubsubs.splice(0).map((p) => p.close()));
});

describe("VaultChannel relay (spec 05 §3.1)", () => {
  it("backfills the readable set then signals ready", async () => {
    const { channel } = channelWith(() => new Set(["A", "B"]));
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello("good");

    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    expect(ws.updates().map((u) => u.docId).sort()).toEqual(["A", "B"]);
  });

  it("closes with an error on a bad token", async () => {
    const { channel } = channelWith(() => new Set(["A"]));
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello("bad");

    await waitFor(() => ws.controls().some((c) => c.t === "err"));
    expect(ws.updates()).toHaveLength(0);
  });

  it("forwards a live update only for docs in the readable set", async () => {
    const { channel } = channelWith(() => new Set(["A"]));
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello("good");
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    const before = ws.updates().length;

    await channel.publishDocUpdate("v1", "A", new Uint8Array([1]));
    await channel.publishDocUpdate("v1", "Z", new Uint8Array([2])); // not readable
    await waitFor(() => ws.updates().length > before);

    const live = ws.updates().slice(before);
    expect(live.map((u) => u.docId)).toEqual(["A"]);
  });

  it("drops a doc when an acl change removes it from the readable set", async () => {
    let set = new Set(["A", "B"]);
    const { channel } = channelWith(() => set);
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello("good");
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));

    set = new Set(["A"]); // B revoked
    await channel.publishAclChanged("v1");
    await waitFor(() => ws.controls().some((c) => c.t === "drop"));

    const drops = ws.controls().filter((c) => c.t === "drop");
    expect(drops).toEqual([{ t: "drop", docId: "B" }]);
  });
});
