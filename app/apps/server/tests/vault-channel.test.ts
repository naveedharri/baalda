import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import {
  decodeWsUpdate,
  decodeVoiceFrame,
  encodeVoiceFrame,
  type VoiceFrame,
  type VoiceHeader,
} from "../src/sync/vault-protocol.js";
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
  hello(
    token: string,
    manifest: Record<string, string> = {},
    priority?: string[],
    caps?: string[],
  ): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "hello", token, manifest, priority, caps })),
      false,
    );
  }
  /** Emit a push-to-talk chunk from this client (binary frame). */
  voice(header: VoiceHeader, audio: Uint8Array): void {
    this.emit("message", Buffer.from(encodeVoiceFrame(header, audio)), true);
  }
  /** Voice frames this client RECEIVED. */
  voices(): VoiceFrame[] {
    return this.sent
      .filter((s) => s.kind === "binary")
      .map((s) => decodeVoiceFrame((s as { bytes: Uint8Array }).bytes))
      .filter((f): f is VoiceFrame => f !== null);
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

  it("parks a presence frame that races the hello auth and replays it once subscribed", async () => {
    const { channel } = channelWith(() => new Set(["A", "B"]));
    const a = new FakeWs();
    const b = new FakeWs();
    channel.handleConnection(b as never);
    b.hello("good");
    await waitFor(() => b.controls().some((c) => c.t === "ready"));
    b.presence("B"); // B is already here before A joins

    // Clients announce right behind hello (they don't wait for ready), so this
    // presence frame lands while A's token verify / ACL resolve is still in
    // flight. It must be parked and replayed — not dropped — or A stays
    // invisible until its whole backfill drains.
    channel.handleConnection(a as never);
    a.hello("good");
    a.presence("A");

    await waitFor(() => b.controls().some((c) => c.t === "presence" && c.docId === "A"));
    // The replayed announce still counts as A's first: it triggers the roster
    // query round, so A learns B is on "B" without waiting for its own ready.
    await waitFor(() => a.controls().some((c) => c.t === "presence" && c.docId === "B"));
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

  it("releases the pubsub subscription when the socket dies inside the hello handshake", async () => {
    // The handshake subscribes only AFTER awaiting the ACL resolve. A socket that
    // closes inside that window has already had its `close` handler run (ws emits
    // it once), so the connection must notice and release the subscription itself
    // — otherwise the handler stays in the topic forever with no owner to remove
    // it, and every later vault event re-runs the ACL query for a dead client.
    const pubsub = new InMemoryPubSub();
    pubsubs.push(pubsub);
    let aclCalls = 0;
    let releaseAcl!: () => void;
    const aclGate = new Promise<void>((r) => {
      releaseAcl = r;
    });
    const channel = new VaultChannel({
      pubsub,
      verifyToken: async () => ({ userId: "u1", vaultId: "v1" }),
      listReadableDocs: async () => {
        aclCalls += 1;
        await aclGate; // hold the handshake open inside its await window
        return new Set(["A"]);
      },
      loadDiff: async (docId: string) => diffFor(docId),
      backfillConcurrency: 4,
    });

    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello("good");
    await waitFor(() => aclCalls === 1); // handshake is now parked mid-await

    ws.close(); // cleanup() runs here — before the subscription is ever assigned
    releaseAcl(); // handshake resumes and reaches the subscribe
    await new Promise((r) => setTimeout(r, 20)); // let the continuation finish

    // A leaked handler would answer this by kicking off another ACL resolve.
    await channel.publishAclChanged("v1");
    await new Promise((r) => setTimeout(r, 20));
    expect(aclCalls).toBe(1);
    expect(ws.controls().some((c) => c.t === "ready")).toBe(false);
  });
});

// ---- push-to-talk voice broadcast ----------------------------------------

/** Like `channelWith`, but the token IS the user id, so a test can put two
 *  distinct speakers on one vault. */
function voiceChannel(): { channel: VaultChannel; pubsub: InMemoryPubSub } {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  const channel = new VaultChannel({
    pubsub,
    verifyToken: async (token: string) => ({ userId: token, vaultId: "v1" }),
    listReadableDocs: async () => new Set<string>(),
    loadDiff: async () => null,
    backfillConcurrency: 4,
  });
  return { channel, pubsub };
}

/** Connect one voice-capable member and wait until it's live. */
async function joinVoice(
  channel: VaultChannel,
  userId: string,
  caps: string[] = ["voice"],
): Promise<FakeWs> {
  const ws = new FakeWs();
  channel.handleConnection(ws as never);
  ws.hello(userId, {}, undefined, caps);
  await waitFor(() => ws.controls().some((c) => c.t === "ready"));
  return ws;
}

describe("VaultChannel voice broadcast", () => {
  it("fans a chunk out to every other member and never back to the speaker", async () => {
    const { channel } = voiceChannel();
    const ada = await joinVoice(channel, "ada");
    const grace = await joinVoice(channel, "grace");
    const alan = await joinVoice(channel, "alan");
    ada.presence(null, "Ada", "#6366f1");

    ada.voice({ s: "tx1", n: 0, fmt: "pcm16", sr: 16000 }, new Uint8Array([1, 2, 3, 4]));

    await waitFor(() => grace.voices().length === 1 && alan.voices().length === 1);
    expect(grace.voices()[0].audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    // Speakers hear themselves live from their own mic; a loopback would be an echo.
    expect(ada.voices()).toHaveLength(0);
  });

  it("stamps the speaker from the token, ignoring any id the client claims", async () => {
    const { channel } = voiceChannel();
    const ada = await joinVoice(channel, "ada");
    const grace = await joinVoice(channel, "grace");
    ada.presence(null, "Ada", "#6366f1");

    // Ada tries to broadcast as Grace. The relay must overwrite `u`.
    ada.voice({ s: "tx1", n: 0, u: "grace", m: "Grace" }, new Uint8Array([9]));

    await waitFor(() => grace.voices().length === 1);
    const { header } = grace.voices()[0];
    expect(header.u).toBe("ada");
    expect(header.m).toBe("Ada"); // from server-held presence, not the payload
    expect(header.c).toBe("#6366f1");
  });

  it("sends the speaker's name only on the opening chunk", async () => {
    const { channel } = voiceChannel();
    const ada = await joinVoice(channel, "ada");
    const grace = await joinVoice(channel, "grace");
    ada.presence(null, "Ada", "#6366f1");

    ada.voice({ s: "tx1", n: 0 }, new Uint8Array([1]));
    ada.voice({ s: "tx1", n: 1 }, new Uint8Array([2]));
    ada.voice({ s: "tx1", n: 2, f: 1 }, new Uint8Array([3]));

    await waitFor(() => grace.voices().length === 3);
    const heard = grace.voices();
    expect(heard.map((v) => v.header.n)).toEqual([0, 1, 2]);
    expect(heard[0].header.m).toBe("Ada");
    expect(heard[1].header.m).toBeUndefined();
    expect(heard[2].header.m).toBeUndefined();
    // The release flag survives the round trip so the receiver can close the stream.
    expect(heard[2].header.f).toBe(1);
  });

  it("withholds voice from a client that did not advertise the capability", async () => {
    // Old clients push every binary frame through `decodeUpdateFrame` and would
    // apply a voice chunk as a corrupt doc update, so they must never receive one.
    const { channel } = voiceChannel();
    const ada = await joinVoice(channel, "ada");
    const legacy = await joinVoice(channel, "legacy", []);
    const grace = await joinVoice(channel, "grace");

    ada.voice({ s: "tx1", n: 0 }, new Uint8Array([1]));

    await waitFor(() => grace.voices().length === 1);
    expect(legacy.voices()).toHaveLength(0);
  });

  it("ignores a malformed or oversized chunk instead of relaying it", async () => {
    const { channel } = voiceChannel();
    const ada = await joinVoice(channel, "ada");
    const grace = await joinVoice(channel, "grace");

    // Not a voice frame at all.
    ada.emit("message", Buffer.from([0xff, 0x00, 0x01]), true);
    // Voice frame, but the header is missing the transmission id.
    ada.emit(
      "message",
      Buffer.from(encodeVoiceFrame({ n: 0 } as unknown as VoiceHeader, new Uint8Array([1]))),
      true,
    );
    // Over MAX_VOICE_CHUNK_BYTES.
    ada.voice({ s: "tx1", n: 0 }, new Uint8Array(64 * 1024 + 1));
    // A good one afterwards proves the connection still works.
    ada.voice({ s: "tx1", n: 1 }, new Uint8Array([7]));

    await waitFor(() => grace.voices().length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(grace.voices()).toHaveLength(1);
    expect(grace.voices()[0].header.n).toBe(1);
  });

  it("drops chunks from a speaker over the rate budget", async () => {
    const { channel } = voiceChannel();
    const ada = await joinVoice(channel, "ada");
    const grace = await joinVoice(channel, "grace");

    // The budget is 128 KB/s and refills with elapsed time, so blast well past
    // it in one tick: 8 x 64 KB = 512 KB with no time to refill.
    for (let n = 0; n < 8; n++) ada.voice({ s: "tx1", n }, new Uint8Array(64 * 1024));

    await waitFor(() => grace.voices().length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(grace.voices().length).toBeGreaterThan(0);
    expect(grace.voices().length).toBeLessThan(8);
  });

  it("refuses to relay audio from a socket that never said hello", async () => {
    const { channel } = voiceChannel();
    const grace = await joinVoice(channel, "grace");

    const anon = new FakeWs();
    channel.handleConnection(anon as never);
    anon.voice({ s: "tx1", n: 0 }, new Uint8Array([1, 2, 3]));

    await new Promise((r) => setTimeout(r, 30));
    expect(grace.voices()).toHaveLength(0);
  });
});
