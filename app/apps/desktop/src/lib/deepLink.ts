// Receiving end of the app's `baalda://` links: a shared note (`shareLink.ts`),
// a server address (`connectLink.ts`), a team invitation (`inviteLink.ts`), the
// account hand-offs after email confirmation / password reset
// (`accountLink.ts`) and the checkout success hand-off (`billingLink.ts`).
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
import { parseConnectLink } from "./connectLink";
import { parseAccountLink } from "./accountLink";
import { parseBillingLink } from "./billingLink";
import { parseInviteDeepLink } from "./inviteLink";
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
  // Connect links are considered across the WHOLE batch before any note link,
  // not just earlier in the loop: a server invite is a precondition for opening
  // anything on that server, so if both arrive together the address goes first.
  // Nothing is applied here — `promptServerLink` only parks the URL and raises
  // the confirm step, because a deep link decides where a password gets posted
  // and must never be honoured without a click.
  for (const url of urls ?? []) {
    const serverUrl = parseConnectLink(url);
    if (!serverUrl) continue;
    await focusWindow();
    useStore.getState().promptServerLink(serverUrl);
    return;
  }
  // Then invitations, ahead of note links: an invitation is what puts the
  // person in the vault a shared note lives in, so if both arrive together
  // joining has to happen first or the note link only reports no access.
  for (const url of urls ?? []) {
    if (!parseInviteDeepLink(url)) continue;
    await focusWindow();
    try {
      await useStore.getState().openInviteLink(url);
    } catch (e) {
      console.error("[deeplink] invite failed", url, e);
    }
    return;
  }
  // Account hand-offs (`baalda://verified`, `baalda://signin`) carry no data;
  // they just tell the app to look at its session again.
  for (const url of urls ?? []) {
    const kind = parseAccountLink(url);
    if (!kind) continue;
    await focusWindow();
    try {
      await useStore.getState().handleAccountLink(kind);
    } catch (e) {
      console.error("[deeplink] account link failed", url, e);
    }
    return;
  }
  // The checkout success page's hand-off: the server has already confirmed the
  // payment, so all this does is make the app look at billing again.
  for (const url of urls ?? []) {
    const billing = parseBillingLink(url);
    if (!billing) continue;
    await focusWindow();
    try {
      await useStore.getState().handleBillingLink(billing.orgId);
    } catch (e) {
      console.error("[deeplink] billing link failed", url, e);
    }
    return;
  }
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
