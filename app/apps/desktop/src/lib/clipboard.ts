import { clipboardClearIf, clipboardWrite } from "./ipc";

/**
 * Clipboard write that survives an `await` before it.
 *
 * WebKit ties `navigator.clipboard.writeText` to transient user activation,
 * and an async hop (e.g. the API call that MINTS the link being copied) can
 * outlive it — the write then rejects even though the user really did click.
 * The native Tauri clipboard has no such rule, so it goes first; the web API
 * and the hidden-textarea `execCommand("copy")` path are fallbacks (and what
 * runs under vitest, where there is no Tauri runtime). Returns whether ANY path
 * succeeded; callers decide what to show when all fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await clipboardWrite(text);
    return true;
  } catch {
    /* not running under Tauri (tests, plain browser) — fall through */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but focusable; `readonly` stops the iOS-style keyboard flash.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** How long a copied secret (the vault key words) stays on the clipboard. */
export const SENSITIVE_CLIPBOARD_CLEAR_MS = 60_000;
/** The toast after copying one. */
export const SENSITIVE_COPIED_MESSAGE = "Copied. Cleared from the clipboard in 60 seconds.";

export interface ClipboardClearDeps {
  /** Lowercase hex sha256 of the UTF-8 text. */
  sha256Hex(text: string): Promise<string>;
  /** Clear only if the clipboard still holds text with this hash; true = cleared. */
  clearIf(sha256Hex: string): Promise<boolean>;
  setTimer(fn: () => void, ms: number): unknown;
  cancelTimer(handle: unknown): void;
}

/**
 * Read-compare-clear, once, `delayMs` after a sensitive copy. Only the text's
 * HASH is kept while waiting (the words themselves are not held), and the
 * clipboard is cleared only if it still holds exactly that text: if the person
 * copied anything else meanwhile, it is left alone. A newer sensitive copy
 * replaces the pending clear. Module-level on purpose: closing the dialog or
 * pressing Hide must not cancel the wipe.
 */
export function createClipboardClearer(deps: ClipboardClearDeps) {
  let pending: unknown = null;
  let generation = 0;
  return {
    async schedule(text: string, delayMs = SENSITIVE_CLIPBOARD_CLEAR_MS): Promise<void> {
      const mine = ++generation;
      const hash = await deps.sha256Hex(text);
      if (mine !== generation) return; // a newer copy already took over
      if (pending !== null) deps.cancelTimer(pending);
      pending = deps.setTimer(() => {
        pending = null;
        void deps.clearIf(hash).catch(() => false);
      }, delayMs);
    },
    cancel(): void {
      generation++;
      if (pending !== null) deps.cancelTimer(pending);
      pending = null;
    },
  };
}

export async function sha256HexOfText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The native (Rust, main thread) compare-and-clear. There is deliberately no
// `navigator.clipboard.readText` fallback: WebKit shows a "Paste" prompt for
// it and refuses it without a fresh click, which a 60 s timer never has.
const sensitiveClearer = createClipboardClearer({
  sha256Hex: sha256HexOfText,
  clearIf: (hash) => clipboardClearIf(hash),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  cancelTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/**
 * Copy a secret (the vault key words): written like `copyText`, then wiped
 * from the clipboard after {@link SENSITIVE_CLIPBOARD_CLEAR_MS} if it still
 * holds exactly this text. Returns whether the copy succeeded.
 */
export async function copySensitiveText(text: string): Promise<boolean> {
  const ok = await copyText(text);
  if (ok) await sensitiveClearer.schedule(text).catch(() => {});
  return ok;
}
