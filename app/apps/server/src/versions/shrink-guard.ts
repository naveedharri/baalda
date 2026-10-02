/**
 * Version-before-a-sharp-shrink (issue #200).
 *
 * The idle capture versions a note ten minutes AFTER an edit session, so a
 * single update that empties a note (the stale-copy wipe of #93, or one typed
 * character replacing a body-wide selection) left history holding only what
 * came after it whenever the note had not been versioned since its last good
 * state. This keeps the text as it stood immediately before any one update
 * that removes most of it, as a `pre-shrink` version the user can restore from
 * Version History.
 *
 * It deliberately does NOT refuse the update. A CRDT client that has applied
 * an operation keeps it: a server that drops it would leave the two sides
 * permanently unequal, and the client's state vector would stay ahead, so it
 * would be named on `ready.behind` and re-push the same delete on every
 * connect. A version is the recoverable half of a refusal without that loop.
 *
 * Both write paths report here — the live Hocuspocus `onChange` (which also
 * carries doc-writer writes to a loaded doc) and the detached `applyDetached`.
 * Bound once per process by `src/index.ts`, like `setDocBatchRuntime`; unbound
 * (unit tests that build a bare sync server) it is a no-op.
 */

/** Below this many characters a note is too small for a shrink to mean much. */
export const SHRINK_MIN_CHARS = 200;
/** An update is a sharp shrink when it leaves at most this share of the text. */
export const SHRINK_KEEP_RATIO = 0.2;

export function isSharpShrink(before: string, after: string): boolean {
  const prev = before.trim().length;
  if (prev < SHRINK_MIN_CHARS) return false;
  return after.trim().length <= prev * SHRINK_KEEP_RATIO;
}

export type ShrinkHook = (
  vaultId: string,
  docId: string,
  previousText: string,
  userId: string | null,
) => void;

let hook: ShrinkHook | null = null;

export function setShrinkHook(next: ShrinkHook | null): void {
  hook = next;
}

/** Report an applied update; fires the hook only for a sharp shrink. Never throws. */
export function reportShrink(
  vaultId: string,
  docId: string,
  before: string,
  after: string,
  userId: string | null,
  /** The server-side writer's origin tag (`mcp`, `bulk`, ...), when known. An
   *  MCP tool call is an explicit request, not a misbehaving client, so it is
   *  versioned like any shrink but never counted towards the burst brake. */
  source?: string | null,
): void {
  if (!isSharpShrink(before, after)) return;
  if (hook) {
    try {
      hook(vaultId, docId, before, userId);
    } catch (err) {
      console.error(`[versions] shrink hook failed for ${docId}:`, err);
    }
  }
  const outcome = userId && source !== "mcp" ? shrinkBrake.recordShrink(userId, vaultId, docId) : null;
  if (userId && outcome === "grew") {
    // A held user's update that was already in flight when the brake engaged
    // (a batch item past its hold check, a socket not yet kicked) still
    // applied: the hold's count follows it, so every surface says how many
    // notes were really emptied, not the threshold (#275).
    const hold = shrinkBrake.holdOf(userId, vaultId);
    if (hold && brakeGrowHook) {
      try {
        brakeGrowHook(vaultId, userId, hold);
      } catch (err) {
        console.error(`[versions] shrink brake grow hook failed for vault ${vaultId}:`, err);
      }
    }
  }
  if (userId && outcome === "engaged") {
    console.warn(
      `[versions] shrink brake engaged for user ${userId} in vault ${vaultId}: ` +
        `${shrinkBrake.threshold} populated notes sharply shrunk within ${shrinkBrake.windowMs / 1000}s; ` +
        `content writes held for ${Math.round(shrinkBrake.holdMs / 60_000)} min`,
    );
    if (brakeHook) {
      const hold = shrinkBrake.holdOf(userId, vaultId);
      try {
        brakeHook(vaultId, userId, hold ?? { until: Date.now(), count: shrinkBrake.threshold });
      } catch (err) {
        console.error(`[versions] shrink brake hook failed for vault ${vaultId}:`, err);
      }
    }
  }
}

// ── the burst brake (issue #252) ───────────────────────────────────────────

/** One live hold: when it lapses (ms epoch) and how many notes engaged it. */
export interface BrakeHold {
  until: number;
  count: number;
}

