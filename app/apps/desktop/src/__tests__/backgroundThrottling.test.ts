// The main window must keep running while it is in the background (#405).
//
// WKWebView's default inactive scheduling policy suspends a page some minutes
// after its window stops being visible. The sync layer lives in that page (the
// vault channel, the debounced registry pull, the disk writes), so remote edits
// stopped reaching the vault folder until the window was focused, while the
// socket stayed open and nothing was logged. App Nap is a separate mechanism and
// turning it off did not help. `backgroundThrottling: "disabled"` maps to
// `WKInactiveSchedulingPolicy.none` (macOS 14+; ignored on Windows and Linux).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) =>
  JSON.parse(readFileSync(resolve(appRoot, "src-tauri", name), "utf8"));

describe("main window background throttling", () => {
  it("is disabled so sync keeps running while the window is in the background", () => {
    const windows = read("tauri.conf.json").app.windows;
    expect(windows).toHaveLength(1);
    expect(windows[0].backgroundThrottling).toBe("disabled");
  });

  it("is not overridden by the dev or staging config", () => {
    for (const name of ["tauri.dev.conf.json", "tauri.staging.conf.json"]) {
      expect(read(name).app?.windows).toBeUndefined();
    }
  });
});
