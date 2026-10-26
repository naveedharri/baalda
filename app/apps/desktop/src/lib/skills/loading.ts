// Small helpers for the skills screens' loading states. Pure, pinned by
// `__tests__/loading.test.ts`.

export const LOAD_TIMEOUT_MS = 30_000;

export class LoadTimeoutError extends Error {
  constructor(message = "This is taking too long. Check your connection and try again.") {
    super(message);
    this.name = "LoadTimeoutError";
  }
}

/**
 * `promise`, or a LoadTimeoutError after `ms`: a request that hangs ends in the
 * page's error state with Try again, never a skeleton that never leaves.
 */
export function withTimeout<T>(promise: Promise<T>, ms = LOAD_TIMEOUT_MS, message?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoadTimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A failure's text for an inline error line. */
export function loadErrorText(e: unknown): string {
  if (e instanceof LoadTimeoutError) return e.message;
  const text = e instanceof Error ? e.message : String(e);
  return text || "Something went wrong.";
}
