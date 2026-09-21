// SPDX-License-Identifier: Apache-2.0
// Agent engine host: included for self-hosting, Pro-gated on Baalda Cloud.
import { requiresCloudPlan } from "../../deployment-policy.js";
import { OpenRouter } from "@openrouter/sdk";
import { Hono } from "hono";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { bodyLimit } from "hono/body-limit";
import { pool } from "../../db/pool.js";
import { getSession } from "../session.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { effectivePermission } from "../../permissions/resolver.js";
import { listReadableDocsInVault } from "../../permissions/vault-docs.js";
import { revisionOf, type DocWriter } from "../../mcp/doc-writer.js";

export interface HousekeeperNote { id: string; path: string; title: string }
export interface HousekeeperHost {
  authorize(): Promise<void>;
  requiresPro?(): boolean;
  providerConfig?(): { mode: string; model: string; configured: boolean };
  createRouter(): OpenRouter;
  notes(): Promise<HousekeeperNote[]>;
  read(id: string, edit?: boolean): Promise<{ content: string; revision: string; path: string }>;
  canEdit?(id: string, path?: string): Promise<void>;
  recoveryVersion?(id: string): Promise<{ content: string; createdAt: string } | null>;
  edit(id: string, revision: string, index: number, before: string, after: string): Promise<string>;
}
export interface HousekeeperExtension {
  handle(action: string, body: unknown, scope: string, host: HousekeeperHost): Promise<unknown>;
}
export class HousekeeperError extends Error {
  constructor(public status: 400 | 401 | 402 | 403 | 404 | 409 | 429 | 503, message: string) { super(message); }
}

