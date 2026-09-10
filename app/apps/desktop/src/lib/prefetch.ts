/** Warm the chunks the user is about to want, after the first paint has landed.
 *
 *  The lazy boundaries exist so the window can appear without waiting on
 *  CodeMirror; they must not make the first note click feel slower than it did
 *  when everything was one chunk. Warming the three chunks a session almost
 *  always needs — the editor, the avatar faces, the settings dialog — costs
 *  nothing visible (they are parsed while the user is still reading the
 *  sidebar) and means the real `import()` resolves from cache.
 *
 *  Fire-and-forget: a failed prefetch just means the real import pays the cost.
 *  Deliberately NOT warmed: the graph (a rare, deliberate action) and the
 *  welcome screen (dead weight for anyone who already has a vault). */
export function prefetchAfterPaint(): void {
  const warm = () => {
    void import("../components/Avatar"); // sidebar/footer faces
    void import("../components/Editor"); // CodeMirror + lezer, the big one
    void import("../components/VaultSettingsDialog");
  };
  const idle = (
    window as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
    }
  ).requestIdleCallback;
  // WebKit has no requestIdleCallback, so the timeout branch is the one that
  // runs in the Tauri webview; both are kept so the module is correct anywhere.
  if (idle) idle(warm, { timeout: 2000 });
  else window.setTimeout(warm, 300);
}
