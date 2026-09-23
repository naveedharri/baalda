// Tree binaries: the half of the blob mirror that lives in the vault tree
// rather than in the hidden `attachments/` store (PR3 Stage A).
//
// Three things are load-bearing here and each has a test that fails loudly if
// it moves: a tree binary is REGISTERED as a `files` row before its bytes go
// (that id is what the ACL resolves), it materializes through the TREE write
// guard and claims its own watcher echo, and its extracted text reaches the
// server exactly once per blob — as search fuel, never as content.
//
// The fourth is a non-behaviour: renaming a tree binary does NOT propagate,
// because identity is still sha256. Pinned below so Stage B's path-keyed diff
// has to delete the assertion on purpose.

import { describe, expect, it, vi } from "vitest";
import {
  AttachmentSync,
  isSafeTreeBinaryRelPath,
  isUnderAttachments,
  routesToAttachmentSync,
  type AttachmentSyncDeps,
} from "../attachments";

/** An error shaped like the api client's `BlobTransportError`. */
function serverError(status: number, code?: string) {
  return Object.assign(new Error(code ?? `HTTP ${status}`), { status, code });
}

interface Log {
  registered: Array<{ relPath: string; id: string }>;
  intents: Array<{ relPath: string; docId: string | null | undefined }>;
  legacyUploads: Array<{ relPath: string; docId: string | null | undefined }>;
  treeWrites: string[];
  attachmentWrites: string[];
  materialized: string[];
  texts: Array<{ blobId: string; docId: string | null | undefined; chars: number }>;
  remembered: Array<{ relPath: string; id: string; authored: boolean }>;
  /** Paths the mirror said the SERVER HOLDS THE BYTES for — the claim that
   *  licenses a revocation to remove the file (`registry.confirmFileBytes`). */
  confirmed: string[];
}

/**
 * A vault whose binaries live wherever the test puts them, wired to a server
 * that speaks the intent flow. Timers are hand-driven: `fire()` runs whatever
 * the sync armed, which is how the text pass is inspected without waiting.
 */
