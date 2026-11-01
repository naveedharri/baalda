import { describe, expect, it } from "vitest";
import { consentKeyHeader, linkMatchesServer, parseOAuthConsentLink } from "./oauthConsentLink";

describe("oauth-consent deep link", () => {
  it("parses both foldings and every app scheme", () => {
    for (const url of [
      "baalda://oauth-consent?id=abcDEF123_-xyz&server=https%3A%2F%2Fapi.baalda.com",
      "baalda:///oauth-consent?id=abcDEF123_-xyz&server=https%3A%2F%2Fapi.baalda.com",
      "baalda-staging://oauth-consent?id=abcDEF123_-xyz&server=https%3A%2F%2Fapi.baalda.com",
      "baalda-dev://oauth-consent?id=abcDEF123_-xyz&server=https%3A%2F%2Fapi.baalda.com",
    ]) {
      expect(parseOAuthConsentLink(url), url).toEqual({ id: "abcDEF123_-xyz", server: "https://api.baalda.com" });
    }
  });

  it("refuses other links, odd ids and other schemes", () => {
    expect(parseOAuthConsentLink("baalda://billing/upgraded")).toBeNull();
    expect(parseOAuthConsentLink("baalda://oauth-consent?id=a b")).toBeNull();
    expect(parseOAuthConsentLink("baalda://oauth-consent")).toBeNull();
    expect(parseOAuthConsentLink("https://oauth-consent?id=abcdefghij")).toBeNull();
  });

  it("only matches the server this app uses", () => {
    const link = parseOAuthConsentLink("baalda://oauth-consent?id=abcdefghij&server=https%3A%2F%2Fapi.baalda.com")!;
    expect(linkMatchesServer(link, "https://api.baalda.com")).toBe(true);
    expect(linkMatchesServer(link, "https://evil.example")).toBe(false);
  });

  it("red team 3: dressed-up, duplicated or misdirected consent links are refused", () => {
    for (const url of [
      "baalda://evil.example@oauth-consent?id=abcdefghij",
      "baalda://user:pw@oauth-consent?id=abcdefghij",
      "baalda://oauth-consent?id=abcdefghij&id=zzzzzzzzzz",
      "baalda://oauth-consent/extra?id=abcdefghij",
      "baalda://oauth-consent?id=abcdefghij&server=javascript%3Aalert(1)",
      "baalda://oauth-consent?id=abcdefghij&server=ftp%3A%2F%2Fevil.example",
      "baalda://oauth-consent?id=..%2F..%2Fmcp%2Ftokens",
    ]) {
      expect(parseOAuthConsentLink(url), url).toBeNull();
    }
    // A link naming another server never reaches that server: it is refused here,
    // and a link naming none is only ever resolved against the app's own server.
    const other = parseOAuthConsentLink("baalda://oauth-consent?id=abcdefghij&server=https%3A%2F%2Fevil.example")!;
    expect(linkMatchesServer(other, "https://api.baalda.com")).toBe(false);
  });

  it("red team 3: never presents a key the server slipped in for another vault", async () => {
    const keys: Record<string, string> = { v1: "K1", vOther: "KO" };
    const api = { vaultKeyFor: (id: string) => keys[id] ?? null, ensureVaultKeyFor: async () => false };
    const elsewhere = (id: string) => id === "vOther";
    expect(await consentKeyHeader(["v1", "vOther"], api, elsewhere)).toBeNull();
    expect(await consentKeyHeader(["v1"], api, elsewhere)).toBe("v1=K1");
    // An absurd list (a harvesting attempt) presents nothing.
    expect(await consentKeyHeader(Array.from({ length: 50 }, (_, i) => `v${i}`), api)).toBeNull();
    expect(await consentKeyHeader("v1" as unknown as string[], api)).toBeNull();
  });

  it("builds vaultId=key pairs only when every key is held", async () => {
    const keys: Record<string, string> = { v1: "K1" };
    const api = {
      vaultKeyFor: (id: string) => keys[id] ?? null,
      ensureVaultKeyFor: async (id: string) => {
        if (id === "v2") keys.v2 = "K2";
        return id === "v2";
      },
    };
    expect(await consentKeyHeader(["v1", "v2"], api)).toBe("v1=K1,v2=K2");
    expect(await consentKeyHeader(["v1", "v3"], api)).toBeNull();
    expect(await consentKeyHeader([], api)).toBeNull();
  });
});
