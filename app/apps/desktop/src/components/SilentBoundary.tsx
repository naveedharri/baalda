/* An ErrorBoundary that renders NOTHING when its subtree throws. For optional
   chrome (the Activity host, the right panel, the unread badge, the reconcile
   banner): a bug there must degrade to "that piece is missing", never to a
   white window. The error goes to the Tauri log plugin directly, so it is
   recorded in production builds too (the console mirror in lib/devConsole.ts
   is dev-only). */
import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

const nothing = () => null;

function logToTauri(label: string, e: Error): void {
  const line = `[SilentBoundary ${label}] ${e.name}: ${e.message}\n${e.stack ?? ""}`.slice(0, 4000);
  void import("@tauri-apps/plugin-log")
    .then(({ error }) => error(line))
    .catch(() => {
      /* not in Tauri (tests, plain browser): console.error already has it */
    });
}

export function SilentBoundary({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ErrorBoundary label={label} fallback={nothing} onError={(e) => logToTauri(label, e)}>
      {children}
    </ErrorBoundary>
  );
}
