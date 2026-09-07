import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * The clickable share-link landing page (`GET /open/note/:orgId/:docId`).
 *
 * Chat apps linkify https where a bare `baalda://` scheme just sits there as
 * text, so share links are web URLs and this page bounces them into the app's
 * deep link. It is public by design — the URL carries identity, not access —
 * so these tests pin the two properties that make that safe: it touches no
 * data (any well-formed ids get the same page), and hostile ids can't smuggle
 * markup into the HTML.
 */
describe("GET /open/note/:orgId/:docId", () => {
  const app = createApp(testAppDeps());

  it("serves a page that deep-links into the app", async () => {
    const res = await app.request("/open/note/org_123/7dfc7a21-310c-41bd-840f-d4c37f8d5db3");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("baalda://note/org_123/7dfc7a21-310c-41bd-840f-d4c37f8d5db3");
  });

  it("is public — no session required", async () => {
    // No Authorization header at all; the ids resolve against whoever is
    // signed in on the DEVICE that opens the deep link, never here.
    const res = await app.request("/open/note/a/b");
    expect(res.status).toBe(200);
  });

  it("refuses ids that don't look like ids (nothing to reflect)", async () => {
    for (const path of [
      "/open/note/%3Cscript%3E/doc",
      "/open/note/org/%22onload%3D",
      `/open/note/${"x".repeat(200)}/doc`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("<script>");
    }
  });
});

/**
 * The server-invite landing page (`GET /open/connect`).
 *
 * The link an admin sends instead of dictating a URL (#91), so the property
 * that matters is that the page names THIS server — the one the recipient just
 * reached — rather than a build-time constant, including behind a
 * TLS-terminating reverse proxy where the request itself arrives as plain http.
 */
describe("GET /open/connect", () => {
  const app = createApp(testAppDeps());

  it("deep-links back to the host the request came in on", async () => {
    const res = await app.request("/open/connect", {
      headers: { host: "notes.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(
      `baalda://connect?server=${encodeURIComponent("http://notes.example.com")}`,
    );
  });

  it("trusts the forwarded proto and host over the local request", async () => {
    const res = await app.request("/open/connect", {
      headers: {
        host: "internal-8080.railway.internal",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "notes.example.com",
      },
    });
    const html = await res.text();
    expect(html).toContain(
      `baalda://connect?server=${encodeURIComponent("https://notes.example.com")}`,
    );
    expect(html).not.toContain("railway.internal");
  });

  it("keeps the path prefix a reverse proxy announces", async () => {
    const announced = await app.request("/open/connect", {
      headers: {
        host: "intranet.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-prefix": "/baalda",
      },
    });
    expect(await announced.text()).toContain(
      `server=${encodeURIComponent("https://intranet.example.com/baalda")}`,
    );
  });

  it("is public, and a hostile host header can't smuggle markup in", async () => {
    const res = await app.request("/open/connect", {
      headers: { host: '"><script>alert(1)</script>' },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    // Falls back to the configured public URL rather than reflecting it.
    expect(html).toContain("baalda://connect?server=");
  });
});
