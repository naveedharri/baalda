import { BRAND_NAME } from "../brand.js";
import type { MailMessage } from "./mailer.js";

/**
 * The three transactional emails the server sends. Deliberately plain: inline
 * styles only, one column, a light background and a single black button —
 * what renders identically in Gmail, Outlook and Apple Mail, and what lands in
 * the inbox rather than the promotions tab. The plain-text twin is not an
 * afterthought: some clients prefer it, and every link must be copy-pasteable
 * from it.
 *
 * Every dynamic value goes through `esc` before it touches HTML. Org names and
 * inviter names are user-supplied.
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(opts: { title: string; intro: string; cta: string; url: string; outro: string }): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f4f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1c1a;">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px;">
    <div style="font-weight:700;letter-spacing:0.18em;font-size:13px;color:#6b6b66;margin-bottom:22px;">${esc(BRAND_NAME.toUpperCase())}</div>
    <div style="background:#ffffff;border:1px solid #e6e5df;border-radius:14px;padding:30px 28px;">
      <h1 style="font-size:20px;font-weight:600;margin:0 0 12px;">${opts.title}</h1>
      <p style="font-size:15px;line-height:1.55;margin:0 0 22px;color:#3a3a37;">${opts.intro}</p>
      <p style="margin:0 0 22px;">
        <a href="${esc(opts.url)}" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px;">${esc(opts.cta)}</a>
      </p>
      <p style="font-size:13px;line-height:1.55;margin:0;color:#6b6b66;">${opts.outro}</p>
      <p style="font-size:12px;line-height:1.5;margin:18px 0 0;color:#8a8a84;word-break:break-all;">If the button doesn't work, paste this link into your browser:<br /><a href="${esc(opts.url)}" style="color:#6b6b66;">${esc(opts.url)}</a></p>
    </div>
  </div>
</body>
</html>`;
}

export function resetPasswordEmail(input: { to: string; url: string; validMinutes: number }): MailMessage {
  const subject = `Reset your ${BRAND_NAME} password`;
  const text = [
    `Someone asked to reset the password for the ${BRAND_NAME} account ${input.to}.`,
    ``,
    `Choose a new password here (the link is valid for ${input.validMinutes} minutes):`,
    input.url,
    ``,
    `If you didn't ask for this, you can ignore this email — your password stays as it is.`,
  ].join("\n");
  const html = layout({
    title: "Reset your password",
    intro: `Someone asked to reset the password for the ${esc(BRAND_NAME)} account <b>${esc(input.to)}</b>. Choose a new one below — the link is valid for ${input.validMinutes} minutes.`,
    cta: "Choose a new password",
    url: input.url,
    outro: `If you didn't ask for this, you can ignore this email; your password stays as it is.`,
  });
  return { to: input.to, subject, text, html };
}

export function verifyEmailEmail(input: { to: string; url: string }): MailMessage {
  const subject = `Confirm your email for ${BRAND_NAME}`;
  const text = [
    `Welcome to ${BRAND_NAME}. Please confirm that ${input.to} is yours:`,
    input.url,
    ``,
    `If you didn't create a ${BRAND_NAME} account, you can ignore this email.`,
  ].join("\n");
  const html = layout({
    title: "Confirm your email",
    intro: `Welcome to ${esc(BRAND_NAME)}. Please confirm that <b>${esc(input.to)}</b> is yours.`,
    cta: "Confirm email",
    url: input.url,
    outro: `If you didn't create a ${esc(BRAND_NAME)} account, you can ignore this email.`,
  });
  return { to: input.to, subject, text, html };
}

export function invitationEmail(input: {
  to: string;
  url: string;
  organizationName: string;
  inviterName: string | null;
  role: string;
  expiresAt: Date;
}): MailMessage {
  const who = input.inviterName?.trim() || "A teammate";
  const subject = `${who} invited you to ${input.organizationName} on ${BRAND_NAME}`;
  const roleNote = input.role === "admin" ? " as an admin" : "";
  const expires = input.expiresAt.toUTCString();
  const text = [
    `${who} invited you to join the vault "${input.organizationName}" on ${BRAND_NAME}${roleNote}.`,
    ``,
    `Accept the invitation:`,
    input.url,
    ``,
    `Sign in with ${input.to} — or create an account with that address — and you'll land in the vault.`,
    `This invitation expires ${expires}.`,
    ``,
    `Don't have ${BRAND_NAME} yet? Get it at https://baalda.com and then open the link again.`,
  ].join("\n");
  const html = layout({
    title: `Join ${esc(input.organizationName)}`,
    intro: `<b>${esc(who)}</b> invited you to join the vault <b>${esc(input.organizationName)}</b> on ${esc(BRAND_NAME)}${esc(roleNote)}. Sign in with <b>${esc(input.to)}</b> — or create an account with that address — and you'll land in the vault.`,
    cta: "Accept invitation",
    url: input.url,
    outro: `This invitation expires ${esc(expires)}. Don't have ${esc(BRAND_NAME)} yet? <a href="https://baalda.com" style="color:#6b6b66;">Get it</a>, then open the link again.`,
  });
  return { to: input.to, subject, text, html };
}
