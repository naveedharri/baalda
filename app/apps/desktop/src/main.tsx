import React from "react";
import ReactDOM from "react-dom/client";

// Design system: fonts (all bundled offline, no runtime CDN) + tokens.
// Open Sauce Two (body/UI, local woff2), Radio Canada Big (display headings,
// via @fontsource), JetBrains Mono (code, via @fontsource). The note-font
// choices (lib/prefs.ts EDITOR_FONTS): Inter, Literata, Atkinson Hyperlegible
// and IBM Plex Mono. Unicode-range subsets load only when text needs them.
import "./assets/fonts/fonts.css";
import "@fontsource/radio-canada-big/400.css";
import "@fontsource/radio-canada-big/600.css";
import "@fontsource/radio-canada-big/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/literata/400.css";
import "@fontsource/literata/400-italic.css";
import "@fontsource/literata/600.css";
import "@fontsource/literata/700.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/400-italic.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles/tokens.css";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppCrashFallback, logAppCrash } from "./components/AppCrashFallback";
import { WindowsControls } from "./components/WindowsControls";
import { UpgradeDialogHost } from "./components/UpgradeDialog";
import { OAuthConsentHost } from "./components/OAuthConsentHost";
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

// The startup guard (public/boot-guard.js) writes a message into #root when
// the app never draws; once we get here it must neither show nor stay.
(window as unknown as { __baaldaMounted?: boolean }).__baaldaMounted = true;
document.querySelector("[data-boot-failure]")?.remove();
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* A render error anywhere outside the inner boundaries used to unmount
        the whole tree: a blank window (reported on Windows after the app sat
        in the background). Now it says so and offers a reload. The Windows
        caption buttons stay outside, so the window can still be closed. */}
    <ErrorBoundary label="Baalda" fallback={(error) => <AppCrashFallback error={error} />} onError={logAppCrash}>
      <App />
    </ErrorBoundary>
    <WindowsControls />
    <UpgradeDialogHost />
    <OAuthConsentHost />
  </React.StrictMode>,
);
// Whether the classic scripts in index.html ran (the packaged CSP must allow
// them) and what this computer's webview was missing: one line in the log.
{
  const w = window as unknown as { __baaldaPolyfills?: string[]; __baaldaBootGuard?: boolean };
  const line = `[boot] legacy support: polyfills ${w.__baaldaPolyfills ? `loaded (filled: ${w.__baaldaPolyfills.join(", ") || "none"})` : "MISSING"}, startup guard ${w.__baaldaBootGuard ? "loaded" : "MISSING"}`;
  void import("@tauri-apps/plugin-log").then(({ info }) => info(line)).catch(() => {});
}
// Render is synchronous up to the first commit's paint, so this is the cost of
// parsing + evaluating the bundle plus React's first render.
perf.mark("react-mount");
