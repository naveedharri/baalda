import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { formatDocName } from "../sync/doc-name.js";
import type { SyncContext } from "../sync/hocuspocus.js";
import { appendUpdate, loadDocState } from "../yjs/persistence.js";
import { indexDoc } from "../index/indexer.js";

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

export interface DocWriter {
  /** Replace the whole note body. */
  setContent(vaultId: string, docId: string, content: string): Promise<void>;
  /** Append text to the end of the note body. */
  appendContent(vaultId: string, docId: string, text: string): Promise<void>;
  /** Read the current note body (from the live doc if open, else from storage). */
  readContent(vaultId: string, docId: string): Promise<string>;
}

/**
 * Publishes a doc update to background vault subscribers — the same fan-out the
 * sync server's `onChange` performs for a live document.
 *
 * The detached path below needs this explicitly. `publishDocUpdate` is driven
 * off Hocuspocus's `onChange`, and the detached path deliberately never touches
 * Hocuspocus, so without this an edit to a note nobody has open is persisted
 * correctly and announced to no one: every connected app keeps the old text on
 * disk until its next full reconcile. Since "nobody has this note open" is the
 * normal case for an AI writing into a vault, that was most MCP edits.
 *
 * Returns `void | Promise<void>` so the contract itself is safe: the real
 * publisher fans out over pub/sub and can REJECT (a Redis blip), and a rejection
 * nobody awaits is an unhandled rejection — which on Node 22 with no
 * `unhandledRejection` handler takes the whole process down. Declaring the
 * promise here means `mutate` below awaits and swallows it once, for every
 * present and future injection site, instead of depending on each caller to
 * remember its own `.catch`.
 */
export type DocUpdatePublisher = (
  vaultId: string,
  docId: string,
  update: Uint8Array,
) => void | Promise<void>;

export function createDocWriter(
  server: Server<SyncContext>,
  publishUpdate?: DocUpdatePublisher,
): DocWriter {
  async function mutate(
    vaultId: string,
    docId: string,
    fn: (text: Y.Text) => void,
  ): Promise<void> {
    const live = server.hocuspocus.documents.get(formatDocName(vaultId, docId));
    if (live) {
      // Live path: the sync server's onChange persists + broadcasts for us.
      live.transact(() => fn(live.getText(CONTENT_FIELD)), MCP_ORIGIN);
      return;
    }

    // Detached path: hydrate, mutate, persist the incremental update.
    const state = await loadDocState(docId);
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    const capture = (u: Uint8Array) => updates.push(u);
    try {
      if (state) Y.applyUpdate(doc, state);
      // Register AFTER hydration so we capture only our own edit.
      doc.on("update", capture);
      doc.transact(() => fn(doc.getText(CONTENT_FIELD)), MCP_ORIGIN);
      doc.off("update", capture);
      if (updates.length > 0) {
        const merged = Y.mergeUpdates(updates);
        await appendUpdate(docId, merged);
        // Fan out to background subscribers, which the live path gets free from
        // Hocuspocus's onChange. Best-effort like the re-index: the write is
        // already durable, and failing it here would turn a delivery problem
        // into a lost edit.
        //
        // `await` inside the try so this covers BOTH failure shapes: a
        // synchronous throw AND a rejected promise. The catch alone only handled
        // the first, and the production publisher is async — so the case that
        // actually happens (pub/sub down) was the one going uncaught, where an
        // unhandled rejection would take the process with it.
        try {
          await publishUpdate?.(vaultId, docId, merged);
        } catch (err) {
          console.warn(`[mcp] failed to publish update for ${docId}`, err);
        }
        // Keep search/graph in sync (best-effort; never fail the write on it).
        await indexDoc(docId).catch(() => {});
      }
    } finally {
      doc.destroy();
    }
  }

  return {
    setContent: (vaultId, docId, content) =>
      mutate(vaultId, docId, (text) => {
        if (text.length > 0) text.delete(0, text.length);
        if (content) text.insert(0, content);
      }),

    appendContent: (vaultId, docId, appended) =>
      mutate(vaultId, docId, (text) => {
        text.insert(text.length, appended);
      }),

    async readContent(vaultId, docId) {
      const live = server.hocuspocus.documents.get(formatDocName(vaultId, docId));
      if (live) return live.getText(CONTENT_FIELD).toString();
      const state = await loadDocState(docId);
      if (!state) return "";
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state);
        return doc.getText(CONTENT_FIELD).toString();
      } finally {
        doc.destroy();
      }
    },
  };
}
