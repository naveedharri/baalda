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
  if (userId && source !== "mcp" && shrinkBrake.record(userId, vaultId, docId)) {
    console.warn(
      `[versions] shrink brake engaged for user ${userId} in vault ${vaultId}: ` +
        `${shrinkBrake.threshold} populated notes sharply shrunk within ${shrinkBrake.windowMs / 1000}s; ` +
        `content writes held for ${Math.round(shrinkBrake.holdMs / 60_000)} min`,
    );
    if (brakeHook) {
      try {
        brakeHook(vaultId, userId);
      } catch (err) {
        console.error(`[versions] shrink brake hook failed for vault ${vaultId}:`, err);
      }
    }
  }
}

// ── the burst brake (issue #252) ───────────────────────────────────────────

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
 * version, so the damage is bounded at {@link ShrinkBrake.threshold} notes and
 * each is restorable from Version History.
 *
 * In-memory and per process. A restart forgets a hold (failing back to today's
 * behaviour, never to something less safe), and with several instances each
 * counts what it sees — a client's sockets for one vault usually land on one.
 */
export class ShrinkBrake {
  private readonly hits = new Map<string, Array<{ docId: string; at: number }>>();
  private readonly held = new Map<string, number>();

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
  }

  private key(userId: string, vaultId: string): string {
    return `${vaultId}\u0000${userId}`;
  }

  /**
   * Count one sharp shrink. Returns true exactly when this one ENGAGES the
   * brake (distinct docs only — the same note shrinking twice is one note).
   */
  record(userId: string, vaultId: string, docId: string): boolean {
    if (this.threshold <= 0) return false;
    const key = this.key(userId, vaultId);
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (h) => t - h.at <= this.windowMs && h.docId !== docId,
    );
    recent.push({ docId, at: t });
    this.hits.set(key, recent);
    this.prune(t);
    if (recent.length < this.threshold || this.isHeld(userId, vaultId)) return false;
    this.held.set(key, t + this.holdMs);
    this.hits.delete(key);
    return true;
  }

  /** Are this user's content writes in this vault being held right now? */
  isHeld(userId: string | null | undefined, vaultId: string): boolean {
    if (!userId) return false;
    const key = this.key(userId, vaultId);
    const until = this.held.get(key);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.held.delete(key);
      return false;
    }
    return true;
  }

  /** Lift a hold early (an owner reviewed it, or a test). */
  release(userId: string, vaultId: string): void {
    this.held.delete(this.key(userId, vaultId));
    this.hits.delete(this.key(userId, vaultId));
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
 *  live sockets for the vault (they reconnect read-only). */
export type ShrinkBrakeHook = (vaultId: string, userId: string) => void;

let brakeHook: ShrinkBrakeHook | null = null;

export function setShrinkBrakeHook(next: ShrinkBrakeHook | null): void {
  brakeHook = next;
}
