import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { config } from "../config.js";
import { verifySyncToken } from "../tokens/sync-token.js";
import { appendUpdate, loadDocState } from "../yjs/persistence.js";
import { scheduleIndex } from "../index/indexer.js";
import { formatDocName, parseDocName } from "./doc-name.js";
import { redisExtensions } from "./redis-extension.js";

/**
 * Hocuspocus sync server (spec 03 §3, 04 §4).
 *
 *  - documents are named `vault:{vaultId}/note:{docId}`.
 *  - onAuthenticate verifies the per-doc JWT matches the requested doc and sets
 *    connection readOnly for view grants (throws on invalid/mismatch).
 *  - onLoadDocument loads the snapshot + replays the update log (BINARY only).
 *  - onChange appends each incremental binary update; compaction fires inside
 *    appendUpdate when the log exceeds the threshold.
 */

// Origin used when we hydrate a freshly-loaded doc, so onChange can tell our own
// load echo apart from real client edits and skip persisting it.
const LOAD_ORIGIN = "hocuspocus:load";

/**
 * WebSocket close code for "this doc's Yjs state is over `MAX_NOTE_MB`".
 *
 * In the private 4000–4999 range on purpose: those are reserved for application
 * use and every WebSocket implementation lets an endpoint send them, where the
 * protocol-level 1009 ("Message Too Big") is filtered by some stacks. Hocuspocus
 * copies `code`/`reason` off a thrown error onto the close frame
 * (`Connection.handleMessage`), which is how this reaches the client.
 *
 * The desktop client mirrors this constant in `src/lib/sync/syncManager.ts` and
 * treats it as TERMINAL — no reconnect. Keep the two in lockstep.
 */
export const CLOSE_NOTE_TOO_LARGE = 4413;

/** Thrown by `beforeHandleMessage`; shaped so Hocuspocus emits a close frame
 *  the client can act on rather than a generic reset. */
class NoteTooLargeError extends Error {
  readonly code = CLOSE_NOTE_TOO_LARGE;
  readonly reason = "note exceeds the maximum size";
  constructor() {
    super("note exceeds the maximum size");
    this.name = "NoteTooLargeError";
  }
}

export interface SyncContext {
  docId: string;
  vaultId: string;
  readOnly: boolean;
  /**
   * The authenticated editor on this connection, from the sync token's `userId`
   * claim — `null` for a token minted before the claim existed (still valid,
   * just anonymous).
   *
   * Also the shape server-side writers put in a `LocalTransactionOrigin`'s
   * `context`, so `onChange` can read one field regardless of who wrote.
   */
  userId: string | null;
}

/**
 * Notified after each persisted doc change so the vault replication channel
 * (spec 05) can fan the update out to background subscribers. Best-effort: the
 * open-note (Hocuspocus) path never blocks or fails on it.
 */
export type DocChangedHook = (
  vaultId: string,
  docId: string,
  update: Uint8Array,
) => void;

/**
 * Notified after each persisted doc change WITH the editor's identity, so the
 * versioning layer can stamp "last edited by" and arm its idle capture.
 *
 * `userId` is null when the writer is unattributable (a pre-attribution token,
 * or a server-side write with no actor). Best-effort, like {@link DocChangedHook}.
 */
export type DocEditedHook = (
  vaultId: string,
  docId: string,
  userId: string | null,
) => void;