function makeVault(
  files: Array<{ relPath: string; sha256?: string }>,
  extra: Partial<AttachmentSyncDeps> = {},
) {
  const log: Log = {
    registered: [],
    intents: [],
    legacyUploads: [],
    treeWrites: [],
    attachmentWrites: [],
    materialized: [],
    texts: [],
    remembered: [],
    confirmed: [],
  };
  const timers: Array<() => void> = [];
  const setTimeoutImpl = ((cb: () => void) => {
    timers.push(cb);
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const deps: AttachmentSyncDeps = {
    listLocal: async () =>
      files.map((f) => ({ relPath: f.relPath, sha256: f.sha256 ?? `sha-${f.relPath}`, size: 3 })),
    readLocal: async () => new Uint8Array([1, 2, 3]),
    writeLocal: async (relPath) => {
      log.attachmentWrites.push(relPath);
    },
    writeTreeLocal: async (relPath) => {
      log.treeWrites.push(relPath);
    },
    markMaterialized: (relPath) => {
      log.materialized.push(relPath);
    },
    listServer: async () => [],
    uploadServer: async (relPath, _bytes, _mime, docId) => {
      log.legacyUploads.push({ relPath, docId });
    },
    downloadServer: async () => new Uint8Array([9]),
    createIntent: async (input) => {
      log.intents.push({ relPath: input.relPath, docId: input.docId });
      return {
        blobId: `blob-for-${input.relPath}`,
        completeUrl: `https://api.test/blobs/${input.relPath}/complete`,
        upload: {
          kind: "single" as const,
          method: "PUT",
          url: "https://s3.test/put",
          headers: {},
          expiresAt: Date.now() + 60_000,
          direct: true,
        },
      };
    },
    completeUpload: async () => {},
    putFile: async () => ({ status: 204, etag: null }),
    // The local index: one uuid per path, stable across rebuilds.
    localFileIds: async () => new Map(files.map((f, i) => [f.relPath, `local-id-${i}`])),
    knownFileId: () => null,
    registerFile: async ({ relPath, id }) => {
      log.registered.push({ relPath, id });
      return id; // the server adopts the supplied id, like `createNote` does
    },
    rememberFileId: (relPath, id, opts) => {
      log.remembered.push({ relPath, id, authored: opts?.authored === true });
    },
    confirmFileBytes: (relPath) => {
      log.confirmed.push(relPath);
    },
    fileText: async (relPath) => ({
      sha256: `sha-${relPath}`,
      status: "ok",
      chars: 5,
      text: "hello",
    }),
    uploadText: async (input) => {
      log.texts.push({ blobId: input.blobId, docId: input.docId, chars: input.chars });
    },
    ...extra,
  };

  const sync = new AttachmentSync(
    deps,
    400,
    setTimeoutImpl,
    (() => {}) as unknown as typeof clearTimeout,
  );
  /** Run every timer armed so far (the text pass), then let it settle. */
  const fire = async () => {
    const pending = timers.splice(0, timers.length);
    for (const t of pending) t();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { sync, deps, log, fire };
}

describe("tree binaries register as `files` rows", () => {
  it("registers a tree binary under the local index id, then uploads with that doc_id", async () => {
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }]);
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(1);
    // The id is the LOCAL `files.id` — one identity across the index, the
    // server row and the blob.
    expect(log.registered).toEqual([{ relPath: "Team/report.docx", id: "local-id-0" }]);
    expect(log.intents).toEqual([{ relPath: "Team/report.docx", docId: "local-id-0" }]);
    // And it is remembered, so the next session pays no round trip for it —
    // `authored`, because this is the UPLOAD path: these bytes are this user's,
    // and that is the only authorship signal a binary has. Removal policy no
    // longer reads it: deletions and revocations are outright for everyone.
    expect(log.remembered).toEqual([
      { relPath: "Team/report.docx", id: "local-id-0", authored: true },
    ]);
  });

  it("never registers a file in the hidden `attachments/` store", async () => {
    const { sync, log } = makeVault([{ relPath: "attachments/abc123.png" }]);
    await sync.reconcile();

    // Content-addressed, hidden, reachable only through the note that embeds
    // it: there is no tree location for the ACL to resolve, so it keeps the
    // blob store's path heuristic.
    expect(log.registered).toEqual([]);
    expect(log.intents).toEqual([{ relPath: "attachments/abc123.png", docId: undefined }]);
  });

  it("reuses the id `.context/config.json` already remembers, without asking again", async () => {
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }], {
      knownFileId: () => "id-from-config",
    });
    await sync.reconcile();

    expect(log.registered).toEqual([]);
    expect(log.intents[0].docId).toBe("id-from-config");
  });

  it("drops a remembered id the server no longer has, re-registers, and uploads", async () => {
    // 2026-09-22: rows deleted server-side while the file stayed on disk. The
    // intent named a dead id, the server fell through to the `attachments/`-only
    // path check and answered 400 `invalid_rel_path` — on every pass, forever.
    let known: string | null = "dead-id";
    const forgotten: string[] = [];
    const intents: Array<string | null | undefined> = [];
    const { sync, log } = makeVault([{ relPath: "research/s-000.png" }], {
      knownFileId: () => known,
      forgetFileId: (relPath) => {
        forgotten.push(relPath);
        known = null;
      },
      createIntent: async (input) => {
        intents.push(input.docId);
        if (input.docId === "dead-id") throw serverError(400, "invalid_rel_path");
        return {
          blobId: "blob-1",
          completeUrl: "https://api.test/blobs/1/complete",
          upload: {
            kind: "single" as const,
            method: "PUT",
            url: "https://s3.test/put",
            headers: {},
            expiresAt: Date.now() + 60_000,
            direct: true,
          },
        };
      },
    });
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(1);
    expect(intents).toEqual(["dead-id", "local-id-0"]);
    expect(forgotten).toEqual(["research/s-000.png"]);
    expect(log.registered).toEqual([{ relPath: "research/s-000.png", id: "local-id-0" }]);
    expect(log.confirmed).toEqual(["research/s-000.png"]);
  });

  it("retries a dead id only once per upload", async () => {
    const intents: Array<string | null | undefined> = [];
    const { sync } = makeVault([{ relPath: "research/s-000.png" }], {
      knownFileId: () => "dead-id",
      registerFile: async () => "still-dead",
      createIntent: async (input) => {
        intents.push(input.docId);
        throw serverError(400, "invalid_rel_path");
      },
    });
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(0);
    expect(intents).toEqual(["dead-id", "dead-id"]);
  });

  it("uploads without a doc_id when the server refuses the row, and stops asking", async () => {
    const registerFile = vi.fn(async () => {
      throw serverError(403, "no_write_access");
    });
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }], { registerFile });
    await sync.reconcile();
    await sync.reconcile();

    // The bytes still go — the file is the user's, the ACL just falls back.
    expect(log.intents.map((i) => i.docId)).toEqual([undefined, undefined]);
    // One refusal is enough: asking again every pass is a guaranteed 403 a pass.
    expect(registerFile).toHaveBeenCalledTimes(1);
  });

  it("retries after a path_folder_mismatch — the registry pull that fixes it is already queued", async () => {
    const registerFile = vi.fn(async () => {
      throw serverError(400, "path_folder_mismatch");
    });
    const { sync } = makeVault([{ relPath: "Team/report.docx" }], { registerFile });
    await sync.reconcile();
    await sync.reconcile();

    expect(registerFile).toHaveBeenCalledTimes(2);
  });

  it("keeps asking after a failure that was never a decision (offline, 5xx)", async () => {
    // A refusal is a decision; a dropped connection is not. Treating the second
    // as the first would cost the file its doc_id — and its real ACL — for the
    // rest of the session.
    const registerFile = vi.fn(async () => {
      throw new Error("network down");
    });
    const { sync } = makeVault([{ relPath: "Team/report.docx" }], { registerFile });
    await sync.reconcile();
    await sync.reconcile();

    expect(registerFile).toHaveBeenCalledTimes(2);
  });

  it("reads the local id map once per pass, not once per file", async () => {
    const localFileIds = vi.fn(async () => new Map([["a.docx", "id-a"], ["b.xlsx", "id-b"]]));
    const { sync } = makeVault([{ relPath: "a.docx" }, { relPath: "b.xlsx" }], { localFileIds });
    await sync.reconcile();

    expect(localFileIds).toHaveBeenCalledTimes(1);
  });

  it("carries the doc_id on the legacy route too (as `x-doc-id`)", async () => {
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }], {
      createIntent: async () => {
        throw serverError(404, "not_found");
      },
    });
    await sync.reconcile();

    expect(log.legacyUploads).toEqual([{ relPath: "Team/report.docx", docId: "local-id-0" }]);
  });

  it("registers nothing when the local index has no `files` row yet", async () => {
    // The extraction worker is seconds behind a drop; the next pass has the id.
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }], {
      localFileIds: async () => new Map(),
    });
    await sync.reconcile();

    expect(log.registered).toEqual([]);
    expect(log.intents[0].docId).toBeUndefined();
  });
});

