// Trash endpoints: URL, method and envelope handling the desktop depends on.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../api";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function client(script: (call: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const r = script(call);
    const status = r.status ?? 200;
    const text = r.json !== undefined ? JSON.stringify(r.json) : "";
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    api: new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl }),
    calls,
  };
}

const ITEM = {
  docId: "d1",
  relPath: "Notes/plan.md",
  deletedAt: "2026-09-20T10:00:00.000Z",
  deletedBy: { id: "u2", name: "Ada" },
  purgeAfter: "2026-10-20T10:00:00.000Z",
  sizeBytes: 42,
  hasUnsyncedContributions: true,
};

describe("ApiClient — trash", () => {
  it("lists a vault's trash with an encoded vault id", async () => {
    const { api, calls } = client(() => ({ json: { items: [ITEM], truncated: false } }));
    const out = await api.listTrash("vault 1");
    expect(out).toEqual({ items: [ITEM], truncated: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://localhost:3010/api/vaults/vault%201/trash");
  });

  it("normalises a missing envelope to an empty, untruncated list", async () => {
    const { api } = client(() => ({ json: {} }));
    expect(await api.listTrash("v")).toEqual({ items: [], truncated: false });
  });

  it("restores a note by POST to its encoded doc id", async () => {
    const { api, calls } = client(() => ({
      json: { docId: "d/1", relPath: "Notes/plan (2).md", renamed: true },
    }));
    const out = await api.restoreNote("d/1");
    expect(out).toEqual({ docId: "d/1", relPath: "Notes/plan (2).md", renamed: true });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://localhost:3010/api/notes/d%2F1/restore");
  });

  it("surfaces 404 and 403 as ApiError with the status", async () => {
    for (const status of [404, 403]) {
      const { api } = client(() => ({ status, json: { error: "nope" } }));
      const err = await api.restoreNote("d1").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
    }
  });
});

describe("ApiClient — trash content", () => {
  it("GETs a deleted note's text by its encoded doc id", async () => {
    const body = { docId: "d/1", relPath: "Notes/plan.md", text: "# Plan", deletedAt: ITEM.deletedAt };
    const { api, calls } = client(() => ({ json: body }));
    expect(await api.trashContent("d/1")).toEqual(body);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://localhost:3010/api/notes/d%2F1/trash-content");
  });

  it("surfaces 404 not_in_trash, 410 purged and 403 as ApiError", async () => {
    for (const status of [404, 410, 403]) {
      const { api } = client(() => ({ status, json: { error: "x" } }));
      const err = await api.trashContent("d1").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
    }
  });
});
