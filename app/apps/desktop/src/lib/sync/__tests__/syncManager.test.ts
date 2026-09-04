import { describe, expect, it } from "vitest";
import { CLOSE_NOTE_TOO_LARGE, deriveWsUrl, isTerminalSyncStatus } from "../syncManager";

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

describe("terminal sync statuses", () => {
  it("treats both refusals as terminal, and nothing else", () => {
    // The distinction this encodes: a status you can retry out of, versus one
    // where every retry produces the identical refusal. Reconnecting on the
    // latter is an infinite loop — 403→reconnect→403 for `no-access`, and
    // oversized-state→close→reconnect for `too-large`, which is what strobed
    // the badge about once a second.
    expect(isTerminalSyncStatus("no-access")).toBe(true);
    expect(isTerminalSyncStatus("too-large")).toBe(true);
    for (const s of ["offline", "connecting", "synced", "read-only", "error"] as const) {
      expect(isTerminalSyncStatus(s)).toBe(false);
    }
  });

  it("pins the close code the server sends for an oversized doc", () => {
    // Must equal `CLOSE_NOTE_TOO_LARGE` in apps/server/src/sync/hocuspocus.ts.
    // The two are in separate packages with no shared module, so this literal is
    // the only thing holding them in lockstep — and if they drift, the client
    // silently goes back to reconnecting forever. Asserted on both sides.
    expect(CLOSE_NOTE_TOO_LARGE).toBe(4413);
    // Deliberately in the private 4000–4999 range: those are reserved for
    // application use and always sendable, unlike the protocol-level 1009.
    expect(CLOSE_NOTE_TOO_LARGE).toBeGreaterThanOrEqual(4000);
    expect(CLOSE_NOTE_TOO_LARGE).toBeLessThanOrEqual(4999);
  });
});
