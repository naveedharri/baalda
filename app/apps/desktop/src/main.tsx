import React from "react";
import ReactDOM from "react-dom/client";

// Design system: fonts (all bundled offline, no runtime CDN) + tokens.
// Open Sauce Two (body/UI, local woff2), Radio Canada Big (display headings,
// via @fontsource), JetBrains Mono (code, via @fontsource).
import "./assets/fonts/fonts.css";
import "@fontsource/radio-canada-big/400.css";
import "@fontsource/radio-canada-big/600.css";
import "@fontsource/radio-canada-big/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/tokens.css";

import App from "./App";
import { initPlatform } from "./lib/platform";
import { initTheme } from "./lib/theme";
import { mirrorConsoleToTerminal } from "./lib/devConsole";
import * as perf from "./lib/perf";

// The launch timeline starts here: the first line of our own JS to run.
perf.mark("script");
// Paint the persisted (or system) theme before the first render.
initTheme();
// Same deal for the platform flag: it sets the macOS traffic-light inset, and
// applying it after the first paint would visibly shove the sidebar down.
initPlatform();
// Dev builds only: webview console → `tauri dev` terminal, for sync diagnostics.
mirrorConsoleToTerminal();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
// Render is synchronous up to the first commit's paint, so this is the cost of
// parsing + evaluating the bundle plus React's first render.
perf.mark("react-mount");
