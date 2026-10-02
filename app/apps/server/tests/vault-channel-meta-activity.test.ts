import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import {
  decodePubsub,
  encodePubsubActivityChanged,
  encodePubsubMetaChanged,
} from "../src/sync/vault-protocol.js";
import type { DocDiff } from "../src/yjs/persistence.js";

// #262: a "last edited by" stamp is not a structural change. It used to go out
// as an anonymous `registry-changed`, so every subscriber recomputed its
// readable set and re-pulled the whole registry once per stamped note.
// #260: the Activity feed refetches on an `activity` frame instead of polling.
// Fakes only — no socket, no DB.

type Sent = { kind: "text"; value: Record<string, unknown> } | { kind: "binary" };

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Sent[] = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({ kind: "binary" });
    else this.sent.push({ kind: "text", value: JSON.parse(data as string) });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "hello", token: "good", manifest: {} })),
      false,
    );
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s.kind === "text")
      .map((s) => (s as { value: Record<string, unknown> }).value);
  }
}

const pubsubs: InMemoryPubSub[] = [];

function channelWith(coalesceMs = 0): { channel: VaultChannel; aclCalls: () => number } {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  let calls = 0;
  const channel = new VaultChannel({
    pubsub,
    verifyToken: async (token: string) => {
      if (token !== "good") throw new Error("bad token");
      return { userId: "u1", vaultId: "v1" };
    },
    listReadableDocs: async () => {
      calls++;
      return new Set(["A"]);
    },
    loadDiff: async (): Promise<DocDiff> => ({
      update: new Uint8Array([1]),
      serverStateVector: new Uint8Array(),
      upToDate: true,
      clientAhead: false,
    }),
    listEmpty: async () => ({ empty: [] as string[], truncated: false }),
    backfillConcurrency: 4,
    registryCoalesceMs: coalesceMs,
  });
  return { channel, aclCalls: () => calls };
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function connected(channel: VaultChannel): Promise<FakeWs> {
  const ws = new FakeWs();
  channel.handleConnection(ws as never);
  ws.hello();
  await waitFor(() => ws.controls().some((c) => c.t === "ready"));
  return ws;
}

afterEach(async () => {
  await Promise.all(pubsubs.splice(0).map((p) => p.close()));
});

describe("pubsub codec — meta / activity", () => {
  it("round-trips both new message types", () => {
    expect(decodePubsub(encodePubsubMetaChanged())).toEqual({ type: "meta-changed" });
    expect(decodePubsub(encodePubsubActivityChanged())).toEqual({ type: "activity-changed" });
  });
});

describe("VaultChannel — meta-only registry frames (#262)", () => {
  it("forwards a stamp as registry{meta:true} without recomputing the readable set", async () => {
    const { channel, aclCalls } = channelWith();
    const ws = await connected(channel);
    const before = aclCalls();

    await channel.publishMetaChanged("v1");
    await waitFor(() => ws.controls().some((c) => c.t === "registry"));

    const frame = ws.controls().find((c) => c.t === "registry");
    expect(frame).toEqual({ t: "registry", meta: true });
    expect(aclCalls()).toBe(before);
    expect(ws.controls().some((c) => c.t === "reauth")).toBe(false);
  });

  it("coalesces a burst of stamps into one frame", async () => {
    const { channel } = channelWith(30);
    const ws = await connected(channel);

    for (let i = 0; i < 40; i++) await channel.publishMetaChanged("v1");
    await waitFor(() => ws.controls().some((c) => c.t === "registry"));
    await new Promise((r) => setTimeout(r, 80));

    expect(ws.controls().filter((c) => c.t === "registry")).toHaveLength(1);
  });

  it("a structural change still sends a plain registry frame", async () => {
    const { channel } = channelWith();
    const ws = await connected(channel);
    await channel.publishRegistryChanged("v1", null);
    await waitFor(() => ws.controls().some((c) => c.t === "registry"));
    expect(ws.controls().find((c) => c.t === "registry")).toEqual({ t: "registry" });
  });
});

describe("VaultChannel — activity frames (#260)", () => {
  it("forwards activity-changed as {t:'activity'}, coalesced per vault", async () => {
    const { channel } = channelWith(30);
    const ws = await connected(channel);

    await channel.publishActivityChanged("v1");
    await channel.publishActivityChanged("v1");
    await waitFor(() => ws.controls().some((c) => c.t === "activity"));
    await new Promise((r) => setTimeout(r, 80));

    expect(ws.controls().filter((c) => c.t === "activity")).toHaveLength(1);
  });

  it("flushPendingRegistry publishes an open activity window immediately", async () => {
    const { channel } = channelWith(10_000);
    const ws = await connected(channel);
    await channel.publishActivityChanged("v1");
    channel.flushPendingRegistry();
    await waitFor(() => ws.controls().some((c) => c.t === "activity"));
  });
});
