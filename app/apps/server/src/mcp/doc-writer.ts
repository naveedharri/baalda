import { createHash } from "node:crypto";
import * as Y from "yjs";
import type { LocalTransactionOrigin, Server } from "@hocuspocus/server";
import { formatDocName } from "../sync/doc-name.js";
import type { SyncContext } from "../sync/hocuspocus.js";
import { loadDocState } from "../yjs/persistence.js";
import { config } from "../config.js";
import {
  applyDetached,
  setDocBatchRuntime,
  withDocLock,
  type DocActor,
  type DocUpdatePublisher,
  type DocWrittenHook,
} from "../sync/doc-batch.js";

/** Re-exported from `sync/doc-batch.ts`, which now owns the write path these
 *  describe (the MCP tools and the bulk push route share it). Kept on this
 *  module so every existing importer keeps its import path. */
export type { DocActor, DocUpdatePublisher, DocWrittenHook };

/**
 * Server-side writer for a note's shared Y.Text `content` — the bridge between
 * the MCP tools and the CRDT store. Two paths, both leave the doc correct:
 *
 *   1. If the note's doc is currently OPEN (a client is connected), mutate the
 *      live Hocuspocus `Document`. That fires the sync server's existing
 *      onChange hook (persist to doc_updates + re-index) AND broadcasts the
 *      change to every connected editor — exactly the path a human edit takes.
 *      So an AI edit shows up live in an open editor and egests to disk.
 *
 *   2. If no client is connected the doc isn't in memory. We hydrate a detached
 *      Y.Doc from the stored state, apply the mutation, and persist the single
 *      incremental update ourselves (then re-index). The next client to open
 *      the note loads this state.
 *
 * `content` matches the desktop bridge and the indexer's CONTENT_FIELD.
 */

const CONTENT_FIELD = "content";
/** Transaction origin tag for edits that originate from the MCP server. */
export const MCP_ORIGIN = "mcp";

/**
 * One targeted change to a note body: delete `deleteLength` chars at `index`,
 * then insert `insert` there. Applied IN ORDER, each index relative to the text
 * as left by the previous op — the natural shape of "edit, then edit again".
 */
export interface TextOp {
  index: number;
  deleteLength: number;
  insert: string;
}

/**
 * The revision of a note body: sha256 of its current text. What `read_note`
 * hands out and what a mutation may be preconditioned on (#78) — a stable,
 * cheap identity for "the text I read", with no server-side revision counter to
 * keep (the CRDT has no single version number; the content hash is the honest
 * equivalent).
 */
