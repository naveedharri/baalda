import nodemailer from "nodemailer";

/**
 * Outbound email (issue #99). Opt-in via env, on the same pattern as Google
 * OAuth: a server with nothing configured simply has no mailer, `emailEnabled()`
 * is false, and every feature that needs to send — password reset, sign-up
 * verification, invitation emails — is not offered (the desktop hides the
 * controls, `/api/auth-methods` says so, Better Auth answers 400 to
 * `request-password-reset`). Nobody self-hosting is forced to run a mailer.
 *
 * Two real transports, chosen by which credential is present:
 *   - `RESEND_API_KEY`  → Resend's HTTP API (plain `fetch`, no SDK).
 *   - `SMTP_URL`        → any SMTP server via nodemailer
 *                         (`smtp://user:pass@host:587`, `smtps://…:465`).
 * `EMAIL_FROM` is required alongside either. Two more exist for development and
 * tests only and are refused in production, because a "configured" server that
 * never delivers a reset link is worse than one that offers no reset at all:
 *   - `EMAIL_TRANSPORT=log`    → prints each message to stdout.
 *   - `EMAIL_TRANSPORT=memory` → collects messages in `memoryOutbox` (the test
 *                                suites read them back to follow the links).
 *
 * Sending is fire-and-forget from the auth hooks (`dispatchMail`): Better Auth
 * awaits its email callbacks, and a slow or failing SMTP hop must never make a
 * sign-up fail or a "we emailed you" answer hang. Failures are logged loudly
 * instead — an operator who sees `[email] … failed` in the logs has a mailer
 * problem; a user who sees an error on sign-up has a lockout.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body — always sent alongside the HTML. */
  text: string;
  html: string;
}

export type MailTransportKind = "smtp" | "resend" | "log" | "memory";

export interface Mailer {
  readonly kind: MailTransportKind;
  send(msg: MailMessage): Promise<void>;
}

export interface EmailEnv {
  emailFrom?: string;
  smtpUrl?: string;
  resendApiKey?: string;
  /** Explicit transport override; normally inferred from the credential present. */
  emailTransport?: string;
  /** NODE_ENV === "production": refuses the dev-only transports. */
  production: boolean;
}

export interface EmailConfig {
  from: string;
  transport: MailTransportKind;
  smtpUrl?: string;
  resendApiKey?: string;
}

const KINDS: readonly MailTransportKind[] = ["smtp", "resend", "log", "memory"];

/**
 * Decide whether — and how — this server sends email. `null` means email is
 * off, which is the default and a perfectly good self-host configuration.
 * Misconfiguration (a credential without a sender address, a transport without
 * its credential, a dev transport in production) throws, so a deploy that
 * *meant* to send mail fails at startup instead of silently offering password
 * reset links that never arrive.
 */
export function resolveEmailConfig(env: EmailEnv): EmailConfig | null {
  const from = env.emailFrom?.trim() || undefined;
  const smtpUrl = env.smtpUrl?.trim() || undefined;
  const resendApiKey = env.resendApiKey?.trim() || undefined;
  const override = env.emailTransport?.trim().toLowerCase() || undefined;

  let transport: MailTransportKind | undefined;
  if (override !== undefined) {
    if (!(KINDS as readonly string[]).includes(override)) {
      throw new Error(
        `EMAIL_TRANSPORT must be one of ${KINDS.join(", ")} (got "${override}")`,
      );
    }
    transport = override as MailTransportKind;
  } else if (resendApiKey) {
    transport = "resend";
  } else if (smtpUrl) {
    transport = "smtp";
  }

  if (!transport) {
    if (from) {
      throw new Error(
        "EMAIL_FROM is set but no transport is: set SMTP_URL or RESEND_API_KEY (or unset EMAIL_FROM to disable email).",
      );
    }
    return null;
  }
  if (!from) {
    throw new Error(
      "EMAIL_FROM is required to send email (e.g. 'Baalda <no-reply@example.com>').",
    );
  }
  if (transport === "smtp" && !smtpUrl) {
    throw new Error("EMAIL_TRANSPORT=smtp requires SMTP_URL.");
  }
  if (transport === "resend" && !resendApiKey) {
    throw new Error("EMAIL_TRANSPORT=resend requires RESEND_API_KEY.");
  }
  if ((transport === "log" || transport === "memory") && env.production) {
    throw new Error(
      `EMAIL_TRANSPORT=${transport} is for development and tests only; it delivers nothing. Configure SMTP_URL or RESEND_API_KEY in production.`,
    );
  }
  return { from, transport, smtpUrl, resendApiKey };
}

