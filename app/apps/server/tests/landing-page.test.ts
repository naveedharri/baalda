// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { isLoopbackHost } from "../src/http/routes/open-link.js";
import { config } from "../src/config.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * `GET /`: the page a browser lands on. Only the managed service (Cloud with
 * billing configured) sends visitors to baalda.com; any other server names
 * itself and links its own `/open/connect`, so its visitors never sign up on
 * the managed service by mistake.
 */
describe("GET /", () => {
  const app = createApp(testAppDeps());
  const saved = {
    deployment: process.env.BAALDA_DEPLOYMENT,
    polar: process.env.POLAR_ACCESS_TOKEN,
    authUrl: config.betterAuthUrl,
  };
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  afterEach(() => {
    restore("BAALDA_DEPLOYMENT", saved.deployment);
    restore("POLAR_ACCESS_TOKEN", saved.polar);
    (config as { betterAuthUrl: string }).betterAuthUrl = saved.authUrl;
  });
  const selfHosted = () => {
    process.env.BAALDA_DEPLOYMENT = "self-hosted";
    delete process.env.POLAR_ACCESS_TOKEN;
  };

  it("points the managed service's visitors at baalda.com", async () => {
    delete process.env.BAALDA_DEPLOYMENT;
    process.env.POLAR_ACCESS_TOKEN = "test-token"; // billing on: read live by billingEnabled()
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("The app lives at");
    expect(html).not.toContain("/open/connect");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("on a self-hosted server, names this server and links its connect page", async () => {
    selfHosted();
    const res = await app.request("/", { headers: { host: "notes.example.com", "x-forwarded-proto": "https" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("self-hosted");
    expect(html).toContain("<code>https://notes.example.com</code>");
    expect(html).toContain('href="https://notes.example.com/open/connect"');
    expect(html).not.toContain("The app lives at");
    // Named from the request: a shared cache must not keep it.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a server without our deploy files (no BAALDA_DEPLOYMENT, no billing) is self-hosted too", async () => {
    delete process.env.BAALDA_DEPLOYMENT;
    delete process.env.POLAR_ACCESS_TOKEN;
    const html = await (await app.request("/", { headers: { host: "notes.example.com" } })).text();
    expect(html).toContain('href="http://notes.example.com/open/connect"');
  });

  it("opened on the server box itself, names the configured public address", async () => {
    selfHosted();
    (config as { betterAuthUrl: string }).betterAuthUrl = "https://notes.example.com";
    const html = await (await app.request("/", { headers: { host: "localhost:3010" } })).text();
    expect(html).toContain("<code>https://notes.example.com</code>");
    expect(html).not.toContain("localhost");
  });

  it("never reflects a hostile Host header: it falls back to the configured address", async () => {
    selfHosted();
    (config as { betterAuthUrl: string }).betterAuthUrl = "https://notes.example.com";
    const html = await (
      await app.request("/", { headers: { host: '"><script>alert(1)</script>' } })
    ).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("<code>https://notes.example.com</code>");
  });
});

describe("isLoopbackHost", () => {
  it("knows loopback names and addresses, with or without a port", () => {
    for (const h of ["localhost", "localhost:3010", "app.localhost", "127.0.0.1", "127.1.2.3:80", "[::1]:3010", "0.0.0.0:3010"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ["notes.example.com", "10.0.0.5:3010", "192.168.1.2", "my-localhost.com"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});
