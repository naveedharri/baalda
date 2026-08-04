import { describe, expect, it, vi } from "vitest";

// Replace the whole ipc module so importing authManager doesn't drag in
// `@tauri-apps/api` (unavailable in the Node test env). These fakes stand in for
// the Rust loopback + keychain + browser-opener.
vi.mock("../../ipc", () => ({
  googleOauthListen: vi.fn(async () => ({ port: 5123, state: "test-nonce" })),
  googleOauthAwait: vi.fn(async () => "code-xyz"),
  openExternal: vi.fn(async () => {}),
  keychainSet: vi.fn(async () => {}),
  keychainGet: vi.fn(async () => null),
  keychainDelete: vi.fn(async () => {}),
  getServerUrl: vi.fn(async () => null),
  setServerUrl: vi.fn(async () => {}),
}));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import { AuthManager } from "../authManager";

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getBaseUrl: () => "http://localhost:3010",
    socialSignInUrl: vi.fn(async () => "https://accounts.google.com/authorize?x=1"),
    exchangeDesktopCode: vi.fn(async () => ({
      user: { id: "u1", email: "a@b.co", name: "" },
      token: "sess-1",
    })),
    ...overrides,
  } as unknown as ApiClient;
}

describe("AuthManager.signInWithGoogle", () => {
  it("drives loopback → authorize → browser → exchange → keychain", async () => {
    const api = fakeApi();
    const mgr = new AuthManager(api);

    const user = await mgr.signInWithGoogle();

    expect(user.id).toBe("u1");
    // Listener started before anything else.
    expect(ipc.googleOauthListen).toHaveBeenCalled();
    // The callback URL embeds the loopback port from the listener, URL-encoded.
    expect(api.socialSignInUrl).toHaveBeenCalledWith(
      "google",
      expect.stringContaining("127.0.0.1%3A5123%2Fcb"),
    );
    // …and carries the listener's CSRF state nonce (URL-encoded in the nested
    // redirect), so a foreign callback is rejected by the Rust listener.
    expect(api.socialSignInUrl).toHaveBeenCalledWith(
      "google",
      expect.stringContaining("state%3Dtest-nonce"),
    );
    // The authorize URL is opened in the system browser.
    expect(ipc.openExternal).toHaveBeenCalledWith("https://accounts.google.com/authorize?x=1");
    // The one-time code from the loopback is exchanged.
    expect(api.exchangeDesktopCode).toHaveBeenCalledWith("code-xyz");
    // The resulting session token is persisted to the OS keychain, under the
    // per-server namespace. Asserted exactly rather than by substring: the
    // prefix is versioned, and the ONLY thing that must never happen is
    // reverting to the bare `session:` keys that pre-Developer-ID (ad-hoc
    // signed) builds wrote — reading one of those makes macOS demand the user's
    // login keychain password. See the KEY_PREFIX comment in authManager.ts.
    const calls = vi.mocked(ipc.keychainSet).mock.calls;
    const [key, value] = calls[calls.length - 1];
    expect(value).toBe("sess-1");
    expect(key).toBe("session-v2:http://localhost:3010");
    expect(key.startsWith("session:")).toBe(false);
  });

  it("propagates a failure from the loopback wait (no token stored)", async () => {
    vi.mocked(ipc.googleOauthAwait).mockRejectedValueOnce(new Error("timed out"));
    vi.mocked(ipc.keychainSet).mockClear();
    const mgr = new AuthManager(fakeApi());

    await expect(mgr.signInWithGoogle()).rejects.toThrow("timed out");
    expect(ipc.keychainSet).not.toHaveBeenCalled();
  });
});
