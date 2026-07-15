import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { decodeWsUpdate } from "../src/sync/vault-protocol.js";

// Load/isolation harness for the core scaling claim (spec 05 §5): the cost of
// one edit is proportional to the number of subscribers in THAT vault, not the
// total user count. We stand up N vaults × M members on one channel, publish a
// single update to one vault, and assert exactly that vault's M subscribers get
// it and the other (N-1)×M get nothing. Pure (no DB/Redis) so it's fast and
// deterministic; scale the constants to stress it.

const N_VAULTS = 15;
const M_MEMBERS = 20;

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  received = 0;
  ready = false;
  constructor(readonly vaultId: string) {
    super();
  }
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) {
      const f = decodeWsUpdate(data as Uint8Array);
      if (f) this.received++;
    } else if ((JSON.parse(data as string) as { t?: string }).t === "ready") {
      this.ready = true;
    }
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(userId: string): void {
    const token = `${this.vaultId}:${userId}`;
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {} })), false);
  }
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("vault fanout isolation / load (spec 05 §5)", () => {
  it("an update reaches only its own vault's subscribers", async () => {
    const channel = new VaultChannel({
      pubsub: new InMemoryPubSub(),
      // token = "<vaultId>:<userId>"; each vault has exactly one doc.
      verifyToken: async (token: string) => {
        const [vaultId, userId] = token.split(":");
        return { userId, vaultId };
      },
      listReadableDocs: async (_userId: string, vaultId: string) =>
        new Set([`doc:${vaultId}`]),
      loadDiff: async () => null, // no backfill; we only measure live fanout
    });

    const sockets: FakeWs[] = [];
    for (let v = 0; v < N_VAULTS; v++) {
      for (let m = 0; m < M_MEMBERS; m++) {
        const ws = new FakeWs(`vault${v}`);
        channel.handleConnection(ws as never);
        ws.hello(`user${m}`);
        sockets.push(ws);
      }
    }
    await waitFor(() => sockets.every((s) => s.ready));

    // One edit in vault0.
    await channel.publishDocUpdate("vault0", "doc:vault0", new Uint8Array([1, 2, 3]));
    await waitFor(() => sockets.filter((s) => s.vaultId === "vault0").every((s) => s.received > 0));

    const inVault0 = sockets.filter((s) => s.vaultId === "vault0");
    const others = sockets.filter((s) => s.vaultId !== "vault0");

    // Exactly vault0's M members received it; nobody else did.
    expect(inVault0.every((s) => s.received === 1)).toBe(true);
    expect(others.every((s) => s.received === 0)).toBe(true);

    const totalDeliveries = sockets.reduce((n, s) => n + s.received, 0);
    expect(totalDeliveries).toBe(M_MEMBERS); // fanout cost ∝ vault size, not N×M
  });
});
