import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, HEALTH_TIMEOUT_MS } from "../api";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a fake `fetch` that records calls and returns scripted responses. */
function fakeFetch(
  script: (call: Call) => { status?: number; json?: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: Call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const r = script(call);
    const status = r.status ?? 200;
    const text = r.json !== undefined ? JSON.stringify(r.json) : "";
    const respHeaders = new Map(Object.entries(r.headers ?? {}));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => respHeaders.get(k) ?? null },
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("ApiClient against a mocked fetch", () => {
  it("captures the set-auth-token header on sign-in and sends it as Bearer", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/api/auth/sign-in/email")) {
        return {
          json: { user: { id: "u1", email: "a@b.co", name: "Ada" } },
          headers: { "set-auth-token": "sess-xyz" },
        };
      }
      if (call.url.endsWith("/api/auth/get-session")) {
        return { json: { user: { id: "u1", email: "a@b.co", name: "Ada" }, session: { activeOrganizationId: "org1" } } };
      }
      return { json: {} };
    });

    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    const { token } = await api.signIn({ email: "a@b.co", password: "pw" });
    expect(token).toBe("sess-xyz");
    expect(api.getToken()).toBe("sess-xyz");

    const session = await api.getSession();
    expect(session?.user.id).toBe("u1");
    expect(session?.activeOrganizationId).toBe("org1");

    // The get-session call must carry the bearer token.
    const sessionCall = calls.find((c) => c.url.endsWith("/api/auth/get-session"))!;
    expect(sessionCall.headers.Authorization).toBe("Bearer sess-xyz");
  });

  it("throws ApiError with the HTTP status on failure (403 sync-token)", async () => {
    const { impl } = fakeFetch(() => ({ status: 403, json: { error: "No access" } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    await expect(api.syncToken("doc1")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
    });
  });

  it("getSession returns null on 401 instead of throwing", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, json: { error: "unauthenticated" } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "stale", fetchImpl: impl });
    expect(await api.getSession()).toBeNull();
  });

  it("getSession returns null when there is no token (no fetch)", async () => {
    const spy = vi.fn();
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: spy as unknown as typeof fetch });
    expect(await api.getSession()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("mints a sync token and returns readOnly/permission", async () => {
    const { impl, calls } = fakeFetch((call) => {
      expect(call.url).toContain("/api/sync-token");
      return { json: { token: "jwt", docId: "d1", vaultId: "v1", readOnly: true, permission: "view" } };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    const res = await api.syncToken("d1");
    expect(res).toEqual({ token: "jwt", docId: "d1", vaultId: "v1", readOnly: true, permission: "view" });
    expect(calls[0].body).toEqual({ docId: "d1" });
  });

  it("normalizes list responses (vaults/notes/shares)", async () => {
    const { impl } = fakeFetch((call) => {
      if (call.url.includes("/api/vaults")) return { json: { vaults: [{ id: "v1", name: "V" }] } };
      if (call.url.includes("/api/notes")) return { json: { notes: [{ id: "n1", rel_path: "a.md", title: "A" }] } };
      return { json: {} };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    expect(await api.listVaults()).toHaveLength(1);
    const notes = await api.listNotes("v1");
    expect(notes[0].id).toBe("n1");
  });

  it("base URL trailing slashes are stripped so paths don't double up", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { vaults: [] } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010/", token: "t", fetchImpl: impl });
    await api.listVaults();
    expect(calls[0].url).toBe("http://localhost:3010/api/vaults");
  });

  it("surfaces ApiError even when the error body is empty", async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    await expect(api.listVaults()).rejects.toBeInstanceOf(ApiError);
  });

  it("requests a Google authorization URL with the loopback callback", async () => {
    const { impl, calls } = fakeFetch((call) => {
      expect(call.url).toContain("/api/auth/sign-in/social");
      return { json: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", redirect: true } };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    const cb = "http://localhost:3010/api/desktop-auth/finish?redirect=http%3A%2F%2F127.0.0.1%3A5000%2Fcb";
    const url = await api.socialSignInUrl("google", cb);
    expect(url).toContain("accounts.google.com");
    expect(calls[0].body).toEqual({ provider: "google", callbackURL: cb });
  });

  it("throws when the social sign-in response has no url", async () => {
    const { impl } = fakeFetch(() => ({ json: { redirect: true } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    await expect(api.socialSignInUrl("google", "http://127.0.0.1:1/cb")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("exchanges a desktop code for the session token and stores it", async () => {
    const { impl, calls } = fakeFetch((call) => {
      expect(call.url).toContain("/api/desktop-auth/exchange");
      return { json: { token: "sess-abc", user: { id: "u2", email: "g@b.co", name: "" } } };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    const { user, token } = await api.exchangeDesktopCode("one-time-code");
    expect(token).toBe("sess-abc");
    expect(user.id).toBe("u2");
    expect(api.getToken()).toBe("sess-abc");
    expect(calls[0].body).toEqual({ code: "one-time-code" });
  });

  it("getAuthMethods falls back to email-only when the endpoint 404s", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, json: { error: "not found" } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    expect(await api.getAuthMethods()).toEqual({
      emailPassword: true,
      google: false,
      passwordReset: false,
      invitationEmail: false,
    });
  });

  it("getAuthMethods reads an older server's two-field answer as no new capabilities", async () => {
    // The whole point of failing closed per FIELD: a server that predates
    // password reset must not be offered as one that can send the email.
    const { impl } = fakeFetch(() => ({ json: { emailPassword: true, google: true } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    expect(await api.getAuthMethods()).toEqual({
      emailPassword: true,
      google: true,
      passwordReset: false,
      invitationEmail: false,
    });
  });

  it("getAuthMethods passes through the full capability set", async () => {
    const { impl } = fakeFetch(() => ({
      json: {
        emailPassword: true,
        google: false,
        passwordReset: true,
        invitationEmail: true,
      },
    }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    expect(await api.getAuthMethods()).toEqual({
      emailPassword: true,
      google: false,
      passwordReset: true,
      invitationEmail: true,
    });
  });

  it("requestPasswordReset posts only the email — never a redirectTo", async () => {
    // A client-supplied redirect target on a reset flow is an open redirect
    // wearing a reset token; the server builds its own link.
    const { impl, calls } = fakeFetch(() => ({ json: { status: true, message: "ok" } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    await api.requestPasswordReset("ada@team.com");
    expect(calls[0].url).toContain("/api/password-reset/request");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ email: "ada@team.com" });
  });

  it("cancelInvitation posts the id to Better Auth's cancel route", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { invitation: { id: "inv_1" } } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    await api.cancelInvitation("inv_1");
    expect(calls[0].url).toContain("/api/auth/organization/cancel-invitation");
    expect(calls[0].body).toEqual({ invitationId: "inv_1" });
  });

  it("previewInvitation reads the public preview and surfaces a 404 as ApiError", async () => {
    const preview = {
      id: "inv_1",
      email: "ada@team.com",
      role: "member",
      status: "pending",
      organizationId: "org_1",
      organizationName: "Team Vault",
      inviterName: "Grace",
    };
    const ok = fakeFetch(() => ({ json: preview }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: ok.impl });
    expect(await api.previewInvitation("inv_1")).toEqual(preview);
    expect(ok.calls[0].url).toBe("http://localhost:3010/api/invitations/inv_1/preview");

    const missing = fakeFetch(() => ({ status: 404, json: { error: "not found" } }));
    const api2 = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: missing.impl });
    await expect(api2.previewInvitation("inv_x")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });

  /**
   * The invite inbox's whole bug: Better Auth's `list-user-invitations` answers
   * 403 for any user whose email isn't verified — every password sign-up — so
   * our own route has to be tried FIRST, and the legacy route only when the
   * server is too old to have ours.
   */
  it("listUserInvitations prefers /api/invitations/mine", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.includes("/api/invitations/mine")) {
        return { json: [{ id: "inv_1", email: "a@b.co", role: "member", status: "pending", organizationId: "org_1", organizationName: "Team" }] };
      }
      throw new Error(`unexpected call to ${call.url}`);
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    const invs = await api.listUserInvitations();
    expect(invs).toHaveLength(1);
    expect(invs[0].organizationName).toBe("Team");
    expect(calls).toHaveLength(1);
  });

  it("listUserInvitations falls back to the Better Auth route on a 404", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.includes("/api/invitations/mine")) {
        return { status: 404, json: { error: "not found" } };
      }
      return { json: { invitations: [{ id: "inv_2", email: "a@b.co", role: "member", status: "pending", organizationId: "org_1" }] } };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    const invs = await api.listUserInvitations();
    expect(invs.map((i) => i.id)).toEqual(["inv_2"]);
    expect(calls[1].url).toContain("/api/auth/organization/list-user-invitations");
  });

  it("listUserInvitations does NOT fall back on a non-404 failure", async () => {
    // A 403 from our own route is a real failure. Retrying the legacy route
    // would answer 403 for the same user and hide the problem as "no invites".
    const { impl, calls } = fakeFetch(() => ({ status: 403, json: { error: "nope" } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    await expect(api.listUserInvitations()).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it("public links: create POSTs, get maps {link:null}, revoke DELETEs", async () => {
    const link = { id: "pl1", docId: "doc1", url: "https://s/p/tok", createdAt: "now" };
    const { impl, calls } = fakeFetch((call) => {
      if (call.method === "POST") return { status: 201, json: { ...link, existing: false } };
      if (call.method === "GET") return { json: { link: null } };
      return { json: { revoked: true } };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });

    const created = await api.createPublicLink("doc1");
    expect(created.url).toBe("https://s/p/tok");
    expect(calls[0].url).toContain("/api/notes/doc1/public-link");
    expect(calls[0].headers.Authorization).toBe("Bearer t");

    expect(await api.getPublicLink("doc1")).toBeNull();
    await api.revokePublicLink("doc1");
    expect(calls[2].method).toBe("DELETE");
    expect(calls[2].url).toContain("/api/notes/doc1/public-link");
  });

  it("getPublicLink returns the link when one exists and rethrows real errors", async () => {
    const link = { id: "pl1", docId: "doc1", url: "https://s/p/tok", createdAt: "now" };
    const ok = fakeFetch(() => ({ json: { link } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: ok.impl });
    expect((await api.getPublicLink("doc1"))?.url).toBe("https://s/p/tok");

    const denied = fakeFetch(() => ({ status: 403, json: { error: "Not allowed" } }));
    const api2 = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: denied.impl });
    await expect(api2.getPublicLink("doc1")).rejects.toMatchObject({ name: "ApiError", status: 403 });
  });

  it("updateUser posts name/image to Better Auth update-user", async () => {
    const { impl, calls } = fakeFetch((call) => {
      expect(call.url).toContain("/api/auth/update-user");
      return { json: { status: true } };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    await api.updateUser({ name: "Ada Lovelace", image: "https://x/y.jpg" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ name: "Ada Lovelace", image: "https://x/y.jpg" });
    expect(calls[0].headers.Authorization).toBe("Bearer t");
  });
});

/**
 * `health()` — the one probe in api.ts that must NOT fail closed (#91).
 *
 * The onboarding step validates a server URL before adopting it, and adopting
 * one is a de-facto sign-out (the session lives under a per-server keychain
 * key). So a wrong address has to come back as a wrong address: these cases pin
 * that a 200 from something-that-isn't-us is a failure, and that "unreachable"
 * stays distinguishable from "reachable but not Baalda" — the two send the user
 * to completely different places.
 */
describe("ApiClient.health", () => {
  /** A fetch returning one scripted raw response body. */
  function rawFetch(status: number, body: string, capture?: { url?: string; auth?: string }) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (capture) {
        capture.url = String(input);
        capture.auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("resolves for a 2xx JSON body with ok:true, probing the given base", async () => {
    const seen: { url?: string; auth?: string } = {};
    const api = new ApiClient({
      baseUrl: "http://localhost:3010",
      token: "t",
      fetchImpl: rawFetch(200, JSON.stringify({ ok: true }), seen),
    });
    await expect(api.health("https://notes.example.com/baalda/")).resolves.toBeUndefined();
    // The candidate URL, not the client's current base — and no session token,
    // because the point is to test the address.
    expect(seen.url).toBe("https://notes.example.com/baalda/health");
    expect(seen.auth).toBeUndefined();
    // Probing must not repoint the client.
    expect(api.getBaseUrl()).toBe("http://localhost:3010");
  });

  it("falls back to the client's own base when none is given", async () => {
    const seen: { url?: string } = {};
    const api = new ApiClient({
      baseUrl: "http://localhost:3010",
      fetchImpl: rawFetch(200, JSON.stringify({ ok: true }), seen),
    });
    await api.health();
    expect(seen.url).toBe("http://localhost:3010/health");
  });

  it("rejects a 200 that isn't a Baalda health body", async () => {
    for (const body of ["<!doctype html><h1>nginx</h1>", "", JSON.stringify({ ok: false }), '"ok"']) {
      const api = new ApiClient({ fetchImpl: rawFetch(200, body) });
      await expect(api.health("https://notes.example.com")).rejects.toMatchObject({
        name: "ServerCheckError",
        kind: "not-baalda",
      });
    }
  });

  it("calls a 404 the wrong app and a 500 an unreachable server", async () => {
    const notUs = new ApiClient({ fetchImpl: rawFetch(404, "Not Found") });
    await expect(notUs.health("https://notes.example.com")).rejects.toMatchObject({
      kind: "not-baalda",
    });

    const down = new ApiClient({ fetchImpl: rawFetch(502, "Bad Gateway") });
    await expect(down.health("https://notes.example.com")).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("reports a network failure or abort as unreachable, not as a crash", async () => {
    const boom = (async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;
    const api = new ApiClient({ fetchImpl: boom });
    await expect(api.health("https://notes.example.com")).rejects.toMatchObject({
      name: "ServerCheckError",
      kind: "unreachable",
    });

    // What the AbortController's timeout looks like from here.
    const aborted = (async () => {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    }) as unknown as typeof fetch;
    const api2 = new ApiClient({ fetchImpl: aborted });
    await expect(api2.health("https://notes.example.com")).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("aborts the request when the server never answers", async () => {
    // Never resolves on its own; only the signal ends it. Proves the Connect
    // button can't spin forever against a host that accepts and then stalls.
    const stalling = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const api = new ApiClient({ fetchImpl: stalling });
      const pending = api.health("https://notes.example.com");
      const assertion = expect(pending).rejects.toMatchObject({ kind: "unreachable" });
      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
