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

// Paint the persisted (or system) theme before the first render.
initTheme();
// Same deal for the platform flag: it sets the macOS traffic-light inset, and
// applying it after the first paint would visibly shove the sidebar down.
initPlatform();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
