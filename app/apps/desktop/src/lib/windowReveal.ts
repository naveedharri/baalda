import { getCurrentWindow } from "@tauri-apps/api/window";

/** The window starts hidden (`visible: false` in `tauri.conf.json`) so nobody
 *  watches an empty frame while the bundle parses. React reveals it on its
 *  first commit — the themed `.booting` shell — so the first thing the user
 *  sees is a correctly coloured window rather than white.
 *
 *  Two nested frames: the first callback is scheduled *before* this commit
 *  paints, the second runs after it, so the window is shown with pixels in it.
 *  `show()` on an already-visible window is a no-op, which is what lets the
 *  Rust dead-man's-switch timer in `lib.rs` race this harmlessly. */
let revealed = false;

export function revealWindowOnce(): void {
  if (revealed) return;
  revealed = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const win = getCurrentWindow();
      void win
        .show()
        .then(() => win.setFocus())
        .catch(() => {});
    }),
  );
}
