import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
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
