/**
 * "Open this vault file in the main pane", asked from inside the editor.
 *
 * A live-preview widget (the in-note file chip) needs to open a pane, which is
 * `store.openNoteByPath`'s job — but the editor extensions are deliberately
 * store-free: `lib/editor/*` is pure CodeMirror that runs under vitest in jsdom
 * with no Tauri and no Zustand, and importing the store there would drag auth,
 * sync and IPC into every editor test (and into the editor's own module cycle).
 *
 * So the widget asks, and `App.tsx` — which already owns the store — answers. A
 * plain DOM CustomEvent, because it needs no state of its own and it is
 * naturally a no-op when nobody is listening (a test mounting a bare editor).
 */
export const OPEN_FILE_EVENT = "baalda:open-file";

/** Ask the app to open `relPath` (vault-relative, no leading slash). */
export function requestOpenFile(relPath: string): void {
  if (!relPath || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT, { detail: relPath }));
}

/** Listen for {@link requestOpenFile}. Returns the unsubscribe. */
export function onOpenFileRequest(cb: (relPath: string) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<string>).detail;
    if (typeof detail === "string" && detail) cb(detail);
  };
  window.addEventListener(OPEN_FILE_EVENT, handler);
  return () => window.removeEventListener(OPEN_FILE_EVENT, handler);
}
