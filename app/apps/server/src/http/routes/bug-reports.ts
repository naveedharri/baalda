import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../../config.js";
import { emailEnabled, sendMail, type MailAttachment } from "../../email/mailer.js";
import { bugReportEmail } from "../../email/templates.js";
import { getSession } from "../session.js";

/**
 * `POST /api/bug-reports { message, details?, videoUrl?, attachments? }` — the
 * desktop's "Report a bug" dialog. Emails the operator's `BUG_REPORT_EMAIL`
 * with Reply-To set to the reporter, so answering is a plain reply. A Loom (or
 * any http/https) link rides in the body; files ride as real email attachments
 * (`attachments: [{ name, data: base64 }]`), their type decided HERE from the
 * extension against an allowlist — never from what the client claims.
 *
 *   200 { sent: true }
 *   400 { error: "invalid_report" }          empty or oversized message
 *   400 { error: "invalid_video_link" }      not an http(s) URL
 *   400 { error: "invalid_attachment" }      a type outside the allowlist, bad data
 *   413 { error: "attachments_too_large" }   over the per-file / total / count caps
 *   401 { error: "unauthorized" }            signed in only: a public inbox
 *                                            endpoint would be a spam relay
 *   404 { error: "bug_reports_disabled" }    no BUG_REPORT_EMAIL, or no mailer
 *   429 { error: "too_many_requests" }       per-account throttle
 *   502 { error: "send_failed" }             the provider refused it (logged)
 *
 * The send is AWAITED, unlike the auth hooks' fire-and-forget: the person is
 * looking at a "Sending…" button, and "sent" must mean it reached the provider.
 */
export const bugReportRoutes = new Hono();

export const BUG_REPORT_MAX_CHARS = 5000;
/** Diagnostics the desktop may attach; anything else is dropped, each value capped. */
const DETAIL_KEYS: ReadonlyArray<[string, string]> = [
  ["appVersion", "App version"],
  ["platform", "Platform"],
  ["os", "OS"],
  ["serverUrl", "Server"],
  ["vault", "Vault"],
  ["syncStatus", "Sync status"],
];
const DETAIL_MAX_CHARS = 200;

export const BUG_REPORT_MAX_FILES = 3;
export const BUG_REPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const BUG_REPORT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Extensions a report may attach, and the Content-Type each is sent as. */
const ATTACHMENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

type AttachmentResult = { ok: true; files: MailAttachment[] } | { ok: false; status: 400 | 413; error: string };

function parseAttachments(raw: unknown): AttachmentResult {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: "invalid_attachment" };
  if (raw.length > BUG_REPORT_MAX_FILES) return { ok: false, status: 413, error: "attachments_too_large" };
  const files: MailAttachment[] = [];
  let total = 0;
  for (const item of raw) {
    const name = typeof item?.name === "string" ? item.name : "";
    const data = typeof item?.data === "string" ? item.data : "";
    // A bare, printable file name: no path, no control characters.
    const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
    const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
    const contentType = ATTACHMENT_TYPES[ext];
    if (!base || !contentType || !data || !BASE64_RE.test(data)) {
      return { ok: false, status: 400, error: "invalid_attachment" };
    }
    const content = Buffer.from(data, "base64");
    total += content.length;
    if (content.length > BUG_REPORT_MAX_FILE_BYTES || total > BUG_REPORT_MAX_TOTAL_BYTES) {
      return { ok: false, status: 413, error: "attachments_too_large" };
    }
    files.push({ filename: base, contentType, content });
  }
  return { ok: true, files };
}

function parseVideoUrl(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return undefined;
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();

/** Whether this server takes bug reports — what `/api/auth-methods` advertises. */
export function bugReportsEnabled(): boolean {
  return !!config.bugReportEmail && emailEnabled();
}

bugReportRoutes.post(
  "/bug-reports",
  // Base64 adds a third: 10 MB of files is ~13.4 MB on the wire.
  bodyLimit({
    maxSize: 15 * 1024 * 1024,
    onError: (c) => c.json({ error: "attachments_too_large" }, 413),
  }),
  async (c) => {
    if (!bugReportsEnabled()) return c.json({ error: "bug_reports_disabled" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "unauthorized" }, 401);

    const body = (await c.req.json().catch(() => null)) as {
      message?: unknown;
      details?: unknown;
      videoUrl?: unknown;
      attachments?: unknown;
    } | null;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message || message.length > BUG_REPORT_MAX_CHARS) {
      return c.json({ error: "invalid_report" }, 400);
    }
    const videoUrl = parseVideoUrl(body?.videoUrl);
    if (videoUrl === null) return c.json({ error: "invalid_video_link" }, 400);
    const attachments = parseAttachments(body?.attachments);
    if (!attachments.ok) return c.json({ error: attachments.error }, attachments.status);

    const now = Date.now();
    const hits = (recent.get(session.userId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (hits.length >= MAX_PER_WINDOW) return c.json({ error: "too_many_requests" }, 429);
    hits.push(now);
    recent.set(session.userId, hits);

    const raw = body?.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
    const details: Array<[string, string]> = [["Account", session.email]];
    for (const [key, label] of DETAIL_KEYS) {
      const v = raw[key];
      if (typeof v === "string" && v.trim()) details.push([label, v.trim().slice(0, DETAIL_MAX_CHARS)]);
    }

    try {
      await sendMail(
        bugReportEmail({
          to: config.bugReportEmail!,
          reporter: { email: session.email },
          message,
          details,
          videoUrl,
          attachments: attachments.files,
        }),
      );
    } catch (err) {
      console.error("[bug-report] send failed:", err);
      return c.json({ error: "send_failed" }, 502);
    }
    return c.json({ sent: true });
  },
);

/** Tests only: forget the per-account throttle. */
export function __resetBugReportThrottleForTests(): void {
  recent.clear();
}
