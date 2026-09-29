// SPDX-License-Identifier: Apache-2.0
import { purgeExpiredTrash } from "./service.js";

/** Hourly: cheap (one indexed SELECT on `purge_after` when nothing is due). */
export const TRASH_PURGE_TICK_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  try {
    // Drain in batches of the purge's own LIMIT until nothing is due.
    for (let i = 0; i < 20; i++) {
      const purged = await purgeExpiredTrash();
      if (purged.length > 0) console.log(`[trash] purged ${purged.length} expired note(s)`);
      if (purged.length < 5000) break;
    }
  } catch (err) {
    console.error("[trash] purge failed:", err);
  }
}

/** Started only from `index.ts` (never imported by tests' app factory). */
export function startTrashPurge(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TRASH_PURGE_TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopTrashPurge(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
