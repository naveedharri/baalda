import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { config } from "../config.js";
import { verifySyncToken } from "../tokens/sync-token.js";
import { syncPermission } from "../trash/access.js";
import { appendUpdate, loadDocState } from "../yjs/persistence.js";
import { scheduleIndex } from "../index/indexer.js";
import { formatDocName, parseDocName } from "./doc-name.js";
import { redisExtensions } from "./redis-extension.js";
import { reportShrink } from "../versions/shrink-guard.js";

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
 * The note text as `onChange` last saw it, per loaded doc — the "before" side
 * of the sharp-shrink check (`versions/shrink-guard.ts`). Weak, so an unloaded
 * doc takes its entry with it.
 */
const lastSeenText = new WeakMap<Y.Doc, string>();

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
  /** Throttle for {@link RejectedHook}: last time this connection reported a
   *  dropped read-only edit (ms epoch). */
  lastRejectedAt?: number;
}

/** Minimum gap between two `rejected` reports for one connection. */
export const REJECTED_THROTTLE_MS = 5000;

/**
 * Notified when a READ-ONLY connection sends an update carrying ops the server
 * lacks, which Hocuspocus drops with only a bare `syncStatus: false`. The vault
 * channel turns it into a `rejected` frame for that user, so the desktop can park
 * the edit. Attributed connections only; throttled per connection.
 */
export type RejectedHook = (vaultId: string, docId: string, userId: string) => void;

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
  /** The transaction origin's `source` tag (`bulk`, `mcp`, …) when the write came
   *  from the server itself; undefined for an ordinary client edit. */
  source?: string | null,
) => void;

/**
 * Why this message must be refused, or null to let it through.
 *
 * TWO ceilings, and the second is the one experience added. Capping the MESSAGE
 * alone bounds a single step, and a note that doubles doubles from small: a
 * customer's `Map of Content.md` went 276 bytes → 8 MB in seventeen messages,
 * not one of them near the cap, and ended at 16 MB of Yjs state holding
 * 1,179,679 lines of 35 distinct ones. Capping the DOC makes the limit a wall
 * the note cannot be pushed through rather than a step size: a doc under it
 * always accepts one more message, a doc over it accepts none and is a repair
 * job (`POST /api/notes/:id/reset-crdt`).
 *
 * BOTH ceilings are in BYTES, and the doc side has to be MEASURED in bytes —
 * `Y.Text.length` counts UTF-16 code units, which is not the same number the cap
 * is written in. A vault of CJK or emoji notes is 2-4 bytes per unit, so a doc
 * comparing its unit count against a byte cap is admitted well past the limit
 * this is meant to be a wall at. The caller passes the text; `Buffer.byteLength`
 * is the honest size of what would be written to disk.
 */
export function noteSizeRefusal(
  updateBytes: number,
  docText: string,
  capBytes: number = config.maxNoteMb * 1024 * 1024,
): string | null {
  if (updateBytes > capBytes) {
    return `Rejecting oversized sync message: ${updateBytes} bytes (cap ${capBytes})`;
  }
  const docBytes = Buffer.byteLength(docText, "utf8");
  if (docBytes > capBytes) {
    return `Refusing writes to oversized doc: ${docBytes} bytes (cap ${capBytes}) — needs /reset-crdt`;
  }
  return null;
}

