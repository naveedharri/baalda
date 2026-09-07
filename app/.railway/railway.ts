// Railway Infrastructure as Code for the Baalda server service.
//
// Successor of the repo-root `railway.json`: Railway's legacy "Config as Code"
// is no longer read by services created after mid-2026 and stops being read
// everywhere on 2026-12-01. This file carries the same generic settings —
// Dockerfile build, pre-deploy migration, health check, restart policy, memory
// cap — so a Railway-hosted server gets them from code instead of the dashboard.
//
// Scope. `partial` limits the file to the `baalda-server` service; Postgres,
// volumes and domains belong to the Railway project and are never planned,
// changed or deleted from here. Every environment variable the server reads is
// listed with `preserve()`, which keeps whatever value the service already has
// and adds NOTHING when the variable is absent — a variable that is not listed
// would be deleted on apply, so add new server env vars here as well as to
// `apps/server/.env.example`. Source is repeated because an omitted source is
// treated as "detach the repo"; forks change the repo string.
//
// Run from `app/` (the SDK is a workspace devDependency there):
//
//   railway link            # pick the project + environment
//   railway config plan     # preview (never changes anything)
//   railway config apply    # apply after review
//
// Settings live on the service afterwards, so this only needs re-applying when
// the file changes — ordinary pushes deploy with whatever was last applied.
import { defineRailway, github, preserve, project, service } from "railway/iac";

export const partial = "baalda-server";

// Server env vars (see apps/server/.env.example and docs/DEPLOY.md). All optional
// here: `preserve()` keeps an existing value and creates nothing.
const SERVER_ENV = [
  "DATABASE_URL",
  "JWT_SECRET",
  "BETTER_AUTH_URL",
  "PORT",
  "HOCUSPOCUS_PORT",
  "NODE_ENV",
  "NODE_OPTIONS",
  "SYNC_TOKEN_TTL_SECONDS",
  "COMPACTION_THRESHOLD",
  "CORS_ORIGINS",
  "OPENAI_API_KEY",
  "REDIS_URL",
  "PG_POOL_MAX",
  "MAX_NOTE_MB",
  "MAX_BLOB_BYTES",
  "MAX_INFLIGHT_UPLOAD_BYTES",
  "BACKFILL_CONCURRENCY",
  "VERSION_IDLE_MS",
  "VAULT_SYNC_PATH",
  "VAULT_HEARTBEAT_MS",
  "VAULT_SEND_CAP_BYTES",
  "VAULT_SEND_POLL_MS",
  "VAULT_SEND_STALL_MS",
  "FREE_MAX_VAULTS",
  "FREE_MAX_MEMBERS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "POLAR_ACCESS_TOKEN",
  "POLAR_SERVER",
  "POLAR_PRODUCT_MONTHLY_ID",
  "POLAR_PRODUCT_YEARLY_ID",
  "POLAR_WEBHOOK_SECRET",
] as const;

export default defineRailway((ctx) => {
  // A project whose name contains "staging" deploys the `staging` branch;
  // every other project deploys `main`.
  const branch = ctx.projectName.toLowerCase().includes("staging") ? "staging" : "main";

  const server = service("baalda-server", {
    source: github("naveedharri/baalda", { branch }),
    build: {
      builder: "DOCKERFILE",
      // Build context is the repo root (pnpm monorepo), so the path is from there.
      dockerfilePath: "app/apps/server/Dockerfile",
    },
    deploy: {
      // Migrations run in a one-off container before the new version takes
      // traffic; a failed migration fails the deploy and the old version keeps
      // serving.
      preDeployCommand: ["node dist/db/migrate.js"],
      healthcheckPath: "/health",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
      limitOverride: { containers: { memoryBytes: 1073741824 } },
    },
    env: Object.fromEntries(SERVER_ENV.map((name) => [name, preserve()])),
  });

  return project(ctx.projectName, { resources: [server] });
});
