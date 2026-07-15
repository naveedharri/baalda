import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "../config.js";
import { auth } from "../auth/auth.js";
import { blobRoutes } from "./routes/blobs.js";
import { registryRoutes } from "./routes/registry.js";
import { syncTokenRoutes } from "./routes/sync-token.js";
import { vaultTokenRoutes } from "./routes/vault-token.js";
import { desktopOauthRoutes } from "./routes/desktop-oauth.js";
import { createShareRoutes, type ShareDeps } from "./routes/shares.js";
import { createOrgRoutes } from "./routes/orgs.js";
import { graphRoutes } from "./routes/graph.js";
import { createMcpRoutes } from "./routes/mcp.js";
import type { DocWriter } from "../mcp/doc-writer.js";

export interface AppDeps extends ShareDeps {
  /** Server-side note writer for the MCP tools (backed by the sync server). */
  docWriter: DocWriter;
}

/**
 * Origins allowed to call the API cross-origin. The Tauri desktop UI runs on
 * http://localhost:1420 in dev and tauri://localhost / http://tauri.localhost
 * in packaged builds; the configured auth URL is included so a same-origin web
 * client works too. Extra origins can be added via CORS_ORIGINS (comma-list).
 */
function allowedOrigins(): string[] {
  const defaults = [
    "http://localhost:1420",
    "tauri://localhost",
    "http://tauri.localhost",
  ];
  try {
    defaults.push(new URL(config.betterAuthUrl).origin);
  } catch {
    // betterAuthUrl isn't a full URL — skip; defaults still apply.
  }
  const extra = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...defaults, ...extra]));
}

/**
 * The HTTP surface (Hono):
 *  - /api/auth/*  → Better Auth (sign-up/in, sessions, organization plugin:
 *                   invitations, members, etc.)
 *  - /api/sync-token → mint per-doc sync JWTs
 *  - /api/{vaults,folders,notes,files} → registry
 *  - /api/vaults/:id/blobs, /api/blobs/:id → attachment blob store
 *  - /api/shares → folder/file ACL management
 *  - /api/orgs/join-code, /api/orgs/join → workspace join codes
 *  - /api/vaults/:id/graph, /api/vaults/:id/search → note index (links+vectors)
 *  - /api/mcp → Model Context Protocol endpoint (AI clients); /api/mcp/tokens → token mgmt
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // CORS must run before any route (incl. Better Auth) so cross-origin browser
  // clients — chiefly the Tauri webview — succeed and can read auth headers.
  // Applied to everything; also answers OPTIONS preflights for /api/*.
  const origins = allowedOrigins();
  app.use(
    "*",
    cors({
      origin: origins,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "x-file-name", "x-rel-path"],
      // set-auth-token carries the session token the desktop client reads after
      // sign-in/up; without exposing it the browser hides it even on success.
      exposeHeaders: ["set-auth-token"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // Better Auth owns everything under /api/auth (web-standard Request handler).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Desktop Google sign-in handoff — deliberately NOT under /api/auth (the
  // catch-all above would shadow it). See desktop-oauth.ts.
  app.route("/api", desktopOauthRoutes);
  app.route("/api", syncTokenRoutes);
  app.route("/api", vaultTokenRoutes);
  app.route("/api", registryRoutes);
  app.route("/api", blobRoutes);
  app.route("/api", createShareRoutes(deps));
  app.route("/api", createOrgRoutes({ disconnectDoc: deps.disconnectDoc }));
  app.route("/api", graphRoutes);
  app.route(
    "/api",
    createMcpRoutes({ docWriter: deps.docWriter, disconnectDoc: deps.disconnectDoc }),
  );

  return app;
}
