// Pure formatting + keyboard-nav helpers for the version history UI.
//
// They live outside `VersionPanel.tsx` so they can be unit-tested in the plain
// Node vitest environment (the panel itself pulls in motion/react, the store and
// the bridge). Every one of them is total: a row must render even when the
// server sent a null author or an unparseable timestamp.

import { relativeAgo } from "./Identity";

/** Why a version exists, as the server records it. */
export type VersionCause = "idle" | "pre-revert";

/** Millis for a server ISO timestamp; `null` when it can't be parsed. */
export function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "2h ago" for an ISO timestamp; "—" when it isn't a usable date. */
export function agoFromIso(iso: string | null | undefined, now: number): string {
  const ms = parseIsoMs(iso);
  return ms == null ? "—" : relativeAgo(ms, now);
}

/**
 * The row's one-word provenance. "Auto-saved" is the overwhelmingly common
 * case (a version is captured when a note goes quiet); "Before revert" marks
 * the safety copy taken on the way into a revert, which is the entry people
 * come looking for when they want to undo one.
 */
export function versionCauseLabel(cause: string): string {
  return cause === "pre-revert" ? "Before revert" : "Auto-saved";
}

/** Display name for a version's author; anonymous when the server had none. */
export function versionAuthorLabel(authorName: string | null | undefined): string {
  return authorName?.trim() || "Unknown";
}

/** Compact byte size for a version row: "812 B", "4.1 KB", "1.2 MB". */
export function formatVersionSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Keyboard navigation over the panel's rows, as arithmetic rather than as an
 * event handler, so the wrap-around is testable. Returns the index to move to,
 * or `null` when the key isn't ours (the caller must then NOT preventDefault —
 * swallowing every keystroke in a focused panel breaks tab-out and copy).
 */
export function nextActiveIndex(
  key: string,
  active: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return (active + 1) % count;
    case "ArrowUp":
      return (active - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Toast copy after a successful per-note revert. */
export function revertToastText(createdAt: string, now: number): string {
  return `Reverted to the version from ${agoFromIso(createdAt, now)}`;
}

/** Tooltip for a sidebar row's last-edited-by tag. */
export function lastEditedTooltip(
  name: string | null | undefined,
  at: number | string | null | undefined,
  now: number,
): string {
  const who = name?.trim() || "Someone";
  const ms = typeof at === "string" ? parseIsoMs(at) : typeof at === "number" ? at : null;
  return ms == null ? `Edited by ${who}` : `Edited by ${who} · ${relativeAgo(ms, now)}`;
}

/** A checkpoint's headline: its label if it has one, else its kind + age. */
export function checkpointTitle(
  label: string | null | undefined,
  kind: string,
  createdAt: string,
  now: number,
): string {
  const trimmed = label?.trim();
  if (trimmed) return trimmed;
  return kind === "manual"
    ? `Manual checkpoint · ${agoFromIso(createdAt, now)}`
    : `Daily checkpoint · ${agoFromIso(createdAt, now)}`;
}

/** "12 notes" / "1 note" — a checkpoint's size, in the unit users think in. */
export function noteCountLabel(count: number): string {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}
