import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

/** An env var that may be absent; empty string is treated as unset. */
function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export const config = {
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://context:context@localhost:5439/context",
  ),
  /** Shared secret: Better Auth crypto + HS256 per-doc sync JWTs. */
  jwtSecret: required("JWT_SECRET", "dev-only-insecure-change-me-please-32bytes"),
  betterAuthUrl: required("BETTER_AUTH_URL", "http://localhost:3010"),
  port: int("PORT", 3010),
  hocuspocusPort: int("HOCUSPOCUS_PORT", 3011),
  syncTokenTtlSeconds: int("SYNC_TOKEN_TTL_SECONDS", 600),
  compactionThreshold: int("COMPACTION_THRESHOLD", 50),
  invitationExpiresInSeconds: 48 * 60 * 60, // 48h per spec 04 §2
  // ---- Vault sync engine (spec 05) ----
  /** Redis connection string. Unset ⇒ in-memory pub/sub, single instance.
   *  Set ⇒ Redis fanout so N server instances share the vault feed (HA). */
  redisUrl: optional("REDIS_URL"),
  /** Max docs backfilled concurrently to a freshly-connected vault subscriber. */
  backfillConcurrency: int("BACKFILL_CONCURRENCY", 6),
  /** WebSocket path for the vault replication channel. */
  vaultSyncPath: required("VAULT_SYNC_PATH", "/vault-sync"),
  // ---- Google OAuth (spec 04 §7 — social sign-in) ----
  /** Google OAuth client id/secret. Both unset ⇒ Google sign-in is simply
   *  disabled and the desktop hides the button; self-host stays fully usable
   *  on email+password alone. Set only via env (never committed). */
  googleClientId: optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
  // ---- Subscription billing (Polar) ----
  /** Polar organization access token. Its presence is the ON switch for the
   *  whole billing feature (see `billingEnabled` below): unset ⇒ billing is
   *  disabled, no free-tier limits are enforced (self-host = unlimited), and
   *  every billing route except GET /api/billing/config returns 404. Set only
   *  via env, never committed. */
  polarAccessToken: optional("POLAR_ACCESS_TOKEN"),
  /** Shared secret for verifying Polar webhook signatures (Standard Webhooks). */
  polarWebhookSecret: optional("POLAR_WEBHOOK_SECRET"),
  /** Which Polar API to hit: 'sandbox' (default) or 'production'. */
  polarServer: optional("POLAR_SERVER") ?? "sandbox",
  /** Polar product ids for the monthly / yearly Pro plan (from the Polar
   *  dashboard). Checkout picks one based on the requested interval. */
  polarProductMonthlyId: optional("POLAR_PRODUCT_MONTHLY_ID"),
  polarProductYearlyId: optional("POLAR_PRODUCT_YEARLY_ID"),
  /** Free-tier caps (only enforced when billing is enabled). A user may OWN up
   *  to this many UNSUBSCRIBED vaults; each unsubscribed vault may hold
   *  up to this many members (incl. pending invitations). */
  freeMaxVaults: int("FREE_MAX_VAULTS", 3),
  freeMaxMembers: int("FREE_MAX_MEMBERS", 3),
} as const;

/**
 * Billing is enabled iff a Polar access token is configured — mirrors the
 * `googleEnabled` env-presence pattern. When disabled, self-hosters get an
 * unlimited, unmetered product (no caps, config reports `{ enabled: false }`).
 *
 * Evaluated live from the environment (not captured at import) so the switch is
 * deterministic under test toggling; production sets it once and never changes.
 */
export function billingEnabled(): boolean {
  const t = process.env.POLAR_ACCESS_TOKEN;
  return t !== undefined && t !== "";
}

export type AppConfig = typeof config;
