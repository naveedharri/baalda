// Deterministic presence colors (spec 04 §5). A user's cursor/selection color is
// derived from their stable id so it's identical across every client and every
// session — no server round-trip, no per-connection randomness.

import type { ActivityStatus } from "../prefs";

/**
 * A curated palette of bright, cheerful hues harmonized with the violet accent.
 * Deliberately excludes red/orange tones — a red ring reads as an error, not a
 * person, so presence stays in happy blues/greens/purples/pinks. Every color is
 * saturated enough to read on both light and dark surfaces.
 */
export const PRESENCE_PALETTE = [
  "#6366f1", // indigo
  "#3b82f6", // blue
  "#0ea5e9", // sky
  "#06b6d4", // cyan
  "#14b8a6", // teal
  "#10b981", // emerald
  "#22c55e", // green
  "#84cc16", // lime
  "#a855f7", // purple
  "#8b5cf6", // violet
  "#d946ef", // fuchsia
  "#ec4899", // pink
] as const;

/** Neutral gray used for a peer's ring when they're offline / not live. */
export const PRESENCE_OFFLINE = "#94a3b8";

/** Stable 32-bit FNV-1a hash of a string. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in unsigned range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pick a deterministic palette color for a user id. */
export function colorForUser(userId: string): string {
  if (!userId) return PRESENCE_PALETTE[0];
  const idx = hashString(userId) % PRESENCE_PALETTE.length;
  return PRESENCE_PALETTE[idx];
}

/** The awareness `user` field every client publishes for cursors + avatars. */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  /** The user's chosen activity status, so peers can show it beside cursors. */
  status?: ActivityStatus;
}

export function presenceUser(
  userId: string,
  name: string,
  status?: ActivityStatus,
): PresenceUser {
  return { id: userId, name, color: colorForUser(userId), ...(status ? { status } : {}) };
}

/**
 * The visual tone of a presence indicator — the shared vocabulary the account
 * avatar light and the note-roster rings both speak. It folds the four chosen
 * availability states down to how *present* someone reads: `online`/`busy` are
 * live (their unique ring colour shows), while `away`/`invisible` read as
 * not-at-the-keyboard (a muted, neutral ring). This is what "the status depends
 * on whether the user is active" means in practice.
 */
export type PresenceTone = "online" | "away" | "busy" | "offline";

/** Fold a chosen availability status into a presence tone. */
export function statusTone(status: ActivityStatus | undefined): PresenceTone {
  switch (status) {
    case "away":
      return "away";
    case "busy":
      return "busy";
    // "Invisible" is meant to read as offline to teammates.
    case "invisible":
      return "offline";
    default:
      return "online";
  }
}

/** Whether a ring should show the user's unique colour (vs. neutral gray). */
export function ringShowsColor(tone: PresenceTone): boolean {
  return tone === "online" || tone === "busy";
}
