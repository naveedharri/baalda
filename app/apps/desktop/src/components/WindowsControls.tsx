// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platformClass } from "../lib/platform";

/** Window-global controls, including welcome and loading screens. */
export function WindowsControls() {
  const windows = platformClass() === "windows";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!windows) return;
    const win = getCurrentWindow();
    let disposed = false;
    let request = 0;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      const current = ++request;
      try {
        const value = await win.isMaximized();
        if (!disposed && current === request) setMaximized(value);
      } catch (error) {
        console.warn("[window] could not read maximize state", error);
      }
    };
    void refresh();
    void win.onResized(() => { void refresh(); }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => console.warn("[window] could not observe resize", error));
    return () => { disposed = true; unlisten?.(); };
  }, [windows]);

  if (!windows) return null;
  const run = (action: "minimize" | "toggleMaximize" | "close") => {
    void getCurrentWindow()[action]().catch((error) => {
      console.error(`[window] ${action} failed`, error);
    });
  };
  return (
    <>
      <div className="windows-boot-drag" data-tauri-drag-region="deep" />
      <div className="windows-controls" aria-label="Window controls">
        <button type="button" aria-label="Minimize" title="Minimize" onClick={() => run("minimize")}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg>
        </button>
        <button type="button" aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"} onClick={() => run("toggleMaximize")}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {maximized ? <><path d="M3.5 3.5v-2h7v7h-2" /><rect x="1.5" y="3.5" width="7" height="7" /></>
              : <rect x="1.5" y="1.5" width="9" height="9" />}
          </svg>
        </button>
        <button type="button" className="windows-close" aria-label="Close window" title="Close"
          onClick={() => run("close")}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
        </button>
      </div>
    </>
  );
}
