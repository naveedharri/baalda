/**
 * "Sync paused: many notes were emptied at once" — this device's view of the
 * server's shrink burst brake (#252).
 *
 * When one account sharply shrinks many populated notes in one vault within a
 * minute, the server holds that account's content writes there for a while.
 * Nothing is refused in a way the app acts on: the held sockets are admitted
 * read-only WITHOUT a `rejected` frame and token mint never says read-only, so
 * no path here discards or rebases a local copy. All the app has to do is SAY
 * so, instead of reading "Syncing…" for half an hour.
 *
 * Two signals, one state:
 *   - the vault channel's `brake` frame (`held` with `until` + `count` on
 *     engage and on every reconnect during a hold; `held: false` when it lapses
 *     or an owner/admin releases it), and
 *   - a batch push answering `shrink_held` per item — the only signal when the
 *     hold lives on another server instance, which carries no `until`.
 *
 * It ends on `held: false`, at `until` (a lapse whose frame we missed), or, for
 * a pause only the batch push told us about, at the first batch write the
 * server accepts again (or after {@link FALLBACK_HOLD_MS}). Pure apart from the
 * injected timer, so the whole lifecycle is unit-tested.
 */

/** The server's default hold, used only when no `until` was ever said. */
export const FALLBACK_HOLD_MS = 30 * 60_000;

export interface SyncPause {
  /** When this device first learned of this pause (ms epoch). Stable for the
   *  episode, so a dismissed banner stays dismissed across re-announcements. */
  since: number;
  /** When the server said it lapses, or null when only a batch refusal told us. */
  until: number | null;
  /** How many notes engaged it, when the server said. */
  count: number | null;
}

export interface SyncPauseTrackerOptions {
  /** Every change, including the end (`next === null`). `reset` means the
   *  vault is being left, not that the server resumed our writes. */
  onChange: (next: SyncPause | null, prev: SyncPause | null, reason: "set" | "lifted" | "reset") => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SyncPauseTracker {
  private state: SyncPause | null = null;
  /** True when the server's channel described this pause (it has an `until`). */
  private fromChannel = false;
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: SyncPauseTrackerOptions) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  current(): SyncPause | null {
    return this.state;
  }

  /** The vault channel's `brake` frame. */
  channel(frame: { held: boolean; until?: number; count?: number }): void {
    if (!frame.held) {
      this.lift();
      return;
    }
    const now = this.now();
    const until = frame.until ?? null;
    // A stale frame (a lapse already behind us) is not a pause.
    if (until != null && until <= now) {
      this.lift();
      return;
    }
    this.fromChannel = until != null;
    this.set({
      since: this.state?.since ?? now,
      until: until ?? this.state?.until ?? now + FALLBACK_HOLD_MS,
      count: frame.count ?? this.state?.count ?? null,
    });
  }

  /** A batch push item came back `shrink_held`. Never shortens a known hold. */
  batchHeld(): void {
    if (this.state) return;
    const now = this.now();
    this.fromChannel = false;
    this.set({ since: now, until: null, count: null });
  }

  /** The server accepted a batch content write: a pause only the batch push
   *  told us about is over. One the channel described waits for its own end. */
  writeAccepted(): void {
    if (this.state && !this.fromChannel) this.lift();
  }

  /** The vault is being left: drop the pause (listeners hear null). */
  reset(): void {
    this.lift("reset");
  }

  private lift(reason: "lifted" | "reset" = "lifted"): void {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const prev = this.state;
    this.state = null;
    this.fromChannel = false;
    if (prev) this.emit(null, prev, reason);
  }

  private set(next: SyncPause): void {
    const prev = this.state;
    this.state = next;
    if (this.timer != null) this.clearTimer(this.timer);
    const end = next.until ?? next.since + FALLBACK_HOLD_MS;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.lift();
    }, Math.max(0, end - this.now()) + 250);
    if (
      !prev ||
      prev.since !== next.since ||
      prev.until !== next.until ||
      prev.count !== next.count
    ) {
      this.emit(next, prev, "set");
    }
  }

  private emit(next: SyncPause | null, prev: SyncPause | null, reason: "set" | "lifted" | "reset"): void {
    try {
      this.opts.onChange(next, prev, reason);
    } catch (e) {
      console.warn("[sync] pause listener threw", e);
    }
  }
}

/** The banner/pill sentence for a pause. */
export function syncPauseText(p: Pick<SyncPause, "count">): string {
  const n = p.count;
  return n != null && n > 0
    ? `Sync paused: ${n.toLocaleString()} notes were emptied at once`
    : "Sync paused: many notes were emptied at once";
}

/** "about 25 min" until the lapse, or null when unknown / already past. */
export function syncPauseRemaining(p: Pick<SyncPause, "until">, now: number): string | null {
  if (p.until == null) return null;
  const ms = p.until - now;
  if (ms <= 0) return null;
  const min = Math.max(1, Math.round(ms / 60_000));
  return `about ${min} min`;
}