/** Self-hosters have access regardless of billing; Cloud vaults require Pro. */
export async function requireHousekeeperPro(orgId: string): Promise<void> {
  if (!requiresCloudPlan()) return;
  // Explicit local preview only; never implied by disabled billing or a client flag.
  if (process.env.NODE_ENV === "development" && process.env.HOUSEKEEPER_LOCAL_PREVIEW === "true") {
    try {
      const database = new URL(process.env.DATABASE_URL ?? "");
      if (["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)) return;
    } catch { /* Missing/malformed configuration keeps the Pro gate closed. */ }
  }
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT (plan = 'pro' AND status IN ('active', 'past_due') AND deleted_at IS NULL) AS allowed
       FROM subscriptions WHERE organization_id = $1`, [orgId],
  );
  if (rows[0]?.allowed !== true) throw new HousekeeperError(402, "Housekeeper requires a Pro vault.");
}

async function loadExtension(): Promise<HousekeeperExtension | null> {
  // An explicit path supports packaged deployments; source and dist share depth.
  const location = process.env.HOUSEKEEPER_MODULE
    ? pathToFileURL(process.env.HOUSEKEEPER_MODULE)
    : new URL("../../../housekeeper/index.mjs", import.meta.url);
  try { await access(location); } catch { return null; }
  return await import(location.href) as HousekeeperExtension;
}

export function createHousekeeperRoutes(docWriter: DocWriter): Hono {
  const routes = new Hono();
  routes.use("/vaults/:vaultId/housekeeper/*", bodyLimit({ maxSize: 4096 }));
  routes.all("/vaults/:vaultId/housekeeper/:action", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const session = await getSession(c);
      if (!session) throw new HousekeeperError(401, "Sign in to use Housekeeper.");
      const vaultId = c.req.param("vaultId");
      const userId = session.userId;
      const authorize = async () => {
        const orgId = await vaultOrg(vaultId);
        if (!orgId || !await orgRole(orgId, userId)) throw new HousekeeperError(403, "Vault access denied.");
        await requireHousekeeperPro(orgId);
      };
      await authorize(); // Before loading the agent engine, reading notes or calling a model.
      const extension = await loadExtension();
      if (!extension) throw new HousekeeperError(503, "Housekeeper is not installed on this server.");
      const note = async (id: string, edit = false) => {
        const { rows } = await pool.query<{ rel_path: string }>(
          "SELECT rel_path FROM notes WHERE id = $1 AND vault_id = $2 AND deleted_at IS NULL", [id, vaultId],
        );
        if (!rows[0]) throw new HousekeeperError(404, "Note is no longer available.");
        const permission = await effectivePermission(userId, id);
        if (permission === "none" || (edit && permission !== "edit")) throw new HousekeeperError(403, "Note access denied.");
        return rows[0];
      };
      const action = c.req.param("action");
      if ((action === "status" && c.req.method !== "GET") || (action !== "status" && c.req.method !== "POST")) return c.json({ error: "Method not allowed" }, 405);
      const body = action === "status" ? {} : await c.req.json().catch(() => { throw new HousekeeperError(400, "Invalid JSON."); });
      const provider = body?.provider;
      const inference = ["suggest", "repair", "diagnose"].includes(action);
      if (inference && (provider?.name !== "openrouter" || typeof provider.apiKey !== "string" || !/^sk-or-[A-Za-z0-9_-]{10,250}$/.test(provider.apiKey) ||
        !["decisions", "chat"].includes(provider.mode) || typeof provider.model !== "string" || !/^[~A-Za-z0-9][A-Za-z0-9._~:/-]{1,149}$/.test(provider.model))) {
        throw new HousekeeperError(400, "Add your OpenRouter API key and choose a model in AI settings.");
      }
      const host: HousekeeperHost = {
        authorize,
        requiresPro: requiresCloudPlan,
        providerConfig: () => ({ mode: provider?.mode ?? "decisions", model: provider?.model ?? "typesafe/jev-1.13", configured: true }),
        createRouter: () => new OpenRouter({ apiKey: provider?.apiKey, appTitle: "Baalda Housekeeper", timeoutMs: 12_000, retryConfig: { strategy: "none" } }),
        async notes() {
          const readable = await listReadableDocsInVault(userId, vaultId);
          const { rows } = await pool.query<HousekeeperNote>(
            `SELECT id, rel_path AS path, COALESCE(title, '') AS title FROM notes
              WHERE vault_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])
              ORDER BY id LIMIT 2001`, [vaultId, [...readable]],
          );
          if (rows.length > 2000) throw new HousekeeperError(409, "This preview supports up to 2,000 readable notes per vault.");
          return rows;
        },
        async read(id, edit) {
          const row = await note(id, edit);
          const content = await docWriter.peekContent(vaultId, id);
          if (content === null) throw new HousekeeperError(409, "Wait for this note to finish syncing, then retry.");
          if (content.length > 100_000) throw new HousekeeperError(409, "This preview supports notes up to 100,000 characters.");
          return { content, revision: revisionOf(content), path: row.rel_path };
        },
        async canEdit(id, path) {
          await authorize(); const current = await note(id, true);
          if (path !== undefined && current.rel_path !== path) throw new HousekeeperError(409, "The file moved. Prepare a fresh action.");
        },
        async recoveryVersion(id) {
          await note(id, true);
          const { rows } = await pool.query<{ content: string; created_at: string }>(
            `SELECT content, created_at FROM note_versions WHERE doc_id = $1 AND vault_id = $2
             AND octet_length(content) > 0 AND octet_length(content) <= 100000 ORDER BY id DESC LIMIT 1`, [id, vaultId]);
          return rows[0] ? { content: rows[0].content, createdAt: String(rows[0].created_at) } : null;
        },
        async edit(id, revision, index, before, after) {
          await authorize();
          await note(id, true);
          const result = await docWriter.editContent(vaultId, id, (current) => {
            if (revisionOf(current) !== revision || current.slice(index, index + before.length) !== before) {
              throw new HousekeeperError(409, "The note changed. Review fresh suggestions before applying.");
            }
            return [{ index, deleteLength: before.length, insert: after }];
          }, { userId });
          return result.revision;
        },
      };
      const result = await extension.handle(action, body, JSON.stringify([vaultId, userId]), host);
      return c.json(result);
    } catch (error) {
      // Commercial modules return public errors by status; never expose provider bodies/keys.
      const status = error instanceof Error && "status" in error ? Number(error.status) : 503;
      const allowed = [400, 401, 402, 403, 404, 409, 429, 503] as const;
      const code = allowed.includes(status as typeof allowed[number]) ? status as typeof allowed[number] : 503;
      return c.json({ error: code === 503 ? "Housekeeper is unavailable. Check the server's provider configuration and retry." : (error as Error).message,
        code: code === 402 ? "housekeeper_requires_pro" : "housekeeper_unavailable" }, code);
    }
  });
  return routes;
}
