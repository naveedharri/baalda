// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * `GET /` — the page a browser lands on. A self-hosted server must not send its
 * visitors to baalda.com as if that were "the app"; it names itself and links
 * its own `/open/connect` instead.
 */
describe("GET /", () => {
  const app = createApp(testAppDeps());
  const prev = process.env.BAALDA_DEPLOYMENT;
  afterEach(() => {
    if (prev === undefined) delete process.env.BAALDA_DEPLOYMENT;
    else process.env.BAALDA_DEPLOYMENT = prev;
  });

  it("points managed-service visitors at baalda.com", async () => {
    delete process.env.BAALDA_DEPLOYMENT;
    const html = await (await app.request("/")).text();
    expect(html).toContain("The app lives at");
    expect(html).not.toContain("/open/connect");
  });

  it("on a self-hosted server, names this server and links its connect page", async () => {
    process.env.BAALDA_DEPLOYMENT = "self-hosted";
    const res = await app.request("/", {
      headers: { host: "notes.example.com", "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("self-hosted");
    expect(html).toContain("<code>https://notes.example.com</code>");
    expect(html).toContain('href="https://notes.example.com/open/connect"');
    expect(html).not.toContain("The app lives at");
  });

  it("never reflects a hostile Host header as markup", async () => {
    process.env.BAALDA_DEPLOYMENT = "self-hosted";
    const html = await (
      await app.request("/", { headers: { host: '"><script>alert(1)</script>' } })
    ).text();
    expect(html).not.toContain("<script>");
  });
});