export function revisionOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** A mutation's precondition failed: the note is not the text the caller read. */
export class StaleRevisionError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Stale write: the note changed since it was read (revision ${actual.slice(0, 12)}…, expected ${expected.slice(0, 12)}…). Read it again and retry.`,
    );
  }
}

export interface DocWriter {
  /**
   * Apply targeted ops (#78). `plan` runs under the doc's write lock with the
   * CURRENT text and returns the ops to apply, or throws to abort with nothing
   * written — that is where a revision precondition is checked, so the check and
   * the write are one atomic step. Returns the resulting text's revision.
   */
  editContent(
    vaultId: string,
    docId: string,
    plan: (current: string) => TextOp[],
    actor?: DocActor,
  ): Promise<{ revision: string; content: string }>;
  /** Replace the whole note body. */
  setContent(
    vaultId: string,
    docId: string,
    content: string,
    actor?: DocActor,
  ): Promise<void>;
  /** Append text to the end of the note body. */
  appendContent(
    vaultId: string,
    docId: string,
    text: string,
    actor?: DocActor,
  ): Promise<void>;
  /** Read the current note body (from the live doc if open, else from storage). */
  readContent(vaultId: string, docId: string): Promise<string>;
  /**
   * Like {@link readContent}, but `null` when the doc has NO live session and NO
   * persisted CRDT state — i.e. the server has never seen this note's content
   * (typical for a freshly-synced vault whose bulk upload is still running).
   * Callers that snapshot content MUST use this: treating "not uploaded yet" as
   * "empty note" is how a checkpoint ends up bulldozing real text with "".
   */
  peekContent(vaultId: string, docId: string): Promise<string | null>;
}

export function createDocWriter(
  server: Server<SyncContext>,
  publishUpdate?: DocUpdatePublisher,
  onDocWritten?: DocWrittenHook,
): DocWriter {
  // Everything the bulk `docs/batch` applier needs to take the LIVE path and to
  // fan out a detached write — the live sync server plus these two hooks. This
  // is the one place that already holds all three, and there is exactly one of
  // each per process. See `sync/doc-batch.ts DocBatchRuntime`.
  setDocBatchRuntime({ server, hooks: { publishUpdate, onDocWritten } });

  function mutate(
    vaultId: string,
    docId: string,
    fn: (text: Y.Text) => void,
    actor?: DocActor,
  ): Promise<void> {
    return withDocLock(docId, () => mutateLocked(vaultId, docId, fn, actor));
  }

  async function mutateLocked(
    vaultId: string,
    docId: string,
    fn: (text: Y.Text) => void,
    actor?: DocActor,
  ): Promise<void> {
    const userId = actor?.userId ?? null;
    const live = server.hocuspocus.documents.get(formatDocName(vaultId, docId));
    if (live) {
      // Live path: the sync server's onChange persists + broadcasts for us.
      //
      // The origin is a Hocuspocus `LocalTransactionOrigin` object rather than
      // the old bare `MCP_ORIGIN` string, because that is the ONLY channel that
      // carries an identity into `onChange`: Hocuspocus resolves
      // `origin.source === "local" ? origin.context : {}`, so a string origin is
      // permanently anonymous. `skipStoreHooks` stays unset — this write must
      // persist exactly like a human's.
      live.transact(() => fn(live.getText(CONTENT_FIELD)), {
        source: "local",
        context: { source: MCP_ORIGIN, userId },
      } satisfies LocalTransactionOrigin);
      return;
    }

    // Detached path: hydrate, mutate, persist the incremental update. Shared
    // with the bulk push route — see `sync/doc-batch.ts applyDetached`, which
    // carries the register-observer-after-hydration subtlety.
    await applyDetached(vaultId, docId, (doc) => doc.transact(() => fn(doc.getText(CONTENT_FIELD)), MCP_ORIGIN), actor, {
      hooks: { publishUpdate, onDocWritten },
    });
  }

  // A plain closure, NOT a method using `this`: call sites hand these functions
  // around detached (`readContent: docWriter.readContent`), where `this` dies.
  async function peekContent(vaultId: string, docId: string): Promise<string | null> {
    const live = server.hocuspocus.documents.get(formatDocName(vaultId, docId));
    if (live) return live.getText(CONTENT_FIELD).toString();
    const state = await loadDocState(docId);
    // No state is NOT an empty note: it is a note whose content has never
    // reached this server. The distinction is load-bearing for checkpoints.
    if (!state) return null;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      return doc.getText(CONTENT_FIELD).toString();
    } finally {
      doc.destroy();
    }
  }

  // The note-size ceiling, enforced where the resulting length is knowable.
  // Guards especially against a WRITER IN A LOOP — an agent appending to the
  // same note forever grows it unboundedly, and past a few MB the doc starts
  // OOM-ing every rebuild (index backfill, compaction, backfill sends).
  const capChars = () => config.maxNoteMb * 1024 * 1024;
  const requireUnderCap = (resulting: number): void => {
    if (resulting > capChars()) {
      throw new Error(
        `note would exceed the ${config.maxNoteMb} MB size ceiling — split the content across smaller notes`,
      );
    }
  };

  /** Apply a plan's ops to a Y.Text, validating each against the live length. */
  const applyOps = (text: Y.Text, ops: TextOp[]): void => {
    for (const op of ops) {
      const len = text.length;
      if (
        !Number.isInteger(op.index) ||
        !Number.isInteger(op.deleteLength) ||
        op.index < 0 ||
        op.deleteLength < 0 ||
        op.index + op.deleteLength > len
      ) {
        throw new Error(`edit out of range: index ${op.index}, delete ${op.deleteLength}, length ${len}`);
      }
      requireUnderCap(len - op.deleteLength + op.insert.length);
      if (op.deleteLength > 0) text.delete(op.index, op.deleteLength);
      if (op.insert) text.insert(op.index, op.insert);
    }
  };

  return {
    editContent: async (vaultId, docId, plan, actor) => {
      let result = "";
      await mutate(
        vaultId,
        docId,
        (text) => {
          // The plan sees the text under the lock; a throw here (stale revision,
          // missing anchor) leaves the transaction empty — nothing is written.
          const ops = plan(text.toString());
          applyOps(text, ops);
          result = text.toString();
        },
        actor,
      );
      return { revision: revisionOf(result), content: result };
    },

    setContent: (vaultId, docId, content, actor) =>
      mutate(
        vaultId,
        docId,
        (text) => {
          requireUnderCap(content.length);
          if (text.length > 0) text.delete(0, text.length);
          if (content) text.insert(0, content);
        },
        actor,
      ),

    appendContent: (vaultId, docId, appended, actor) =>
      mutate(
        vaultId,
        docId,
        (text) => {
          requireUnderCap(text.length + appended.length);
          text.insert(text.length, appended);
        },
        actor,
      ),

    readContent: async (vaultId, docId) => (await peekContent(vaultId, docId)) ?? "",

    peekContent,
  };
}
