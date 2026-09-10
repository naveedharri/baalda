import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    /**
     * `minimumSystemVersion: "10.15"` (src-tauri/tauri.conf.json) means the
     * oldest WKWebView we support is Safari 13. Vite's default target is
     * baseline-widely-available (~Safari 16.4), which emits syntax that throws
     * on Catalina — a correctness bug, not a size one. Keep 10.15 and target
     * the webview that ships with it.
     */
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    /**
     * One stylesheet, as before the code split. The Suspense fallbacks render
     * rules that belong to a lazy chunk's CSS (the editor skeleton, the graph
     * overlay, the avatar monogram), and splitting them would show the
     * fallbacks unstyled and repaint the pane when the chunk lands. The whole
     * sheet is ~135 KB and already shipped blocking, so this costs nothing new.
     */
    cssCodeSplit: false,
    /**
     * Never inline the AudioWorklet module.
     *
     * It's ~2 KB, so Vite's default `assetsInlineLimit` turns it into a `data:`
     * URL — and the Tauri CSP is `script-src 'self'`, which blocks a worklet
     * loaded from `data:`. Push-to-talk then fails only in a packaged build,
     * where `tauri dev` (which serves the file over http) looks fine. Keep it a
     * real same-origin asset.
     */
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith("recorder-worklet.js") ? false : undefined,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
