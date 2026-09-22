import { Hono, type Context } from "hono";
import { config } from "../../config.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import {
  BootstrapBusyError,
  SessionExpiredError,
  createBootstrapSession,
  loadBootstrapPage,
} from "../../yjs/bootstrap.js";
import { getSession } from "../session.js";

/**
 * Whole-vault bootstrap download.
 *
 * Replaces the per-doc backfill for a cold joiner: instead of N WebSocket frames
 * each costing a probe, a snapshot read, a full `doc_updates` read, a merge and
 * a diff, the client takes ONE session and pulls resumable binary pages from it.
 * The vault channel stays exactly as it is for the live case — this is the cold
 * case only, and the two meet at the manifest a client sends on its next hello.
 *
 * **The body is gzip, and deliberately NOT declared with `Content-Encoding`.**
 * Declaring it would have `fetch` transparently inflate it, which reads as
 * convenient and is not: the page is a hand-mirrored binary format, its decoder
 * is tested against byte fixtures, and a transport that silently rewrites the
 * bytes on some platforms and not others is the one thing that would make those
 * fixtures a lie. The client gunzips explicitly, and the `X-Baalda-Bytes` header
 * reports the UNCOMPRESSED size so a progress bar matches `session.bytes`.
 */

export const BOOTSTRAP_CONTENT_TYPE = "application/vnd.baalda.bootstrap";

/** Auth, verbatim from `http/routes/vault-token.ts`: session → vault → member. */
async function gate(c: Context): Promise<{ userId: string; vaultId: string } | Response> {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const vaultId = c.req.param("vaultId") ?? "";
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault", code: "unknown_vault" }, 404);
  const role = await orgRole(org, session.userId);
  if (!role) return c.json({ error: "Not a member of this vault", code: "not_a_member" }, 403);
  return { userId: session.userId, vaultId };
}

export const bootstrapRoutes = new Hono();

bootstrapRoutes.post("/vaults/:vaultId/bootstrap", async (c) => {
  const auth = await gate(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json().catch(() => ({}));
  const rawHave = (body as { have?: unknown }).have;
  // `have` is what the client already holds CRDT state for. Unknown ids are
  // harmless — they simply subtract nothing — so this filters shape, not membership.
  const have = Array.isArray(rawHave)
    ? rawHave.filter((d): d is string => typeof d === "string" && d !== "")
    : [];
  const session = await createBootstrapSession({
    vaultId: auth.vaultId,
    userId: auth.userId,
    have,
  });
  return c.json(session);
});

bootstrapRoutes.get("/vaults/:vaultId/bootstrap/:sessionId", async (c) => {
  const auth = await gate(c);
  if (auth instanceof Response) return auth;
  const sessionId = c.req.param("sessionId") ?? "";
  const cursorRaw = Number.parseInt(c.req.query("cursor") ?? "0", 10);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0;
  const maxRaw = Number.parseInt(c.req.query("maxBytes") ?? "", 10);
  const maxBytes = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : undefined;

  try {
    const page = await loadBootstrapPage({
      sessionId,
      vaultId: auth.vaultId,
      userId: auth.userId,
      cursor,
      maxBytes,
    });
    c.header("Content-Type", BOOTSTRAP_CONTENT_TYPE);
    // ABSENT means drained — the client stops rather than having to compare a
    // sentinel. Present means "ask again from here".
    if (page.nextCursor !== null) c.header("X-Baalda-Cursor", String(page.nextCursor));
    c.header("X-Baalda-Docs", String(page.docs));
    c.header("X-Baalda-Bytes", String(page.bytes));
    c.header("ETag", `"${sessionId}:${cursor}"`);
    return c.body(page.body as unknown as ArrayBuffer);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      // 410, not 404: the client's recovery is to re-POST with a fresh `have`,
      // which is a different action from "this server has no such route".
      return c.json({ error: "Bootstrap session expired", code: "session_expired" }, 410);
    }
    if (err instanceof BootstrapBusyError) {
      c.header("Retry-After", String(err.retryAfterSeconds));
      return c.json({ error: "Too many bootstraps in flight", code: "bootstrap_busy" }, 503);
    }
    throw err;
  }
});
