import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { config } from "../src/config.js";
import { memoryOutbox } from "../src/email/mailer.js";
import { __resetBugReportThrottleForTests } from "../src/http/routes/bug-reports.js";

/**
 * "Report a bug" (desktop sidebar → bug icon): a signed-in report is emailed to
 * BUG_REPORT_EMAIL (tests/helpers/email-env.ts) with Reply-To = the reporter.
 */
const app = createApp(testAppDeps());

/** Only what reached the operator inbox (sign-up also sends a verification email). */
const reports = () => memoryOutbox.filter((m) => m.to === "bugs@baalda.local");

function report(body: unknown, token?: string) {
  return app.request("/api/bug-reports", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("bug reports", () => {
  beforeEach(async () => {
    await resetDb();
    memoryOutbox.length = 0;
    __resetBugReportThrottleForTests();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("is advertised when an inbox is configured", async () => {
    const res = await app.request("/api/auth-methods");
    expect(await res.json()).toMatchObject({ bugReport: true });
  });

  it("emails the operator inbox, replying to the reporter, with only known details", async () => {
    const alice = await signUp("alice@bugs.io");
    const res = await report(
      {
        message: "Sidebar froze <b>after</b> a rename\nSecond line",
        details: { appVersion: "0.1.73", os: "macOS 15", secret: "dropped", vault: "x".repeat(500) },
      },
      alice.token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });

    expect(reports()).toHaveLength(1);
    const mail = reports()[0]!;
    expect(mail.to).toBe("bugs@baalda.local");
    expect(mail.replyTo).toBe("alice@bugs.io");
    expect(mail.subject).toBe("Bug report: Sidebar froze <b>after</b> a rename");
    expect(mail.text).toContain("App version: 0.1.73");
    expect(mail.text).toContain("Account: alice@bugs.io");
    expect(mail.text).not.toContain("dropped");
    expect(mail.text).toContain(`Vault: ${"x".repeat(200)}\n`);
    // User text is escaped in the HTML part.
    expect(mail.html).toContain("&lt;b&gt;after&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>after</b>");
  });

  it("refuses signed-out, empty and oversized reports", async () => {
    expect((await report({ message: "hello" })).status).toBe(401);
    const bob = await signUp("bob@bugs.io");
    expect((await report({ message: "   " }, bob.token)).status).toBe(400);
    expect((await report({ message: "x".repeat(5001) }, bob.token)).status).toBe(400);
    expect(reports()).toHaveLength(0);
  });

  it("throttles one account at five reports an hour", async () => {
    const carol = await signUp("carol@bugs.io");
    for (let i = 0; i < 5; i++) expect((await report({ message: `bug ${i}` }, carol.token)).status).toBe(200);
    expect((await report({ message: "bug 6" }, carol.token)).status).toBe(429);
    expect(reports()).toHaveLength(5);
  });

  it("carries a video link and allowlisted files as real attachments", async () => {
    const erin = await signUp("erin@bugs.io");
    const png = Buffer.from("fake-png-bytes").toString("base64");
    const res = await report(
      {
        message: "Crash on save",
        videoUrl: "https://www.loom.com/share/abc123",
        attachments: [
          { name: "../../etc/Screen Shot.PNG", data: png },
          { name: "app.log", data: Buffer.from("line 1").toString("base64") },
        ],
      },
      erin.token,
    );
    expect(res.status).toBe(200);
    const mail = reports()[0]!;
    expect(mail.text).toContain("Video: https://www.loom.com/share/abc123");
    expect(mail.html).toContain('href="https://www.loom.com/share/abc123"');
    // Type comes from the extension (never the client), the path is stripped.
    expect(mail.attachments?.map((a) => [a.filename, a.contentType])).toEqual([
      ["Screen Shot.PNG", "image/png"],
      ["app.log", "text/plain"],
    ]);
    expect(mail.attachments?.[0]?.content.toString()).toBe("fake-png-bytes");
  });

  it("refuses bad links, disallowed types and oversized files", async () => {
    const finn = await signUp("finn@bugs.io");
    const ok = Buffer.from("x").toString("base64");
    expect((await report({ message: "m", videoUrl: "javascript:alert(1)" }, finn.token)).status).toBe(400);
    expect((await report({ message: "m", attachments: [{ name: "run.exe", data: ok }] }, finn.token)).status).toBe(400);
    expect((await report({ message: "m", attachments: [{ name: "a.png", data: "%%%" }] }, finn.token)).status).toBe(400);
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `s${i}.png`, data: ok }));
    expect((await report({ message: "m", attachments: four }, finn.token)).status).toBe(413);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
    expect((await report({ message: "m", attachments: [{ name: "big.png", data: big }] }, finn.token)).status).toBe(413);
    expect(reports()).toHaveLength(0);
  });

  it("is off — route 404, not advertised — without an inbox", async () => {
    const saved = config.bugReportEmail;
    (config as { bugReportEmail?: string }).bugReportEmail = undefined;
    try {
      const dave = await signUp("dave@bugs.io");
      expect((await report({ message: "hello" }, dave.token)).status).toBe(404);
      expect(await (await app.request("/api/auth-methods")).json()).toMatchObject({ bugReport: false });
    } finally {
      (config as { bugReportEmail?: string }).bugReportEmail = saved;
    }
  });
});
