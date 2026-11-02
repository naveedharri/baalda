// "Messages changed" hint from the vault channel (`{t: "messages-changed"}`).
// The sync layer calls `notifyMessagesChanged`; the message center subscribes
// and refetches. A hint only: the 10-min poll covers a missed frame.

type Listener = () => void;
const listeners = new Set<Listener>();

export function onMessagesChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyMessagesChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error("messages-changed listener failed:", err);
    }
  }
}
