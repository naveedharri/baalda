import { describe, expect, it } from "vitest";
import { ApiClient } from "../api";
import {
  REQUIRED_SERVER_FEATURES,
  backendStatus,
  isManagedServer,
  parseHealth,
} from "../serverFeatures";

const SELF = "https://baalda.example.org";
const MANAGED = "https://api.baalda.com";

describe("parseHealth", () => {
  it("tolerates the old { ok: true } shape", () => {
    expect(parseHealth({ ok: true })).toEqual({ ok: true, features: [] });
  });

  it("reads the current shape and drops non-string features", () => {
    expect(
      parseHealth({
        ok: true,
        features: ["notes-with-state", 7, null],
        version: "0.2.0",
        minDesktopVersion: "0.1.80",
      }),
    ).toEqual({
      ok: true,
      features: ["notes-with-state"],
      version: "0.2.0",
      minDesktopVersion: "0.1.80",
    });
  });

  it("answers null for anything that is not a Baalda health body", () => {
    expect(parseHealth(null)).toBeNull();
    expect(parseHealth("ok")).toBeNull();
    expect(parseHealth({ ok: false })).toBeNull();
    expect(parseHealth({ status: "up" })).toBeNull();
  });
});

describe("backendStatus", () => {
  it("old shape ⇒ outdated, listing every required feature as missing", () => {
    const s = backendStatus(parseHealth({ ok: true }), SELF);
    expect(s.outdated).toBe(true);
    expect(s.missing).toEqual([...REQUIRED_SERVER_FEATURES]);
    expect(s.serverVersion).toBeUndefined();
    expect(s.managed).toBe(false);
  });

  it("current shape with every required feature ⇒ not outdated", () => {
    const s = backendStatus(
      parseHealth({ ok: true, features: [...REQUIRED_SERVER_FEATURES, "extra"], version: "0.2.0" }),
      SELF,
    );
    expect(s).toEqual({ outdated: false, missing: [], serverVersion: "0.2.0", managed: false });
  });

  it("names only the features that are actually missing", () => {
    const s = backendStatus(
      { ok: true, features: ["a"], version: "0.1.9" },
      SELF,
      ["a", "b"],
    );
    expect(s.outdated).toBe(true);
    expect(s.missing).toEqual(["b"]);
    expect(s.serverVersion).toBe("0.1.9");
  });

  it("fetch failure / unreachable (null) ⇒ not outdated", () => {
    expect(backendStatus(null, SELF)).toEqual({ outdated: false, missing: [], managed: false });
    expect(backendStatus(null, MANAGED)).toEqual({ outdated: false, missing: [], managed: true });
  });

  it("flags the managed host", () => {
    expect(backendStatus(parseHealth({ ok: true }), MANAGED).managed).toBe(true);
  });
});

describe("isManagedServer", () => {
  it("matches api.baalda.com only, case-insensitively, any path or port", () => {
    expect(isManagedServer("https://api.baalda.com")).toBe(true);
    expect(isManagedServer("https://API.Baalda.com/")).toBe(true);
    expect(isManagedServer(" https://api.baalda.com/sync ")).toBe(true);
    expect(isManagedServer("https://api.baalda.com.evil.example")).toBe(false);
    expect(isManagedServer("https://staging.baalda.com")).toBe(false);
    expect(isManagedServer("http://localhost:3010")).toBe(false);
    expect(isManagedServer("not a url")).toBe(false);
    expect(isManagedServer("")).toBe(false);
    expect(isManagedServer(null)).toBe(false);
  });
});

describe("ApiClient.getHealth", () => {
  const client = (impl: (url: string) => Promise<Response>) =>
    new ApiClient({ baseUrl: SELF, fetchImpl: ((u: string) => impl(u)) as never });

  it("parses the health body from /health", async () => {
    let seen = "";
    const api = client(async (u) => {
      seen = u;
      return new Response(JSON.stringify({ ok: true, features: ["notes-with-state"], version: "0.2.0" }));
    });
    expect(await api.getHealth()).toEqual({
      ok: true,
      features: ["notes-with-state"],
      version: "0.2.0",
    });
    expect(seen).toBe(`${SELF}/health`);
  });

  it("answers null on a network failure, a 5xx or a non-JSON body", async () => {
    expect(await client(async () => { throw new TypeError("Load failed"); }).getHealth()).toBeNull();
    expect(await client(async () => new Response("down", { status: 502 })).getHealth()).toBeNull();
    expect(await client(async () => new Response("<html></html>")).getHealth()).toBeNull();
  });

  it("a fetch failure therefore never reads as outdated", async () => {
    const api = client(async () => { throw new TypeError("Load failed"); });
    expect(backendStatus(await api.getHealth(), SELF).outdated).toBe(false);
  });
});
