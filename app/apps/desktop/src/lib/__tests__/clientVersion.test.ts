import { describe, expect, it } from "vitest";
import { ApiClient, isClientOutdated, onClientOutdated } from "../api";
import { CLIENT_VERSION, CLIENT_VERSION_PARAM } from "../clientVersion";
import conf from "../../../src-tauri/tauri.conf.json";

/**
 * Issue #251: the routes that hand out the ability to push note content carry
 * this build's version, so a server can refuse a build too old to push safely —
 * and a refusal reaches whoever shows "Update required".
 */

function recordingFetch(status = 200, json: unknown = { token: "t", docId: "d", vaultId: "v" }) {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, urls, headers };
}

describe("client version reporting", () => {
  it("is the build's tauri.conf.json version", () => {
    expect(CLIENT_VERSION).toBe(conf.version);
  });

  it("rides the sync-token, vault-token and batch-push calls as a query parameter", async () => {
    const f = recordingFetch(200, { token: "t", docId: "d", vaultId: "v", results: [] });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: f.impl });
    await api.syncToken("d");
    await api.vaultSyncToken("v");
    await api.batchPushDocs("v", []);
    for (const url of f.urls) {
      expect(new URL(url).searchParams.get(CLIENT_VERSION_PARAM)).toBe(CLIENT_VERSION);
    }
    // Never as a header: a server that predates the gate would fail the CORS
    // preflight for an unlisted header and refuse every request.
    for (const h of f.headers) {
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("x-baalda-version");
    }
  });

  it("surfaces 426 client_outdated to listeners and as a typed check", async () => {
    const f = recordingFetch(426, { error: "too old", code: "client_outdated", minVersion: "9.9.9" });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: f.impl });
    const seen: Array<string | null> = [];
    const off = onClientOutdated(({ minVersion }) => seen.push(minVersion));
    let caught: unknown;
    try {
      await api.syncToken("d");
    } catch (e) {
      caught = e;
    } finally {
      off();
    }
    expect(isClientOutdated(caught)).toBe(true);
    expect(seen).toEqual(["9.9.9"]);
  });

  it("does not treat another refusal as outdated", async () => {
    const f = recordingFetch(403, { error: "no access" });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: f.impl });
    const err = await api.syncToken("d").catch((e) => e);
    expect(isClientOutdated(err)).toBe(false);
  });
});
