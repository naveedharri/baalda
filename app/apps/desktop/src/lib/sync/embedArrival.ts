/**
 * Fetch an embed a teammate just added, as soon as their edit arrives.
 *
 * A pasted screenshot reaches a teammate in two pieces: the text
 * `![shot](/attachments/<hash>.png)` over the note's CRDT, within milliseconds,
 * and the bytes as a hash-named `attachments/` blob. The server announces no
 * event for that blob (only `files` rows broadcast `registry-changed`), so the
 * binary mirror used to wait for an unrelated registry change or watcher event
 * before it downloaded the picture, and the embed rendered broken meanwhile.
 *
 * This watches the open note's REMOTE transactions for `attachments/` refs the
 * disk lacks and asks the mirror for exactly those paths (`downloadMissing`,
 * the same create-only transport and listing a pass uses, so the Free-plan rule
 * is unchanged: embeds under `attachments/` download on every plan). The
 * uploader is usually still mid-upload when the text lands, so a miss retries
 * on a short backoff, then every 30 s for as long as an open image still shows
 * it as downloading (`attachmentArrivals.ts` wanted set). A vault-channel
 * reconnect or a registry / file signal asks again at once (`nudge`). Whatever
 * stops here is still caught by the mirror's next ordinary pass.
 */
import { isSafeAttachmentRelPath } from "./attachments";

/** Retry delays after a failed attempt (the upload may still be in flight). */
export const EMBED_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
/** After the schedule above: how often a file an open image still shows as
 *  "Downloading" is asked for again. A slow uploader (a large image, a bad
 *  network, an upload pass that was busy) must not strand the picture. */
export const EMBED_SLOW_RETRY_MS = 30_000;
/** Coalesces a burst of remote keystrokes into one scan. */
export const EMBED_SCAN_DEBOUNCE_MS = 250;

const LINK_TARGET = /\]\(\s*<?([^)\s>]+)/g;
const HTML_SRC = /\bsrc\s*=\s*["']([^"']+)["']/gi;

/**
 * Normalize an embed `src` to a vault-relative `attachments/…` path, or null.
 * `/attachments/x`, `attachments/x` and `./attachments/x` are all the vault's
 * `attachments/` store (the app writes the first; the other two are what an
 * AI or another editor writes for the same file).
 */