// ---- Transports ------------------------------------------------------------

/** Messages "sent" by the memory transport, oldest first. Tests read these. */
export const memoryOutbox: MailMessage[] = [];

function memoryMailer(): Mailer {
  return {
    kind: "memory",
    async send(msg) {
      memoryOutbox.push(msg);
    },
  };
}

function logMailer(from: string): Mailer {
  return {
    kind: "log",
    async send(msg) {
      console.log(
        `[email] (log transport — not delivered)\nFrom: ${from}\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`,
      );
    },
  };
}

function smtpMailer(from: string, smtpUrl: string): Mailer {
  // nodemailer accepts the whole connection as a URL — host, port, auth and
  // TLS (smtps:// for implicit TLS on 465; smtp:// upgrades with STARTTLS
  // when the server offers it).
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    kind: "smtp",
    async send(msg) {
      await transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
    },
  };
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function resendMailer(
  from: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Mailer {
  return {
    kind: "resend",
    async send(msg) {
      const res = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Resend responded ${res.status}: ${body.slice(0, 300)}`);
      }
    },
  };
}

export function createMailer(cfg: EmailConfig): Mailer {
  switch (cfg.transport) {
    case "memory":
      return memoryMailer();
    case "log":
      return logMailer(cfg.from);
    case "smtp":
      return smtpMailer(cfg.from, cfg.smtpUrl!);
    case "resend":
      return resendMailer(cfg.from, cfg.resendApiKey!);
  }
}

// ---- Process-wide mailer -----------------------------------------------------

function envConfig(): EmailConfig | null {
  return resolveEmailConfig({
    emailFrom: process.env.EMAIL_FROM,
    smtpUrl: process.env.SMTP_URL,
    resendApiKey: process.env.RESEND_API_KEY,
    emailTransport: process.env.EMAIL_TRANSPORT,
    production: process.env.NODE_ENV === "production",
  });
}

let resolved = false;
let mailer: Mailer | null = null;

/** The configured mailer, built once from the environment; null = email off. */
export function getMailer(): Mailer | null {
  if (!resolved) {
    const cfg = envConfig();
    mailer = cfg ? createMailer(cfg) : null;
    resolved = true;
    if (mailer) console.log(`[email] outbound email ON (transport: ${mailer.kind})`);
  }
  return mailer;
}

/**
 * Is this server able to send email? Drives every email-dependent feature:
 * which Better Auth hooks are registered, what `/api/auth-methods` advertises,
 * whether the branded pages show "Forgot password?".
 */
export function emailEnabled(): boolean {
  return getMailer() !== null;
}

/** Send, or throw if email is off. Prefer {@link dispatchMail} from request paths. */
export async function sendMail(msg: MailMessage): Promise<void> {
  const m = getMailer();
  if (!m) throw new Error("Outbound email is not configured on this server.");
  await m.send(msg);
}

/**
 * Fire-and-forget send for the auth hooks. Never throws, never blocks the
 * request that triggered it; a failure is logged with enough context to chase.
 * With the memory transport the message is queued synchronously, so a test can
 * read `memoryOutbox` right after the request that caused the send resolves.
 */
export function dispatchMail(what: string, msg: MailMessage): void {
  void sendMail(msg).catch((err: unknown) => {
    console.error(`[email] ${what} to ${msg.to} failed:`, err);
  });
}

/** Tests only: swap the process mailer (pass null to re-resolve from env). */
export function __setMailerForTests(m: Mailer | null): void {
  mailer = m;
  resolved = m !== null;
}
