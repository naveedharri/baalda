import { describe, it, expect } from "vitest";
import {
  resolveServerUrl,
  DEFAULT_SERVER_URL,
  LOCAL_SERVER_URL,
  PRODUCTION_SERVER_URL,
} from "../api";

// Vitest runs with import.meta.env.DEV === true, which is exactly the mode
// these rules are about: a dev build must never end up talking to production
// just because the URL was persisted once.
describe("resolveServerUrl (dev build)", () => {
  it("defaults to the local stack when nothing is persisted", () => {
    expect(DEFAULT_SERVER_URL).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl(null)).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl("")).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl("   ")).toBe(LOCAL_SERVER_URL);
  });

  it("ignores a persisted production URL", () => {
    // The reported state: config.json held api.baalda.com, so every launch of
    // `pnpm dev:desktop` was reading and writing real vaults.
    expect(resolveServerUrl(PRODUCTION_SERVER_URL)).toBe(LOCAL_SERVER_URL);
    expect(resolveServerUrl("https://api.baalda.com/")).toBe(LOCAL_SERVER_URL);
  });

  it("honours any other persisted server", () => {
    // Staging / LAN / self-host overrides must keep working from Settings.
    expect(resolveServerUrl("https://staging.example.com")).toBe(
      "https://staging.example.com",
    );
    expect(resolveServerUrl("http://192.168.1.20:3010/")).toBe(
      "http://192.168.1.20:3010",
    );
    expect(resolveServerUrl("http://localhost:4000")).toBe("http://localhost:4000");
  });
});