describe("a `files` row is not its bytes", () => {
  // The row is minted BEFORE the upload, and the upload can be refused for
  // good (a Free vault's standalone file, one over the blob ceiling, one behind
  // a full quota). Only a completed transfer — or a listing that already holds
  // the sha — may tell the registry the server has these bytes, because that
  // claim is what lets a revocation take the file off this disk.

  it("confirms the bytes once the upload completes", async () => {
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }]);
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(1);
    expect(log.confirmed).toEqual(["Team/report.docx"]);
  });

  it("registers the row but confirms NOTHING when the plan refuses the upload", async () => {
    const createIntent = vi.fn(async () => {
      throw serverError(402, "attachment_sync_requires_pro");
    });
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }], { createIntent });
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(0);
    // The row exists — the server accepted it, and the ACL resolves through it.
    expect(log.registered).toEqual([{ relPath: "Team/report.docx", id: "local-id-0" }]);
    // …and the bytes never left, so nothing here may license their removal.
    expect(log.confirmed).toEqual([]);
  });

  it("confirms from the listing when the server already holds the sha", async () => {
    // The repair path for an install that predates the flag: rows written by an
    // older client load unconfirmed and settle on the next pass, without a
    // single byte moving.
    const { sync, log } = makeVault([{ relPath: "Team/report.docx" }], {
      listServer: async () => [
        { id: "blob-1", sha256: "sha-Team/report.docx", relPath: "Team/report.docx" },
      ],
    });
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(0);
    expect(log.intents).toEqual([]);
    expect(log.confirmed).toEqual(["Team/report.docx"]);
  });

  it("says nothing about a hidden `attachments/` drop — it has no `files` row", async () => {
    const { sync, log } = makeVault([{ relPath: "attachments/abc123.png" }], {
      listServer: async () => [
        { id: "blob-1", sha256: "sha-attachments/abc123.png", relPath: "attachments/abc123.png" },
      ],
    });
    await sync.reconcile();
    expect(log.confirmed).toEqual([]);
  });
});

