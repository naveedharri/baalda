import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { pool } from "../../db/pool.js";
import { config } from "../../config.js";
import { BRAND_NAME } from "../../brand.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { renderNoteHtml } from "../../render/note-html.js";
import type { DocWriter } from "../../mcp/doc-writer.js";

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
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         margin: 0; background: #f6f5f2; color: #2a2a28; line-height: 1.6; }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  article h1, article h2, article h3 { line-height: 1.3; }
  article img { max-width: 100%; height: auto; border-radius: 6px; }
  article pre { background: #eceae5; padding: 0.8rem 1rem; border-radius: 8px;
                overflow-x: auto; }
  article code { background: #eceae5; padding: 0.1em 0.35em; border-radius: 4px;
                 font-size: 0.92em; }
  article pre code { background: none; padding: 0; }
  article blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid #d8d5cd;
                       color: #6b6b66; }
  article a { color: #2a5db0; }
  .wikilink { color: #6b6b66; border-bottom: 1px dotted #b5b2aa; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e3e0d9;
           font-size: 0.85rem; color: #6b6b66; }
  footer a { color: inherit; }
  h1.doc-title { font-size: 1.7rem; margin: 0 0 1.5rem; }
`;

function pageShell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(title)} · ${esc(BRAND_NAME)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
${inner}
<footer>Shared via ${esc(BRAND_NAME)} · <a href="https://baalda.com" rel="noopener noreferrer">Get ${esc(BRAND_NAME)}</a></footer>
</main>
</body>
</html>`;
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
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
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
  title: string | null;
  rel_path: string;
}

async function noteForToken(token: string): Promise<PublicNoteRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query<PublicNoteRow>(
    `SELECT pl.doc_id, pl.vault_id, n.title, n.rel_path
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

/** Passive image types only — never SVG (active content). */
const IMAGE_MIME_ALLOWLIST = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

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
    return c.html(
      pageShell(
        title,
        `<article><h1 class="doc-title">${esc(title)}</h1>\n${bodyHtml}</article>`,
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

    const { rows } = await pool.query<{ id: string; mime: string | null }>(
      "SELECT id, mime FROM blobs WHERE vault_id = $1 AND rel_path = $2",
      [row.vault_id, relPath],
    );
    const blob = rows[0];
    // The stored mime is uploader-controlled: only passive image types render.
    if (!blob || !blob.mime || !IMAGE_MIME_ALLOWLIST.has(blob.mime)) return miss(c);

    const { rows: dataRows } = await pool.query<{ data: Buffer | null }>(
      "SELECT data FROM blobs WHERE id = $1",
      [blob.id],
    );
    const data = dataRows[0]?.data;
    if (!data) return miss(c);
    return c.body(data, 200, {
      ...PAGE_HEADERS,
      "Content-Type": blob.mime,
      "Content-Length": String(data.byteLength),
      "Content-Disposition": "inline",
    });
  });

  return app;
}
