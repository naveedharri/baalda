// SPDX-License-Identifier: Apache-2.0
import * as ipc from "./ipc";

// A separate opt-in: the old email-only preference is not password consent.
export const REMEMBER_PASSWORD_KEY = "context.rememberPassword";
const CREDENTIAL_KEY = "remembered-password-v1";
let pending: Promise<unknown> = Promise.resolve();
let generation = 0;

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => {});
  return result;
}

export function readRememberPassword(): boolean {
  try {
    return localStorage.getItem(REMEMBER_PASSWORD_KEY) === "on";
  } catch {
    return false;
  }
}

export async function writeRememberPassword(on: boolean): Promise<void> {
  generation++;
  // Disable reads immediately; serialize deletion after any in-flight save.
  if (!on) {
    try { localStorage.removeItem(REMEMBER_PASSWORD_KEY); }
    finally { await serial(() => ipc.keychainDelete(CREDENTIAL_KEY)); }
  } else {
    localStorage.setItem(REMEMBER_PASSWORD_KEY, "on");
  }
}

function scope(server: string, email: string): string {
  return JSON.stringify([server.trim().replace(/\/+$/, ""), email.trim().toLowerCase()]);
}

/** One remembered account, bound to its server and email. Never a session token. */
export async function loadRememberedPassword(server: string, email: string): Promise<string> {
  const started = generation;
  if (!readRememberPassword()) return "";
  return serial(async () => {
    if (!readRememberPassword() || started !== generation) return "";
    const raw = await ipc.keychainGet(CREDENTIAL_KEY);
    if (!raw || !readRememberPassword() || started !== generation) return "";
    try {
      const saved = JSON.parse(raw);
      return saved?.scope === scope(server, email) && typeof saved.password === "string"
        ? saved.password : "";
    } catch {
      return "";
    }
  });
}

/** Call only after successful password authentication, never after OAuth. */
export async function saveRememberedPassword(server: string, email: string, password: string): Promise<void> {
  const started = generation;
  if (!readRememberPassword()) return;
  await serial(async () => {
    if (!readRememberPassword() || started !== generation) return;
    await ipc.keychainSet(CREDENTIAL_KEY, JSON.stringify({ scope: scope(server, email), password }));
  });
}
