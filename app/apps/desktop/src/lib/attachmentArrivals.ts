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
