import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { createResolverCache, effectivePermission } from "../../permissions/resolver.js";
import {
  pathDepth,
  prefetchFiles,
  prefetchFolders,
  registerCtx,
  registerFile,
  registerFolder,
  registerNotes,
  type RegisterCtx,
} from "../../registry/batch-ops.js";
import { dirname, samePath } from "../../registry/tree-ops.js";
import { purgeNoteIndex } from "../../index/indexer.js";
import {
  applyDocPushBatch,
  serverDocCoversUpdate,
  type DocApplyItem,
} from "../../sync/doc-batch.js";
import { getSession } from "../session.js";
import { ORIGIN_HEADER } from "./registry.js";
import type {
  BatchStatus,
  DocPushItem,
  DocPushResult,
  FileBatchItem,
  FileBatchResult,
  FolderBatchItem,
  FolderBatchResult,
  NoteBatchItem,
  NoteBatchResult,
  NoteDeleteResult,
} from "./bulk-types.js";

/**
 * Bulk registration + content push.
 *
 * These four routes exist because the per-item ones cost a network round trip
 * each: turning on sync for a 5,000-note vault was 5,000 `POST /api/notes`, then
 * 5,000 `POST /api/sync-token` and 5,000 WebSocket handshakes, at widths 6 and 4
 * — measured at 3.7 notes/s, and unable to finish in one pass because
 * `ready.empty` is capped at 2,000. Nothing here is a new WRITE path: every item
 * lands through exactly the same functions the single-item routes call
 * (`registry/batch-ops.ts`, `sync/doc-batch.ts`), so a batch and N singles
 * produce the same rows and the same refusal codes. What is removed is the
 * transport, not the rules.
 *
 * **No transaction per chunk.** Items are independently idempotent, and a 23505
 * on `notes_live_path_uq` — which the adopt path treats as "someone else won the
 * race, take their row" — would abort a surrounding transaction and take the
 * other 199 items with it. They run autocommit on ONE checked-out connection
 * instead, which bounds a batch to a single pool slot while the vault channel's
 * backfill competes for the rest.
 */

export interface BulkDeps {
  /** Structure changed → the vault channel tells every open client to re-pull.
   *  Fired ONCE per request, not per item: a 200-note batch that broadcast per
   *  item would cost 200 per-subscriber ACL recomputes for one logical change. */
  onRegistryChanged?: (vaultId: string, originId: string | null) => void;
  /**
   * Close every socket on a doc AND drop the server's cached copy.
   *
   * `disconnectDoc` alone is not enough once the row is gone: Hocuspocus keeps
   * the loaded `Y.Doc` and serves that cached copy to the next connect, and 200
   * of those stay resident afterwards. Deliberately run AFTER the response, off
   * the request path — kicking an editor is not something the caller waits for.
   */
  evictDoc?: (vaultId: string, docId: string) => Promise<void> | void;
}

/** Ids per destructive statement. Postgres holds the whole `= ANY` array in
 *  memory (a million ids is ~700 MB), so a big delete is chunked rather than
 *  sent as one array.
 *
 *  It guards nothing today and is not meant to: this route rejects a body over
 *  `config.batchMaxNotes` (200) long before it chunks, so every loop below is a
 *  single pass. It is here so the chunking already exists the day that cap moves
 *  or these helpers get a caller that is not the route. */
const DELETE_CHUNK = 5000;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Auth, verbatim from `http/routes/vault-token.ts`: session → vault → member.
 *  Carries the contract's codes so a client can branch without string-matching. */
async function gate(c: Context): Promise<{ userId: string; vaultId: string } | Response> {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const vaultId = c.req.param("vaultId") ?? "";
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault", code: "unknown_vault" }, 404);
  const role = await orgRole(org, session.userId);
  if (!role) return c.json({ error: "Not a member of this vault", code: "not_a_member" }, 403);
  return { userId: session.userId, vaultId };
}

/** `{ items: [...] }`, or a 400 describing what is wrong with it. */
function readItems(body: unknown, max: number): unknown[] | { error: string; code: string } {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { error: "items array required", code: "invalid_body" };
  if (items.length > max) {
    return { error: `at most ${max} items per request`, code: "batch_too_large" };
  }
  return items;
}