describe("one file, one `files` row", () => {
  /** A vault whose server has these bytes already, under somebody else's row. */
  function dedupedTo(
    blob: { docId: string | null; relPath: string | null },
    extra: Partial<AttachmentSyncDeps> = {},
    files: Array<{ relPath: string; sha256?: string }> = [{ relPath: "Team/guide.pdf" }],
  ) {
    const deletedRows: string[] = [];
    const forgotten: string[] = [];
    const v = makeVault(files, {
      createIntent: async (input) => ({
        deduped: true as const,
        blob: {
          id: "blob-1",
          sha256: input.sha256,
          size: 3,
          mime: input.mime,
          relPath: blob.relPath,
          docId: blob.docId,
        },
      }),
      deleteFile: async (id) => {
        deletedRows.push(id);
      },
      forgetFileId: (relPath) => {
        forgotten.push(relPath);
      },
      ...extra,
    });
    return { ...v, deletedRows, forgotten };
  }

  it("adopts the row the bytes already belong to instead of forking the file", async () => {
    // The 2026-09-17 bug. A tree binary renamed on disk while the server was
    // restarting: the delete queue could not pair it, so the upload path saw a
    // brand-new path and registered a SECOND row — while the blob, a dedupe
    // hit, stayed bound to the FIRST (doc_id adoption is NULL→set only). One
    // file, two doc_ids, and a share set on either one reaching neither disk.
    const { sync, log, deletedRows, forgotten } = dedupedTo({
      docId: "file-original",
      // The row's own path is gone from this disk — that is what makes it a
      // rename rather than a second file with identical bytes.
      relPath: "Team/guide (1).pdf",
    });
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(1);
    // The fork it minted is dropped BEFORE the move: the server adopts by path
    // first and would otherwise hand our own row straight back.
    expect(deletedRows).toEqual(["local-id-0"]);
    expect(log.registered).toEqual([
      { relPath: "Team/guide.pdf", id: "local-id-0" },
      { relPath: "Team/guide.pdf", id: "file-original" },
    ]);
    // Both stale mappings go, so `.context/config.json` names ONE id for it.
    expect(forgotten).toEqual(["Team/guide.pdf", "Team/guide (1).pdf"]);
    expect(log.remembered[log.remembered.length - 1]).toEqual({
      relPath: "Team/guide.pdf",
      id: "file-original",
      // Adoption says nothing about who put the bytes there; the claim this
      // device made when it uploaded them is keyed by doc_id and survives.
      authored: false,
    });
  });

  it("heals a fork a previous session already wrote to config", async () => {
    // Nothing is minted this pass — the duplicate id is the one the vault
    // remembers — and the repair is the same one.
    const { sync, log, deletedRows } = dedupedTo(
      { docId: "file-original", relPath: "Team/guide (1).pdf" },
      { knownFileId: () => "file-fork" },
    );
    await sync.reconcile();

    expect(deletedRows).toEqual(["file-fork"]);
    expect(log.registered).toEqual([{ relPath: "Team/guide.pdf", id: "file-original" }]);
  });

  it("leaves two files that merely hold identical bytes alone", async () => {
    // The row's path is on disk, so this is the mirror's oldest limitation (one
    // blob, two files) and NOT a rename. Moving the row would take the first
    // file's ACL onto the second.
    const { sync, log, deletedRows } = dedupedTo(
      { docId: "file-a", relPath: "Team/a.pdf" },
      {},
      [
        { relPath: "Team/a.pdf", sha256: "twins" },
        { relPath: "Team/b.pdf", sha256: "twins" },
      ],
    );
    await sync.reconcile();

    expect(deletedRows).toEqual([]);
    expect(log.registered).toEqual([
      { relPath: "Team/a.pdf", id: "local-id-0" },
      { relPath: "Team/b.pdf", id: "local-id-1" },
    ]);
  });

  it("leaves an unregistered path queued while the delete queue has an unsettled window", async () => {
    // A rename it is still trying to pair looks exactly like a new path from
    // here, and registering it creates the row the pairing was there to avoid.
    // The whole file waits: uploading it without a doc_id would put the bytes on
    // the server anyway, and the next pass — which subtracts by sha — would
    // never queue it again to fix that.
    const states: Array<Record<string, string>> = [];
    const { sync, log } = makeVault([{ relPath: "Team/guide.pdf" }], {
      isRenamePending: () => true,
      onFileStates: (s) => states.push({ ...s }),
    });
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(0);
    expect(log.registered).toEqual([]);
    expect(log.intents).toEqual([]);
    expect(states[states.length - 1]).toEqual({ "Team/guide.pdf": "queued" });
  });

  it("uploads a path it already owns even while a window is unsettled", async () => {
    const { sync, log } = makeVault([{ relPath: "Team/guide.pdf" }], {
      isRenamePending: () => true,
      knownFileId: () => "file-known",
    });
    const res = await sync.reconcile();

    expect(res.uploaded).toBe(1);
    expect(log.intents).toEqual([{ relPath: "Team/guide.pdf", docId: "file-known" }]);
  });

  it("still mints an id when the deduped blob names no row at all", async () => {
    const { sync, log, deletedRows } = dedupedTo({ docId: null, relPath: null });
    await sync.reconcile();

    expect(deletedRows).toEqual([]);
    expect(log.registered).toEqual([{ relPath: "Team/guide.pdf", id: "local-id-0" }]);
  });
});

