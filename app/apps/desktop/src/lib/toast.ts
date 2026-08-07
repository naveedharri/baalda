import { useEffect, useState } from "react";

/**
 * Transient, low-stakes notifications — "Imported 12 files", "Couldn't copy
 * link", "Vault renamed".
 *
 * Deliberately NOT in the Zustand store. The store is documented as a UI
 * view-state mirror of the vault, and a toast is neither vault state nor
 * something any other component reads; putting it there would mean every
 * subscriber re-renders because a message appeared in the corner. A module-level
 * emitter also means non-React code (sync callbacks, IPC error paths) can raise
 * one without reaching for the store.
 *
 * Three tones, and the distinction matters: `error` toasts do NOT auto-dismiss,
 * because a failure the user blinked past is a failure they will report as
 * "nothing happened". Successes and neutrals do — they're confirmations, and a
 * confirmation you have to dismiss is a chore.
 *
 * This is for things that are *fine to miss twice*. Anything requiring a
 * decision stays a banner (see `App.tsx`), which persists and has actions.
 */
export type ToastTone = "success" | "error" | "neutral";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  /** ms until auto-dismiss; 0 = sticky (errors). */
  ttl: number;
}

const DEFAULT_TTL = 4200;
/** Beyond this the oldest are dropped — a stack taller than the app is noise. */
const MAX_VISIBLE = 4;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();

function emit(): void {
  const snapshot = toasts;
  for (const l of listeners) l(snapshot);
}

/** Raise a toast. Returns its id so a caller can dismiss it early. */
export function toast(text: string, tone: ToastTone = "success"): number {
  const id = nextId++;
  // Errors stay until dismissed; everything else fades on its own.
  const ttl = tone === "error" ? 0 : DEFAULT_TTL;
  toasts = [...toasts, { id, text, tone, ttl }].slice(-MAX_VISIBLE);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/** Test/teardown helper — drops everything without animating. */
export function clearToasts(): void {
  if (toasts.length === 0) return;
  toasts = [];
  emit();
}

/** The current stack. A snapshot: callers must not mutate it. */
export function getToasts(): readonly Toast[] {
  return toasts;
}

export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    // Re-sync on subscribe: a toast raised between render and effect would
    // otherwise be missed until the next one arrived.
    setList(toasts);
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}
