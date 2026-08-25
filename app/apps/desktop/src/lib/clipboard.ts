/**
 * Clipboard write that survives an `await` before it.
 *
 * WebKit ties `navigator.clipboard.writeText` to transient user activation,
 * and an async hop (e.g. the API call that MINTS the link being copied) can
 * outlive it — the write then rejects even though the user really did click.
 * The native Tauri clipboard has no such rule, so it goes first; the web API
 * and the hidden-textarea `execCommand("copy")` path are fallbacks (and what
 * runs under vitest, where the plugin import fails). Returns whether ANY path
 * succeeded; callers decide what to show when all fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
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