describe("tree binary rename (Stage A's known limit)", () => {
  it("does NOT propagate a rename — identity is still sha256", async () => {
    // The server holds the bytes under the OLD path; the disk has them under a
    // new one. Nothing to upload (the sha is known) and nothing to download
    // (the sha is local), so another device keeps the old name. Stage B's
    // path-keyed diff over `files.id` is what changes this — deliberately, by
    // deleting this test.
    const { sync, log } = makeVault([{ relPath: "Team/renamed.docx", sha256: "same-bytes" }], {
      listServer: async () => [
        { id: "blob-1", sha256: "same-bytes", relPath: "Team/original.docx" },
      ],
    });
    const res = await sync.reconcile();

    expect(res).toEqual({ uploaded: 0, downloaded: 0 });
    expect(log.registered).toEqual([]);
    expect(log.treeWrites).toEqual([]);
  });
});

describe("materializing a tree binary", () => {
  it("writes through the TREE guard and claims its own watcher echo", async () => {
    const { sync, log } = makeVault([], {
      listServer: async () => [
        { id: "blob-1", sha256: "sha-remote", relPath: "Team/from-teammate.docx" },
      ],
      downloadUrl: async () => ({ url: "https://api.test/blobs/blob-1", expiresAt: null, direct: false }),
      fetchBytes: async () => new Uint8Array([4, 5, 6]),
    });
    const res = await sync.reconcile();

    expect(res.downloaded).toBe(1);
    expect(log.treeWrites).toEqual(["Team/from-teammate.docx"]);
    expect(log.attachmentWrites).toEqual([]);
    // Our own write, ~150ms before its watcher event: claimed the way the
    // registry claims a materialized note, or the echo reads as an edit.
    expect(log.materialized).toEqual(["Team/from-teammate.docx"]);
  });

  it("tells Rust which guard to apply when it streams the file itself", async () => {
    const seen: Array<{ relPath: string; tree: boolean }> = [];
    const { sync } = makeVault([], {
      listServer: async () => [
        { id: "b1", sha256: "s1", relPath: "Team/deck.pptx" },
        { id: "b2", sha256: "s2", relPath: "attachments/img.png" },
      ],
      downloadUrl: async () => ({ url: "https://s3.test/get", expiresAt: null, direct: true }),
      fetchToFile: async (input) => {
        seen.push({ relPath: input.relPath, tree: input.tree });
        return { status: 200, bytes: 3 };
      },
    });
    await sync.reconcile();

    expect(seen).toEqual([
      { relPath: "Team/deck.pptx", tree: true },
      { relPath: "attachments/img.png", tree: false },
    ]);
  });

  it("refuses a server path neither guard accepts", async () => {
    const { sync, log } = makeVault([], {
      listServer: async () => [
        { id: "evil-note", sha256: "s1", relPath: "Team/Plans.md" },
        { id: "evil-ctx", sha256: "s2", relPath: ".context/index.sqlite" },
        { id: "evil-up", sha256: "s3", relPath: "Team/../../escape.png" },
        { id: "ok", sha256: "s4", relPath: "Team/ok.docx" },
      ],
      downloadUrl: async () => ({ url: "https://api.test/b", expiresAt: null, direct: false }),
      fetchBytes: async () => new Uint8Array([1]),
    });
    const res = await sync.reconcile();

    expect(res.downloaded).toBe(1);
    expect(log.treeWrites).toEqual(["Team/ok.docx"]);
  });
});

