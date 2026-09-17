/**
 * Admission control for the upload path. Moved verbatim out of
 * `http/routes/blobs.ts` when that file became routes-only; the behaviour is
 * unchanged, it just finally has somewhere to be unit-tested from.
 */

/** Requests allowed to WAIT for budget before we start shedding with 503. */
export const MAX_UPLOAD_QUEUE = 16;

/** How long a queued upload waits for budget before giving up with 503. */
export const UPLOAD_WAIT_MS = 30_000;

/**
 * FIFO admission control over a byte budget.
 *
 * Peak memory on the upload path is proportional to the size of the bodies
 * being handled, and nothing else bounded it: the size cap limited one request
 * while any number of compliant requests could run at once. Callers reserve
 * their (declared, clamped) body size before touching the body and release it
 * when done.
 */
export class ByteBudget {
  private inflight = 0;
  private readonly waiters: Array<{
    bytes: number;
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    private readonly budget: number,
    private readonly maxQueue: number = MAX_UPLOAD_QUEUE,
    private readonly waitMs: number = UPLOAD_WAIT_MS,
  ) {}

  /** Bytes currently reserved. Test/observability helper. */
  get reserved(): number {
    return this.inflight;
  }

  /** Requests currently waiting for budget. Test/observability helper. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Reserve `bytes`. Resolves true once admitted, false if the queue is
   * saturated or the wait timed out (caller should shed the request).
   *
   * `inflight === 0` always admits, so a request larger than the whole budget
   * still makes progress instead of deadlocking. Admission is strictly FIFO —
   * a newcomer never jumps a queue — so a large upload can't be starved by a
   * stream of small ones.
   */
  acquire(bytes: number): Promise<boolean> {
    if (this.waiters.length === 0 && this.fits(bytes)) {
      this.inflight += bytes;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= this.maxQueue) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = {
        bytes,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, this.waitMs),
      };
      // Never hold the process open just for a queued upload.
      if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /** Give back a previous successful reservation. Always call from a `finally`. */
  release(bytes: number): void {
    this.inflight -= bytes;
    if (this.inflight < 0) this.inflight = 0;
    while (this.waiters.length > 0 && this.fits(this.waiters[0].bytes)) {
      const waiter = this.waiters.shift() as (typeof this.waiters)[number];
      clearTimeout(waiter.timer);
      this.inflight += waiter.bytes;
      waiter.resolve(true);
    }
  }

  private fits(bytes: number): boolean {
    return this.inflight === 0 || this.inflight + bytes <= this.budget;
  }
}
