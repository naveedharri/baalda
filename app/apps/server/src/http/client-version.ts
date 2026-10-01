import type { MiddlewareHandler } from "hono";

/**
 * Minimum supported desktop version for CONTENT WRITES (issue #251).
 *
 * An install that was closed for weeks starts its normal startup sync before
 * its auto-updater has replaced it. Builds before 0.1.49 have no empty-file
 * ingest guard, so a 0-byte file on disk becomes one delete covering a
 * populated note's whole text — pushed to the server, which accepted it
 * because nothing on the wire said how old the client was.
 *
 * The desktop now reports its version on those requests as the
 * {@link CLIENT_VERSION_PARAM} query parameter (the {@link CLIENT_VERSION_HEADER}
 * header is accepted too, for non-browser clients). A query parameter and not a
 * header because the webview is cross-origin to the API: a new header must be
 * listed in the CORS preflight, so a new desktop talking to a server that
 * predates this change would have EVERY request refused, while an unknown
 * query parameter is ignored. This gate refuses the routes a client needs
 * in order to push CRDT state — the per-doc sync token (the only key to a
 * Hocuspocus socket), the vault-channel token, and the batch push — with
 * `426 client_outdated`, before any of them does work.
 *
 * Why the token mint and not the Hocuspocus update itself: a CRDT client that
 * has applied an op keeps it, so a server that drops the update leaves the two
 * sides permanently unequal and the client re-pushes on every connect (see
 * `versions/shrink-guard.ts`). Refusing the KEY instead means an outdated
 * client never opens a writable socket at all; it sits at "can't sync" until
 * its updater (which talks to the release feed, not to this server) installs
 * the current build, and that build pushes through the guards it carries.
 * Every read route — the registry listing, sign-in, the session — stays open.
 *
 * A browser WebSocket cannot carry custom headers, which is the other reason
 * the mint is the layer: a token is only issued to a request that passed here.
 *
 * Policy, both read LIVE from the environment (like `billingEnabled`) so a test
 * can flip it and a self-host sees exactly what it configured:
 *  - `MIN_CLIENT_VERSION` — `x.y.z`; default {@link DEFAULT_MIN_CLIENT_VERSION}.
 *    `0` or `off` disables the version floor.
 *  - `UNVERSIONED_CLIENTS` — what a request with NO version header gets:
 *    `allow` (default) or `refuse`. A header that is present but unparsable is
 *    treated as missing.
 *
 * Why `allow` is the default even though the builds this exists to stop send
 * no header: so does every build released before the header, including the
 * current ones (0.1.49 and later) that are perfectly safe. Refusing them on
 * deploy would stop every installed app from syncing until it updated — their
 * edits would stay safe on disk, but "existing clients keep working" is the
 * rollout rule. So the version floor applies at once to every build that
 * reports itself, and an operator turns on `UNVERSIONED_CLIENTS=refuse` once
 * the header-sending release has rolled out (auto-update makes that days, not
 * months). Self-hosts with custom or older tooling simply leave it on `allow`.
 */

/** Query parameter the desktop sends on the gated routes; mirrored in the
 *  desktop's `src/lib/clientVersion.ts`. Keep the two in lockstep. */
export const CLIENT_VERSION_PARAM = "clientVersion";

/** Header alternative for non-browser clients (listed in the CORS allow-list
 *  so a future desktop may switch to it once servers have rolled out). */
export const CLIENT_VERSION_HEADER = "x-baalda-version";

/** The first release that ships the empty-file ingest guard. */
export const DEFAULT_MIN_CLIENT_VERSION = "0.1.49";

/** Machine-readable refusal code; the desktop surfaces it as "Update required". */
export const CLIENT_OUTDATED_CODE = "client_outdated";

type Version = readonly [number, number, number];

/**
 * The numeric `major.minor.patch` core of a version string, or null.
 *
 * A pre-release suffix (`0.1.73-staging.12`) is IGNORED rather than ranked
 * below its base the way semver would: a Staging build is cut from the same
 * code as the base it names, so `0.1.49-staging.3` carries the 0.1.49 guards
 * and must not be refused by a `0.1.49` floor.
 */
export function parseClientVersion(raw: string | null | undefined): Version | null {
  if (!raw) return null;
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function below(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

export interface ClientVersionPolicy {
  /** null = no floor. */
  min: Version | null;
  minRaw: string | null;
  allowUnversioned: boolean;
}

export function clientVersionPolicy(env: NodeJS.ProcessEnv = process.env): ClientVersionPolicy {
  const rawMin = (env.MIN_CLIENT_VERSION ?? "").trim();
  let min: Version | null;
  let minRaw: string | null;
  if (rawMin === "") {
    min = parseClientVersion(DEFAULT_MIN_CLIENT_VERSION);
    minRaw = DEFAULT_MIN_CLIENT_VERSION;
  } else if (rawMin === "0" || rawMin.toLowerCase() === "off") {
    min = null;
    minRaw = null;
  } else {
    min = parseClientVersion(rawMin);
    if (!min) throw new Error(`MIN_CLIENT_VERSION must look like 0.1.49 (got "${rawMin}")`);
    minRaw = rawMin;
  }
  const unversioned = (env.UNVERSIONED_CLIENTS ?? "").trim().toLowerCase();
  if (unversioned !== "" && unversioned !== "allow" && unversioned !== "refuse") {
    throw new Error(`UNVERSIONED_CLIENTS must be "allow" or "refuse" (got "${unversioned}")`);
  }
  return { min, minRaw, allowUnversioned: unversioned !== "refuse" };
}

export type ClientVersionVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "below_minimum"; minVersion: string | null };

/** Is a client that sent `header` allowed to write content? Pure. */
export function judgeClientVersion(
  header: string | null | undefined,
  policy: ClientVersionPolicy = clientVersionPolicy(),
): ClientVersionVerdict {
  const v = parseClientVersion(header);
  if (!v) {
    if (policy.allowUnversioned) return { ok: true };
    return { ok: false, reason: "missing", minVersion: policy.minRaw };
  }
  if (policy.min && below(v, policy.min)) {
    return { ok: false, reason: "below_minimum", minVersion: policy.minRaw };
  }
  return { ok: true };
}

/**
 * Hono middleware for a content-write route. Lets GET/HEAD/OPTIONS through
 * (reads and CORS preflights are never gated) and answers anything else from
 * an outdated client with `426 client_outdated`.
 */
export function requireSupportedClient(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const verdict = judgeClientVersion(
      c.req.header(CLIENT_VERSION_HEADER) ?? c.req.query(CLIENT_VERSION_PARAM),
    );
    if (verdict.ok) return next();
    return c.json(
      {
        error: "This version of Baalda is too old to sync. Update the app to continue.",
        code: CLIENT_OUTDATED_CODE,
        reason: verdict.reason,
        minVersion: verdict.minVersion,
      },
      426,
    );
  };
}
