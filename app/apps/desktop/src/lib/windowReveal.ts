import { getCurrentWindow } from "@tauri-apps/api/window";
import * as perf from "./perf";

/** The window starts hidden (`visible: false` in `tauri.conf.json`) so nobody
 *  watches an empty frame while the bundle parses. React reveals it on its
 *  first commit — the themed `.booting` shell — so the first thing the user
 *  sees is a correctly coloured window rather than white.
 *
 *  `show()` on an already-visible window is a no-op, which is what lets the
 *  Rust dead-man's-switch timer in `lib.rs` race this harmlessly. */
let revealed = false;

export function revealWindowOnce(): void {
  if (revealed) return;
  revealed = true;
  // NOT requestAnimationFrame. WebKit does not run rAF callbacks while the
  // window is hidden, so a rAF-gated reveal only ever fired after the Rust
  // backstop in lib.rs had shown the window for it — measured as `window-shown`
  // landing at +726 ms, the exact moment the 1.5 s timer went off. A macrotask
  // after the commit is enough: the DOM is committed, the theme was painted by
  // the inline script before React ran, and WebKit composites the first frame
  // on show, so what appears is the themed shell rather than a white window.
  setTimeout(() => {
    const win = getCurrentWindow();
    void win
      .show()
      .then(() => {
        perf.mark("window-shown");
        return win.setFocus();
      })
      .catch((e) => console.warn("[window] show from the frontend failed", e));
  }, 0);
}
