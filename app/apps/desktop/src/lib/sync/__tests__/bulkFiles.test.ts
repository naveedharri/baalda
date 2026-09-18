// Tree binaries take the batch path above the threshold — and NOTHING else
// about them changes.
//
// `files` rows are minted on the UPLOAD side, one `POST /api/files` per binary,
// inside `ensureFileRow`. Above `BULK_THRESHOLD_DOCS` the pass pre-fills those
// ids with `POST /vaults/:id/files/batch` instead; every decision that follows
// (the dedupe/adoption repair, the authorship claim, the refusal memo, the
// bytes themselves) is the same code in the same order, which is what these
// tests pin: the resulting registry state must be indistinguishable from N
// single registrations.

import { describe, expect, it, vi } from "vitest";
import {
  AttachmentSync,
  type AttachmentSyncDeps,
  type LocalAttachment,
} from "../attachments";
import { BATCH_MAX_FILES, BULK_THRESHOLD_DOCS } from "../pool";

/** `n` tree binaries (NOT under `attachments/` — those keep the old heuristic
 *  and never get a `files` row at all). */
function binaries(n: number): LocalAttachment[] {
  return Array.from({ length: n }, (_, i) => ({
    relPath: `Docs/file${i}.pdf`,
    sha256: `sha-${i}`,
    size: 100 + i,
  }));
}

interface Recorded {
  singles: string[];
  batches: Array<Array<{ relPath: string; id: string; sha256: string; size: number; mime: string | null }>>;
  remembered: Array<[string, string, boolean]>;
  uploaded: Array<[string, string | null | undefined]>;
}

function harness(
  files: LocalAttachment[],
  opts: {
    batch?: boolean;
    answer?: (
      items: Array<{ relPath: string; id: string }>,
    ) => Array<{
      relPath: string;
      id: string | null;
      status: "created" | "adopted" | "conflict" | "error";
      code: string | null;
      error: string | null;
    }>;
    throwOnBatch?: unknown;
  } = {},
) {
  const rec: Recorded = { singles: [], batches: [], remembered: [], uploaded: [] };
  const deps: AttachmentSyncDeps = {
    listLocal: async () => files,
    readLocal: async () => new Uint8Array([1]),
    writeLocal: async () => {},
    listServer: async () => [],
    uploadServer: async (relPath, _bytes, _mime, docId) => {
      rec.uploaded.push([relPath, docId]);
    },
    downloadServer: async () => new Uint8Array(),
    localFileIds: async () => new Map(files.map((f) => [f.relPath, `local-${f.relPath}`])),
    knownFileId: () => null,
    registerFile: async ({ relPath, id }) => {
      rec.singles.push(relPath);
      return `srv-${id}`;
    },
    rememberFileId: (relPath, id, o) => rec.remembered.push([relPath, id, o?.authored === true]),
  };
  if (opts.batch !== false) {
    deps.registerFiles = vi.fn(async (items: Array<{
      relPath: string;
      id: string;
      sha256: string;
      size: number;
      mime: string | null;
    }>) => {
      rec.batches.push(items);
      if (opts.throwOnBatch) throw opts.throwOnBatch;
      return (
        opts.answer?.(items) ??
        items.map((i) => ({
          relPath: i.relPath,
          id: `srv-${i.id}`,
          status: "created" as const,
          code: null,
          error: null,
        }))
      );
    });
  }
  return { deps, rec };
}

describe("the threshold decides which route registers a binary", () => {
  it("24 binaries go one POST /api/files each", async () => {
    const { deps, rec } = harness(binaries(BULK_THRESHOLD_DOCS - 1));
    await new AttachmentSync(deps).reconcile();

    expect(rec.batches).toHaveLength(0);
    expect(rec.singles).toHaveLength(24);
    expect(rec.uploaded).toHaveLength(24);
  });

  it("25 go in ONE files/batch, and nothing asks per file afterwards", async () => {
    const { deps, rec } = harness(binaries(BULK_THRESHOLD_DOCS));
    await new AttachmentSync(deps).reconcile();

    expect(rec.batches).toHaveLength(1);
    expect(rec.batches[0]).toHaveLength(25);
    expect(rec.singles).toHaveLength(0);
    // Every item carries what the server resolves the row from.
    expect(rec.batches[0][0]).toEqual({
      relPath: "Docs/file0.pdf",
      id: "local-Docs/file0.pdf",
      sha256: "sha-0",
      size: 100,
      mime: "application/pdf",
    });
  });

  it("chunks by BATCH_MAX_FILES", async () => {
    const n = BATCH_MAX_FILES + 30;
    const { deps, rec } = harness(binaries(n));
    await new AttachmentSync(deps).reconcile();

    expect(rec.batches).toHaveLength(2);
    expect(rec.batches[0]).toHaveLength(BATCH_MAX_FILES);
    expect(rec.batches[1]).toHaveLength(30);
    expect(rec.batches.flat()).toHaveLength(n);
  });

  it("stays on the per-file path when the host offers no batch dep", async () => {
    const { deps, rec } = harness(binaries(40), { batch: false });
    await new AttachmentSync(deps).reconcile();
    expect(rec.singles).toHaveLength(40);
  });
});

