// The two data-less `baalda://` links the server's account pages bounce into
// (routes/account-pages.ts): `baalda://verified` after the email-confirmation
// link is clicked, and `baalda://signin` after a password was reset in the
// browser. Neither carries an id or a token — they only say "come back and look
// again": the app re-reads its session, so the verified state (or the revoked
// one) shows up without anyone reloading anything.
//
// Both foldings are accepted, like every other link parser here: some platforms
// deliver `baalda://verified` with host "verified", others `baalda:///verified`
// with it in the path.

export type AccountLinkKind = "verified" | "signin";

export function parseAccountLink(url: string): AccountLinkKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "baalda:") return null;
  const segments = [parsed.host, ...parsed.pathname.split("/")].filter((s) => s.length > 0);
  if (segments.length !== 1) return null;
  return segments[0] === "verified" || segments[0] === "signin" ? segments[0] : null;
}
