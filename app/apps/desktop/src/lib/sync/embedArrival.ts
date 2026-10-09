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
 * on a short backoff. Each path is queued at most once per session; whatever
 * gives up here is still caught by the mirror's next ordinary pass.
 */
import { isSafeAttachmentRelPath } from "./attachments";

/** Retry delays after a failed attempt (the upload may still be in flight). */
export const EMBED_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
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
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class EmbedArrivalFetcher {
  /** Paths queued this session — each one at most once. */
  private readonly seen = new Set<string>();
  private pendingText: (() => string) | null = null;
  private scanTimer: unknown = null;
  private readonly retryTimers = new Set<unknown>();
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
      if (r) void this.scan(r());
    }, EMBED_SCAN_DEBOUNCE_MS);
  }

  /** Stop every timer (vault switch / teardown). */
  stop(): void {
    this.stopped = true;
    if (this.scanTimer != null) this.clearT(this.scanTimer);
    this.scanTimer = null;
    for (const t of this.retryTimers) this.clearT(t);
    this.retryTimers.clear();
  }

  private async scan(text: string): Promise<void> {
    const fresh = embedAttachmentRefs(text).filter((p) => !this.seen.has(p));
    if (!fresh.length) return;
    for (const p of fresh) this.seen.add(p);
    const missing: string[] = [];
    await Promise.all(
      fresh.map(async (p) => {
        try {
          if (!(await this.deps.exists(p))) missing.push(p);
        } catch {
          // Unknown: leave it to the mirror's ordinary pass.
        }
      }),
    );
    if (missing.length) await this.attempt(missing.sort(), 0);
  }

  private async attempt(paths: string[], tries: number): Promise<void> {
    if (this.stopped) return;
    try {
      await this.deps.download(paths);
      return;
    } catch {
      // Not uploaded yet, a pass already running, a network blip: retry.
    }
    if (this.stopped || tries >= EMBED_RETRY_DELAYS_MS.length) return;
    // Only what is still missing goes again; the rest landed in the meantime.
    const still: string[] = [];
    await Promise.all(
      paths.map(async (p) => {
        try {
          if (!(await this.deps.exists(p))) still.push(p);
        } catch {
          still.push(p);
        }
      }),
    );
    if (!still.length) return;
    const t = this.setT(() => {
      this.retryTimers.delete(t);
      void this.attempt(still.sort(), tries + 1);
    }, EMBED_RETRY_DELAYS_MS[tries]);
    this.retryTimers.add(t);
  }
}
