import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The feedback half of every asynchronous action in the app.
 *
 * Two numbers do the real work here, and both come from how people perceive
 * delay rather than from taste:
 *
 * - **`SPINNER_DELAY` (140ms).** Under ~100ms an action already feels
 *   instantaneous, so a spinner that appears immediately is *worse* than none:
 *   it flashes on and off and reads as a glitch. Waiting a beat means fast
 *   actions stay silent and only genuinely slow ones grow an indicator. The
 *   press-down state on the button covers the gap, so the action is never
 *   unacknowledged — it just isn't yet labelled "waiting".
 * - **`DONE_HOLD` (900ms).** A success tick that vanishes with the spinner is
 *   never seen. Holding it briefly closes the loop — the user learns the action
 *   finished, rather than inferring it from the absence of a spinner.
 *
 * `pending` is the honest "still running" flag (use it to disable a control the
 * instant it's pressed); `showPending` is the *display* flag that respects the
 * delay. Keeping them separate is what stops a double-submit while also keeping
 * fast paths visually quiet.
 */
export const SPINNER_DELAY = 140;
export const DONE_HOLD = 900;

export type AsyncPhase = "idle" | "pending" | "done" | "error";

export interface AsyncAction<A extends unknown[]> {
  /** Invoke the action. Re-entrant calls while pending are dropped. */
  run: (...args: A) => Promise<void>;
  /** True from the moment it's invoked until it settles. Use to disable. */
  pending: boolean;
  /** True only once the wait has outlived `SPINNER_DELAY`. Use to render. */
  showPending: boolean;
  /** Held for `DONE_HOLD` after a success, so the tick is actually seen. */
  done: boolean;
  /** The error the last run threw, if it threw. Cleared on the next run. */
  error: unknown;
  phase: AsyncPhase;
  /** Drop a sticky error without re-running (e.g. the user edited the form). */
  reset: () => void;
}

export interface AsyncActionOptions {
  /**
   * Show a success tick when the action resolves. Off by default: for actions
   * whose *result* is the feedback (a vault opens, a dialog closes, a row
   * disappears) a tick is redundant noise, and often the component has already
   * unmounted by then.
   */
  confirm?: boolean;
  /** Swallow the rejection instead of re-throwing. Default: re-throw. */
  swallow?: boolean;
}

/**
 * Wrap an async function so a control can report that it is working.
 *
 * Errors are recorded in `error` and re-thrown by default, because the callers
 * that already show a message need the throw and silently-swallowed failures
 * are how "the button did nothing" bugs happen. Pass `swallow` when the phase
 * alone is the whole story.
 */
export function useAsyncAction<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown> | unknown,
  opts: AsyncActionOptions = {},
): AsyncAction<A> {
  const { confirm = false, swallow = false } = opts;
  const [phase, setPhase] = useState<AsyncPhase>("idle");
  const [showPending, setShowPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // `pending` is mirrored into a ref so the re-entrancy guard reads the truth
  // synchronously — two clicks in the same tick both see the pre-render state.
  const pendingRef = useRef(false);
  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  // The latest fn without making `run` a new function on every render (which
  // would defeat memoized children and re-trigger effects that depend on it).
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const clearTimers = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimers();
    };
  }, []);

  const run = useCallback(
    async (...args: A) => {
      if (pendingRef.current) return; // already running — ignore the second press
      pendingRef.current = true;
      clearTimers();
      setPhase("pending");
      setError(null);
      timers.current.push(
        window.setTimeout(() => {
          if (alive.current && pendingRef.current) setShowPending(true);
        }, SPINNER_DELAY),
      );
      try {
        await fnRef.current(...args);
        if (!alive.current) return;
        setShowPending(false);
        if (confirm) {
          setPhase("done");
          timers.current.push(
            window.setTimeout(() => {
              if (alive.current) setPhase("idle");
            }, DONE_HOLD),
          );
        } else {
          setPhase("idle");
        }
      } catch (e) {
        if (alive.current) {
          setShowPending(false);
          setPhase("error");
          setError(e);
        }
        if (!swallow) throw e;
      } finally {
        // Not gated on `alive`: an unmounted component must still release the
        // guard, or a remounted one inherits a permanently "pending" action.
        pendingRef.current = false;
      }
    },
    [confirm, swallow],
  );

  const reset = useCallback(() => {
    clearTimers();
    setShowPending(false);
    setError(null);
    setPhase("idle");
  }, []);

  return {
    run,
    pending: phase === "pending",
    showPending: showPending && phase === "pending",
    done: phase === "done",
    error,
    phase,
    reset,
  };
}
