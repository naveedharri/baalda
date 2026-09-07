import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import type { DocDiff } from "../src/yjs/persistence.js";

// When a structural change is (and is NOT) also an ACL change.
//
// `reauth` tells a client to re-mint the OPEN note's sync token, which drops and
// reopens that note's Hocuspocus socket. It used to be sent on every
// `registry-changed`, with no origin skip — so one create/rename/delete cost
// every subscriber, the author included, a token re-mint plus a full registry
// pull, and the pull's own writes published the next `registry-changed`. On a
// vault with work left to do that never settled: the sync badge blinked
// Syncing/Synced indefinitely (#93). Fakes only — no socket, no DB.

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
  hello(origin?: string): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "hello", token: "good", manifest: {}, origin })),
      false,
    );
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s.kind === "text")
      .map((s) => (s as { value: Record<string, unknown> }).value);
  }
  countOf(t: string): number {
    return this.controls().filter((c) => c.t === t).length;
  }
}

const pubsubs: InMemoryPubSub[] = [];

function channelWith(readable: () => Set<string>): {
  channel: VaultChannel;
  pubsub: InMemoryPubSub;
} {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  const channel = new VaultChannel({
    pubsub,
    verifyToken: async (token: string) => {
      if (token !== "good") throw new Error("bad token");
      return { userId: "u1", vaultId: "v1" };
    },
    // A COPY per call. Handing back the same Set the test mutates would make
    // `prev` and `next` the same object inside `refreshAcl`, so no add or removal
    // could ever be detected — the fake would hide the very thing under test.
    listReadableDocs: async () => new Set(readable()),
    loadDiff: async (docId: string): Promise<DocDiff> => ({
      update: new Uint8Array([docId.charCodeAt(0)]),
      serverStateVector: new Uint8Array(),
      upToDate: false,
    }),
    listEmpty: async () => ({ empty: [] as string[], truncated: false }),
    backfillConcurrency: 4,
    // No coalescing window, so each publish is its own broadcast and the test
    // does not have to wait one out.
    registryCoalesceMs: 0,
  });
  return { channel, pubsub };
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A connected, backfilled client. */
async function connected(
  channel: VaultChannel,
  origin?: string,
): Promise<FakeWs> {
  const ws = new FakeWs();
  channel.handleConnection(ws as never);
  ws.hello(origin);
  await waitFor(() => ws.controls().some((c) => c.t === "ready"));
  return ws;
}

afterEach(async () => {
  await Promise.all(pubsubs.splice(0).map((p) => p.close()));
});

describe("VaultChannel — reauth is for ACL changes, not every structural write", () => {
  it("sends no reauth for a structural change that leaves the readable set alone", async () => {
    const readable = new Set(["A"]);
    const { channel } = channelWith(() => readable);
    const ws = await connected(channel, "client-1");

    // Someone else's rename: this client must re-pull the structure…
    await channel.publishRegistryChanged("v1", "client-2");
    await waitFor(() => ws.countOf("registry") === 1);
    // …but its open note's grant did not move, so nothing re-mints.
    expect(ws.countOf("reauth")).toBe(0);
  });

  it("still sends reauth when the structural change added a readable doc", async () => {
    const readable = new Set(["A"]);
    const { channel } = channelWith(() => readable);
    const ws = await connected(channel, "client-1");

    readable.add("B"); // a note this user can now read appeared
    await channel.publishRegistryChanged("v1", "client-2");
    await waitFor(() => ws.countOf("reauth") === 1);
  });

  it("still sends reauth when the structural change took a readable doc away", async () => {
    const readable = new Set(["A", "B"]);
    const { channel } = channelWith(() => readable);
    const ws = await connected(channel, "client-1");

    readable.delete("B"); // deleted, or moved out of reach
    await channel.publishRegistryChanged("v1", "client-2");
    await waitFor(() => ws.countOf("drop") === 1);
    expect(ws.countOf("reauth")).toBe(1);
  });

  it("never asks the author of a structural change to re-mint or re-pull", async () => {
    // The loop's closing edge: this client's OWN registry writes came back to it
    // as `reauth`, which triggered another pull, whose writes came back again.
    const readable = new Set(["A"]);
    const { channel } = channelWith(() => readable);
    const ws = await connected(channel, "client-1");

    await channel.publishRegistryChanged("v1", "client-1");
    // Nothing to wait for, so give the relay a few turns to prove a negative.
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.countOf("registry")).toBe(0);
    expect(ws.countOf("reauth")).toBe(0);
  });

  it("always sends reauth for a real ACL change, even with the set unchanged", async () => {
    // view↔edit and lock/unlock leave the readable SET intact while flipping the
    // open note's editability — that is precisely what reauth is for.
    const readable = new Set(["A"]);
    const { channel } = channelWith(() => readable);
    const ws = await connected(channel, "client-1");

    await channel.publishAclChanged("v1");
    await waitFor(() => ws.countOf("reauth") === 1);
  });
});
