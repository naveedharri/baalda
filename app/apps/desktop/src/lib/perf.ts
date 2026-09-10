// Launch timeline. One `performance.mark` plus one console line per stage, so
// the boot can be measured instead of guessed at.
//
// `console.info` is mirrored into the `tauri dev` terminal by
// `mirrorConsoleToTerminal` (devConsole.ts wraps it onto the Tauri log plugin),
// which is the whole point: the numbers that matter are the ones from a REAL
// relaunch on a real vault, and reading them must not require the Web Inspector.
// Cheap enough to leave on in production — a handful of marks per launch.
//
// The two numbers to report: `tree-painted` (what the user feels) and
// `reconcile-done` (the structural pass, which must not regress).

/** Webview time when this module first evaluated — our own zero. */
const t0 = performance.now();
let first = true;

// The dev terminal mirror (devConsole.ts) attaches asynchronously, so the
// earliest marks — `script`, `react-mount`, the ones that say how long the
// bundle took — would otherwise only ever reach the Web Inspector. Keep them
// until a sink attaches, then replay; marks after that ride the wrapped console.
const early: string[] = [];
let attached = false;

/** Called once by the dev terminal mirror when it is ready to forward lines. */
export function attachEarlySink(sink: (line: string) => void): void {
  attached = true;
  for (const line of early) sink(line);
  early.length = 0;
}

function emit(line: string): void {
  console.info(line);
  if (!attached) early.push(line);
}

export function mark(name: string): void {
  const at = performance.now();
  try {
    performance.mark(`baalda:boot:${name}`);
  } catch {
    /* `performance.mark` unsupported / disabled — the log line is the payload */
  }
  if (first) {
    first = false;
    // How long the webview itself took before our first line of JS ran; it is
    // not ours to optimize, but it is part of what the user waits for.
    emit(
      `[boot] webview-start +${Math.round(t0)}ms (timeOrigin ${Math.round(
        performance.timeOrigin,
      )})`,
    );
  }
  emit(`[boot] ${name} +${Math.round(at - t0)}ms`);
}