describe("batch ≡ N singles", () => {
  it("leaves the same registry state and stamps the same bytes with doc_ids", async () => {
    const small = harness(binaries(24));
    await new AttachmentSync(small.deps).reconcile();
    const big = harness(binaries(24));
    // Force the batch path for the SAME input by dropping the threshold test:
    // 25 files, minus one, is the only difference between the two runs — so
    // compare the 24 shared paths' outcomes from a 25-file batch run.
    const batchRun = harness(binaries(25));
    await new AttachmentSync(batchRun.deps).reconcile();

    const singleState = small.rec.remembered.map(([p, id, authored]) => [p, id, authored]);
    const batchState = batchRun.rec.remembered
      .filter(([p]) => small.rec.remembered.some(([q]) => q === p))
      .map(([p, id, authored]) => [p, id, authored]);
    expect(batchState).toEqual(singleState);
    // `authored` is set on both: this is the upload side, so the bytes are ours,
    // and that flag is a binary's only authorship signal.
    expect(batchState.every(([, , authored]) => authored === true)).toBe(true);
    // Both runs stamp the uploaded bytes with the row's doc_id.
    expect(batchRun.rec.uploaded[0][1]).toBe("srv-local-Docs/file0.pdf");
    expect(small.rec.uploaded[0][1]).toBe("srv-local-Docs/file0.pdf");
    expect(big.rec.batches).toHaveLength(0);
  });
});

describe("per-item outcomes", () => {
  it("one refused item does not cost the others their row", async () => {
    const { deps, rec } = harness(binaries(25), {
      answer: (items) =>
        items.map((i, n) =>
          n === 3
            ? {
                relPath: i.relPath,
                id: null,
                status: "error" as const,
                code: "no_write_access",
                error: "denied",
              }
            : {
                relPath: i.relPath,
                id: `srv-${i.id}`,
                status: "created" as const,
                code: null,
                error: null,
              },
        ),
    });
    const sync = new AttachmentSync(deps);
    await sync.reconcile();

    expect(rec.remembered).toHaveLength(24);
    expect(rec.remembered.some(([p]) => p === "Docs/file3.pdf")).toBe(false);
    // …and the refused file's BYTES still go up, just without a doc_id.
    expect(rec.uploaded).toHaveLength(25);
    expect(rec.uploaded.find(([p]) => p === "Docs/file3.pdf")?.[1]).toBeUndefined();

    // An answered refusal is a decision: the next pass does not ask again.
    rec.batches.length = 0;
    rec.singles.length = 0;
    await sync.reconcile();
    expect(rec.batches.flat().some((i) => i.relPath === "Docs/file3.pdf")).toBe(false);
    expect(rec.singles).not.toContain("Docs/file3.pdf");
  });

  it("a `path_folder_mismatch` falls straight through to the per-file ask", async () => {
    // Not a decision, so it is not remembered as a refusal: the file simply has
    // no id yet when `ensureFileRow` reaches it, and that method does what it
    // has always done — asks for this one file. (The registry pull that fixes
    // the parent is already queued either way.)
    const { deps, rec } = harness(binaries(25), {
      answer: (items) =>
        items.map((i, n) =>
          n === 0
            ? {
                relPath: i.relPath,
                id: null,
                status: "error" as const,
                code: "path_folder_mismatch",
                error: null,
              }
            : {
                relPath: i.relPath,
                id: `srv-${i.id}`,
                status: "created" as const,
                code: null,
                error: null,
              },
        ),
    });
    await new AttachmentSync(deps).reconcile();

    expect(rec.singles).toEqual(["Docs/file0.pdf"]);
    expect(rec.remembered).toHaveLength(25); // 24 from the batch + this one
  });

  it("adopts a row the server answers with instead of minting a second", async () => {
    const { deps, rec } = harness(binaries(25), {
      answer: (items) =>
        items.map((i) => ({
          relPath: i.relPath,
          id: "adopted-id",
          status: "adopted" as const,
          code: null,
          error: null,
        })),
    });
    await new AttachmentSync(deps).reconcile();
    expect(rec.remembered.every(([, id]) => id === "adopted-id")).toBe(true);
  });
});

describe("request-level failures", () => {
  it("a 402 stops the pre-registration and refuses nothing", async () => {
    const { deps, rec } = harness(binaries(BATCH_MAX_FILES + 30), {
      throwOnBatch: Object.assign(new Error("full"), {
        status: 402,
        code: "vault_limit_reached",
      }),
    });
    await new AttachmentSync(deps).reconcile();

    // One request, then it stops — it does not grind through the chunks.
    expect(rec.batches).toHaveLength(1);
    // Nothing is written off as refused: every file falls through to the
    // per-file ask it would have taken before this optimisation existed.
    expect(rec.singles).toHaveLength(BATCH_MAX_FILES + 30);
    expect(rec.remembered).toHaveLength(BATCH_MAX_FILES + 30);
  });

  it("a 5xx is a hiccup: the per-file path still gets every row", async () => {
    const { deps, rec } = harness(binaries(25), {
      throwOnBatch: Object.assign(new Error("boom"), { status: 503 }),
    });
    await new AttachmentSync(deps).reconcile();

    expect(rec.singles).toHaveLength(25);
    expect(rec.remembered).toHaveLength(25);
    expect(rec.uploaded).toHaveLength(25);
  });

  it("a 403 is a decision about those files: asked once, never again", async () => {
    const { deps, rec } = harness(binaries(25), {
      throwOnBatch: Object.assign(new Error("nope"), { status: 403 }),
    });
    const sync = new AttachmentSync(deps);
    await sync.reconcile();
    // No row, no second ask — and the bytes still go up, without a doc_id,
    // exactly as one refused single registration behaves.
    expect(rec.singles).toHaveLength(0);
    expect(rec.remembered).toHaveLength(0);
    expect(rec.uploaded).toHaveLength(25);

    rec.batches.length = 0;
    await sync.reconcile();
    expect(rec.batches).toHaveLength(0);
    expect(rec.singles).toHaveLength(0);
  });
});