/** Run `fn` over items with at most `limit` in flight. A rejection propagates,
 *  which turns a database failure into a 500 rather than a partial answer. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    }),
  );
}

/**
 * `folderPath` is a CROSS-CHECK, never the location.
 *
 * `relPath` is authoritative — `registerNote`/`registerFile` resolve the parent
 * from it, which is what closed the 2026-08-27 phantom-root-folder (a client
 * whose two fields disagreed wrote a row every device rendered in one place and
 * every ACL walk read in another). So this does not place the item; it refuses
 * one whose own two fields contradict each other, which is exactly the state
 * that incident was made of. Absent (or null) ⇒ nothing to check.
 */
function folderPathDisagrees(relPath: string, folderPath: string | null): boolean {
  if (folderPath === null) return false;
  return !samePath(folderPath, dirname(relPath));
}

/** Borrow ONE pooled connection for a whole registration batch. Every item runs
 *  autocommit on it, so the batch is one pool slot and one session — not 200
 *  interleaved checkouts racing the vault channel for `PG_POOL_MAX`. */
async function withRegisterCtx<T>(
  vaultId: string,
  userId: string,
  fn: (ctx: RegisterCtx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(
      registerCtx(vaultId, userId, client as unknown as Pick<pg.Pool, "query">, {
        // One permission memo for the whole request. `canCreateIn` is already
        // memoised per folder; this makes folders 2..N of a batch ~3 queries
        // instead of ~7, because the member role and the vault baseline are
        // facts about the VAULT, not about the folder. The verdict is still
        // `canCreateIn`'s — see `permissions/resolver.ts ResolverCache`.
        resolverCache: createResolverCache(),
      }),
    );
  } finally {
    client.release();
  }
}

