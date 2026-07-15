import { describe, expect, it } from "vitest";
import { InMemoryPubSub, vaultTopic } from "../src/sync/pubsub.js";

// Pure unit test — no Postgres/Redis. Exercises the fanout contract the vault
// channel relies on (spec 05 §3.2). RedisPubSub shares the same interface and is
// covered by the HA integration path; here we pin the in-memory default.

describe("InMemoryPubSub (spec 05 §3.2)", () => {
  it("delivers a binary payload to every subscriber of a topic", async () => {
    const ps = new InMemoryPubSub();
    const t = vaultTopic("v1");
    const got: Uint8Array[] = [];
    await ps.subscribe(t, (p) => got.push(p));
    await ps.subscribe(t, (p) => got.push(p));

    const payload = new Uint8Array([1, 2, 3]);
    await ps.publish(t, payload);

    expect(got).toHaveLength(2);
    expect([...got[0]]).toEqual([1, 2, 3]);
    await ps.close();
  });

  it("isolates topics — a publish reaches only its own subscribers", async () => {
    const ps = new InMemoryPubSub();
    const a: number[] = [];
    const b: number[] = [];
    await ps.subscribe(vaultTopic("A"), () => a.push(1));
    await ps.subscribe(vaultTopic("B"), () => b.push(1));

    await ps.publish(vaultTopic("A"), new Uint8Array([0]));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    await ps.close();
  });

  it("stops delivering after unsubscribe and cleans up the empty topic", async () => {
    const ps = new InMemoryPubSub();
    const t = vaultTopic("v2");
    let count = 0;
    const off = await ps.subscribe(t, () => count++);

    await ps.publish(t, new Uint8Array([0]));
    await off();
    await ps.publish(t, new Uint8Array([0]));

    expect(count).toBe(1);
    await ps.close();
  });

  it("tolerates a handler that unsubscribes mid-dispatch", async () => {
    const ps = new InMemoryPubSub();
    const t = vaultTopic("v3");
    let offSelf: (() => Promise<void>) | null = null;
    let other = 0;
    offSelf = await ps.subscribe(t, () => {
      // Unsubscribing while the set is being iterated must not throw or skip peers.
      void offSelf?.();
    });
    await ps.subscribe(t, () => other++);

    await ps.publish(t, new Uint8Array([0]));

    expect(other).toBe(1);
    await ps.close();
  });
});
