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
): void {
  if (!hook || !isSharpShrink(before, after)) return;
  try {
    hook(vaultId, docId, before, userId);
  } catch (err) {
    console.error(`[versions] shrink hook failed for ${docId}:`, err);
  }
}
