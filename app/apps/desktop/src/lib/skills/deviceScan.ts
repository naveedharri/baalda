// The "On this device" scan, run once per session and shared: the Skills tab
// starts it quietly (so its toggle can show a count), the device view reads the
// same answer, and Refresh rescans. Rust's `skills_scan_device` is read-only.

import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { loadErrorText, withTimeout } from "./loading";

export type DeviceScan =
  | { status: "loading" }
  | { status: "ready"; entries: ipc.DeviceSkill[]; errors: ipc.DeviceScanError[]; refreshing?: boolean }
  | { status: "error"; message: string };

let current: DeviceScan = { status: "loading" };
let started = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<(s: DeviceScan) => void>();

function set(next: DeviceScan): void {
  current = next;
  for (const l of listeners) l(current);
}

/** Scan (again with `force`); a scan already running is shared. */
export function scanDevice(force = false): Promise<void> {
  if (inflight) return inflight;
  if (started && !force) return Promise.resolve();
  started = true;
  // A rescan keeps showing the last answer (marked refreshing) until the new one lands.
  set(current.status === "ready" ? { ...current, refreshing: true } : { status: "loading" });
  inflight = withTimeout(ipc.skillsScanDevice(), 60_000)
    .then(
      (r) => set({ status: "ready", entries: r.entries, errors: r.errors }),
      (e) => set({ status: "error", message: loadErrorText(e) }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The session's scan, started on first use. */
export function useDeviceScan(): DeviceScan {
  const [s, setS] = useState(current);
  useEffect(() => {
    setS(current);
    listeners.add(setS);
    void scanDevice();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

// ---- First-visit dot on the "On this device" toggle -------------------------

const SEEN_KEY = "context.skills.deviceSeen";

/** Has this person opened "On this device" on this computer? */
export function deviceSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // no storage: never nag
  }
}

export function markDeviceSeen(): void {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* storage unavailable */ }
}
