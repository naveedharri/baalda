// Receiving end of a shared note link (see `shareLink.ts` for the format).
//
// Two arrival paths, and both have to work or links are unreliable:
//   - the app is already running → `onOpenUrl` fires (on Windows/Linux this
//     depends on the single-instance plugin registered in `lib.rs`, which hands
//     a second launch's URL to the instance already up);
//   - the click LAUNCHED the app → the URL was an argv/startup payload, which
//     `getCurrent()` replays once.
// Handling only the first is the classic bug where a link works for people who
// happen to have the app open and silently does nothing for everyone else.

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { parseNoteLink } from "./shareLink";

/** Bring the window forward — a link click means "show me this note". */
async function focusWindow(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch {
    /* focus is a courtesy; never let it stop the navigation */
  }
}

async function handle(urls: string[] | null): Promise<void> {
  for (const url of urls ?? []) {
    if (!parseNoteLink(url)) continue;
    await focusWindow();
    try {
      await useStore.getState().openNoteLink(url);
    } catch (e) {
      console.error("[deeplink] open failed", url, e);
    }
    // One navigation per batch: opening three notes in a row would just leave
    // the user on whichever won the race.
    return;
  }
}

/**
 * Start listening for `baalda://` opens. Returns a cleanup for React's effect.
 *
 * The plugin's subscribe is async, so the unsubscribe can only be applied once
 * it resolves; `cancelled` covers the case where the effect is torn down first
 * (React StrictMode does exactly that in development).
 */
export function listenForNoteLinks(): () => void {
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const stop = await onOpenUrl((urls) => void handle(urls));
      if (cancelled) stop();
      else unlisten = stop;
    } catch (e) {
      // A build without the plugin registered (or a platform that can't) must
      // not take the rest of the app down with it.
      console.warn("[deeplink] listener unavailable", e);
    }
    try {
      await handle(await getCurrent());
    } catch {
      /* nothing was pending */
    }
  })();

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
