// In-app messages (docs/MESSAGES.md).
//
// GET    /api/messages                    pending messages for the signed-in user
//                                          (?showing=<id>&showingOrg=<orgId|empty>: the
//                                          one on screen ignores show counts and gaps)
// POST   /api/messages/:id/receipt        shown | snooze | dismiss | done
// GET    /api/admin/messages              operator: every message
// POST   /api/admin/messages              operator: create (409 exists)
// PUT    /api/admin/messages/:id          operator: replace the spec (409 archived)
// DELETE /api/admin/messages/:id          operator: archive (one-way)
// GET    /api/admin/messages/:id/stats    operator: receipt counts
//
// The admin routes answer 404 unless BAALDA_ADMIN_TOKEN (≥32 chars) is set AND
// the request carries it in `x-baalda-admin-token`, so an unconfigured server
// shows no admin surface at all.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import { reportedClientVersion } from "../client-version.js";
import { getSession } from "../session.js";
import { announceMessagesChanged, announceUserMessagesChanged } from "../../messages/events.js";
import { MessageSpecError, validateMessageSpec } from "../../messages/spec.js";
import {
  archiveMessage,
  createMessage,
  listAllMessages,
  liveSpec,
  messageStats,
  pendingMessages,
  recordReceipt,
  updateMessage,
  type ReceiptEvent,
} from "../../messages/service.js";

export const MESSAGES_FEATURE = "messages";
export const MESSAGES_ADMIN_HEADER = "x-baalda-admin-token";

const EVENTS: ReceiptEvent[] = ["shown", "snooze", "dismiss", "done"];

function adminAllowed(c: Context): boolean {
  const expected = (process.env.BAALDA_ADMIN_TOKEN ?? "").trim();
  const given = c.req.header(MESSAGES_ADMIN_HEADER) ?? "";
  if (expected.length < 32 || !given) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);

function parseSpec(body: unknown): { ok: true; spec: ReturnType<typeof validateMessageSpec> } | { ok: false; error: string } {
  try {
    return { ok: true, spec: validateMessageSpec(body) };
  } catch (err) {
    if (err instanceof MessageSpecError) return { ok: false, error: err.message };
    throw err;
  }
}

export function createMessageRoutes(): Hono {
  const routes = new Hono();

  routes.get("/messages", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const showingId = c.req.query("showing");
    const showing = showingId ? { messageId: showingId, orgId: c.req.query("showingOrg") || null } : null;
    // `org` is the open vault ("" for none); builds that don't send it get every vault.
    const org = c.req.query("org");
    const openOrgId = org === undefined ? undefined : org || null;
    const messages = await pendingMessages(session.userId, reportedClientVersion(c), pool, showing, openOrgId);
    return c.json({ messages });
  });

  routes.post("/messages/:id/receipt", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const body = (await c.req.json().catch(() => null)) as {
      orgId?: unknown;
      event?: unknown;
      actionId?: unknown;
    } | null;
    const event = body?.event;
    const orgId = body?.orgId ?? null;
    const actionId = body?.actionId;
    if (
      typeof event !== "string" ||
      !EVENTS.includes(event as ReceiptEvent) ||
      (orgId !== null && (typeof orgId !== "string" || orgId === "" || orgId.length > 200)) ||
      (actionId !== undefined && (typeof actionId !== "string" || actionId.length > 40))
    ) {
      return c.json({ error: "event must be shown, snooze, dismiss or done", code: "invalid_argument" }, 400);
    }
    const spec = await liveSpec(c.req.param("id"));
    if (!spec) return c.json({ error: "Unknown message", code: "not_found" }, 404);
    if (orgId !== null && !(await orgRole(orgId as string, session.userId, pool))) {
      return c.json({ error: "Unknown message", code: "not_found" }, 404);
    }
    await recordReceipt(spec, session.userId, orgId as string | null, event as ReceiptEvent, actionId as string | undefined);
    // `shown` changes nothing another device should react to.
    if (event !== "shown") announceUserMessagesChanged(session.userId);
    return c.json({ ok: true });
  });

  routes.get("/admin/messages", async (c) => {
    if (!adminAllowed(c)) return notFound(c);
    return c.json({ messages: await listAllMessages() });
  });

  routes.post("/admin/messages", async (c) => {
    if (!adminAllowed(c)) return notFound(c);
    const parsed = parseSpec(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error, code: "invalid_message" }, 400);
    const message = await createMessage(parsed.spec);
    if (!message) return c.json({ error: "A message with this id already exists", code: "exists" }, 409);
    announceMessagesChanged();
    return c.json({ message }, 201);
  });

  routes.put("/admin/messages/:id", async (c) => {
    if (!adminAllowed(c)) return notFound(c);
    const parsed = parseSpec(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error, code: "invalid_message" }, 400);
    if (parsed.spec.id !== c.req.param("id")) {
      return c.json({ error: "The spec id must match the path", code: "invalid_message" }, 400);
    }
    const result = await updateMessage(parsed.spec);
    if (!result.ok && result.reason === "not_found") return c.json({ error: "Unknown message", code: "not_found" }, 404);
    if (!result.ok) return c.json({ error: "This message is archived", code: "archived" }, 409);
    announceMessagesChanged();
    return c.json({ message: result.message });
  });

  routes.delete("/admin/messages/:id", async (c) => {
    if (!adminAllowed(c)) return notFound(c);
    if (!(await archiveMessage(c.req.param("id")))) return c.json({ error: "Unknown message", code: "not_found" }, 404);
    announceMessagesChanged();
    return c.json({ ok: true });
  });

  routes.get("/admin/messages/:id/stats", async (c) => {
    if (!adminAllowed(c)) return notFound(c);
    const stats = await messageStats(c.req.param("id"));
    if (!stats) return c.json({ error: "Unknown message", code: "not_found" }, 404);
    return c.json(stats);
  });

  return routes;
}
