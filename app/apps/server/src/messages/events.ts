/**
 * "Messages changed" hints. A hint only: desktops refetch `GET /api/messages`,
 * and their 10-min poll covers a missed frame. Best-effort, like the other
 * announce* helpers in `sync/member-events.ts`; a no-op until `index.ts` wires
 * a publisher.
 *
 * - `all`: an operator created, edited or archived a message, so every
 *   connected app refetches.
 * - `user`: one person acted on a message (or saved a vault key), so their
 *   other devices drop it.
 */
export type MessagesChangedEvent = { scope: "all" } | { scope: "user"; userId: string };

type MessagesPublisher = (event: MessagesChangedEvent) => void;

let publish: MessagesPublisher | null = null;

export function setMessagesPublisher(fn: MessagesPublisher | null): void {
  publish = fn;
}

export function announceMessagesChanged(): void {
  try {
    publish?.({ scope: "all" });
  } catch (err) {
    console.error("announceMessagesChanged failed:", err);
  }
}

export function announceUserMessagesChanged(userId: string): void {
  try {
    publish?.({ scope: "user", userId });
  } catch (err) {
    console.error("announceUserMessagesChanged failed:", err);
  }
}
