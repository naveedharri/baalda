import { Hono } from "hono";
import { BRAND_NAME } from "../../brand.js";

/**
 * Clickable share links — `GET /open/note/:orgId/:docId`.
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
