import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import { pool } from "../../db/pool.js";
import { config } from "../../config.js";
import { BRAND_NAME } from "../../brand.js";
import { WORDMARK_INK_DATA_URI } from "../../brand-assets.js";
import { orgRole } from "../../permissions/lookup.js";
import { ACCOUNT_READ_ONLY_BODY, refusedForBilling } from "../../permissions/http-gates.js";
import { effectivePermission } from "../../permissions/resolver.js";
import { getSession } from "../session.js";
import { renderNoteHtml } from "../../render/note-html.js";
import type { DocWriter } from "../../mcp/doc-writer.js";
import {
  NEVER_INLINE_MIME,
  SAFE_INLINE_MIME,
  isAllowedMime,
  normalizeMime,
} from "../../blobs/formats.js";
import { resolveStoreForRow, storageKeyForRow } from "../../blobs/store.js";
import { s3Config, type S3Config } from "../../blobs/config.js";

/**
 * Public note links — the "anyone with the link can view" sibling of the
 * private `/open/note/…` deep link.
 *
 *   POST/GET/DELETE /api/notes/:docId/public-link   mint / inspect / revoke
 *   GET  /p/:token                                  the public read-only page
 *   GET  /p/:token/a/<rel_path>                     images the note embeds
 *
 * Access model: the token IS the capability. 24 random bytes (192 bits) of
 * base64url — entropy is the enumeration defense, so there is deliberately no
 * per-IP rate limiter here (managed deploys can add one at the reverse proxy).
 * Creation/revocation uses the same authority as share management
 * (`shares.ts` canManage): vault owner/admin or the note's creator.
 *
 * The public page is defensive on every axis: one byte-identical generic 404
 * for malformed/unknown/revoked tokens and deleted notes (nothing to
 * enumerate), `no-store` so revocation is instant, `no-referrer` so the token
 * never leaks via the Referer of an outbound link, and an escape-first
 * renderer (`render/note-html.ts`) so hostile note content can never become
 * markup.
 */

/** base64url of 24 bytes — exactly 32 chars, no padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

function publicOrigin(): string {
  try {
    return new URL(config.betterAuthUrl).origin;
  } catch {
    return "";
  }
}

function linkUrl(token: string): string {
  return `${publicOrigin()}/p/${token}`;
}

interface NoteInfo {
  vaultId: string;
  organizationId: string;
  createdBy: string | null;
}

/** The note, its collection and org — deleted notes are invisible here. */
async function liveNote(docId: string): Promise<NoteInfo | null> {
  const { rows } = await pool.query<{
    vault_id: string;
    organization_id: string;
    created_by: string | null;
  }>(
    `SELECT n.vault_id, v.organization_id, n.created_by
       FROM notes n JOIN vaults v ON v.id = n.vault_id
      WHERE n.id = $1 AND n.deleted_at IS NULL`,
    [docId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
  };
}

// ── Management API (session-gated) ──────────────────────────────────────────

export const publicLinkApiRoutes = new Hono();

/**
 * Same authority as `shares.ts` canManage for a file: org owner/admin or the
 * note's creator. Publishing a note to the open web is the widest possible
 * share, so it deliberately uses the share-management gate, not edit access.
 *
 * Read access is required ON TOP of it, and that is not redundant: the role no
 * longer implies read. In a Private vault, or under an item set to Private, an
 * owner can hold the management gate over a note they cannot open — and minting
 * a public link would have published its contents to the open web from a seat
 * that is not allowed to see them. Managing a restriction and reading through
 * it are different powers; only the first one is role-based.
 */
async function gate(
  userId: string,
  docId: string,
): Promise<
  | { ok: true; note: NoteInfo }
  | { ok: false; status: 404 | 403; error: string }
> {
  const note = await liveNote(docId);
  if (!note) return { ok: false, status: 404, error: "Unknown note" };
  const role = await orgRole(note.organizationId, userId);
  const isAdmin = role === "owner" || role === "admin";
  const isCreator = note.createdBy !== null && note.createdBy === userId;
  if (!isAdmin && !isCreator) {
    return { ok: false, status: 403, error: "Not allowed to manage sharing here" };
  }
  if ((await effectivePermission(userId, docId)) === "none") {
    return { ok: false, status: 403, error: "No access to this note" };
  }
  return { ok: true, note };
}

interface LinkRow {
  id: string;
  doc_id: string;
  token: string;
  created_at: string;
}

publicLinkApiRoutes.post("/notes/:docId/public-link", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const docId = c.req.param("docId");
  const g = await gate(session.userId, docId);
  if (!g.ok) return c.json({ error: g.error }, g.status);
  // Minting publishes the note: refused while the account is lapsed. Revoking
  // (DELETE below) stays allowed, since it only narrows exposure.
  if (await refusedForBilling(g.note.organizationId)) return c.json(ACCOUNT_READ_ONLY_BODY, 402);

  // Create-or-get: repeated copies must return the SAME url. The unique
  // doc_id key makes the race harmless — the loser's insert is a no-op and
  // both callers read back the one surviving row.
  const inserted = await pool.query<LinkRow>(
    `INSERT INTO public_links (id, doc_id, vault_id, org_id, token, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (doc_id) DO NOTHING
     RETURNING id, doc_id, token, created_at`,
    [randomUUID(), docId, g.note.vaultId, g.note.organizationId, mintToken(), session.userId],
  );
  const created = inserted.rows[0] ?? null;
  const row =
    created ??
    (
      await pool.query<LinkRow>(
        "SELECT id, doc_id, token, created_at FROM public_links WHERE doc_id = $1",
        [docId],
      )
    ).rows[0];
  if (!row) return c.json({ error: "Unknown note" }, 404);
  return c.json(
    {
      id: row.id,
      docId: row.doc_id,
      token: row.token,
      url: linkUrl(row.token),
      createdAt: row.created_at,
      existing: created === null,
    },
    created === null ? 200 : 201,
  );
});

