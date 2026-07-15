// Auth orchestration (spec 04 §7). Ties the typed HTTP client (`api.ts`) to the
// OS keychain (`ipc.ts`) and the persisted server URL. Owns the single shared
// ApiClient instance so the sync layer reuses the same base URL + bearer token.
//
// Session tokens are captured from Better Auth's `set-auth-token` header and
// stored ONLY in the OS keychain — never localStorage/plaintext.

import { ApiClient, DEFAULT_SERVER_URL, type AuthUser, type SessionInfo } from "../api";
import * as ipc from "../ipc";

const KEY_PREFIX = "session:";

export class AuthManager {
  /** The single shared client; the sync layer imports this too. */
  readonly api: ApiClient;
  private serverUrl: string;

  constructor(api?: ApiClient) {
    this.api = api ?? new ApiClient();
    this.serverUrl = this.api.getBaseUrl();
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  /** Keychain namespace is per-server so multiple servers don't collide. */
  private keychainKey(url = this.serverUrl): string {
    return KEY_PREFIX + url;
  }

  /**
   * Load the configured server URL + restore a persisted session on launch.
   * Returns the live session, or null if signed out / token invalid / offline.
   */
  async init(): Promise<SessionInfo | null> {
    try {
      const url = await ipc.getServerUrl();
      if (url) {
        this.serverUrl = stripSlash(url);
        this.api.setBaseUrl(this.serverUrl);
      }
    } catch {
      /* config unavailable — fall back to the default URL */
    }

    let token: string | null = null;
    try {
      token = await ipc.keychainGet(this.keychainKey());
    } catch {
      token = null;
    }
    if (!token) return null;

    this.api.setToken(token);
    try {
      const session = await this.api.getSession();
      if (!session) {
        // Token invalid/revoked — drop it.
        await this.clearToken();
        return null;
      }
      return session;
    } catch {
      // Network error (server down): keep the token for a later retry, but we
      // are effectively signed out for now (the app stays usable offline).
      return null;
    }
  }

  /** Change + persist the server URL. Restores that server's token if present. */
  async setServerUrl(url: string): Promise<SessionInfo | null> {
    const clean = stripSlash(url) || DEFAULT_SERVER_URL;
    this.serverUrl = clean;
    this.api.setBaseUrl(clean);
    await ipc.setServerUrl(clean);
    this.api.setToken(null);
    return this.init();
  }

  async signUp(input: { email: string; password: string; name: string }): Promise<AuthUser> {
    const { user, token } = await this.api.signUp(input);
    if (token) await ipc.keychainSet(this.keychainKey(), token);
    return user;
  }

  async signIn(input: { email: string; password: string }): Promise<AuthUser> {
    const { user, token } = await this.api.signIn(input);
    if (token) await ipc.keychainSet(this.keychainKey(), token);
    return user;
  }

  /**
   * Google sign-in via the system browser + a loopback handoff (spec 04 §7).
   * The Rust core owns the 127.0.0.1 listener; we bridge it to the server's
   * social flow and the one-time-code exchange, then persist the token exactly
   * like an email/password sign-in.
   */
  async signInWithGoogle(): Promise<AuthUser> {
    const port = await ipc.googleOauthListen();
    const redirect = `http://127.0.0.1:${port}/cb`;
    const callbackURL = `${this.serverUrl}/api/desktop-auth/finish?redirect=${encodeURIComponent(
      redirect,
    )}`;
    const authorizeUrl = await this.api.socialSignInUrl("google", callbackURL);
    await ipc.openExternal(authorizeUrl);
    const code = await ipc.googleOauthAwait();
    const { user, token } = await this.api.exchangeDesktopCode(code);
    if (token) await ipc.keychainSet(this.keychainKey(), token);
    return user;
  }

  async signOut(): Promise<void> {
    try {
      await this.api.signOut();
    } finally {
      await this.clearToken();
    }
  }

  async currentSession(): Promise<SessionInfo | null> {
    return this.api.getSession();
  }

  private async clearToken(): Promise<void> {
    this.api.setToken(null);
    try {
      await ipc.keychainDelete(this.keychainKey());
    } catch {
      /* best-effort */
    }
  }
}

function stripSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Process-wide singleton; the shared ApiClient lives on `authManager.api`. */
export const authManager = new AuthManager();
export const api = authManager.api;
