import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { VaultChannel, WS_CLOSE_UNAUTHORIZED } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { decodePubsub, encodePubsubMemberRemoved } from "../src/sync/vault-protocol.js";
import type { DocDiff } from "../src/yjs/persistence.js";

// A removed (or departed) member's vault-channel sockets are told and closed,
// and nobody else's. Fakes only — no socket, no DB.

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly texts: Array<Record<string, unknown>> = [];
  closeCode: number | null = null;
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (!opts?.binary) this.texts.push(JSON.parse(data as string));
  }
  close(code?: number): void {
    if (this.readyState === 3) return;
    this.closeCode = code ?? null;
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string, caps: string[]): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "hello", token, manifest: {}, caps })),
      false,
    );
  }
}

const pubsubs: InMemoryPubSub[] = [];

function channel(): VaultChannel {
  const pubsub = new InMemoryPubSub();
  pubsubs.push(pubsub);
  return new VaultChannel({
    pubsub,
    // token = the user id
    verifyToken: async (token: string) => ({ userId: token, vaultId: "v1" }),
    listReadableDocs: async () => new Set(["A"]),
    loadDiff: async (): Promise<DocDiff> => ({
      update: new Uint8Array([1]),
      serverStateVector: new Uint8Array(),
      upToDate: true,
      clientAhead: false,
    }),
    listEmpty: async () => ({ empty: [] as string[], truncated: false }),
    backfillConcurrency: 4,
    registryCoalesceMs: 0,
  });
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function connected(ch: VaultChannel, userId: string, caps: string[]): Promise<FakeWs> {
  const ws = new FakeWs();
  ch.handleConnection(ws as never);
  ws.hello(userId, caps);
  await waitFor(() => ws.texts.some((c) => c.t === "ready"));
  return ws;
}

afterEach(async () => {
  await Promise.all(pubsubs.splice(0).map((p) => p.close()));
});

describe("pubsub codec — member-removed", () => {
  it("round-trips and rejects a bad reason", () => {
    expect(decodePubsub(encodePubsubMemberRemoved("o1", "u1", "left"))).toEqual({
      type: "member-removed",
      orgId: "o1",
      userId: "u1",
      reason: "left",
    });
    const bad = encodePubsubMemberRemoved("o1", "u1", "removed");
    const tampered = new Uint8Array([bad[0], ...new TextEncoder().encode('{"orgId":"o1","userId":"u1","reason":"x"}')]);
    expect(decodePubsub(tampered)).toBeNull();
  });
});

describe("VaultChannel — member-removed", () => {
  it("tells only that user's capable sockets, closes all of theirs, leaves others alone", async () => {
    const ch = channel();
    const gone = await connected(ch, "u1", ["member-removed"]);
    const goneOld = await connected(ch, "u1", []);
    const other = await connected(ch, "u2", ["member-removed"]);

    await ch.publishMemberRemoved("v1", "o1", "u1", "removed");
    await waitFor(() => gone.readyState === 3 && goneOld.readyState === 3);

    expect(gone.texts.find((c) => c.t === "member-removed")).toEqual({
      t: "member-removed",
      orgId: "o1",
      userId: "u1",
      reason: "removed",
    });
    expect(gone.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
    // No cap: closed without the frame an old client cannot parse.
    expect(goneOld.texts.some((c) => c.t === "member-removed")).toBe(false);
    expect(goneOld.closeCode).toBe(WS_CLOSE_UNAUTHORIZED);
    // A teammate hears nothing and stays connected.
    await new Promise((r) => setTimeout(r, 20));
    expect(other.texts.some((c) => c.t === "member-removed")).toBe(false);
    expect(other.readyState).toBe(1);
  });

  it("carries reason left", async () => {
    const ch = channel();
    const ws = await connected(ch, "u1", ["member-removed"]);
    await ch.publishMemberRemoved("v1", "o1", "u1", "left");
    await waitFor(() => ws.readyState === 3);
    expect(ws.texts.find((c) => c.t === "member-removed")?.reason).toBe("left");
  });
});