/**
 * A per-(user, vault) brake on a BURST of sharp shrinks.
 *
 * One update emptying one note is a person clearing a note, and stays exactly
 * as it was: applied, with a `pre-shrink` version. Several populated notes
 * emptied by the same user in the same vault within a minute is not how anyone
 * edits — it is a client ingesting 0-byte files, a stale copy, a script — and
 * every one of those updates is individually valid, so nothing else stops it.
 *
 * Tripping HOLDS that user's further content writes in that vault for
 * {@link ShrinkBrake.holdMs}, in a way that never touches what the client has:
 *  - live sockets are kicked (`index.ts` brake hook) and re-admitted by
 *    `onAuthenticate` as read-only connections. Hocuspocus drops their updates
 *    unapplied; the client keeps its ops in its local CRDT and its file on
 *    disk, exactly as when it is offline. Deliberately NO `rejected` frame and
 *    NO `readOnly: true` at the token mint: both send the desktop down its
 *    view-grant path, which rebases the local copy onto the server's. A hold
 *    must not rewrite anything on the device; it only stops the server taking
 *    more of it.
 *  - the batch push answers `error` / `shrink_held` per item, which every
 *    desktop build treats as a retryable failure: the local CRDT is kept and
 *    the item is retried on a later pass, not in a loop.
 * When the hold lapses, the client's held ops arrive like any reconnect's. If
 * they are the same burst they trip the brake again after at most
 * {@link ShrinkBrake.threshold} more notes, each keeping its own `pre-shrink`
 * version, so the brake bounds the RATE of loss rather than pretending a CRDT
 * op can be refused forever.
 *
 * The updates that tripped the brake were applied, each with its `pre-shrink`
 * version, so the damage is bounded at {@link ShrinkBrake.threshold} notes plus
 * any already in flight when it engaged (which the hold's `count` includes, so
 * every surface names the real number, #275), and each is restorable from
 * Version History.
 *
 * In-memory and per process. A restart forgets a hold (failing back to today's
 * behaviour, never to something less safe), and with several instances each
 * counts what it sees — a client's sockets for one vault usually land on one.
 */
export class ShrinkBrake {
  private readonly hits = new Map<string, Array<{ docId: string; at: number }>>();
  private readonly held = new Map<string, BrakeHold>();
  /** The distinct notes counted into each live hold: the burst that engaged
   *  it plus every one that shrank while held, so `count` never double counts
   *  a note that shrinks again. */
  private readonly heldDocs = new Map<string, Set<string>>();

