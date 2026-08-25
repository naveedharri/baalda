import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

/** The insecure example secret shipped in .env.example. Never allowed in prod. */
const INSECURE_JWT_SECRET = "dev-only-insecure-change-me-please-32bytes";

/**
 * The shared signing secret (Better Auth crypto + HS256 sync/vault JWTs), read
 * fail-closed. In production (NODE_ENV=production, set by the Dockerfile) an
 * unset secret OR the known example placeholder is a FATAL startup error, so a
 * deploy can never silently sign real tokens with a globally-known key
 * (`cp .env.example .env` and forget). Outside production the placeholder is
 * tolerated with a loud warning, so local dev / tests keep working unchanged.
 */
function jwtSecret(): string {
  const v = process.env.JWT_SECRET;
  const prod = process.env.NODE_ENV === "production";
  if (v === undefined || v === "") {
    if (prod) {
      throw new Error(
        "JWT_SECRET is required in production. Generate one with: openssl rand -base64 32",
      );
    }
    console.warn(
      "[config] JWT_SECRET is unset — falling back to an INSECURE development secret. Never run production this way.",
    );
    return INSECURE_JWT_SECRET;
  }
  if (v === INSECURE_JWT_SECRET) {
    if (prod) {
      throw new Error(
        "JWT_SECRET is the insecure .env.example placeholder. Generate a real secret with: openssl rand -base64 32",
      );
    }
    console.warn(
      "[config] JWT_SECRET is the insecure .env.example placeholder — fine for local dev only, FATAL in production.",
    );
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
  /** Shared secret: Better Auth crypto + HS256 per-doc sync JWTs. Fail-closed
   *  in production (see {@link jwtSecret}). */
  jwtSecret: jwtSecret(),
  betterAuthUrl: required("BETTER_AUTH_URL", "http://localhost:3010"),
  port: int("PORT", 3010),
  hocuspocusPort: int("HOCUSPOCUS_PORT", 3011),
  syncTokenTtlSeconds: int("SYNC_TOKEN_TTL_SECONDS", 600),
  compactionThreshold: int("COMPACTION_THRESHOLD", 50),
  /** Quiet time after a note's last edit before a version is captured.
   *  Lower it locally to test the history panel without the 10-minute wait. */
  versionIdleMs: int("VERSION_IDLE_MS", 10 * 60_000),
  invitationExpiresInSeconds: 48 * 60 * 60, // 48h per spec 04 §2
  // ---- Vault sync engine (spec 05) ----
  /** Redis connection string. Unset ⇒ in-memory pub/sub, single instance.
   *  Set ⇒ Redis fanout so N server instances share the vault feed (HA). */
  redisUrl: optional("REDIS_URL"),
  /** Max docs backfilled concurrently to a freshly-connected vault subscriber. */
  backfillConcurrency: int("BACKFILL_CONCURRENCY", 6),
  /** WebSocket path for the vault replication channel. */
  vaultSyncPath: required("VAULT_SYNC_PATH", "/vault-sync"),
  /**
   * Outbound bound for ONE vault-channel connection: how many bytes may sit in
   * its socket queue before the server stops producing frames for it (backfill
   * parks *before* its Postgres read; live updates fold into a pending
   * full-state resend). The channel keeps no second userland queue, so
   * `ws.bufferedAmount` is the connection's whole outbound footprint and this is
   * a real bound, not a watermark on part of it. Peak per connection is this cap
   * plus the frames the concurrently-admitted backfill loads hand over (at most
   * `backfillConcurrency` of them — a WebSocket frame is indivisible, so it is
   * always enqueued whole once its doc has been read).
   *
   * 4 MiB is ~320 ms of a 100 Mbit/s link, so producing never becomes the
   * throughput limit for a healthy client; 32 connections backfilling at once
   * total 128 MiB, which fits the headroom the 512 MB heap cap (Dockerfile
   * NODE_OPTIONS) leaves above the ~160 MB idle footprint.
   */
  vaultSendCapBytes: int("VAULT_SEND_CAP_BYTES", 4 * 1024 * 1024),
  /**
   * How long a connection may sit AT `vaultSendCapBytes` with **zero** bytes
   * leaving its socket before it is terminated. Any drain progress at all resets
   * the window, so a peer draining even a trickle is paced indefinitely and is
   * never closed for being slow; this fires only on a peer that has stopped
   * reading. 60 s matches the idle deadline `@hocuspocus/server` applies to its
   * own sockets in this same process.
   */
  vaultSendStallMs: int("VAULT_SEND_STALL_MS", 60_000),
  /**
   * Sampling period for a **blocked** connection — no timer runs for a
   * connection that is under its cap. This is how often it re-reads
   * `ws.bufferedAmount` to release parked producers and to check drain progress.
   * At 25 ms the cap can be refilled ~40×/s (≈160 MB/s at the 4 MiB default),
   * well above any real link, so sampling latency is never the bottleneck.
   */
  vaultSendPollMs: int("VAULT_SEND_POLL_MS", 25),
  /**
   * Vault-channel heartbeat period. One shared interval pings every connection
   * and terminates any that did not answer the previous tick, so a peer that
   * vanished without FIN/RST is reaped after one to two ticks (30–60 s) instead
   * of keeping its PubSub subscription — and its presence dot in every
   * teammate's sidebar — forever. Comparable to `@hocuspocus/server`'s 60 s
   * `timeout` default.
   */
  vaultHeartbeatMs: int("VAULT_HEARTBEAT_MS", 30_000),
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
   *  up to this many members (incl. pending invitations).
   *
   *  Members sit well above vaults on purpose: a free vault should be able to
   *  hold a real team, so the upgrade prompt arrives when a group outgrows the
   *  product rather than the moment it stops being a pair. */
  freeMaxVaults: int("FREE_MAX_VAULTS", 3),
  freeMaxMembers: int("FREE_MAX_MEMBERS", 10),
  /** Hard ceiling on a single note-sync message / note body, in MB. Real notes
   *  are tiny (production p99 ≈ 600 kB; the largest legitimate page ≈ 7 MB), so
   *  anything past this is a runaway — most likely a forked-note feedback loop
   *  duplicating content on every bounce (2026-08-25: single updates reached
   *  17 MB and OOM-crash-looped the server). The cap is the circuit breaker. */
  maxNoteMb: int("MAX_NOTE_MB", 10),
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