export function createSyncServer(
  port: number = config.hocuspocusPort,
  onDocChanged?: DocChangedHook,
  onDocEdited?: DocEditedHook,
  onRejected?: RejectedHook,
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
      const refusal = noteSizeRefusal(
        data.update.byteLength,
        data.document.getText("content").toString(),
      );
      if (refusal) {
        console.error(`${refusal} for ${data.documentName}`);
        throw new NoteTooLargeError();
      }
    },

    /**
     * Read-only drop detection. Runs before Hocuspocus' own readOnly branch
     * (which answers step 2 / update with `syncStatus: false` and discards it).
     * Only step 2 (1) and update (2) carry ops; an update the document already
     * contains (a reconnecting viewer's step 2) is not a rejection.
     */
    async beforeSync(data) {
      if (!onRejected) return;
      const ctx = data.context as SyncContext | undefined;
      if (!ctx?.readOnly || !ctx.userId) return;
      if (data.type !== 1 && data.type !== 2) return;
      const now = Date.now();
      if (ctx.lastRejectedAt && now - ctx.lastRejectedAt < REJECTED_THROTTLE_MS) return;
      let contained = true;
      try {
        contained = Y.snapshotContainsUpdate(Y.snapshot(data.document), data.payload);
      } catch {
        contained = true; // undecodable: Hocuspocus will reject it anyway
      }
      if (contained) return;
      ctx.lastRejectedAt = now;
      try {
        onRejected(ctx.vaultId, ctx.docId, ctx.userId);
      } catch (err) {
        console.error("onRejected hook failed:", err);
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

      // The DB is the authority on permission; the token's `readOnly` claim is
      // only a hint.
      //
      // Trusting the claim alone left a revocation hole exactly as wide as the
      // token TTL (`SYNC_TOKEN_TTL_SECONDS`, 10 min by default): the moment a
      // vault went Read-only, or a lock landed, `disconnectDoc` closed every
      // live socket — but it could not invalidate a token a client already
      // held, so that client reconnected inside the window and was re-admitted
      // as an editor. A kick is a disconnection, not a revocation.
      //
      // One resolver call per connect, which is the right unit: a token is
      // minted per connect anyway, so this adds one query to a path that
      // already did several. `none` rejects the connection outright — the doc
      // was deleted, or the grant is gone — and anything less than `edit` is
      // read-only regardless of what the token says. Never the other way round:
      // a `readOnly` token whose user has since regained `edit` still has to
      // re-mint, because the claim is what the client was told it holds.
      let readOnly = claims.readOnly;
      if (claims.userId) {
        let permission;
        try {
          permission = await syncPermission(claims.userId, parsed.docId);
        } catch (err) {
          // Fail CLOSED. A resolver that cannot answer must not be read as
          // "carry on with whatever the token claimed" — that is the hole this
          // check exists to close, re-opened by a database blip.
          console.error(
            `[onAuthenticate] permission re-check failed for ${data.documentName}:`,
            err,
          );
          throw new Error("Could not verify access to this document");
        }
        if (permission === "none") {
          throw new Error("No access to this document");
        }
        readOnly = claims.readOnly || permission !== "edit";
      }
      // An attribution-less token (`userId` absent) has nobody to resolve, so it
      // keeps the claim. Those predate the `userId` claim and no route can mint
      // one any more — `POST /api/sync-token` always sets it — so this branch
      // covers only tokens already in flight at deploy time, and it dies with
      // them. It is reachable only by someone who can sign with `JWT_SECRET`.

      // View grants: server silently rejects updates from this connection.
      if (readOnly) {
        data.connectionConfig.readOnly = true;
      }

      const context: SyncContext = {
        docId: parsed.docId,
        vaultId: parsed.vaultId,
        readOnly,
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
        lastSeenText.set(data.document, data.document.getText("content").toString());
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
      // Read the text BEFORE any await, so the before/after pair brackets
      // exactly the updates seen so far.
      const text = data.document.getText("content").toString();
      const before = lastSeenText.get(data.document);
      lastSeenText.set(data.document, text);
      // Skip the echo from our own onLoadDocument hydration.
      if (data.transactionOrigin === LOAD_ORIGIN) return;
      const parsed = parseDocName(data.documentName);
      if (!parsed) return;
      if (before !== undefined) {
        const ctx = data.context as Partial<SyncContext> | undefined;
        reportShrink(parsed.vaultId, parsed.docId, before, text, ctx?.userId ?? null);
      }
      // NEVER let this reject. Hocuspocus calls `onChange` unawaited AND
      // uncaught (`handleDocumentUpdate` → `this.hooks("onChange", …)`), so a
      // rejection here is an unhandled rejection, which Node 22 turns into a
      // process exit — a pool-exhaustion blip or a slow compact would take the
      // whole server down and drop every in-memory doc whose updates had not
      // been appended yet.
      //
      // Swallowing it is also the SAFE direction for the client: the update
      // never reached the log, so the client keeps a clock the server lacks and
      // `loadDocDiff` reports `clientAhead` on its next connect — the doc is
      // named on `ready.behind` and re-pushed. A crash loses that signal for
      // every other doc too.
      try {
        await appendUpdate(parsed.docId, data.update);
      } catch (err) {
        console.error(
          `[sync] failed to persist an update for ${data.documentName}; the client stays ahead and will re-push:`,
          err,
        );
        return;
      }
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
          const ctx = data.context as (Partial<SyncContext> & { source?: string }) | undefined;
          const editorId = ctx?.userId ?? null;
          onDocEdited(parsed.vaultId, parsed.docId, editorId, ctx?.source ?? null);
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