describe("extracted text upload", () => {
  it("sends a blob's text once, after `files-indexed`, with its doc_id", async () => {
    const { sync, log, fire } = makeVault([{ relPath: "Team/report.docx" }]);
    await sync.reconcile(); // registers + uploads, which also queues the text
    await fire();

    expect(log.texts).toEqual([
      { blobId: "blob-for-Team/report.docx", docId: "local-id-0", chars: 5 },
    ]);

    // A second signal for the same blob sends nothing: text describes BYTES.
    sync.handleFilesIndexed(["Team/report.docx"]);
    await fire();
    expect(log.texts).toHaveLength(1);
  });

  it("skips a file whose extraction has not finished, or produced nothing", async () => {
    const { sync, log, fire } = makeVault([{ relPath: "Media/clip.mp4" }], {
      fileText: async () => ({ sha256: "sha-Media/clip.mp4", status: "pending", chars: 0, text: "" }),
    });
    await sync.reconcile();
    await fire();

    expect(log.texts).toEqual([]);
  });

  it("skips a path whose blob the server does not hold yet", async () => {
    const { sync, log, fire } = makeVault([], {
      // Nothing local, nothing uploaded — so no blob to attach the text to.
      fileText: async () => ({ sha256: "sha-unknown", status: "ok", chars: 4, text: "word" }),
    });
    await sync.reconcile();
    sync.handleFilesIndexed(["Team/never-uploaded.docx"]);
    await fire();

    expect(log.texts).toEqual([]);
  });

  it("stops offering text for the whole session after one 404", async () => {
    const uploadText = vi.fn(async () => {
      throw serverError(404, "not_found");
    });
    const { sync, fire } = makeVault(
      [{ relPath: "Team/a.docx" }, { relPath: "Team/b.docx" }],
      { uploadText },
    );
    await sync.reconcile();
    await fire();
    sync.handleFilesIndexed(["Team/a.docx", "Team/b.docx"]);
    await fire();

    // One probe, not one per file and not one per pass: a 404 is either a
    // server without the route or a blob it has forgotten.
    expect(uploadText).toHaveBeenCalledTimes(1);
  });

  it("never retries a blob the server refused the text of (413/409)", async () => {
    const uploadText = vi.fn(async () => {
      throw serverError(413, "text_too_large");
    });
    const { sync, fire } = makeVault([{ relPath: "Team/huge.docx" }], { uploadText });
    await sync.reconcile();
    await fire();
    sync.handleFilesIndexed(["Team/huge.docx"]);
    await fire();

    expect(uploadText).toHaveBeenCalledTimes(1);
  });

  it("caps what it sends at a million characters, on a character boundary", async () => {
    const { sync, log, fire } = makeVault([{ relPath: "Team/big.docx" }], {
      fileText: async () => ({
        sha256: "sha-Team/big.docx",
        status: "ok",
        chars: 2_000_000,
        // The last kept character is a high surrogate unless the cap backs off.
        text: "a".repeat(999_999) + "😀".repeat(10),
      }),
    });
    await sync.reconcile();
    await fire();

    expect(log.texts[0].chars).toBe(999_999);
  });

  it("drops the pending text pass when the vault stops being current", async () => {
    let current = true;
    const { sync, log, fire } = makeVault([{ relPath: "Team/report.docx" }], {
      isCurrent: () => current,
    });
    await sync.reconcile();
    current = false;
    await fire();

    expect(log.texts).toEqual([]);
  });
});

