// PubSub — the cross-process fanout seam for the vault replication channel
// (spec 05 §3.2). One topic per vault (`vault:{vaultId}`); payloads are opaque
// binary frames (encoded Yjs updates / control messages). The vault channel is a
// *stateless relay*, so nothing here ever holds a Y.Doc — we only move bytes.
//
// Two interchangeable implementations, chosen once at boot from `REDIS_URL`:
//   - InMemoryPubSub: single process, zero deps. The self-host default.
//   - RedisPubSub:    N instances share the feed, so any client can hit any
//                     instance behind a load balancer (HA + rolling deploys).
// Nothing else in the codebase knows which one is running.

import type { Redis } from "ioredis";

/** Called for each message published to a subscribed topic. */
export type PubSubHandler = (payload: Uint8Array) => void;

export interface PubSub {
  publish(topic: string, payload: Uint8Array): Promise<void>;
  /** Subscribe; returns an unsubscribe function. Multiple handlers per topic ok. */
  subscribe(topic: string, handler: PubSubHandler): Promise<() => void>;
  close(): Promise<void>;
}

/** Topic name for a vault's fanout channel. */
export function vaultTopic(vaultId: string): string {
  return `vault:${vaultId}`;
}

// ---------------------------------------------------------------------------

/** Single-process fanout: a plain in-memory handler registry. */
export class InMemoryPubSub implements PubSub {
  private readonly topics = new Map<string, Set<PubSubHandler>>();

  async publish(topic: string, payload: Uint8Array): Promise<void> {
    const handlers = this.topics.get(topic);
    if (!handlers) return;
    // Copy so a handler that (un)subscribes mid-dispatch can't mutate the set
    // we're iterating.
    for (const h of [...handlers]) h(payload);
  }

  async subscribe(topic: string, handler: PubSubHandler): Promise<() => void> {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return async () => {
      const s = this.topics.get(topic);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.topics.delete(topic);
    };
  }

  async close(): Promise<void> {
    this.topics.clear();
  }
}

// ---------------------------------------------------------------------------

/**
 * Redis-backed fanout. Uses two connections — Redis requires a dedicated
 * connection in subscriber mode (it can't run normal commands), so publishing
 * rides a separate connection. Payloads stay binary end-to-end via the
 * `messageBuffer` event (never the string `message` event, which would corrupt
 * bytes). Channel routing is done client-side against a local handler registry,
 * so many vault topics multiplex over the one subscriber connection.
 */
export class RedisPubSub implements PubSub {
  private readonly handlers = new Map<string, Set<PubSubHandler>>();

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    // Route every inbound binary message to the topic's local handlers.
    this.sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
      const set = this.handlers.get(channel.toString());
      if (!set) return;
      const payload = new Uint8Array(message);
      for (const h of [...set]) h(payload);
    });
  }

  async publish(topic: string, payload: Uint8Array): Promise<void> {
    await this.pub.publish(topic, Buffer.from(payload));
  }

  async subscribe(topic: string, handler: PubSubHandler): Promise<() => void> {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
      await this.sub.subscribe(topic); // first local handler ⇒ join the channel
    }
    set.add(handler);
    return async () => {
      const s = this.handlers.get(topic);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.handlers.delete(topic);
        await this.sub.unsubscribe(topic); // last handler gone ⇒ leave the channel
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.pub.disconnect();
    this.sub.disconnect();
  }
}

/**
 * Build the PubSub for this process. `redisUrl` unset ⇒ in-memory (single
 * instance). Set ⇒ Redis (multi-instance). `ioredis` is imported lazily so the
 * dependency is only touched when Redis is actually configured — self-hosters
 * who never set REDIS_URL don't pay for it at boot.
 */
export async function createPubSub(redisUrl: string | undefined): Promise<PubSub> {
  if (!redisUrl) return new InMemoryPubSub();
  const { Redis } = await import("ioredis");
  const pub = new Redis(redisUrl, { lazyConnect: false });
  const sub = new Redis(redisUrl, { lazyConnect: false });
  return new RedisPubSub(pub, sub);
}
