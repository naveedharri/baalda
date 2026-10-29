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
