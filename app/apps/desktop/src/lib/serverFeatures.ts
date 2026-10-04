// Server capability detection: is the backend this app talks to new enough?
//
// Pure (no I/O) so it runs under vitest. The fetch lives in `api.ts getHealth`
// and the polling in `components/BackendBehindNotice.tsx`; the result is a UI
// mirror in the store and never gates sync on its own.
//
// `GET /health` grew `features` / `version` / `minDesktopVersion`. A server that
// predates that answers `{ ok: true }` with no `features` at all, and that is
// exactly the "behind" case: it lacks every feature this app requires. An
// UNREACHABLE server is a different thing (offline, wrong URL, a hiccup) and is
// never reported as outdated: unknown shows nothing.

/** Features this desktop needs from its server. Extend as the wire grows. */
export const REQUIRED_SERVER_FEATURES: readonly string[] = ["notes-with-state"];

/** Host of the managed instance (`PRODUCTION_SERVER_URL`). */
export const MANAGED_SERVER_HOST = "api.baalda.com";

export interface ServerHealth {
  ok: boolean;
  /** Empty for a server that predates feature advertising. */
  features: string[];
  version?: string;
  minDesktopVersion?: string;
}

export interface BackendStatus {
  outdated: boolean;
  /** Required features the server did not advertise. Empty unless outdated. */
  missing: string[];
  serverVersion?: string;
  /** True when the server URL is the managed `api.baalda.com`. */
  managed: boolean;
}

/**
 * Parse a `/health` body. Tolerates the old `{ ok: true }` shape (features
 * become `[]`) and drops non-string entries. Anything that is not a Baalda
 * health answer (`ok !== true`, not an object) returns null: unknown.
 */
export function parseHealth(body: unknown): ServerHealth | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return null;
  const features = Array.isArray(b.features)
    ? b.features.filter((f): f is string => typeof f === "string")
    : [];
  const out: ServerHealth = { ok: true, features };
  if (typeof b.version === "string" && b.version) out.version = b.version;
  if (typeof b.minDesktopVersion === "string" && b.minDesktopVersion) {
    out.minDesktopVersion = b.minDesktopVersion;
  }
  return out;
}

/** True when `serverUrl`'s host is the managed instance. Malformed ⇒ false. */
export function isManagedServer(serverUrl: string | null | undefined): boolean {
  if (!serverUrl) return false;
  try {
    return new URL(serverUrl.trim()).hostname.toLowerCase() === MANAGED_SERVER_HOST;
  } catch {
    return false;
  }
}

/**
 * Judge a health answer. `health` null (fetch failed, unreachable, not
 * Baalda) ⇒ not outdated: we only warn when the server answered and
 * demonstrably lacks something.
 */
export function backendStatus(
  health: ServerHealth | null,
  serverUrl: string | null | undefined,
  required: readonly string[] = REQUIRED_SERVER_FEATURES,
): BackendStatus {
  const managed = isManagedServer(serverUrl);
  if (!health || !health.ok) return { outdated: false, missing: [], managed };
  const have = new Set(health.features);
  const missing = required.filter((f) => !have.has(f));
  const status: BackendStatus = { outdated: missing.length > 0, missing, managed };
  if (health.version) status.serverVersion = health.version;
  return status;
}

/** How often the app re-checks while open. */
export const BACKEND_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// ---- Cached feature list for the sync layer -----------------------------
//
// The sync layer branches on what the server accepts (`notes-with-state`,
// `bootstrap-only`). It shares the SAME `/health` answer the sidebar poll
// fetches: one promise per server URL, primed by the poll and reused by sync.
// There is no second poller. A failed fetch is not cached (unknown ⇒ retried
// on the next ask) and answers the empty set, which reads as "old server", the
// safe direction: the old two-step flow still works against a new server.

export const NOTES_WITH_STATE = "notes-with-state";
export const BOOTSTRAP_ONLY = "bootstrap-only";
/** One-step file upload: a blob intent may carry `register`, and the `files`
 *  row is created with the bytes (no separate `POST /api/files`). */
export const FILES_WITH_BYTES = "files-with-bytes";

const featureCache = new Map<string, Promise<ServerHealth | null>>();

function urlKey(serverUrl: string | null | undefined): string {
  return (serverUrl ?? "").trim().replace(/\/+$/, "");
}

/** Record a health answer the sidebar poll already fetched. */
export function primeServerFeatures(
  serverUrl: string | null | undefined,
  health: ServerHealth | null,
): void {
  if (!health) return; // unknown is never cached
  featureCache.set(urlKey(serverUrl), Promise.resolve(health));
}

/**
 * The server's advertised features, fetched at most once per URL while the
 * answer is known. `fetchHealth` is `api.getHealth`. Call once per connect.
 */
export async function serverFeatures(
  serverUrl: string | null | undefined,
  fetchHealth: () => Promise<ServerHealth | null>,
): Promise<ReadonlySet<string>> {
  const key = urlKey(serverUrl);
  let p = featureCache.get(key);
  if (!p) {
    p = fetchHealth().catch(() => null);
    featureCache.set(key, p);
  }
  const health = await p;
  if (!health) {
    if (featureCache.get(key) === p) featureCache.delete(key);
    return new Set();
  }
  return new Set(health.features);
}

/** Drop the cached answer (server URL change, reconnect after an upgrade). */
export function forgetServerFeatures(serverUrl?: string | null): void {
  if (serverUrl === undefined) featureCache.clear();
  else featureCache.delete(urlKey(serverUrl));
}
