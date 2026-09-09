// Invite links that point the app at a server — `baalda://connect?server=<url>`.
//
// The companion to `shareLink.ts`, and the same shape of problem one step
// earlier: a self-hosting admin can tell their team the server URL in prose and
// hope everyone types it into the right field, or they can send one link. This
// is the link. It carries no identity and no access — just an address — and the
// app still asks the person to confirm it before writing it, because a URL that
// arrives from outside decides where a password gets posted.
//
// Like `parseNoteLink`, this is permissive about SHAPE (anything can hand us a
// URL, so a malformed one is a quiet null rather than a throw) and strict about
// CONTENT (only http(s) survives `normalizeServerUrl`).

import { normalizeServerUrl } from "./auth/serverChoice";
import { APP_SCHEME, isAppProtocol } from "./deepLinkScheme";

/** URL scheme this build registers (tauri.conf.json → deep-link; staging differs). */
export const CONNECT_SCHEME = APP_SCHEME;

/**
 * Build the deep link an admin shares. The server also serves an https mirror
 * at `<server>/open/connect` that bounces into this, because chat apps linkify
 * https where a bare scheme sits there as text.
 */
export function buildConnectLink(serverUrl: string): string | null {
  const url = normalizeServerUrl(serverUrl);
  if (!url) return null;
  return `${CONNECT_SCHEME}://connect?server=${encodeURIComponent(url)}`;
}

/**
 * Read the server URL out of a connect link, or `null` if it isn't one.
 *
 * Both foldings are accepted: `baalda://connect?…` parses with host "connect"
 * and an empty path, while some platforms hand the URL over as
 * `baalda:///connect?…` with the host folded into the path instead. Depending
 * on which one a given OS produces is how a link works on one platform and
 * silently does nothing on another.
 */
export function parseConnectLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isAppProtocol(parsed.protocol)) return null;
  const segments = [parsed.host, ...parsed.pathname.split("/")].filter(
    (s) => s.length > 0,
  );
  if (segments.length !== 1 || segments[0] !== "connect") return null;
  const raw = parsed.searchParams.get("server");
  if (!raw) return null;
  return normalizeServerUrl(raw);
}
