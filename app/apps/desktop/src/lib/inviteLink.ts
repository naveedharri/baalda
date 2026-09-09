// Team-invitation links — the https page an admin can paste anywhere, and the
// `baalda://invite/<id>` deep link that page bounces into.
//
// The sibling of `connectLink.ts` (an address) and `shareLink.ts` (a note), and
// the same shape of problem as both: a value that arrives from outside the app
// and decides what happens next. So the parser is permissive about SHAPE (any
// process can hand us a URL; a malformed one is a quiet null, never a throw)
// and strict about CONTENT — the id has to look like an id, and the `server`
// query parameter only survives if `normalizeServerUrl` says it is an http(s)
// address, because that value decides where a password gets posted.
//
// The link carries no access of its own. The invitation id is the capability
// and the server re-checks it on accept; this module only routes.

import { normalizeServerUrl } from "./auth/serverChoice";

/** URL scheme registered by the desktop app (tauri.conf.json → deep-link). */
export const INVITE_SCHEME = "baalda";

/**
 * The shape an invitation id may take. Better Auth emits UUIDs, but ids are
 * `TEXT` server-side and clients may supply their own, so this is a
 * conservative "one safe path segment" rather than a UUID pattern — while
 * still refusing anything with a slash, a space or a scheme in it.
 */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface InviteDeepLink {
  invitationId: string;
  /** The server the link says the invitation lives on, or null if it didn't
   *  say (or said something that isn't an http(s) address). */
  server: string | null;
}

/**
 * The https page to share: `<server>/invite/<id>`.
 *
 * Not the `baalda://` link, deliberately. Chat apps linkify https and leave a
 * bare custom scheme sitting there as unclickable text, and the page also
 * catches the case where the recipient has not installed the app yet. The page
 * itself bounces into the deep link this module parses.
 *
 * Returns null when the server URL isn't an address — an invite link built
 * around a non-address would only fail later, in the recipient's hands.
 */
export function buildInviteLink(serverUrl: string, invitationId: string): string | null {
  const base = normalizeServerUrl(serverUrl);
  if (!base) return null;
  if (!ID_RE.test(invitationId)) return null;
  return `${base}/invite/${encodeURIComponent(invitationId)}`;
}

/**
 * Read an invitation out of a deep link, or `null` if it isn't one.
 *
 * Both foldings are accepted, exactly as in `parseConnectLink`:
 * `baalda://invite/<id>` parses with host "invite" and path "/<id>", while some
 * platforms hand the same URL over as `baalda:///invite/<id>` with the host
 * folded into the path. Handling only one is how a link works on macOS and
 * silently does nothing on Windows.
 */
export function parseInviteDeepLink(url: string): InviteDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${INVITE_SCHEME}:`) return null;
  const segments = [parsed.host, ...parsed.pathname.split("/")]
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
  if (segments.length !== 2 || segments[0] !== "invite") return null;
  const invitationId = segments[1];
  if (!ID_RE.test(invitationId)) return null;
  const rawServer = parsed.searchParams.get("server");
  return {
    invitationId,
    server: rawServer ? normalizeServerUrl(rawServer) : null,
  };
}
