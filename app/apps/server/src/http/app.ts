import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { config } from "../config.js";
import { auth } from "../auth/auth.js";
import { oauthConnectRoutes } from "./routes/oauth-connect.js";
import { openLinkRoutes } from "./routes/open-link.js";
import { createPublicPageRoutes, publicLinkApiRoutes } from "./routes/public-links.js";
import { blobRoutes } from "./routes/blobs.js";
import { createRegistryRoutes, ORIGIN_HEADER } from "./routes/registry.js";
import { syncTokenRoutes } from "./routes/sync-token.js";
import { vaultTokenRoutes } from "./routes/vault-token.js";
import { desktopOauthRoutes } from "./routes/desktop-oauth.js";
import { createShareRoutes, type ShareDeps } from "./routes/shares.js";
import { createOrgRoutes } from "./routes/orgs.js";
import { graphRoutes } from "./routes/graph.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { createRepairRoutes } from "./routes/repair.js";
import { createVersionRoutes } from "./routes/versions.js";
import { createBillingRoutes } from "./routes/billing.js";
import { PolarBillingProvider } from "../billing/polar.js";
import type { BillingProvider } from "../billing/provider.js";
import type { DocWriter } from "../mcp/doc-writer.js";

export interface AppDeps extends ShareDeps {
  /** Server-side note writer for the MCP tools (backed by the sync server). */
  docWriter: DocWriter;
  /**
   * Close every socket on a doc AND drop the server's cached copy of it.
   *
   * Stronger than `disconnectDoc`, and required by any route that rewrites a
   * doc's rows underneath the sync server: without the unload, Hocuspocus keeps
   * the loaded `Y.Doc` and hands that stale copy to the next client, undoing the
   * write. Backed by `sync/hocuspocus.ts` `evictDoc`.
   */
  evictDoc: (vaultId: string, docId: string) => Promise<void> | void;
  /** Payment provider. Defaults to Polar; tests inject a fake. */
  billingProvider?: BillingProvider;
  /**
   * Structure changed (folder/note create/rename/move/delete) → broadcast.
   * `originId` identifies the client that made the change (x-baalda-origin), so
   * the broadcast can skip it — see `RegistryDeps.onRegistryChanged`.
   *
   * **Required**, unlike its counterparts on the inner `RegistryDeps`/`McpDeps`.
   * This is the one seam where the whole app is constructed, and forgetting it
   * here is both catastrophic and silent: every write still succeeds, and no
   * running app ever hears about it — a note exists in Postgres and in nobody's
   * sidebar until they restart. Making it required turns that into a compile
   * error. Pass an explicit no-op if a test genuinely doesn't care.
   */
  onRegistryChanged: (vaultId: string, originId: string | null) => void;
  /**
   * Access changed in a collection → subscribers re-resolve their readable set.
   *
   * Narrowed from optional (`ShareDeps`) to **required** here for the same reason,
   * with sharper teeth: this is the only thing that revokes access on a live
   * vault-channel socket. An app built without it keeps streaming vault content to
   * someone whose share — or whose membership — was just taken away, until their
   * token expires. Inner routers keep it optional for focused unit tests.
   */
  onAclChanged: (vaultId: string) => void;
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
 *  - /api/notes/:id/versions, /api/vaults/:id/checkpoints → version history
 *  - /api/shares → folder/file ACL management
 *  - /api/notes/:docId/public-link → mint/inspect/revoke a public note link
 *  - /p/:token → public read-only note page (no auth; token is the capability)
 *  - /api/orgs/join-code, /api/orgs/join → vault join codes
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
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "x-file-name",
        "x-rel-path",
        // Opaque per-client instance id on registry writes, so the vault channel
        // doesn't tell a client to re-pull its own structural change.
        ORIGIN_HEADER,
      ],
      // set-auth-token carries the session token the desktop client reads after
      // sign-in/up; without exposing it the browser hides it even on success.
      exposeHeaders: ["set-auth-token"],
    }),
  );

  // Response compression for the JSON API. The registry listings are what make
  // this worth having: GET /api/notes for a several-hundred-note vault is a few
  // hundred KB of highly repetitive JSON, and it is on the critical path of every
  // client start-up and every `registry` broadcast.
  //
  // After CORS (so preflights are answered plain) and scoped to /api/*, which
  // also keeps it off the WS upgrade paths — those are handled by the Node
  // server, not by Hono, but /health and /p/:token stay uncompressed too.
  //
  // Hono's compress already limits itself to compressible content types (its
  // default regex covers JSON/text and never image/*, application/octet-stream
  // or text/event-stream). Blob DOWNLOAD is nonetheless excluded by path rather
  // than trusted to that: a stored mime of text/markdown would otherwise put a
  // re-encode on a route whose only job is handing back exact bytes. The blob
  // LIST route (/api/vaults/:id/blobs) is JSON and stays compressed.
  const compressor = compress();
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/blobs/")) return next();
    return compressor(c, next);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ── MCP OAuth discovery (RFC 8414 / RFC 9728) ─────────────────────────────
  // These MUST sit at the origin root: our protected-resource metadata names
  // the origin as the authorization server, so an MCP client (e.g. a Claude
  // custom connector) fetches /.well-known/* from the origin, not /api/auth.
  // The helpers proxy to the Better Auth `mcp` plugin's own endpoints.
  app.get("/.well-known/oauth-authorization-server", (c) =>
    oAuthDiscoveryMetadata(auth)(c.req.raw),
  );
  app.get("/.well-known/oauth-protected-resource", (c) =>
    oAuthProtectedResourceMetadata(auth)(c.req.raw),
  );
  // The human-facing login + consent screens of that OAuth flow.
  app.route("/", oauthConnectRoutes);

  // Clickable share links: https://<server>/open/note/… bounces into the app's
  // baalda:// deep link. Public — the URL carries identity, never access.
  app.route("/", openLinkRoutes);

  // Public note pages: /p/<token> renders a note read-only for anyone with the
  // link. Here the URL DOES carry access — the token is the capability.
  app.route("/", createPublicPageRoutes({ docWriter: deps.docWriter }));

  // Better Auth owns everything under /api/auth (web-standard Request handler).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Desktop Google sign-in handoff — deliberately NOT under /api/auth (the
  // catch-all above would shadow it). See desktop-oauth.ts.
  app.route("/api", desktopOauthRoutes);
  app.route("/api", syncTokenRoutes);
  app.route("/api", vaultTokenRoutes);
  app.route(
    "/api",
    createRegistryRoutes({
      onRegistryChanged: deps.onRegistryChanged,
      disconnectDoc: deps.disconnectDoc,
    }),
  );
  app.route("/api", blobRoutes);
  app.route(
    "/api",
    createVersionRoutes({
      docWriter: deps.docWriter,
      onRegistryChanged: deps.onRegistryChanged,
    }),
  );
  app.route("/api", createRepairRoutes({ evictDoc: deps.evictDoc }));
  app.route("/api", createShareRoutes(deps));
  app.route("/api", publicLinkApiRoutes);
  const billingProvider = deps.billingProvider ?? new PolarBillingProvider();
  app.route(
    "/api",
    createOrgRoutes({
      disconnectDoc: deps.disconnectDoc,
      // Was simply never plumbed here, which is why removing a member left their
      // vault-channel socket streaming content for up to the token TTL.
      onAclChanged: deps.onAclChanged,
      billingProvider,
    }),
  );
  app.route("/api", createBillingRoutes({ provider: billingProvider }));
  app.route("/api", graphRoutes);
  app.route(
    "/api",
    createMcpRoutes({
      docWriter: deps.docWriter,
      disconnectDoc: deps.disconnectDoc,
      onRegistryChanged: deps.onRegistryChanged,
    }),
  );

  return app;
}
