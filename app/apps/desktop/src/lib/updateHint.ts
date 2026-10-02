/**
 * The server's "a new release exists" hint (`version-available` on the vault
 * channel, #269), routed from the sync layer to whoever owns the updater.
 *
 * A seam rather than a direct call so the sync modules never import the Tauri
 * updater plugin (and stay runnable under vitest), and so the app decides
 * whether hints are acted on at all — a dev build ignores them exactly as it
 * skips the update poll.
 *
 * Only ever a hint: the handler runs the ordinary background update check,
 * which fetches the manifest itself and verifies the bundle's signature, so a
 * server cannot deliver or force an update through this.
 */
type UpdateHintHandler = (version: string) => void;

let handler: UpdateHintHandler | null = null;

export function setUpdateHintHandler(next: UpdateHintHandler | null): void {
  handler = next;
}

export function hintUpdateAvailable(version: string): void {
  try {
    handler?.(version);
  } catch (e) {
    console.warn("[updater] update hint handler failed", e);
  }
}
