import { Hono } from "hono";
import type { Context } from "hono";
import { BRAND_NAME } from "../../brand.js";
import { config } from "../../config.js";

/**
 * Clickable share links — `GET /open/note/:orgId/:docId` and
 * `GET /open/connect`.
 *
 * A `baalda://` link is dead weight in most chat apps: schemes nobody has
 * allow-listed don't linkify, so the recipient had to copy-paste it into a
 * browser. Share links are therefore `https://<server>/open/note/…` — every
 * chat app makes those clickable — and this page is the landing spot: it
 * immediately bounces to the `baalda://` deep link (which the OS hands to the
 * installed app) and shows a button + install pointer as the fallback.
 *
 * Public and unauthenticated ON PURPOSE. The URL carries identity, not access:
 * two opaque ids and nothing else. Whoever clicks it still resolves both
 * against their own signed-in session in the app — a stranger gets the same
 * "no access" they'd get typing the ids by hand. Nothing here reads the
 * database, so this page can't leak whether the ids even exist.
 */
export const openLinkRoutes = new Hono();

/** Better Auth ids and client doc_ids (UUIDs) — one conservative shape. */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

openLinkRoutes.get("/open/note/:orgId/:docId", (c) => {
  const orgId = c.req.param("orgId");
  const docId = c.req.param("docId");
  if (!ID_RE.test(orgId) || !ID_RE.test(docId)) {
    return c.text("Malformed link", 400);
  }
  // Re-encoded on the way out even after the shape check, so the deep link is
  // inert as markup no matter what future id shapes are allowed through.
  const deepLink = `baalda://note/${encodeURIComponent(orgId)}/${encodeURIComponent(docId)}`;
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Open note · ${esc(BRAND_NAME)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0;
         background: #f6f5f2; color: #2a2a28; }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 1.2rem; font-weight: 600; }
  p { color: #6b6b66; max-width: 34rem; }
  a.button { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.4rem;
             border-radius: 999px; background: #2a2a28; color: #fff;
             text-decoration: none; font-weight: 600; }
  a.plain { color: #6b6b66; }
</style>
</head>
<body>
<main>
  <h1>Opening this note in ${esc(BRAND_NAME)}…</h1>
  <p>If nothing happens, ${esc(BRAND_NAME)} may not be installed on this device.</p>
  <a class="button" href="${esc(deepLink)}">Open in ${esc(BRAND_NAME)}</a>
  <p><a class="plain" href="https://baalda.com" rel="noopener">Get ${esc(BRAND_NAME)}</a></p>
  <script>location.href = ${JSON.stringify(deepLink)};</script>
</main>
</body>
</html>`);
});

/**
 * `GET /open/connect` — the invite link a self-hosting admin sends their team.
 *
 * Same trick as the note link, one step earlier in the story. Before #91 an
 * admin's only option was to tell people the server URL in prose and hope each
 * of them found the collapsed "Server settings" disclosure and typed it in
 * correctly; the ones who didn't signed up on the managed instance instead and
 * nobody found out until the admin couldn't see them. Now the admin sends
 * `https://<their server>/open/connect` and this page bounces into
 * `baalda://connect?server=<this server>`, which opens the app on a confirm
 * step.
 *
 * Carries no identity and no access — just this server's own address, which is
 * the one thing the person clicking it already knows. The app still asks before
 * adopting it, because a URL that arrives from outside decides where a password
 * gets posted.
 */
openLinkRoutes.get("/open/connect", (c) => {
  const server = publicBaseUrl(c);
  const deepLink = `baalda://connect?server=${encodeURIComponent(server)}`;
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Connect to this ${esc(BRAND_NAME)} server</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0;
         background: #f6f5f2; color: #2a2a28; }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 1.2rem; font-weight: 600; }
  p { color: #6b6b66; max-width: 34rem; }
  code { background: #eceae4; border-radius: 6px; padding: 0.1rem 0.35rem; }
  a.button { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.4rem;
             border-radius: 999px; background: #2a2a28; color: #fff;
             text-decoration: none; font-weight: 600; }
  a.plain { color: #6b6b66; }
</style>
</head>
<body>
<main>
  <h1>Pointing ${esc(BRAND_NAME)} at <code>${esc(server)}</code>…</h1>
  <p>Your ${esc(BRAND_NAME)} app will ask you to confirm before it connects.
     If nothing happens, ${esc(BRAND_NAME)} may not be installed on this device.</p>
  <a class="button" href="${esc(deepLink)}">Connect ${esc(BRAND_NAME)}</a>
  <p><a class="plain" href="https://baalda.com" rel="noopener">Get ${esc(BRAND_NAME)}</a></p>
  <script>location.href = ${JSON.stringify(deepLink)};</script>
</main>
</body>
</html>`);
});

/** A host header we're willing to put in a URL: no scheme, path, or markup. */
const HOST_RE = /^[A-Za-z0-9._:[\]-]{1,255}$/;
/** A proxy path prefix we're willing to keep, e.g. `/baalda`. */
const PREFIX_RE = /^(?:\/[A-Za-z0-9._~-]{1,64})*$/;

/**
 * This server's public base URL, as seen by whoever just loaded the page.
 *
 * Request-first, because the URL the browser actually used to get here is by
 * definition one that reaches this server from the outside — stronger evidence
 * than any config value, which a self-hoster can leave at its default. The
 * forwarded headers fix the one thing the request itself gets wrong behind a
 * TLS-terminating proxy (it sees plain http), and `BETTER_AUTH_URL` is the
 * fallback for the case with no Host at all.
 *
 * The Host header is client-supplied, and that is fine here: nobody can set it
 * on someone else's browser, and a link to an attacker's own `/open/connect` is
 * no different from mailing a `baalda://connect` link directly — which the app
 * confirms before honouring either way. The shape checks exist so a hostile
 * value can't smuggle a path or markup into the link, not as an authz boundary.
 */
export function publicBaseUrl(c: Context): string {
  const hdr = (name: string) => c.req.header(name)?.split(",")[0]?.trim() || undefined;
  const host = hdr("x-forwarded-host") ?? hdr("host");
  let base = config.betterAuthUrl;
  if (host && HOST_RE.test(host)) {
    const forwarded = hdr("x-forwarded-proto");
    const proto =
      forwarded === "https" || forwarded === "http"
        ? forwarded
        : safeProtocol(c.req.url) ?? "http";
    base = `${proto}://${host}`;
  }
  // A path prefix belongs in the URL — a server behind `example.com/baalda` is
  // not reachable at `example.com` — but the only place we can learn it is the
  // header, because a proxy that forwards the prefix UNSTRIPPED never reaches
  // this handler at all (Hono matches `/open/connect` exactly, so
  // `/baalda/open/connect` is a 404 — the same limitation `/open/note` has).
  const announced = hdr("x-forwarded-prefix");
  const keep = announced && PREFIX_RE.test(announced) ? stripSlash(announced) : "";
  return stripSlash(base) + keep;
}

function safeProtocol(url: string): "http" | "https" | null {
  try {
    const p = new URL(url).protocol;
    return p === "https:" ? "https" : p === "http:" ? "http" : null;
  } catch {
    return null;
  }
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
