// Which server this device's account lives on — the first question the auth
// dialog asks, and the one it used to hide.
//
// The old sign-in form had ONE server: whatever `DEFAULT_SERVER_URL` said, with
// a collapsed `<details>` "Server settings" at the bottom of the card. For the
// managed instance that is right. For a self-hosting team it is a trap: every
// member who installs the app signs up on api.baalda.com, gets an account and a
// vault there, and only finds out when their admin cannot see them (#91). So the
// choice is now a step of its own, both options carrying equal weight, and the
// form that follows says which server it is about to post credentials to.
//
// Pure on purpose: the desktop workspace has no DOM test harness, so the
// decision table and the URL normalizer are plain functions with a unit test,
// exactly like `resolveServerUrl` next door.

import { DEFAULT_SERVER_URL } from "../api";

/**
 * What the user answered, persisted per device (`lib/prefs.ts`).
 *
 * `null` (never asked) is a distinct third state, not a synonym for "managed":
 * it is the only thing that makes the step appear at all, so defaulting it
 * would silently restore the old behaviour.
 */
export type ServerChoice = "managed" | "custom";

/** The steps the auth dialog can be on. */
export type AuthStep = "choose-server" | "confirm-link" | "form";

/**
 * Clean up whatever the user typed into a server address, or `null` if it can't
 * be one.
 *
 * - a bare host gets `https://` — nobody types the scheme, and defaulting to
 *   http would send credentials in the clear;
 * - only http(s) survive, so a `javascript:` or `ftp:` string (which can arrive
 *   from a deep link, not just a keyboard) is refused rather than stored;
 * - trailing slashes go, because the URL is concatenated with paths like
 *   `/health` everywhere downstream;
 * - **a path prefix is kept.** Self-hosters put Baalda behind a reverse proxy at
 *   e.g. `https://intranet.example.com/baalda`, and stripping that would point
 *   the app at the proxy's root.
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Only a full `scheme://` counts as "already has a scheme": `javascript:x`
  // has a scheme by the spec's reckoning but is not an address, and we want it
  // to fail the parse below rather than be honoured.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  const prefix = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${prefix}`;
}

/**
 * The bit of a server URL worth showing a person: host, plus any path prefix
 * (which is the only thing distinguishing two vaults behind one proxy). Falls
 * back to the raw string so a caption never renders empty.
 */
export function serverHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/**
 * An extra sentence to append when a server we couldn't reach is plain `http`
 * on something other than loopback — `null` when that isn't the situation.
 *
 * This case is a genuine dead end without the hint. The webview's `connect-src`
 * (tauri.conf.json) allows every `https:` host but only loopback for `http:`,
 * so a LAN server at `http://192.168.1.5:3010` is blocked before the request
 * leaves the app, and WebKit reports it as a bare `TypeError: Load failed` —
 * indistinguishable from a server that is simply down. Note that a dev build's
 * CSP is more permissive, so the same URL can work in `pnpm dev:desktop` and
 * fail in the installed app; guessing is worse than saying so.
 */
export function plainHttpHint(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    return null;
  }
  return "Installed builds can only use plain http on localhost — this server needs https.";
}

/**
 * The choice a device's existing state already implies, for a device that was
 * never asked.
 *
 * Everyone who used the app before this step existed has a persisted choice of
 * `null`, and a good number of them deliberately pointed at their own server
 * through the old `<details>`. Asking them again — and defaulting them to
 * managed if they just close the card — would be the exact failure this step is
 * meant to prevent, so a non-default URL is read as a self-host answer already
 * given.
 */
export function impliedServerChoice(
  serverUrl: string,
  defaultServerUrl: string = DEFAULT_SERVER_URL,
): ServerChoice | null {
  const current = normalizeServerUrl(serverUrl);
  const fallback = normalizeServerUrl(defaultServerUrl);
  if (!current || current === fallback) return null;
  return "custom";
}

/**
 * Which step the auth dialog opens on.
 *
 * Order matters: an inbound `baalda://connect` link outranks everything, because
 * it is the whole reason the dialog is on screen and it needs an explicit yes
 * before it may touch the server URL (a deep link is untrusted input — it
 * decides where a password gets posted).
 */
export function decideAuthStep({
  choice,
  serverUrl,
  pendingServerLink = null,
  defaultServerUrl = DEFAULT_SERVER_URL,
}: {
  /** The persisted answer, or `null` if this device was never asked. */
  choice: ServerChoice | null;
  /** The server the app is pointed at right now. */
  serverUrl: string;
  /** A server URL an invite link is offering, awaiting confirmation. */
  pendingServerLink?: string | null;
  /** Injectable so the table test doesn't depend on the build's default. */
  defaultServerUrl?: string;
}): AuthStep {
  if (pendingServerLink) return "confirm-link";
  if (choice) return "form";
  // Never asked. Only a device still sitting on the build's default has an
  // unanswered question; anything else answered it by pointing elsewhere.
  return impliedServerChoice(serverUrl, defaultServerUrl) ? "form" : "choose-server";
}
