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
  presence(docId: string | null, name = "Ada", color = "#6366f1", status = "online"): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "presence", docId, name, color, status })),
      false,
    );
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

  it("tells the client to re-pull on a registry change", async () => {
    let set = new Set(["A"]);
    const { channel } = channelWith(() => set);
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello("good");
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));

    // A teammate created a note "B" — the readable set grew AND a registry frame
    // is sent so the client re-pulls its tree; the new doc also backfills.
    set = new Set(["A", "B"]);
    await channel.publishRegistryChanged("v1");
    await waitFor(() => ws.controls().some((c) => c.t === "registry"));

    expect(ws.controls().filter((c) => c.t === "registry")).toEqual([{ t: "registry" }]);
    // Newly-readable "B" is backfilled off the same signal.
    await waitFor(() => ws.updates().some((u) => u.docId === "B"));
  });

  it("forwards a member-joined announcement to every subscriber (not doc-scoped)", async () => {
    const { channel } = channelWith(() => new Set(["A"]));
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello("good");
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));

    await channel.publishMemberJoined("v1", "Ada");
    await waitFor(() => ws.controls().some((c) => c.t === "member"));

    expect(ws.controls().filter((c) => c.t === "member")).toEqual([
      { t: "member", name: "Ada" },
    ]);
  });

  it("forwards a teammate's presence to subscribers that can read the doc (gone always passes)", async () => {
    const { channel } = channelWith(() => new Set(["A"]));
    const a = new FakeWs();
    const b = new FakeWs();
    channel.handleConnection(a as never);
    channel.handleConnection(b as never);
    a.hello("good");
    b.hello("good");
    await waitFor(() => a.controls().some((c) => c.t === "ready"));
    await waitFor(() => b.controls().some((c) => c.t === "ready"));

    // A is viewing note "A" (readable by B) → B sees it.
    a.presence("A");
    await waitFor(() => b.controls().some((c) => c.t === "presence" && c.docId === "A"));
    const seen = b.controls().find((c) => c.t === "presence" && c.docId === "A");
    expect(seen).toEqual({
      t: "presence",
      userId: "u1",
      docId: "A",
      name: "Ada",
      color: "#6366f1",
      status: "online",
    });

    // A moves to note "Z" (NOT in B's readable set) → B never sees "Z".
    a.presence("Z");
    // A closes the note (docId null = gone) → always forwarded so B can clear.
    a.presence(null);
    await waitFor(() => b.controls().some((c) => c.t === "presence" && c.docId === null));
    expect(b.controls().some((c) => c.t === "presence" && c.docId === "Z")).toBe(false);
  });

  it("re-announces presence so a newcomer learns who's already viewing what", async () => {
    const { channel } = channelWith(() => new Set(["A"]));
    const a = new FakeWs();
    channel.handleConnection(a as never);
    a.hello("good");
    await waitFor(() => a.controls().some((c) => c.t === "ready"));
    a.presence("A"); // A is already here before B joins

    // B joins afterward and announces itself; its first announce triggers a
    // presence-query, prompting A to re-announce so B learns A is on "A".
    const b = new FakeWs();
    channel.handleConnection(b as never);
    b.hello("good");
    await waitFor(() => b.controls().some((c) => c.t === "ready"));
    b.presence(null);

    await waitFor(() => b.controls().some((c) => c.t === "presence" && c.docId === "A"));
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