describe("watcher routing", () => {
  it("routes every binary to the blob mirror and every note to the CRDT path", () => {
    // Before this, only `attachments/` short-circuited, so a `.docx` dropped
    // into a folder reached the note path — where an unmapped file means
    // "register it as a note".
    for (const binary of [
      "Team/report.docx",
      "Team/sheet.xlsx",
      "Media/clip.mp4",
      "Data/rows.csv",
      "attachments/abc.png",
      "attachments",
      "Photos/holiday.PNG",
    ]) {
      expect(routesToAttachmentSync(binary)).toBe(true);
    }
    for (const note of [
      "Team/Plans.md",
      "Notes/readme.txt",
      "Notes/page.html",
      "Board.canvas",
      "Projects", // a folder: the tree event the registry pull is for
      "Notes/LICENSE",
    ]) {
      expect(routesToAttachmentSync(note)).toBe(false);
    }
  });
});

describe("tree binary path guard", () => {
  it("accepts what a user could have dropped, and nothing else", () => {
    expect(isSafeTreeBinaryRelPath("Team/report.docx")).toBe(true);
    expect(isSafeTreeBinaryRelPath("clip.mp4")).toBe(true);
    // Notes belong to the CRDT pipeline; a blob must never overwrite one.
    expect(isSafeTreeBinaryRelPath("Team/Plans.md")).toBe(false);
    expect(isSafeTreeBinaryRelPath("notes.txt")).toBe(false);
    // Hidden/derived state, traversal, and types the vault does not surface.
    expect(isSafeTreeBinaryRelPath(".context/index.sqlite")).toBe(false);
    expect(isSafeTreeBinaryRelPath("Team/.hidden/x.png")).toBe(false);
    expect(isSafeTreeBinaryRelPath("Team/../escape.png")).toBe(false);
    expect(isSafeTreeBinaryRelPath("src/app.js")).toBe(false);
    expect(isSafeTreeBinaryRelPath("Makefile")).toBe(false);
    expect(isSafeTreeBinaryRelPath("")).toBe(false);
  });

  it("knows which home a path belongs to", () => {
    expect(isUnderAttachments("attachments/a.png")).toBe(true);
    expect(isUnderAttachments("attachments")).toBe(true);
    expect(isUnderAttachments("Team/attachments/a.png")).toBe(false);
    expect(isUnderAttachments("Team/a.png")).toBe(false);
  });
});

describe("a downloaded tree binary", () => {
  it("records the server's files id, and never claims authorship for it", async () => {
    // Two things at once. `ensureFileRow` only ever runs on the UPLOAD path, so
    // a teammate's binary had no `files` id on this device at all — which meant
    // the vault channel's `hello` could not announce it and a revocation of it
    // could never be named. And the id it gets must NOT be marked authored:
    // these are somebody else's bytes, so a revocation removes them outright
    // rather than filing a readable copy in `.context/trash`.
    const { sync, log } = makeVault([], {
      listServer: async () => [
        { id: "blob-1", sha256: "sha-remote", relPath: "Team/theirs.pdf", docId: "file-theirs" },
        // The hidden root store keeps the old path heuristic and has no `files`
        // row, so nothing is remembered for it.
        { id: "blob-2", sha256: "sha-drop", relPath: "attachments/drop.png", docId: null },
      ],
      downloadUrl: async () => ({
        url: "https://s3.test/get",
        direct: true,
        headers: {},
        expiresAt: Date.now() + 60_000,
      }),
      fetchToFile: async () => ({ status: 200, bytes: 3 }),
    });

    await sync.reconcile();

    expect(log.remembered).toEqual([
      { relPath: "Team/theirs.pdf", id: "file-theirs", authored: false },
    ]);
  });
});
