/* The last line of defence: what the window shows when the app itself hit an
   error it could not recover from, instead of an empty window. Reloading
   starts the app again from this computer's files and sync state; nothing
   typed is lost, because every edit is saved as it is made. */

export function logAppCrash(e: Error): void {
  const line = `[AppCrash] ${e.name}: ${e.message}\n${e.stack ?? ""}`.slice(0, 4000);
  void import("@tauri-apps/plugin-log")
    .then(({ error }) => error(line))
    .catch(() => {
      /* not in Tauri (tests, plain browser): console.error already has it */
    });
}

export function AppCrashFallback({ error, reload = () => window.location.reload() }: { error: Error; reload?: () => void }) {
  return (
    <div className="error-boundary app-crash" role="alert">
      <div className="error-boundary-card">
        <strong>Baalda hit a problem</strong>
        <p>Reload to pick up where you left off. Your notes are saved on this computer.</p>
        <p className="muted">{error.message}</p>
        <button className="primary sm" onClick={reload}>
          Reload
        </button>
      </div>
    </div>
  );
}
