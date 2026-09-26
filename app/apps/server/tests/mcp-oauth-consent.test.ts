import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { oauthConnectRoutes } from "../src/http/routes/oauth-connect.js";

// Issue #211: a client whose user is already signed in in the browser skipped
// /oauth/login and — without prompt=consent — the vault picker too, so its
// token had no vault binding. Authorize must always go through consent.
const reached: string[] = [];
const app = new Hono().route("/", oauthConnectRoutes);
app.get("/api/auth/*", (c) => {
  reached.push(c.req.url);
  return c.text("better-auth");
});

describe("MCP authorize always shows the vault picker", () => {
  it("redirects an authorize without prompt=consent to one with it", async () => {
    const res = await app.request(
      "/api/auth/mcp/authorize?client_id=abc&response_type=code&state=s1&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcb",
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`${config.betterAuthUrl}/api/auth/mcp/authorize`);
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("client_id")).toBe("abc");
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5000/cb");
  });

  it("overrides another prompt value", async () => {
    const res = await app.request("/api/auth/mcp/authorize?client_id=abc&prompt=none");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("prompt")).toBe("consent");
  });

  it("passes an authorize that already carries prompt=consent to Better Auth", async () => {
    reached.length = 0;
    const res = await app.request("/api/auth/mcp/authorize?client_id=abc&prompt=consent");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("better-auth");
    expect(reached).toHaveLength(1);
  });
});
