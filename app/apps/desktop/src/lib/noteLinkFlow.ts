/**
 * The private-link open flow's pure parts: the pending-link queue (a shared
 * note link that arrived before sign-in / before a vault folder existed), the
 * keep-waiting rule for the registry poll, and the failure-message mapping.
 * Pure and store-free so they unit-test in node (the `planLanding` pattern).
 */

// ---- Pending link queue ----------------------------------------------------
// Mirrors `pendingOpenOrgId` in store.ts: module state, not store state — it's
// a handoff between two moments of one flow, never something the UI renders.
// Only the latest link is kept; clicking two links while signed out means the
// second one is the one the user still cares about.

let pendingNoteLink: string | null = null;

export function queueNoteLink(url: string): void {
  pendingNoteLink = url;
}

export function takePendingNoteLink(): string | null {
  const url = pendingNoteLink;
  pendingNoteLink = null;
  return url;
}

export function clearPendingNoteLink(): void {
  pendingNoteLink = null;
}

export function hasPendingNoteLink(): boolean {
  return pendingNoteLink !== null;
}

/** Read without consuming — for guards that must not eat someone else's link. */
export function peekPendingNoteLink(): string | null {
  return pendingNoteLink;
}

// ---- Keep-waiting rule for waitForDocPath ----------------------------------

export interface WaitInputs {
  /** ms since the wait started. */
  elapsedMs: number;
  /** The base window every wait gets. */
  baseMs: number;
  /** The hard cap, busy or not. */
  capMs: number;
  /** Is sync visibly still working (switching, folder prompt, bulk phases)? */
  busy: boolean;
}

/**
 * Wait within the base window unconditionally; past it, keep waiting only
 * while sync is demonstrably still working, and never past the cap. A first
 * pull of a big vault can legitimately outlast the base window, but an idle
 * registry that hasn't produced the path by then never will.
 */
export function keepWaitingForDoc({ elapsedMs, baseMs, capMs, busy }: WaitInputs): boolean {
  if (elapsedMs < baseMs) return true;
  return busy && elapsedMs < capMs;
}

// ---- Timeout message mapping -----------------------------------------------

export interface OpenNoteFailureInputs {
  syncEnabled: boolean;
  syncStatus: string;
}

/**
 * Membership was already verified before the wait began, so naming a
 * connectivity problem leaks nothing. Everything else keeps the generic
 * text — byte-identical to the historical one, because "no access" and
 * "doesn't exist" must stay indistinguishable (anti-enumeration).
 */
export function openNoteFailureMessage(i: OpenNoteFailureInputs): string {
  if (i.syncEnabled && (i.syncStatus === "offline" || i.syncStatus === "connecting" || i.syncStatus === "error")) {
    return "Couldn't reach the server to fetch that note — check your connection and open the link again";
  }
  return "Couldn't open that note — you may not have access to it";
}