export function attachmentRelFromSrc(src: string): string | null {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  let rel = src.split(/[?#]/)[0].replace(/^\/+/, "").replace(/^(\.\/)+/, "");
  try {
    rel = decodeURI(rel);
  } catch {
    // A malformed escape: keep the raw text, the safety check still applies.
  }
  return isSafeAttachmentRelPath(rel) ? rel : null;
}

/** Every distinct `attachments/` path the markdown embeds or links. */
export function embedAttachmentRefs(text: string): string[] {
  if (!text.includes("attachments/")) return [];
  const out = new Set<string>();
  for (const re of [LINK_TARGET, HTML_SRC]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const rel = attachmentRelFromSrc(m[1]);
      if (rel) out.add(rel);
    }
  }
  return [...out];
}

export interface EmbedArrivalDeps {
  /** Is the file on this disk? A throw counts as "unknown": skip this time. */
  exists(relPath: string): Promise<boolean>;
  /** Ask the binary mirror for these paths; throws on any failure. */
  download(relPaths: readonly string[]): Promise<void>;
  /** Does an open image still wait for this path? Past the fixed schedule a
   *  path keeps retrying (every {@link EMBED_SLOW_RETRY_MS}) only while this
   *  says yes. Absent ⇒ never: the schedule is the whole budget. */
  isWanted?(relPath: string): boolean;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** One path being fetched: how many attempts failed, and its armed retry. */
interface Pending {
  tries: number;
  timer: unknown;
}

export class EmbedArrivalFetcher {
  /** Paths still being fetched. A path leaves when it lands, or when it has
   *  used its schedule and no image wants it; a later edit, reopen or image
   *  that names it again starts it afresh. */
  private readonly active = new Map<string, Pending>();
  /** Paths whose next attempt is due, collected into one download call. */
  private readonly due = new Set<string>();
  private inFlight = false;
  private flushAgain = false;
  private pendingText: (() => string) | null = null;
  private scanTimer: unknown = null;
  private stopped = false;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(private readonly deps: EmbedArrivalDeps) {
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** A remote transaction touched the open note; `read` returns its text. */
  noteRemoteChange(read: () => string): void {
    if (this.stopped) return;
    this.pendingText = read;
    if (this.scanTimer != null) return;
    this.scanTimer = this.setT(() => {
      this.scanTimer = null;
      const r = this.pendingText;
      this.pendingText = null;
      if (r) void this.request(embedAttachmentRefs(r()));
    }, EMBED_SCAN_DEBOUNCE_MS);
  }

  /**
   * Fetch these `attachments/` paths if this disk lacks them (an image widget
   * that could not load, or a scan). A path already being fetched is left to
   * its own schedule.
   */
  async request(paths: readonly string[]): Promise<void> {
    if (this.stopped) return;
    const fresh = [...new Set(paths)].filter((p) => !this.active.has(p));
    if (!fresh.length) return;
    // Claimed before the disk is asked, so a second scan cannot queue it twice.
    for (const p of fresh) this.active.set(p, { tries: 0, timer: null });
    const missing: string[] = [];
    await Promise.all(
      fresh.map(async (p) => {
        let here: boolean | null = null;
        try {
          here = await this.deps.exists(p);
        } catch {
          // Unknown: leave it to the mirror's ordinary pass.
        }
        if (here === false) missing.push(p);
        else this.active.delete(p);
      }),
    );
    if (this.stopped || !missing.length) return;
    for (const p of missing) this.due.add(p);
    await this.flush();
  }

  /**
   * Something suggests the server may hold new bytes now — the vault channel
   * (re)connected, a registry or file change arrived. Every path still being
   * fetched is asked for at once, with its schedule reset.
   */
  nudge(): void {
    if (this.stopped || this.active.size === 0) return;
    for (const [p, st] of this.active) {
      if (st.timer != null) this.clearT(st.timer);
      st.timer = null;
      st.tries = 0;
      this.due.add(p);
    }
    void this.flush();
  }

  /** Stop every timer (vault switch / teardown). */
  stop(): void {
    this.stopped = true;
    if (this.scanTimer != null) this.clearT(this.scanTimer);
    this.scanTimer = null;
    for (const st of this.active.values()) if (st.timer != null) this.clearT(st.timer);
    this.active.clear();
    this.due.clear();
  }

  private async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      // One download at a time: the mirror refuses a second while one runs.
      this.flushAgain = true;
      return;
    }
    const paths = [...this.due].filter((p) => this.active.has(p)).sort();
    this.due.clear();
    if (!paths.length) return;
    this.inFlight = true;
    try {
      let ok = false;
      try {
        await this.deps.download(paths);
        ok = true;
      } catch {
        // Not uploaded yet, a pass already running, a network blip: retry.
      }
      if (this.stopped) return;
      await Promise.all(
        paths.map(async (p) => {
          let here = ok;
          if (!ok) {
            try {
              here = await this.deps.exists(p);
            } catch {
              here = false;
            }
          }
          if (here) this.active.delete(p);
          else this.retryLater(p);
        }),
      );
    } finally {
      this.inFlight = false;
    }
    if (this.flushAgain && !this.stopped) {
      this.flushAgain = false;
      await this.flush();
    }
  }

  private retryLater(p: string): void {
    const st = this.active.get(p);
    if (!st || this.stopped) return;
    const delay =
      st.tries < EMBED_RETRY_DELAYS_MS.length
        ? EMBED_RETRY_DELAYS_MS[st.tries]
        : this.deps.isWanted?.(p)
          ? EMBED_SLOW_RETRY_MS
          : null;
    if (delay == null) {
      // Schedule spent and nothing on screen waits for it: the mirror's
      // ordinary pass still catches it, and a widget that shows it again
      // starts it afresh.
      this.active.delete(p);
      return;
    }
    st.tries++;
    if (st.timer != null) this.clearT(st.timer);
    st.timer = this.setT(() => {
      st.timer = null;
      this.due.add(p);
      void this.flush();
    }, delay);
  }
}
