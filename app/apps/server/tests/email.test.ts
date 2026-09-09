import { describe, expect, it, vi } from "vitest";
import {
  createMailer,
  memoryOutbox,
  resendMailer,
  resolveEmailConfig,
} from "../src/email/mailer.js";
import { invitationEmail, resetPasswordEmail, verifyEmailEmail } from "../src/email/templates.js";

/**
 * Outbound email configuration (issue #99). No Postgres, no network: the
 * process-wide mailer is exercised end-to-end by the password-reset and
 * invitation suites; this one pins the env → config contract and the message
 * bodies.
 */
describe("resolveEmailConfig", () => {
  const off = { production: false };

  it("is OFF with nothing set — the self-host default", () => {
    expect(resolveEmailConfig(off)).toBeNull();
  });

  it("picks Resend from its key, SMTP from its URL", () => {
    expect(
      resolveEmailConfig({ ...off, emailFrom: "Baalda <no-reply@x.io>", resendApiKey: "re_1" }),
    ).toMatchObject({ transport: "resend", from: "Baalda <no-reply@x.io>" });
    expect(
      resolveEmailConfig({ ...off, emailFrom: "a@x.io", smtpUrl: "smtp://u:p@mail.x.io:587" }),
    ).toMatchObject({ transport: "smtp", smtpUrl: "smtp://u:p@mail.x.io:587" });
  });

  it("prefers an explicit EMAIL_TRANSPORT and validates it", () => {
    expect(
      resolveEmailConfig({
        ...off,
        emailFrom: "a@x.io",
        smtpUrl: "smtp://mail",
        resendApiKey: "re_1",
        emailTransport: "smtp",
      })?.transport,
    ).toBe("smtp");
    expect(() =>
      resolveEmailConfig({ ...off, emailFrom: "a@x.io", emailTransport: "carrier-pigeon" }),
    ).toThrow(/EMAIL_TRANSPORT/);
  });

  it("refuses a half-configured setup instead of pretending to send", () => {
    // A credential without a sender.
    expect(() => resolveEmailConfig({ ...off, smtpUrl: "smtp://mail" })).toThrow(/EMAIL_FROM/);
    // A sender without any transport.
    expect(() => resolveEmailConfig({ ...off, emailFrom: "a@x.io" })).toThrow(/SMTP_URL or RESEND_API_KEY/);
    // A transport named without its credential.
    expect(() =>
      resolveEmailConfig({ ...off, emailFrom: "a@x.io", emailTransport: "resend" }),
    ).toThrow(/RESEND_API_KEY/);
  });

  it("refuses the dev-only transports in production", () => {
    for (const t of ["log", "memory"]) {
      expect(() =>
        resolveEmailConfig({ production: true, emailFrom: "a@x.io", emailTransport: t }),
      ).toThrow(/development and tests only/);
      expect(resolveEmailConfig({ production: false, emailFrom: "a@x.io", emailTransport: t })).toMatchObject({
        transport: t,
      });
    }
  });

  it("treats blank strings as unset", () => {
    expect(resolveEmailConfig({ ...off, emailFrom: "  ", smtpUrl: "", resendApiKey: "" })).toBeNull();
  });
});

describe("transports", () => {
  it("memory transport collects messages", async () => {
    const before = memoryOutbox.length;
    const m = createMailer({ from: "a@x.io", transport: "memory" });
    await m.send({ to: "b@x.io", subject: "s", text: "t", html: "<p>t</p>" });
    expect(memoryOutbox.length).toBe(before + 1);
    expect(memoryOutbox[memoryOutbox.length - 1]).toMatchObject({ to: "b@x.io", subject: "s" });
  });

  it("resend transport posts the message and surfaces API failures", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const okFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response('{"id":"x"}', { status: 200 });
    }) as unknown as typeof fetch;
    const m = resendMailer("Baalda <no-reply@x.io>", "re_key", okFetch);
    await m.send({ to: "b@x.io", subject: "Hi", text: "t", html: "<p>t</p>" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: "Baalda <no-reply@x.io>",
      to: ["b@x.io"],
      subject: "Hi",
      text: "t",
      html: "<p>t</p>",
    });

    const badFetch = (async () => new Response("nope", { status: 422 })) as unknown as typeof fetch;
    await expect(
      resendMailer("a@x.io", "k", badFetch).send({ to: "b@x.io", subject: "s", text: "t", html: "h" }),
    ).rejects.toThrow(/422/);
  });
});

describe("templates", () => {
  it("carry the link in both bodies and escape user-supplied names", () => {
    const reset = resetPasswordEmail({ to: "a@x.io", url: "https://s/reset-password?token=T", validMinutes: 60 });
    expect(reset.text).toContain("https://s/reset-password?token=T");
    expect(reset.html).toContain("https://s/reset-password?token=T");
    expect(reset.subject).toMatch(/reset/i);

    const verify = verifyEmailEmail({ to: "a@x.io", url: "https://s/v?token=T" });
    expect(verify.text).toContain("https://s/v?token=T");

    const inv = invitationEmail({
      to: "a@x.io",
      url: "https://s/invite/I",
      organizationName: "<script>Acme</script>",
      inviterName: "Bob & Co",
      role: "admin",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect(inv.html).not.toContain("<script>Acme");
    expect(inv.html).toContain("&lt;script&gt;Acme");
    expect(inv.html).toContain("Bob &amp; Co");
    expect(inv.text).toContain("https://s/invite/I");
    expect(inv.text).toContain("as an admin");
    expect(inv.subject).toContain("Bob & Co");
  });
});