  constructor(
    public threshold: number,
    public windowMs: number,
    public holdMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Re-tune in place and forget every count and hold (tests, mostly). */
  configure(opts: { threshold?: number; windowMs?: number; holdMs?: number }): void {
    if (opts.threshold !== undefined) this.threshold = opts.threshold;
    if (opts.windowMs !== undefined) this.windowMs = opts.windowMs;
    if (opts.holdMs !== undefined) this.holdMs = opts.holdMs;
    this.hits.clear();
    this.held.clear();
    this.heldDocs.clear();
  }

  private key(userId: string, vaultId: string): string {
    return `${vaultId}\u0000${userId}`;
  }

  /**
   * Count one sharp shrink. Returns true exactly when this one ENGAGES the
   * brake (distinct docs only — the same note shrinking twice is one note).
   */
  record(userId: string, vaultId: string, docId: string): boolean {
    return this.recordShrink(userId, vaultId, docId) === "engaged";
  }

  /**
   * Count one sharp shrink and say what it did: `engaged` the brake, `grew` a
   * live hold's count (a note not yet counted in it — the hold's lapse never
   * moves), or nothing (`null`).
   */
  recordShrink(userId: string, vaultId: string, docId: string): "engaged" | "grew" | null {
    if (this.threshold <= 0) return null;
    const key = this.key(userId, vaultId);
    const t = this.now();
    const hold = this.holdOf(userId, vaultId);
    if (hold) {
      const docs = this.heldDocs.get(key);
      if (!docs || docs.has(docId)) return null;
      docs.add(docId);
      hold.count = docs.size;
      return "grew";
    }
    const recent = (this.hits.get(key) ?? []).filter(
      (h) => t - h.at <= this.windowMs && h.docId !== docId,
    );
    recent.push({ docId, at: t });
    this.hits.set(key, recent);
    this.prune(t);
    if (recent.length < this.threshold) return null;
    this.held.set(key, { until: t + this.holdMs, count: recent.length });
    this.heldDocs.set(key, new Set(recent.map((h) => h.docId)));
    this.hits.delete(key);
    return "engaged";
  }

  /** Are this user's content writes in this vault being held right now? */
  isHeld(userId: string | null | undefined, vaultId: string): boolean {
    return this.holdOf(userId, vaultId) !== null;
  }

  /** The live hold on this user in this vault — when it lapses and how many
   *  notes engaged it — or null. Expired holds are forgotten on read. */
  holdOf(userId: string | null | undefined, vaultId: string): BrakeHold | null {
    if (!userId) return null;
    const key = this.key(userId, vaultId);
    const hold = this.held.get(key);
    if (hold === undefined) return null;
    if (this.now() >= hold.until) {
      this.held.delete(key);
      this.heldDocs.delete(key);
      return null;
    }
    return hold;
  }

  /**
   * Lift a hold early (an owner/admin released it, or a test). Returns whether
   * a hold was live. The burst count restarts from zero as well, so a client
   * still replaying the same burst is braked again after another
   * {@link threshold} notes — each one still versioned `pre-shrink` first.
   */
  release(userId: string, vaultId: string): boolean {
    const was = this.isHeld(userId, vaultId);
    this.held.delete(this.key(userId, vaultId));
    this.heldDocs.delete(this.key(userId, vaultId));
    this.hits.delete(this.key(userId, vaultId));
    return was;
  }

  /** Bound memory: drop windows that have aged out entirely. */
  private prune(t: number): void {
    if (this.hits.size < 1024) return;
    for (const [k, list] of this.hits) {
      if (list.every((h) => t - h.at > this.windowMs)) this.hits.delete(k);
    }
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * The process-wide brake. `SHRINK_BRAKE_COUNT` (default 10; 0 disables) distinct
 * populated notes within `SHRINK_BRAKE_WINDOW_SECONDS` (default 60) engage it
 * for `SHRINK_BRAKE_HOLD_MINUTES` (default 30).
 */
export const shrinkBrake = new ShrinkBrake(
  envInt("SHRINK_BRAKE_COUNT", 10),
  envInt("SHRINK_BRAKE_WINDOW_SECONDS", 60) * 1000,
  envInt("SHRINK_BRAKE_HOLD_MINUTES", 30) * 60_000,
);

/** Is this user's content in this vault currently held read-only? */
export function isShrinkHeld(userId: string | null | undefined, vaultId: string): boolean {
  return shrinkBrake.isHeld(userId, vaultId);
}

/** Notified once when the brake engages, so the process can kick that user's
 *  live sockets for the vault (they reconnect read-only), tell that user's app
 *  why, and record the hold for the vault's owners/admins (Activity). */
export type ShrinkBrakeHook = (vaultId: string, userId: string, hold: BrakeHold) => void;

let brakeHook: ShrinkBrakeHook | null = null;

export function setShrinkBrakeHook(next: ShrinkBrakeHook | null): void {
  brakeHook = next;
}

/** Notified each time a live hold counts one more distinct note (#275), with
 *  the hold as it now stands, so the process can correct the recorded event and
 *  the held user's notice. Called once per note: coalesce before writing. */
export type ShrinkBrakeGrowHook = (vaultId: string, userId: string, hold: BrakeHold) => void;

let brakeGrowHook: ShrinkBrakeGrowHook | null = null;

export function setShrinkBrakeGrowHook(next: ShrinkBrakeGrowHook | null): void {
  brakeGrowHook = next;
}

/**
 * Coalesces a hold's growth per (vault, user): the first grow schedules ONE
 * flush `delayMs` later and every grow until then rides on it, so a 500-note
 * script costs a DB write and a frame per window, not per note — and, being a
 * throttle rather than a debounce, a steady stream still updates every window.
 * Pure apart from the injected timer.
 */
export class BrakeGrowthCoalescer {
  private readonly pending = new Map<string, unknown>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly delayMs: number,
    private readonly flush: (vaultId: string, userId: string) => void,
    timers: {
      setTimer?: (fn: () => void, ms: number) => unknown;
      clearTimer?: (handle: unknown) => void;
    } = {},
  ) {
    this.setTimer =
      timers.setTimer ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return h;
      });
    this.clearTimer = timers.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** One more note counted into this user's hold. */
  grew(vaultId: string, userId: string): void {
    const key = `${vaultId}\u0000${userId}`;
    if (this.pending.has(key)) return;
    this.pending.set(
      key,
      this.setTimer(() => {
        this.pending.delete(key);
        try {
          this.flush(vaultId, userId);
        } catch (err) {
          console.error(`[versions] shrink brake count flush failed for vault ${vaultId}:`, err);
        }
      }, this.delayMs),
    );
  }

  /** The hold ended (lapse or release): a pending flush has nothing to say. */
  cancel(vaultId: string, userId: string): void {
    const key = `${vaultId}\u0000${userId}`;
    const h = this.pending.get(key);
    if (h === undefined) return;
    this.clearTimer(h);
    this.pending.delete(key);
  }
}

/** Notified when a hold is lifted early on this process, so it can tell every
 *  other instance (pub/sub), re-admit the user's sockets writable and clear the
 *  notice on their app. Wired by `src/index.ts`; unbound it is a no-op. */
export type ShrinkBrakeReleaseHook = (vaultId: string, userId: string) => void;

let releaseHook: ShrinkBrakeReleaseHook | null = null;

export function setShrinkBrakeReleaseHook(next: ShrinkBrakeReleaseHook | null): void {
  releaseHook = next;
}

/**
 * Lift a user's hold in a vault early (the owner/admin Release action).
 *
 * Safe by construction: nothing held was ever discarded — the client kept its
 * ops — so releasing only lets them arrive, through the same write paths as any
 * edit. Every sharp shrink among them is still versioned `pre-shrink` first,
 * and the burst count restarts, so the same burst is braked again after
 * another {@link ShrinkBrake.threshold} notes. Returns whether THIS process
 * held one (another instance may; the hook reaches it). Never throws.
 */
export function releaseShrinkBrake(vaultId: string, userId: string): boolean {
  const was = shrinkBrake.release(userId, vaultId);
  if (releaseHook) {
    try {
      releaseHook(vaultId, userId);
    } catch (err) {
      console.error(`[versions] shrink brake release hook failed for vault ${vaultId}:`, err);
    }
  }
  return was;
}
