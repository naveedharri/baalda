// Dev-only: mirror the webview console into the Tauri process's stdout via the
// log plugin (its Stdout target is configured in src-tauri/src/lib.rs), so sync
// diagnostics can be read from the `tauri dev` terminal instead of only from the
// Web Inspector. A no-op in production builds.

import { attachEarlySink } from "./perf";

type Sink = (message: string) => Promise<void>;

export function mirrorConsoleToTerminal(): void {
  if (!import.meta.env.DEV) return;
  // Imported inside the DEV guard so the log plugin is not part of the
  // production startup chunk, which nothing there would ever call.
  void import("@tauri-apps/plugin-log").then(({ error, info, warn }) => {
    install(info, warn, error);
  });
}

function install(info: Sink, warn: Sink, error: Sink): void {
  const fmt = (args: unknown[]) =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ")
      .slice(0, 2000);
  const wrap = (name: "log" | "info" | "warn" | "error", sink: Sink) => {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      orig(...args);
      void sink(fmt(args)).catch(() => {});
    };
  };
  wrap("log", info);
  wrap("info", info);
  wrap("warn", warn);
  // Boot marks logged before this mirror was installed: replay them now so the
  // terminal timeline starts at the first line of JS, not at the mirror.
  attachEarlySink((line) => void info(line).catch(() => {}));
  wrap("error", error);
}