export function createSyncServer(
  port: number = config.hocuspocusPort,
  onDocChanged?: DocChangedHook,
  onDocEdited?: DocEditedHook,
): Server<SyncContext> {
  return new Server<SyncContext>({
    name: "context-sync",
    port,
    quiet: true,
    // HA: mirror doc updates + awareness across instances when REDIS_URL is set
    // (spec 05 §5). Empty (single-instance) otherwise — no behaviour change.
    extensions: redisExtensions(config.redisUrl),

    /**
     * Circuit breaker: refuse any sync message larger than the note ceiling.
     * A legitimate note never comes close (see `config.maxNoteMb`); a message
     * this big means runaway growth — historically a forked-note feedback loop
     * duplicating the content on every bounce. Throwing rejects the message and
     * closes the connection BEFORE the update is applied or broadcast, so the
     * oversized state can neither persist nor fan out.
     *
     * The thrown error carries {@link CLOSE_NOTE_TOO_LARGE} so the close frame
     * NAMES this cause. Hocuspocus otherwise falls back to `ResetConnection`
     * (4205) — the same code a transient server-side reset uses — and a client
     * cannot tell "retry me" from "I will refuse this doc forever". That
     * ambiguity is the bug: the provider reconnected, re-sent the same
     * oversized state, was closed again, and strobed the sync badge about once
     * a second for as long as the app was open.
     */
    async beforeHandleMessage(data) {
      const cap = config.maxNoteMb * 1024 * 1024;
      if (data.update.byteLength > cap) {
        console.error(
          `Rejecting oversized sync message for ${data.documentName}: ` +
            `${data.update.byteLength} bytes (cap ${cap})`,
        );
        throw new NoteTooLargeError();
      }
    },

    async onAuthenticate(data) {
      const parsed = parseDocName(data.documentName);
      if (!parsed) {
        throw new Error(`Unrecognized document name: ${data.documentName}`);
      }

      let claims;
      try {
        claims = await verifySyncToken(data.token);
      } catch (err) {
        // Log WHY, not just that it failed: an empty token (the client couldn't
        // mint one) and an expired or wrong-secret token are completely different
        // faults, and "Invalid or expired sync token" alone can't tell them apart
        // — which turned a client-side retry storm into thousands of identical,
        // undiagnosable log lines.
        const len = typeof data.token === "string" ? data.token.length : -1;
        const code = (err as { code?: string })?.code ?? (err as Error)?.name;
        console.warn(
          `[onAuthenticate] rejected token for ${data.documentName}: ${code} (token length ${len})`,
        );
        throw new Error("Invalid or expired sync token");
      }

      // Token must be scoped to exactly this doc (and vault).
      if (claims.docId !== parsed.docId || claims.vaultId !== parsed.vaultId) {
        throw new Error("Sync token does not match requested document");
      }

      // View grants: server silently rejects updates from this connection.
      if (claims.readOnly) {
        data.connectionConfig.readOnly = true;
      }

      const context: SyncContext = {
        docId: parsed.docId,
        vaultId: parsed.vaultId,
        readOnly: claims.readOnly,
        userId: claims.userId ?? null,
      };
      return context;
    },

    async onLoadDocument(data) {
      const parsed = parseDocName(data.documentName);
      if (!parsed) return data.document;
      try {
        const state = await loadDocState(parsed.docId);
        if (state) {
          Y.applyUpdate(data.document, state, LOAD_ORIGIN);
        }
      } catch (err) {
        // Destroy-then-rethrow is load-bearing; Hocuspocus cannot clean this up
        // for us. It only inserts the Document into its `documents` map AFTER
        // this hook resolves (Hocuspocus.createDocument), and its own failure
        // path calls `unloadDocument(document)`, which early-returns on
        // `if (!this.documents.has(documentName)) return;` — so `destroy()` is
        // never reached. Meanwhile `new Document(...)` built a `y-protocols`
        // Awareness whose constructor arms a plain (non-`unref`'d) 3-second
        // `setInterval` closing over the doc; `Awareness.destroy()` — reached
        // only via the Y.Doc `destroy` event — is the sole `clearInterval`.
        // Without this, one failed load (a dead pooled client, or an in-flight
        // query during a Postgres restart/failover) permanently leaks the doc
        // plus a live timer that keeps it reachable.
        try {
          data.document.destroy();
        } catch (destroyErr) {
          console.error(
            `Failed to destroy document ${data.documentName} after a failed load:`,
            destroyErr,
          );
        }
        // Rethrow so Hocuspocus still rejects the connection — a client must
        // never get an empty doc it would then treat as authoritative and sync
        // its local state into.
        throw err;
      }
      return data.document;
    },

    async onChange(data) {
      // Skip the echo from our own onLoadDocument hydration.
      if (data.transactionOrigin === LOAD_ORIGIN) return;
      const parsed = parseDocName(data.documentName);
      if (!parsed) return;
      await appendUpdate(parsed.docId, data.update);
      // Re-derive links + embedding for this note (debounced, best-effort).
      // Also covers lazy indexing: a doc missing from note_index gets a row on
      // its next store.
      scheduleIndex(parsed.docId);
      // Fan the incremental update out to vault-channel subscribers (spec 05).
      // The `update` is the exact delta this connection applied — replay it to
      // background clients so their disk stays current without opening the note.
      if (onDocChanged) {
        try {
          onDocChanged(parsed.vaultId, parsed.docId, data.update);
        } catch (err) {
          console.error("onDocChanged hook failed:", err);
        }
      }
      // Attribution. Hocuspocus resolves `data.context` for us: the CONNECTION's
      // context for a client edit, and a `LocalTransactionOrigin`'s `context` for
      // a server-side write (the doc writer's live path) — both of which carry
      // `userId`. Anything else (a plain string origin, a Redis-replicated
      // update) lands as `{}`, i.e. anonymous.
      if (onDocEdited) {
        try {
          const editorId = (data.context as Partial<SyncContext> | undefined)?.userId ?? null;
          onDocEdited(parsed.vaultId, parsed.docId, editorId);
        } catch (err) {
          console.error("onDocEdited hook failed:", err);
        }
      }
    },
  });
}

/**
 * Instant-kill: force-close every live socket for a doc (spec 04 §4). Called on
 * share revoke so access dies immediately rather than at token expiry.
 */
export function disconnectDoc(
  server: Server<SyncContext>,
  vaultId: string,
  docId: string,
): void {
  server.hocuspocus.closeConnections(formatDocName(vaultId, docId));
}

/**
 * Close every connection to a doc AND drop it from memory.
 *
 * `disconnectDoc` alone is not enough after the doc's rows change underneath the
 * server: Hocuspocus keeps the loaded `Y.Doc` and would serve that cached copy
 * to the next client, re-materialising the very state we just deleted. Unloading
 * forces the next connect through `onLoadDocument`, i.e. back to Postgres.
 *
 * Order matters — `unloadDocument` no-ops while connections remain.
 */
export async function evictDoc(
  server: Server<SyncContext>,
  vaultId: string,
  docId: string,
): Promise<void> {
  const name = formatDocName(vaultId, docId);
  const hp = server.hocuspocus;
  hp.closeConnections(name);
  const doc = hp.documents.get(name);
  if (doc) await hp.unloadDocument(doc);
}
