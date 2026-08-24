// Shareable note links — `baalda://note/<orgId>/<docId>`.
//
// The point of a link is that a teammate can paste it into chat and the person
// who clicks it lands on the note. That means the link must carry **identity,
// not access**: it names a vault and a doc, and the app that opens it resolves
// both against whoever is signed in there. A stranger who clicks it gets
// nothing; a teammate without a grant gets the same "no access" they'd get by
// navigating to the note by hand.
//
// Ids, never paths. A note's path changes with every rename and move — a link
// built on one would rot the first time someone tidied a folder — while its
// doc_id is the join key that survives all of it (the spec's "key by doc_id,
// never by path"). The vault is the Better Auth organization id, which is what
// `setActiveOrganization` takes.

/** URL scheme registered by the desktop app (tauri.conf.json → deep-link). */
export const SHARE_SCHEME = "baalda";

export interface NoteLinkTarget {
  /** Better Auth organization id — the user-facing vault. */
  orgId: string;
  /** The note's stable doc_id. */
  docId: string;
}

/**
 * Build the link a user copies.
 *
 * With a server base URL this is an **https** link (`<server>/open/note/…`):
 * chat apps linkify https where a bare `baalda://` scheme just sits there as
 * text, so the recipient can click instead of copy-pasting. The server's
 * `/open/note` page bounces straight into the `baalda://` deep link. Without a
 * base (unit tests, no server configured) it falls back to the raw scheme,
 * which still opens the app directly.
 */
export function buildNoteLink(target: NoteLinkTarget, serverBase?: string | null): string {
  const ids = `note/${encodeURIComponent(target.orgId)}/${encodeURIComponent(target.docId)}`;
  if (serverBase) {
    try {
      const u = new URL(serverBase);
      const prefix = u.pathname.replace(/\/+$/, "");
      u.pathname = `${prefix}/open/${ids}`;
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch {
      /* malformed base — fall back to the scheme link */
    }
  }
  return `${SHARE_SCHEME}://${ids}`;
}

/**
 * Parse a link back to its target, or null if it isn't one of ours.
 *
 * Deliberately permissive about *shape* and strict about *content*: anything
 * can hand us a URL, so a malformed one has to be a quiet null rather than a
 * throw, and the two ids are the only things we read out of it.
 */
export function parseNoteLink(url: string): NoteLinkTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const isScheme = parsed.protocol === `${SHARE_SCHEME}:`;
  const isWeb = parsed.protocol === "https:" || parsed.protocol === "http:";
  if (!isScheme && !isWeb) return null;
  // `baalda://note/<org>/<doc>` parses with host "note" and pathname
  // "/<org>/<doc>". Some platforms hand the URL over with the host folded into
  // the path instead, so accept both rather than depending on which. The https
  // form is `https://<server>[/prefix]/open/note/<org>/<doc>` — host-agnostic,
  // because self-hosted servers mint these links too.
  const segments = [...(isScheme ? [parsed.host] : []), ...parsed.pathname.split("/")]
    .filter((p) => p.length > 0)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  // For the web form, anchor on the trailing `/open/note/<org>/<doc>` so a
  // reverse-proxy path prefix in front of it doesn't matter.
  const at = isWeb ? segments.lastIndexOf("open") : -1;
  const rest = isWeb
    ? at !== -1 && segments[at + 1] === "note"
      ? segments.slice(at + 1)
      : []
    : segments;
  if (rest[0] !== "note") return null;
  const [, orgId, docId] = rest;
  if (!orgId || !docId) return null;
  return { orgId, docId };
}
