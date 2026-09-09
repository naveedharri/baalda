// The `baalda://billing/upgraded[?org=<orgId>]` hand-off the server's checkout
// success page bounces into (routes/billing.ts). By the time it fires the
// server has already confirmed the payment with the provider and written the
// subscription, so the link carries no proof of anything — it only says "come
// back and look": the app re-reads billing for that vault so Pro shows up
// without the person hunting for it. Whoever can send the app a URL could send
// this one, which is why it is a refresh trigger and never a grant.
//
// Both foldings are accepted, like every other link parser here: some
// platforms deliver `baalda://billing/upgraded` with host "billing", others
// `baalda:///billing/upgraded` with everything in the path.

import { isAppProtocol } from "./deepLinkScheme";

export interface BillingLink {
  /** The vault the checkout was for, when the server knew it. */
  orgId: string | null;
}

export function parseBillingLink(url: string): BillingLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isAppProtocol(parsed.protocol)) return null;
  const segments = [parsed.host, ...parsed.pathname.split("/")].filter((s) => s.length > 0);
  if (segments.length !== 2 || segments[0] !== "billing" || segments[1] !== "upgraded") {
    return null;
  }
  const org = parsed.searchParams.get("org")?.trim() ?? "";
  return { orgId: org.length > 0 ? org : null };
}
