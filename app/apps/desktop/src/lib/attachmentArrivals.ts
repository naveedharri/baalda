/**
 * "A file under `attachments/` just landed on this disk." The binary mirror
 * announces every download here (`sync/attachments.ts downloadOne`), and an
 * image embed that failed to load because its bytes were not here yet listens,
 * so a teammate's pasted screenshot swaps its placeholder for the picture the
 * moment the download finishes instead of staying broken until the note is
 * reopened. In-process only; nothing persists.
 */
type Listener = (relPath: string) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe. */
export function onAttachmentArrived(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Tell every listener `relPath` (vault-relative, no leading slash) now exists. */
export function announceAttachmentArrived(relPath: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(relPath);
    } catch (e) {
      console.warn("[attachments] arrival listener failed", e);
    }
  }
}

// ---- Which files an open image is waiting for -----------------------------

/** Path → how many mounted image widgets show it as "Downloading". */
const wanted = new Map<string, number>();
const wantListeners = new Set<Listener>();

/**
 * An image widget could not load `relPath` and now waits for it. Counted, so
 * the same picture shown twice is wanted until both let go. Every listener
 * (the embed fetcher) hears it, so an image scrolled back into view, or a note
 * reopened after the fetcher stopped, starts the fetch again. Returns the
 * release, which the widget calls once it loads or is destroyed.
 */
export function wantAttachment(relPath: string): () => void {
  wanted.set(relPath, (wanted.get(relPath) ?? 0) + 1);
  for (const cb of [...wantListeners]) {
    try {
      cb(relPath);
    } catch (e) {
      console.warn("[attachments] want listener failed", e);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (wanted.get(relPath) ?? 1) - 1;
    if (n > 0) wanted.set(relPath, n);
    else wanted.delete(relPath);
  };
}

/** Does any mounted image still wait for `relPath`? */
export function isAttachmentWanted(relPath: string): boolean {
  return (wanted.get(relPath) ?? 0) > 0;
}

/** Subscribe to {@link wantAttachment}; returns the unsubscribe. */
export function onAttachmentWanted(cb: Listener): () => void {
  wantListeners.add(cb);
  return () => {
    wantListeners.delete(cb);
  };
}
