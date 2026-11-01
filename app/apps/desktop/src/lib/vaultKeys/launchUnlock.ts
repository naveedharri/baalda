// Seamless keys F at launch: a remembered password unlocks (or re-wraps) the
// account key. A server answer of `wrong_password` means the remembered one is
// stale (changed elsewhere); every try counts in the shared sign-in throttle,
// so retrying on each launch could walk the person into the sign-in lockout.
// After one such answer, launch-time unlock is off for that server + account on
// this device until the next successful manual password sign-in re-arms it.
// Device-local (localStorage) and never a secret: only "<server>|<userId>".

export const LAUNCH_UNLOCK_OFF_KEY = "context.vaultKeys.launchUnlockOff";

const scope = (server: string, userId: string) => `${server.trim().replace(/\/+$/, "")}|${userId}`;

function readOff(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LAUNCH_UNLOCK_OFF_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function writeOff(list: string[]): void {
  try {
    if (list.length) localStorage.setItem(LAUNCH_UNLOCK_OFF_KEY, JSON.stringify(list.slice(-20)));
    else localStorage.removeItem(LAUNCH_UNLOCK_OFF_KEY);
  } catch {
    /* storage unavailable: the next launch simply tries again */
  }
}

/** A successful manual password sign-in: launch-time unlock may run again. */
export function allowLaunchUnlock(server: string, userId: string): void {
  const s = scope(server, userId);
  const list = readOff();
  if (list.includes(s)) writeOff(list.filter((x) => x !== s));
}

export type LaunchUnlockOutcome = string;

/**
 * Run the launch-time unlock unless it was switched off for this scope. The
 * password is loaded and used once; it is never stored here.
 */
export async function runLaunchUnlock(deps: {
  server: string;
  userId: string;
  loadPassword: () => Promise<string>;
  unlock: (password: string) => Promise<LaunchUnlockOutcome>;
}): Promise<LaunchUnlockOutcome | "skipped" | "no-password"> {
  const s = scope(deps.server, deps.userId);
  if (readOff().includes(s)) return "skipped";
  const password = await deps.loadPassword().catch(() => "");
  if (!password) return "no-password";
  const result = await deps.unlock(password);
  if (result === "wrong-password") writeOff([...readOff().filter((x) => x !== s), s]);
  return result;
}