export function createBulkRoutes(deps: BulkDeps = {}): Hono {
  const routes = new Hono();
  const changed = (c: { req: { header: (n: string) => string | undefined } }, vaultId: string) =>
    deps.onRegistryChanged?.(vaultId, c.req.header(ORIGIN_HEADER) ?? null);

  // ── folders ──────────────────────────────────────────────────────────────
  routes.post("/vaults/:vaultId/folders/batch", async (c) => {
    const auth = await gate(c);
    if (auth instanceof Response) return auth;
    const body = await c.req.json().catch(() => null);
    const items = readItems(body, config.batchMaxFolders);
    if (!Array.isArray(items)) return c.json(items, 400);

    const parsed = items.map((raw, index) => {
      const it = (raw ?? {}) as Partial<FolderBatchItem>;
      return {
        index,
        path: typeof it.path === "string" ? it.path : "",
        name: typeof it.name === "string" ? it.name : "",
        color: it.color,
      };
    });

    const results: FolderBatchResult[] = parsed.map((p) => ({
      path: p.path,
      id: null,
      status: "error" as BatchStatus,
      code: "invalid_body",
      error: "path and name are required",
    }));

    // Depth order, resolved in-request. This is what deletes the client's
    // level-by-level loop: it sends the whole tree in one call, in any order,
    // and `a/b/c` still finds `a/b` because `a/b` was inserted earlier in this
    // very pass. A stable secondary sort on the original index keeps two folders
    // at the same depth in the order the caller listed them.
    const ordered = parsed
      .filter((p) => p.path !== "" && p.name !== "")
      .sort((a, b) => pathDepth(a.path) - pathDepth(b.path) || a.index - b.index);

    let wrote = false;
    await withRegisterCtx(auth.vaultId, auth.userId, async (ctx) => {
      // One `lower(path) = ANY($1)` read answers every adopt probe AND every
      // parent lookup this batch is about to make. Misses are cached too — "no
      // folder here yet" is the answer for most of a fresh tree — and each
      // create writes through, so `a/b/c` still finds the `a/b` two items back.
      await prefetchFolders(ctx, [
        ...ordered.map((i) => i.path),
        ...ordered.map((i) => dirname(i.path)),
      ]);
      for (const item of ordered) {
        try {
          const out = await registerFolder(ctx, { path: item.path, name: item.name, color: item.color });
          if (out.status === "error") {
            results[item.index] = {
              path: item.path,
              id: null,
              status: "error",
              code: out.code,
              error: out.message,
            };
            continue;
          }
          wrote ||= out.wrote;
          results[item.index] = {
            path: out.row.path,
            id: out.row.id,
            status: out.status,
            code: null,
            error: null,
          };
        } catch (err) {
          // Per item. One bad path must not cost the other 499 their pass.
          results[item.index] = {
            path: item.path,
            id: null,
            status: "error",
            code: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    });
    if (wrote) changed(c, auth.vaultId);
    return c.json({ results });
  });

  // ── notes ────────────────────────────────────────────────────────────────
  routes.post("/vaults/:vaultId/notes/batch", async (c) => {
    const auth = await gate(c);
    if (auth instanceof Response) return auth;
    const body = await c.req.json().catch(() => null);
    const items = readItems(body, config.batchMaxNotes);
    if (!Array.isArray(items)) return c.json(items, 400);

    const parsed = items.map((raw, index) => {
      const it = (raw ?? {}) as Partial<NoteBatchItem>;
      return {
        index,
        relPath: typeof it.relPath === "string" ? it.relPath : "",
        docId: typeof it.docId === "string" && it.docId ? it.docId : undefined,
        title: typeof it.title === "string" ? it.title : null,
        // `folderPath` rather than a folderId: a path needs no cross-chunk
        // ordering, so a note can be registered in the same pass as its folder.
        // It is a CROSS-CHECK, not the location — see `folderPathDisagrees`.
        folderPath: typeof it.folderPath === "string" ? it.folderPath : null,
      };
    });

    const results: NoteBatchResult[] = parsed.map((p) => ({
      relPath: p.relPath,
      docId: null,
      status: "error" as BatchStatus,
      folderId: null,
      title: null,
      code: "invalid_body",
      error: "relPath is required",
    }));

    let wrote = false;
    await withRegisterCtx(auth.vaultId, auth.userId, async (ctx) => {
      // Everything whose own two fields agree goes to `registerNotes` in ONE
      // call: it prefills the adopt + parent-folder maps with one `= ANY` read
      // each and writes the survivors with one `unnest` INSERT, instead of the
      // 1–3 serial queries per item this loop used to pay on one connection.
      const eligible: typeof parsed = [];
      for (const item of parsed) {
        if (item.relPath === "") continue;
        if (folderPathDisagrees(item.relPath, item.folderPath)) {
          results[item.index] = {
            relPath: item.relPath,
            docId: null,
            status: "error",
            folderId: null,
            title: null,
            code: "path_folder_mismatch",
            error: `"${item.relPath}" is not inside folder "${item.folderPath}"`,
          };
          continue;
        }
        eligible.push(item);
      }
      if (eligible.length === 0) return;

      let outcomes;
      try {
        outcomes = await registerNotes(
          ctx,
          eligible.map((item) => ({
            relPath: item.relPath,
            docId: item.docId,
            title: item.title,
          })),
        );
      } catch (err) {
        // Per request now rather than per item, because the batch shares one
        // statement: a failure that is not a per-row refusal (a dead connection,
        // a statement timeout) is the same failure for every row in it, and each
        // still gets its own result rather than a 500 for the whole call.
        const error = err instanceof Error ? err.message : String(err);
        for (const item of eligible) {
          results[item.index] = {
            relPath: item.relPath,
            docId: null,
            status: "error",
            folderId: null,
            title: null,
            code: null,
            error,
          };
        }
        return;
      }

      outcomes.forEach((out, i) => {
        const item = eligible[i];
        if (out.status === "conflict") {
          results[item.index] = {
            relPath: item.relPath,
            docId: item.docId ?? null,
            status: "conflict",
            folderId: null,
            title: null,
            code: out.code,
            error: out.message,
          };
          return;
        }
        if (out.status === "error") {
          results[item.index] = {
            relPath: item.relPath,
            docId: null,
            status: "error",
            folderId: null,
            title: null,
            code: out.code,
            error: out.message,
          };
          return;
        }
        wrote ||= out.wrote;
        // The row's CANONICAL spelling, exactly as `POST /api/notes` echoes
        // it: a desktop whose disk spells the path differently adopts this and
        // stops re-registering its own spelling on every pass.
        results[item.index] = {
          relPath: out.row.relPath,
          docId: out.row.id,
          status: out.status,
          folderId: out.row.folderId,
          title: out.row.title,
          code: null,
          error: null,
        };
      });
    });
    if (wrote) changed(c, auth.vaultId);
    return c.json({ results });
  });

  // ── files (tree binaries) ────────────────────────────────────────────────
  routes.post("/vaults/:vaultId/files/batch", async (c) => {
    const auth = await gate(c);
    if (auth instanceof Response) return auth;
    const body = await c.req.json().catch(() => null);
    const items = readItems(body, config.batchMaxFiles);
    if (!Array.isArray(items)) return c.json(items, 400);

    const parsed = items.map((raw, index) => {
      const it = (raw ?? {}) as Partial<FileBatchItem>;
      return {
        index,
        relPath: typeof it.relPath === "string" ? it.relPath : "",
        fileId: typeof it.fileId === "string" && it.fileId ? it.fileId : undefined,
        folderPath: typeof it.folderPath === "string" ? it.folderPath : null,
      };
    });

    const results: FileBatchResult[] = parsed.map((p) => ({
      relPath: p.relPath,
      fileId: null,
      status: "error" as BatchStatus,
      folderId: null,
      code: "invalid_body",
      error: "relPath is required",
    }));

    let wrote = false;
    await withRegisterCtx(auth.vaultId, auth.userId, async (ctx) => {
      await prefetchFiles(
        ctx,
        parsed.map((i) => i.relPath),
      );
      for (const item of parsed) {
        if (item.relPath === "") continue;
        if (folderPathDisagrees(item.relPath, item.folderPath)) {
          results[item.index] = {
            relPath: item.relPath,
            fileId: null,
            status: "error",
            folderId: null,
            code: "path_folder_mismatch",
            error: `"${item.relPath}" is not inside folder "${item.folderPath}"`,
          };
          continue;
        }
        try {
          // `sha256`/`size`/`mime` ride the item for the blob store's benefit
          // and are deliberately not written here: a `files` row is identity +
          // path, and the bytes are registered by the upload itself. Accepting
          // them keeps ONE item shape between the two halves of a file's sync.
          const out = await registerFile(ctx, { path: item.relPath, docId: item.fileId });
          if (out.status === "error") {
            results[item.index] = {
              relPath: item.relPath,
              fileId: null,
              status: "error",
              folderId: null,
              code: out.code,
              error: out.message,
            };
            continue;
          }
          wrote ||= out.wrote;
          results[item.index] = {
            relPath: out.row.path,
            fileId: out.row.id,
            status: out.status,
            folderId: out.row.folderId,
            code: null,
            error: null,
          };
        } catch (err) {
          results[item.index] = {
            relPath: item.relPath,
            fileId: null,
            status: "error",
            folderId: null,
            code: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    });
    if (wrote) changed(c, auth.vaultId);
    return c.json({ results });
  });

  // ── content push ─────────────────────────────────────────────────────────
  //
  // 16 MB bounds what is read off the socket; `batchMaxDecodedBytes` bounds what
  // survives base64 decoding into heap, which is the number that matters with
  // four of these in flight against a 512 MB cap.
  routes.post(
    "/vaults/:vaultId/docs/batch",
    bodyLimit({ maxSize: 16 * 1024 * 1024 }),
    async (c) => {
      const auth = await gate(c);
      if (auth instanceof Response) return auth;
      const body = await c.req.json().catch(() => null);
      const items = readItems(body, config.batchMaxDocs);
      if (!Array.isArray(items)) return c.json(items, 400);

      const perItemCap = config.maxNoteMb * 1024 * 1024;
      const results: DocPushResult[] = [];
      const pending: Array<{ index: number; item: DocApplyItem }> = [];
      let decodedTotal = 0;

      items.forEach((raw, index) => {
        const it = (raw ?? {}) as Partial<DocPushItem>;
        const docId = typeof it.docId === "string" ? it.docId : "";
        results.push({ docId, status: "error", code: "invalid_body", error: null });
        if (!docId || typeof it.update !== "string") {
          results[index].error = "docId and update are required";
          return;
        }
        let update: Buffer;
        try {
          update = Buffer.from(it.update, "base64");
        } catch {
          results[index].error = "update is not valid base64";
          return;
        }
        // In BYTES, against the same ceiling the CRDT store enforces. A runaway
        // doc is the 2026-08-25 fork loop, and refusing it here is cheaper than
        // refusing it after it has been merged into a snapshot.
        if (update.length > perItemCap) {
          results[index] = { docId, status: "too_large", code: "note_too_large", error: null };
          return;
        }
        decodedTotal += update.length;
        pending.push({ index, item: { docId, update, expectEmpty: it.expectEmpty === true } });
      });

      // Request-level, and only over the items that could have been applied — an
      // oversized item is already answered per item above and must not turn the
      // other 99 into a 400.
      if (decodedTotal > config.batchMaxDecodedBytes) {
        return c.json(
          {
            error: `at most ${config.batchMaxDecodedBytes} decoded bytes per request`,
            code: "batch_too_large",
          },
          400,
        );
      }

      // Scoped to THIS vault, like `POST /vaults/:id/access-check`: a doc id with
      // no live row here never reaches the resolver. Without it a caller could
      // push into a doc they may edit in a DIFFERENT vault through this vault's
      // doc name, which is how a live document ends up keyed to the wrong vault.
      const askedIds = [...new Set(pending.map((p) => p.item.docId))];
      const { rows: present } = await pool.query<{ id: string }>(
        "SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])",
        [auth.vaultId, askedIds],
      );
      const inVault = new Set(present.map((r) => r.id));

      // Per-item permission is the EXISTING resolver, memoised per request and
      // run at the same width the vault channel backfills at. Deliberately NOT a
      // new set-based "editable docs" query: a second permission algebra that
      // disagreed with `effectivePermission` would not be a 403, it would be a
      // healing LOOP — the client is told a doc is empty, pushes, is refused,
      // and `ready.empty` names it again on the next connect, forever.
      //
      // What IS memoised is the resolver's INPUTS: the member role, the vault
      // baseline and each folder's ancestor chain are facts the whole request
      // shares, and they were 4 of the 7–8 queries every single doc paid for.
      const permission = new Map<string, string>();
      const resolverCache = createResolverCache();
      await runPool(askedIds, config.backfillConcurrency, async (docId) => {
        permission.set(
          docId,
          inVault.has(docId)
            ? await effectivePermission(auth.userId, docId, pool, resolverCache)
            : "none",
        );
      });

      const permitted: Array<{ index: number; item: DocApplyItem }> = [];
      const readOnly: Array<{ index: number; item: DocApplyItem }> = [];
      for (const p of pending) {
        if (permission.get(p.item.docId) !== "edit") {
          if (permission.get(p.item.docId) === "view") readOnly.push(p);
          else
            results[p.index] = {
              docId: p.item.docId,
              status: "denied",
              code: "no_edit_permission",
              error: null,
            };
          continue;
        }
        permitted.push(p);
      }

      // A view-only client often sends its full state immediately after a
      // Private→Read-only re-download. Refusing that as an edit invents one
      // error per note even when the server already holds every operation.
      // State-vector comparison is read-only: answer `skipped` only when the
      // server provably covers the submitted state; genuine client-ahead ops
      // remain denied and the desktop preserves their file as a recovery copy.
      await runPool(readOnly, config.backfillConcurrency, async (p) => {
        let covered = false;
        try {
          covered = await serverDocCoversUpdate(auth.vaultId, p.item.docId, p.item.update);
        } catch {
          covered = false;
        }
        results[p.index] = covered
          ? { docId: p.item.docId, status: "skipped", code: null, error: null }
          : {
              docId: p.item.docId,
              status: "denied",
              code: "no_edit_permission",
              error: null,
            };
      });

      const applied = await applyDocPushBatch(
        auth.vaultId,
        permitted.map((p) => p.item),
        { userId: auth.userId },
      );
      applied.forEach((out, i) => {
        const index = permitted[i].index;
        results[index] =
          out.outcome === "error"
            ? { docId: out.docId, status: "error", code: null, error: out.error ?? null }
            : { docId: out.docId, status: out.outcome, code: null, error: null };
      });

      return c.json({ results });
    },
  );

  // ── delete (soft) ────────────────────────────────────────────────────────
  //
  // The batched twin of `DELETE /api/notes/:id`, and the SAME write: a row is
  // soft-deleted (`deleted_at`, keeping its doc_id and its Yjs doc, so a
  // teammate with it open loses tree visibility rather than their text) and its
  // derived `note_index` / `note_links` / `blob_refs` rows go with it — those
  // are a rebuildable cache of the canonical Yjs state (m005), and `note_index`
  // holds a FULL PLAIN-TEXT COPY of the body, so leaving it behind is both
  // unbounded growth and deleted content still readable server-side.
  //
  // What the batch removes is the transport: 500 sidebar deletes were 500
  // requests, each re-resolving the permission algebra from scratch and each
  // broadcasting a `registry-changed` the whole vault re-pulled on.
  routes.post("/vaults/:vaultId/notes/delete-batch", async (c) => {
    const auth = await gate(c);
    if (auth instanceof Response) return auth;
    const body = await c.req.json().catch(() => null);
    const raw = (body as { docIds?: unknown } | null)?.docIds;
    if (!Array.isArray(raw)) {
      return c.json({ error: "docIds array required", code: "invalid_body" }, 400);
    }
    if (raw.length > config.batchMaxNotes) {
      return c.json(
        { error: `at most ${config.batchMaxNotes} items per request`, code: "batch_too_large" },
        400,
      );
    }

    const docIds = raw.map((d) => (typeof d === "string" ? d : ""));
    const results: NoteDeleteResult[] = docIds.map((docId) => ({
      docId,
      status: "error",
      code: "invalid_body",
      error: "docId must be a string",
    }));

    // Scoped to THIS vault, exactly like the push route: an id with no LIVE
    // `notes` row here never reaches the resolver, so a caller cannot delete
    // through this vault's path something that lives in another one.
    const asked = [...new Set(docIds.filter((d) => d !== ""))];
    const inVault = new Set<string>();
    for (const slice of chunked(asked, DELETE_CHUNK)) {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])",
        [auth.vaultId, slice],
      );
      for (const r of rows) inVault.add(r.id);
    }

    // ONE permission algebra: the same `effectivePermission` the single-item
    // route asks through `canEditDoc`, per doc, with only its INPUTS memoised
    // (see `permissions/resolver.ts ResolverCache`). A set-based "deletable
    // docs" dual that disagreed would not be a 403, it would be a client that
    // deletes its local file and finds the note again on the next pull.
    const permission = new Map<string, string>();
    const resolverCache = createResolverCache();
    await runPool(asked, config.backfillConcurrency, async (docId) => {
      permission.set(
        docId,
        inVault.has(docId) ? await effectivePermission(auth.userId, docId, pool, resolverCache) : "none",
      );
    });

    const deletable: string[] = [];
    docIds.forEach((docId, index) => {
      if (docId === "") return;
      if (!inVault.has(docId)) {
        results[index] = {
          docId,
          status: "error",
          code: "unknown_note",
          error: "No live note with this id in this vault",
        };
        return;
      }
      if (permission.get(docId) !== "edit") {
        results[index] = { docId, status: "denied", code: "no_edit_permission", error: null };
        return;
      }
      results[index] = { docId, status: "deleted", code: null, error: null };
      deletable.push(docId);
    });

    const unique = [...new Set(deletable)];
    for (const slice of chunked(unique, DELETE_CHUNK)) {
      await pool.query(
        "UPDATE notes SET deleted_at = now() WHERE id = ANY($1::text[]) AND deleted_at IS NULL",
        [slice],
      );
      await purgeNoteIndex(slice);
    }

    // ONE broadcast for the batch — the whole reason this route exists beside
    // the per-item one.
    if (unique.length > 0) changed(c, auth.vaultId);

    // Off the response path: 200 `evictDoc` calls in one un-yielded tick block
    // the event loop the HTTP and WebSocket listeners share, and nothing the
    // caller does depends on the answer.
    if (unique.length > 0 && deps.evictDoc) {
      const evict = deps.evictDoc;
      setImmediate(() => {
        void (async () => {
          for (const docId of unique) {
            try {
              await evict(auth.vaultId, docId);
            } catch (err) {
              console.warn(`[bulk] evictDoc failed for ${docId}:`, err);
            }
          }
        })();
      });
    }

    return c.json({ results });
  });

  return routes;
}
