/**
 * Stamp the host platform onto `<html>` so CSS can react to it.
 *
 * The only thing this currently drives is the macOS traffic-light inset. The
 * window runs with `titleBarStyle: "Overlay"` (see `tauri.conf.json`), which
 * hands the webview the full window height and floats the close/minimise/zoom
 * buttons *over* our own top-left corner. Windows and Linux keep a real system
 * title bar above the webview, so reserving that space there would just
 * reintroduce the dead strip we removed.
 *
 * Read from the user agent rather than `@tauri-apps/plugin-os` on purpose: this
 * has to run synchronously before the first paint (an async platform lookup
 * would land a frame late and visibly shove the sidebar down), and it keeps the
 * bundle free of a plugin we'd otherwise pull in for one boolean.
 */
export function platformClass(): "macos" | "windows" | "linux" | "other" {
  const ua = navigator.userAgent;
  // Apple Silicon still reports "Intel Mac OS X" in WKWebView, so match loosely.
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

export function initPlatform(): void {
  document.documentElement.dataset.platform = platformClass();
}
