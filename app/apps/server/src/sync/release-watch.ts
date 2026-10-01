/**
 * Release watcher: learn the latest desktop version and tell connected apps
 * (issue #269).
 *
 * A running app otherwise meets a new release only on its next updater poll
 * (every 15 minutes). The server already holds a live vault-channel socket to
 * every signed-in app, so it polls the release manifest itself — ONE request
 * per server instance, rather than a faster poll from every install — and, when
 * the version changes, sends each connection a `version-available` frame.
 *
 * The frame is a HINT and nothing more. The desktop answers it by running its
 * ordinary background update check, which fetches the manifest itself and
 * verifies the bundle's minisign signature, so a server can never deliver or
 * force an update — only make a check happen sooner. Clients that predate the
 * frame ignore an unknown `t`.
 *
 * Config (env):
 *  - `RELEASE_MANIFEST_URL` — the updater manifest to watch; defaults to the
 *    public release's `latest.json`. `off` disables the watcher entirely, as
 *    does an air-gapped host simply failing to fetch (logged once, retried).
 *  - `RELEASE_POLL_MINUTES` — default 5; `0` disables.
 *
 * The first successful fetch only RECORDS the version: announcing at startup
 * would make every app check at once after each server deploy for a release
 * they have most likely already installed. Only a change after that is sent.
 */

export const DEFAULT_RELEASE_MANIFEST_URL =
  "https://github.com/naveedharri/baalda/releases/latest/download/latest.json";

const FETCH_TIMEOUT_MS = 15_000;

export interface ReleaseWatchOptions {
  manifestUrl: string;
  intervalMs: number;
  /** Called once per newly observed version (never for the first one seen). */
  onNewVersion: (version: string) => void;
  fetchImpl?: typeof fetch;
}

export interface ReleaseWatch {
  /** The latest version seen, or null before the first successful fetch. */
  latest(): string | null;
  /** One poll now (exposed for tests); never throws. */
  poll(): Promise<void>;
  stop(): void;
}

/** `version` out of an updater manifest body, or null when it has none. */
export function manifestVersion(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as { version?: unknown }).version;
  if (typeof v !== "string") return null;
  const trimmed = v.trim().replace(/^v/, "");
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}([-+][0-9A-Za-z.-]{1,64})?$/.test(trimmed) ? trimmed : null;
}

export function createReleaseWatch(opts: ReleaseWatchOptions): ReleaseWatch {
  const doFetch = opts.fetchImpl ?? fetch;
  let latest: string | null = null;
  let failing = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = async (): Promise<void> => {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(opts.manifestUrl, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const version = manifestVersion(await res.json());
      if (!version) throw new Error("manifest has no version");
      if (failing) console.info("[release-watch] release manifest reachable again");
      failing = false;
      const previous = latest;
      latest = version;
      if (previous !== null && previous !== version) {
        console.info(`[release-watch] new desktop release ${version}; hinting connected apps`);
        try {
          opts.onNewVersion(version);
        } catch (err) {
          console.error("[release-watch] broadcast failed:", err);
        }
      }
    } catch (err) {
      // Once per outage: an air-gapped self-host would otherwise log this
      // every few minutes forever.
      if (!failing) {
        console.warn(
          `[release-watch] could not read the release manifest (${(err as Error)?.message ?? err}); will keep trying quietly`,
        );
      }
      failing = true;
    } finally {
      clearTimeout(abort);
    }
  };

  if (opts.intervalMs > 0) {
    void poll();
    timer = setInterval(() => void poll(), opts.intervalMs);
    timer.unref?.();
  }

  return {
    latest: () => latest,
    poll,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** The watcher's settings from the environment, or null when it is disabled. */
export function releaseWatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): { manifestUrl: string; intervalMs: number } | null {
  const url = (env.RELEASE_MANIFEST_URL ?? "").trim();
  if (url.toLowerCase() === "off") return null;
  const raw = (env.RELEASE_POLL_MINUTES ?? "").trim();
  const minutes = raw === "" ? 5 : Number.parseInt(raw, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return { manifestUrl: url || DEFAULT_RELEASE_MANIFEST_URL, intervalMs: minutes * 60_000 };
}
