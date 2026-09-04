import { describe, expect, it } from "vitest";
import { deriveWsUrl } from "../syncManager";

describe("deriveWsUrl", () => {
  it("appends /sync on the same origin/port for a no-port https host", () => {
    expect(deriveWsUrl("https://api.baalda.com")).toBe("wss://api.baalda.com/sync");
  });

  it("appends /sync on the same origin/port for a no-port http host", () => {
    expect(deriveWsUrl("http://myserver")).toBe("ws://myserver/sync");
  });

  it("keeps a custom explicit port and appends /sync", () => {
    expect(deriveWsUrl("http://myserver:8080")).toBe("ws://myserver:8080/sync");
  });

  it("preserves a reverse-proxy path prefix ahead of /sync", () => {
    expect(deriveWsUrl("https://host/baalda")).toBe("wss://host/baalda/sync");
  });

  it("collapses a trailing slash instead of double-slashing /sync", () => {
    expect(deriveWsUrl("https://api.baalda.com/")).toBe("wss://api.baalda.com/sync");
  });

  it("keeps an explicit :3010 on the SAME port and appends /sync (single-port self-host, #79)", () => {
    // The Compose bundle publishes only 3010; bumping to a dedicated 3011 here
    // sent every content upload to a port nothing listened on.
    expect(deriveWsUrl("http://localhost:3010")).toBe("ws://localhost:3010/sync");
    expect(deriveWsUrl("http://127.0.0.1:3010")).toBe("ws://127.0.0.1:3010/sync");
  });

  it("falls back to the local default on the HTTP port for unparseable input", () => {
    expect(deriveWsUrl("not a url")).toBe("ws://localhost:3010/sync");
  });
});
