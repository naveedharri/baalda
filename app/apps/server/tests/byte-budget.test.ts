import { describe, expect, it } from "vitest";
import { ByteBudget } from "../src/blobs/admission.js";

/** Let queued promises settle without depending on a timer. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("ByteBudget (upload admission)", () => {
  it("admits while the budget fits and accounts for what is reserved", async () => {
    const b = new ByteBudget(100);
    expect(await b.acquire(40)).toBe(true);
    expect(await b.acquire(60)).toBe(true);
    expect(b.reserved).toBe(100);
    expect(b.waiting).toBe(0);
  });

  it("admits an over-budget request when nothing is in flight (no deadlock)", async () => {
    const b = new ByteBudget(100);
    expect(await b.acquire(10_000)).toBe(true);
    expect(b.reserved).toBe(10_000);
  });

  it("queues past the budget and drains FIFO on release", async () => {
    const b = new ByteBudget(100);
    expect(await b.acquire(80)).toBe(true);

    const order: string[] = [];
    const big = b.acquire(60).then((ok) => order.push(`big:${ok}`));
    const small = b.acquire(10).then((ok) => order.push(`small:${ok}`));
    await tick();
    // Both wait: `small` would fit, but a newcomer never jumps the queue.
    expect(b.waiting).toBe(2);

    b.release(80);
    await Promise.all([big, small]);
    expect(order).toEqual(["big:true", "small:true"]);
    expect(b.reserved).toBe(70);
    expect(b.waiting).toBe(0);
  });

  it("refuses immediately once the queue is saturated", async () => {
    const b = new ByteBudget(100, 2);
    expect(await b.acquire(100)).toBe(true);
    const queued = [b.acquire(50), b.acquire(50)];
    await tick();
    expect(b.waiting).toBe(2);

    // Third waiter: queue full → shed now rather than pile up.
    expect(await b.acquire(50)).toBe(false);

    b.release(100);
    expect(await Promise.all(queued)).toEqual([true, true]);
  });

  it("gives up with false when the wait times out, and stops occupying the queue", async () => {
    const b = new ByteBudget(100, 4, 20);
    expect(await b.acquire(100)).toBe(true);
    expect(await b.acquire(50)).toBe(false); // waited 20ms, never admitted
    expect(b.waiting).toBe(0);
    expect(b.reserved).toBe(100);
  });

  it("never lets release drive the reservation negative", () => {
    const b = new ByteBudget(100);
    b.release(50);
    expect(b.reserved).toBe(0);
  });
});