publicLinkApiRoutes.get("/notes/:docId/public-link", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const docId = c.req.param("docId");
  const g = await gate(session.userId, docId);
  if (!g.ok) return c.json({ error: g.error }, g.status);

  const { rows } = await pool.query<LinkRow>(
    "SELECT id, doc_id, token, created_at FROM public_links WHERE doc_id = $1",
    [docId],
  );
  const row = rows[0];
  return c.json({
    link: row
      ? {
          id: row.id,
          docId: row.doc_id,
          token: row.token,
          url: linkUrl(row.token),
          createdAt: row.created_at,
        }
      : null,
  });
});

publicLinkApiRoutes.delete("/notes/:docId/public-link", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const docId = c.req.param("docId");
  const g = await gate(session.userId, docId);
  if (!g.ok) return c.json({ error: g.error }, g.status);

  await pool.query("DELETE FROM public_links WHERE doc_id = $1", [docId]);
  // No disconnectDoc/onAclChanged: viewers are stateless HTTP requests, and no
  // sync-visible ACL changed. The next GET /p/<token> simply misses.
  return c.json({ revoked: true });
});

// ── Public pages (no auth) ──────────────────────────────────────────────────

export interface PublicPageDeps {
  docWriter: Pick<DocWriter, "peekContent">;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const PAGE_CSS = `
  /* baalda.com's design system, light only: warm off-white page with the
     violet glow at the top, a white sheet, ink type (Radio Canada Big for
     headings, Inter for text), black pill buttons and the violet accent. */
  :root {
    color-scheme: light;
    --bg-page: #fcf9f7; --bg-sheet: #ffffff; --bg-soft: #f7f4f1;
    --ink: #030302; --ink-soft: #404040; --ink-muted: #737373; --ink-faint: #a3a3a3;
    --border: rgba(3, 3, 2, 0.08); --violet: #7c5cff; --violet-tint: rgba(124, 92, 255, 0.08);
    --display: "Radio Canada Big", "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
    --mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg-page); color: var(--ink-soft);
         background-image: radial-gradient(70% 520px at 50% 0%, rgba(124, 92, 255, 0.14), transparent 70%);
         background-repeat: no-repeat;
         font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         font-size: 16.5px; line-height: 1.75; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 20px 24px 48px; }
  .site-top { display: flex; align-items: center; justify-content: space-between;
              gap: 12px; padding: 10px 4px 24px; }
  a.brand { display: inline-flex; align-items: center; }
  a.brand img { height: 18px; width: auto; display: block; }
  a.open-app { display: inline-flex; align-items: center; height: 40px; padding: 0 20px; border-radius: 999px;
               background: var(--ink); color: #fff; text-decoration: none; font-weight: 500;
               font-size: 14px; white-space: nowrap;
               box-shadow: 0 8px 16px -6px rgba(3, 3, 2, 0.35);
               transition: background .15s, box-shadow .2s, transform .15s; }
  a.open-app:hover { background: #262624; box-shadow: 0 12px 22px -8px rgba(3, 3, 2, 0.4); transform: translateY(-1px); }
  main { background: var(--bg-sheet); border: 1px solid rgba(3, 3, 2, 0.06); border-radius: 24px;
         padding: 72px 96px 80px;
         box-shadow: 0 30px 60px -24px rgba(48, 32, 140, 0.16), 0 2px 6px rgba(3, 3, 2, 0.04); }
  @media (max-width: 720px) {
    .wrap { padding: 12px 16px 36px; }
    main { padding: 36px 22px 40px; border-radius: 18px; }
    a.open-app { height: 36px; padding: 0 16px; font-size: 13px; }
  }
  h1.doc-title { font-family: var(--display); color: var(--ink); font-size: clamp(2rem, 4.5vw, 2.75rem);
                 line-height: 1.1; letter-spacing: -0.03em; margin: 0 0 32px; font-weight: 600; }
  article > :first-child { margin-top: 0; }
  article h1, article h2, article h3, article h4 { font-family: var(--display); color: var(--ink);
                                                  font-weight: 600; line-height: 1.25; letter-spacing: -0.02em;
                                                  margin: 1.9em 0 0.55em; }
  article h1 { font-size: 1.75rem; } article h2 { font-size: 1.4rem; }
  article h3 { font-size: 1.15rem; } article h4 { font-size: 1rem; }
  article strong { color: var(--ink); font-weight: 600; }
  article p, article ul, article ol { margin: 0 0 1.1em; }
  article ul, article ol { padding-left: 1.4em; }
  article li { margin: 0.3em 0; }
  article li::marker { color: var(--ink-faint); }
  article img { display: block; max-width: 100%; height: auto; border-radius: 14px; margin: 0.4em 0 1.1em; }
  article hr { border: 0; border-top: 1px solid var(--border); margin: 2.4em 0; }
  article a { color: var(--violet); text-decoration: underline; text-decoration-thickness: 1px;
              text-underline-offset: 3px; text-decoration-color: rgba(124, 92, 255, 0.4); }
  article a:hover { text-decoration-color: var(--violet); }
  /* A [[wikilink]] points at a note this page does not carry: the site's
     violet chip, not a link. */
  .wikilink { color: var(--violet); background: var(--violet-tint); padding: 0.1em 0.45em;
              border-radius: 7px; font-weight: 500; }
  article pre { background: var(--bg-soft); border: 1px solid var(--border); padding: 16px 18px;
                border-radius: 14px; overflow-x: auto; font-size: 0.86em; line-height: 1.6; }
  article code { background: var(--bg-soft); padding: 0.14em 0.42em; border-radius: 6px; font-size: 0.86em;
                 font-family: var(--mono); color: var(--ink); }
  article pre code { background: none; padding: 0; }
  article blockquote { margin: 0 0 1.1em; padding: 14px 20px; border-left: 3px solid var(--violet);
                       background: #faf8ff; border-radius: 0 14px 14px 0; color: var(--ink-soft); }
  article blockquote > :last-child { margin-bottom: 0; }
  /* Tables — the editor's exact treatment: natural column widths, cells wrap
     at a readable measure, a wide table scrolls in its wrapper. */
  .md-table { margin: 14px 0 1.1em; overflow-x: auto; contain: inline-size;
              border: 1px solid var(--border); border-radius: 14px; }
  .md-table table { border-collapse: collapse; width: max-content; min-width: 100%; font-size: 0.92em; }
  .md-table th, .md-table td { border-bottom: 1px solid var(--border); padding: 9px 14px;
                               text-align: left; vertical-align: top; max-width: 42ch; }
  .md-table tr:last-child td { border-bottom: 0; }
  .md-table th { font-weight: 600; color: var(--ink); background: var(--bg-soft); }
  .md-table::-webkit-scrollbar { height: 8px; }
  .md-table::-webkit-scrollbar-thumb { background-color: var(--border); border-radius: 4px; }
  .md-table::-webkit-scrollbar-track { background: transparent; }
  footer { text-align: center; margin-top: 28px; font-family: var(--mono); font-size: 11px;
           letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); }
  footer a { color: var(--ink-muted); text-decoration: none; }
  footer a:hover { color: var(--ink); }
`;

/** The page frame: brand bar (with "Open in Baalda" when there is a note to
 *  open), the white sheet, and a quiet footer under it. */
export function pageShell(title: string, inner: string, openHref?: string): string {
  const open = openHref
    ? `<a class="open-app" href="${esc(openHref)}">Open in ${esc(BRAND_NAME)}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)} · ${esc(BRAND_NAME)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Radio+Canada+Big:wght@500;600&display=swap" />
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="site-top"><a class="brand" href="https://baalda.com" rel="noopener noreferrer"><img src="${WORDMARK_INK_DATA_URI}" alt="${esc(BRAND_NAME)}" /></a>${open}</header>
<main>
${inner}
</main>
<footer>Shared with ${esc(BRAND_NAME)} · <a href="https://baalda.com" rel="noopener noreferrer">Get ${esc(BRAND_NAME)} →</a></footer>
</div>
</body>
</html>`;
}

/**
 * Where an embedded image's bytes actually come from. On S3/R2 the asset route
 * answers with a 302 to a presigned bucket URL, and a browser applies the
 * page's `img-src` to the redirect target too — with only `'self'` allowed,
 * every image on a shared page rendered as a broken placeholder in production
 * while working on a Postgres-stored self-host. Origins only, derived from the
 * same settings the S3 client signs with (virtual-hosted and path-style).
 */
export function bucketImageOrigins(cfg: S3Config | null = s3Config()): string[] {
  if (!cfg || cfg.proxyDownloads) return [];
  if (cfg.endpoint) {
    let url: URL;
    try {
      url = new URL(cfg.endpoint);
    } catch {
      return [];
    }
    return cfg.forcePathStyle ? [url.origin] : [`${url.protocol}//${cfg.bucket}.${url.host}`, url.origin];
  }
  return cfg.forcePathStyle
    ? [`https://s3.${cfg.region}.amazonaws.com`]
    : [`https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`, `https://${cfg.bucket}.s3.amazonaws.com`];
}

/** Headers every /p/* response carries — misses included, so 404s don't
 *  differ from hits on anything but the body. */
const PAGE_HEADERS: Record<string, string> = {
  // Revocation must be instant, and the token must never leak via Referer.
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    // data: for the embedded wordmark, the bucket for redirected images (see
    // `bucketImageOrigins`), Google Fonts for baalda.com's type.
    `default-src 'none'; img-src ${["'self'", "data:", ...bucketImageOrigins()].join(" ")}; ` +
    "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
};

/** One generic page for malformed/unknown/revoked/deleted — byte-identical on
 *  purpose, so the response can't confirm that a link ever existed. */
const NOT_FOUND_HTML = pageShell(
  "Link not found",
  `<h1 class="doc-title">This link doesn&#39;t exist or has been turned off</h1>
<p>The person who shared it can create a new one from ${esc(BRAND_NAME)}.</p>`,
);

interface PublicNoteRow {
  doc_id: string;
  vault_id: string;
  org_id: string;
  title: string | null;
  rel_path: string;
}

async function noteForToken(token: string): Promise<PublicNoteRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query<PublicNoteRow>(
    `SELECT pl.doc_id, pl.vault_id, pl.org_id, n.title, n.rel_path
       FROM public_links pl
       JOIN notes n ON n.id = pl.doc_id AND n.deleted_at IS NULL
      WHERE pl.token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

/** Display title: stored title, else the filename without extension. */
function noteTitle(row: PublicNoteRow): string {
  const t = row.title?.trim();
  if (t) return t.replace(/\.md$/i, "");
  const stem = row.rel_path.split("/").pop() ?? row.rel_path;
  return stem.replace(/\.md$/i, "");
}

/**
 * Headers for an ASSET response (not the HTML page).
 *
 * The page's CSP is about what the page may load; this one is about what the
 * asset may DO if a browser ever treats it as a document: `default-src 'none'`
 * plus `sandbox` (no origin, no scripts, no forms) means even a file that slips
 * past the type checks below executes nothing. `nosniff` comes from
 * PAGE_HEADERS and is what stops the browser second-guessing the Content-Type
 * we set.
 */
const ASSET_HEADERS: Record<string, string> = {
  ...PAGE_HEADERS,
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

/** `bytes=<start>-<end?>`, the only form worth honouring here. Anything else
 *  (multi-range, suffix ranges) is ignored and the whole object is served. */
function parseRange(header: string | undefined): { start: number; end?: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d+)?$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? undefined : Number(m[2]);
  if (!Number.isFinite(start) || (end !== undefined && (!Number.isFinite(end) || end < start))) {
    return null;
  }
  return end === undefined ? { start } : { start, end };
}

export function createPublicPageRoutes(deps: PublicPageDeps): Hono {
  const app = new Hono();

  const miss = (c: Context) => c.html(NOT_FOUND_HTML, 404, PAGE_HEADERS);

  app.get("/p/:token", async (c) => {
    const token = c.req.param("token");
    const row = await noteForToken(token);
    if (!row) return miss(c);

    // null = content never reached this server; render as empty, not a miss —
    // the link is real and the note exists.
    const md = (await deps.docWriter.peekContent(row.vault_id, row.doc_id)) ?? "";
    const { bodyHtml } = renderNoteHtml(md, {
      assetUrl: (rel) =>
        `/p/${token}/a/${rel.split("/").map(encodeURIComponent).join("/")}`,
    });
    const title = noteTitle(row);
    // The private-link flow, one click away: /open/note bounces into the app,
    // where the viewer's own session and ACL decide what they see — the button
    // grants nothing the ids don't already carry.
    const openHref = `/open/note/${encodeURIComponent(row.org_id)}/${encodeURIComponent(row.doc_id)}`;
    return c.html(
      pageShell(
        title,
        `<h1 class="doc-title">${esc(title)}</h1>\n<article>${bodyHtml}</article>`,
        openHref,
      ),
      200,
      PAGE_HEADERS,
    );
  });

  // Images the note embeds, scoped by the same token. The containment check —
  // the note's own current text must reference the path — is the per-note twin
  // of `canReadAttachment`, but exact rather than index-lagged: the token
  // grants this note, so it grants only what this note shows.
  app.get("/p/:token/a/*", async (c) => {
    const token = c.req.param("token");
    const row = await noteForToken(token);
    if (!row) return miss(c);

    const prefix = `/p/${token}/a/`;
    let relPath: string;
    try {
      relPath = decodeURIComponent(c.req.path.slice(prefix.length));
    } catch {
      return miss(c);
    }
    if (
      relPath === "" ||
      relPath.includes("\\") ||
      relPath.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
    ) {
      return miss(c);
    }

    const md = await deps.docWriter.peekContent(row.vault_id, row.doc_id);
    if (!md || !md.includes(relPath)) return miss(c);

    const { rows } = await pool.query<{
      id: string;
      mime: string | null;
      filename: string | null;
      storage_provider: string | null;
      storage_key: string | null;
    }>(
      `SELECT id, mime, filename, storage_provider, storage_key
         FROM blobs
        WHERE vault_id = $1 AND rel_path = $2 AND status = 'ready'`,
      [row.vault_id, relPath],
    );
    const blob = rows[0];
    if (!blob) return miss(c);

    // The stored mime is uploader-controlled, so it decides only HOW the bytes
    // are served, never whether they are trusted:
    //   · SAFE_INLINE_MIME — passive media (images, PDF, audio, video) — renders
    //     inline with its real type, which is what makes a shared note show its
    //     screenshots and play its clips.
    //   · svg / html — ACTIVE documents. Not served at all, inline or otherwise;
    //     an attachment disposition would still leave a one-click path to
    //     executing uploader-authored script on this origin.
    //   · anything else on the allow-list (docx, zip, csv, …) downloads as
    //     octet-stream, so the browser never picks a handler off our say-so.
    //   · anything not on the allow-list is a miss, as before.
    const mime = normalizeMime(blob.mime);
    if (mime === "" || NEVER_INLINE_MIME.has(mime) || !isAllowedMime(mime)) return miss(c);
    const inline = SAFE_INLINE_MIME.has(mime);

    try {
      const store = await resolveStoreForRow(blob);
      const range = parseRange(c.req.header("range"));
      // The type and disposition decided above are PINNED onto the response by
      // the provider — for S3 that means they are part of the presigned URL's
      // signature, so the redirect below cannot serve an uploader-chosen
      // `text/html` inline just because the object's own metadata says so.
      const result = await store.get(storageKeyForRow(blob), {
        mime: inline ? mime : "application/octet-stream",
        filename: blob.filename,
        disposition: inline ? "inline" : "attachment",
        ...(range ? { range } : {}),
      });
      // s3: a 302 to a short-lived presigned GET. The browser follows it with
      // no credentials of ours attached, and the bucket serves the bytes —
      // which is what keeps a shared page's video off this server's egress.
      if (result.kind === "redirect") return c.redirect(result.url, 302);
      const headers: Record<string, string> = {
        ...ASSET_HEADERS,
        "Content-Type": inline ? mime : "application/octet-stream",
        "Content-Length": String(result.size),
        "Content-Disposition": inline ? "inline" : "attachment",
        // Postgres has to materialize the whole value to reach any byte of it,
        // so it answers `none` and the browser asks for the lot.
        "Accept-Ranges": result.acceptRanges ? "bytes" : "none",
      };
      if (result.range) {
        headers["Content-Range"] =
          `bytes ${result.range.start}-${result.range.end}/${result.totalSize}`;
        return c.body(Readable.toWeb(result.body) as ReadableStream, 206, headers);
      }
      return c.body(Readable.toWeb(result.body) as ReadableStream, 200, headers);
    } catch {
      // A blob whose bytes are gone, or whose provider this build cannot reach,
      // is indistinguishable from a link that never existed — same generic miss
      // the rest of this route uses, so nothing is confirmed either way.
      return miss(c);
    }
  });

  return app;
}
