// The versioning half of the HTTP boundary: URLs, methods, and the shapes the
// desktop actually depends on. These are contract tests against the server's
// documented responses — every expectation here mirrors one in the server's
// `tests/versions.test.ts` / `tests/checkpoints.test.ts`.

import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, noteLastEdited, type RegisteredNote } from "../api";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(script: (call: Call) => { status?: number; json?: unknown; text?: string }) {
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
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function client(script: Parameters<typeof fakeFetch>[0]) {
  const { impl, calls } = fakeFetch(script);
  return {
    api: new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl }),
    calls,
  };
}

const VERSION = {
  id: 7,
  createdAt: "2026-08-11T10:00:00.000Z",
  cause: "idle" as const,
  authorId: "u1",
  authorName: "Ada",
  sha256: "abc",
  size: 12,
};

describe("ApiClient — per-note versions", () => {
  it("lists versions newest-first and unwraps the envelope", async () => {
    const { api, calls } = client(() => ({ json: { versions: [VERSION] } }));
    const versions = await api.listNoteVersions("doc 1");
    expect(versions).toEqual([VERSION]);
    // The docId is path-encoded, not interpolated raw.
    expect(calls[0].url).toBe("http://localhost:3010/api/notes/doc%201/versions");
    expect(calls[0].method).toBe("GET");
  });

  it("returns [] when the server omits the versions array", async () => {
    const { api } = client(() => ({ json: {} }));
    expect(await api.listNoteVersions("d1")).toEqual([]);
  });

  it("fetches one version WITH content (the preview payload)", async () => {
    const { api, calls } = client(() => ({ json: { ...VERSION, content: "# hi" } }));
    const detail = await api.getNoteVersion("d1", 7);
    expect(detail.content).toBe("# hi");
    expect(detail.sha256).toBe("abc");
    expect(calls[0].url).toBe("http://localhost:3010/api/notes/d1/versions/7");
  });

  it("reverts and surfaces a null preRevertVersionId (live text already stored)", async () => {
    const { api, calls } = client(() => ({ json: { ok: true, preRevertVersionId: null } }));
    expect(await api.revertNoteToVersion("d1", 7)).toEqual({
      ok: true,
      preRevertVersionId: null,
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://localhost:3010/api/notes/d1/versions/7/revert");
  });

  it("surfaces the 403 a locked share produces on revert", async () => {
    const { api } = client(() => ({ status: 403, json: { error: "Read-only" } }));
    await expect(api.revertNoteToVersion("d1", 7)).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
    });
  });
});

const CHECKPOINT = {
  id: "cp-1",
  kind: "manual" as const,
  label: "Before the rewrite",
  createdAt: "2026-08-11T10:00:00.000Z",
  createdBy: "u1",
  createdByName: "Ada",
  noteCount: 3,
};

describe("ApiClient — vault checkpoints", () => {
  it("lists checkpoints for a note collection", async () => {
    const { api, calls } = client(() => ({ json: { checkpoints: [CHECKPOINT] } }));
    expect(await api.listCheckpoints("v1")).toEqual([CHECKPOINT]);
    expect(calls[0].url).toBe("http://localhost:3010/api/vaults/v1/checkpoints");
  });

  it("creates a checkpoint and reads the summary UNWRAPPED from the 201", async () => {
    const { api, calls } = client(() => ({ status: 201, json: CHECKPOINT }));
    expect(await api.createCheckpoint("v1", "  Before the rewrite  ".trim())).toEqual(CHECKPOINT);
    expect(calls[0].body).toEqual({ label: "Before the rewrite" });
  });

  it("omits the label entirely when none is given", async () => {
    const { api, calls } = client(() => ({ status: 201, json: { ...CHECKPOINT, label: null } }));
    await api.createCheckpoint("v1");
    expect(calls[0].body).toEqual({});
  });

  it("maps the 409 taken while the vault lock is held", async () => {
    const { api } = client(() => ({ status: 409, json: { error: "Vault is busy" } }));
    await expect(api.createCheckpoint("v1")).rejects.toBeInstanceOf(ApiError);
  });

  it("deletes a checkpoint via a 204 with an EMPTY body (nothing to parse)", async () => {
    const { api, calls } = client(() => ({ status: 204, text: "" }));
    await expect(api.deleteCheckpoint("v1", "cp 1")).resolves.toBeUndefined();
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("http://localhost:3010/api/vaults/v1/checkpoints/cp%201");
  });

  it("returns the whole-vault revert tally", async () => {
    const result = {
      ok: true as const,
      docsChanged: 2,
      docsRestored: 1,
      docsDeleted: 1,
      foldersCreated: 0,
      preRevertCheckpointId: "cp-0",
    };
    const { api, calls } = client(() => ({ json: result }));
    expect(await api.revertToCheckpoint("v1", "cp-1")).toEqual(result);
    expect(calls[0].url).toBe("http://localhost:3010/api/vaults/v1/checkpoints/cp-1/revert");
    expect(calls[0].method).toBe("POST");
  });
});

describe("noteLastEdited — dual-casing normalization", () => {
  const base: RegisteredNote = { id: "n1", title: "A" };

  it("reads the server's snake_case row", () => {
    expect(
      noteLastEdited({
        ...base,
        last_edited_by: "u1",
        last_edited_by_name: "Ada",
        last_edited_at: "2026-08-11T10:00:00.000Z",
      }),
    ).toEqual({ userId: "u1", name: "Ada", at: "2026-08-11T10:00:00.000Z" });
  });

  it("reads camelCase too, and prefers it when both are present", () => {
    expect(
      noteLastEdited({
        ...base,
        lastEditedBy: "u2",
        last_edited_by: "u1",
        lastEditedAt: "2026-08-11T11:00:00.000Z",
        last_edited_at: "2026-08-11T10:00:00.000Z",
      })?.userId,
    ).toBe("u2");
  });

  it("is null for a note that has never been edited (no timestamp)", () => {
    // The absence of `last_edited_at` is what the whole UI branches on — a note
    // with an author but no time is not a stamp, it's a half-written row.
    expect(noteLastEdited(base)).toBeNull();
    expect(noteLastEdited({ ...base, last_edited_by: "u1" })).toBeNull();
  });

  it("keeps a stamp whose author has been deleted (name/id null, time real)", () => {
    expect(noteLastEdited({ ...base, last_edited_at: "2026-08-11T10:00:00.000Z" })).toEqual({
      userId: null,
      name: null,
      at: "2026-08-11T10:00:00.000Z",
    });
  });
});
