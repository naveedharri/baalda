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

export interface SyncContext {
  docId: string;
  vaultId: string;
  readOnly: boolean;
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

export function createSyncServer(
  port: number = config.hocuspocusPort,
  onDocChanged?: DocChangedHook,
): Server<SyncContext> {
  return new Server<SyncContext>({
    name: "context-sync",
    port,
    quiet: true,
    // HA: mirror doc updates + awareness across instances when REDIS_URL is set
    // (spec 05 §5). Empty (single-instance) otherwise — no behaviour change.
    extensions: redisExtensions(config.redisUrl),

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
