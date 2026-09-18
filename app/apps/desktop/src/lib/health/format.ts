// Display helpers for Vault Settings → Health.
//
// Pure and dependency-free (no React, no store, no Tauri) so they unit-test in
// the plain Node vitest environment alongside `model.ts`, the same way
// `components/versionFormat.ts` sits outside `VersionPanel.tsx`.
//
// On reuse: `versionFormat.formatVersionSize` and `Identity.relativeAgo` cover
// the DENSE surfaces — a version row, a sidebar pill — where "4.1 MB" and "3d
// ago" have to fit in a few characters. The Health page is the opposite: a wide
// panel where numbers are the content, so it spells units out ("3 min ago",
// "2 days ago") and carries GB, which the version formatter stops short of.
// Same reason both exist rather than one: they are different registers, not a
// duplicated implementation.

import type { HealthIssueKind, HealthVerdict } from "./types";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * A size for a stat tile or a table cell: "812 B", "94 KB", "4.1 MB", "1.2 GB".
 *
 * Whole numbers below a megabyte — a tenth of a kilobyte is noise nobody acts
 * on — and one decimal above it, where the tenth is the difference between a
 * note that syncs and one the server refuses. Negative, NaN and Infinity all
 * come back as "0 B" rather than throwing: every one of these is fed by a
 * count the Rust census produced, and a broken census must not blank the page.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < KB) return `${Math.round(n)} B`;
  if (n < MB) return `${Math.round(n / KB).toLocaleString()} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / GB).toFixed(1)} GB`;
}

/**
 * How long ago something happened, spelled out: "just now", "3 min ago",
 * "5 hours ago", "2 days ago". A future timestamp (a clock skew between this
 * device and a file's mtime) reads as "just now" rather than "in 3 minutes",
 * which would send the reader looking for a bug that isn't theirs.
 */
export function relativeTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return "—";
  const secs = Math.floor((now - ms) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

/**
 * Shorten a path from the MIDDLE: "Projects/Q3/…/meeting-notes.md". The two
 * ends are the two things a reader needs — which folder it came from and which
 * file it is — and an end-truncated path throws the filename away, which is the
 * half that identifies the row.
 *
 * The full path always goes in a `title` attribute at the call site; this is
 * only what fits on the line.
 */
export function middleTruncate(path: string, max: number): string {
  if (max <= 1) return "…";
  if (path.length <= max) return path;
  // One character of the budget is the ellipsis itself; the head keeps the
  // extra when the remainder is odd, because the leading folder disambiguates
  // more often than the second-to-last character of a filename does.
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${path.slice(0, head)}…${tail > 0 ? path.slice(path.length - tail) : ""}`;
}

/** The verdict pill's words. Sentence case, like every other label in settings. */
export function verdictLabel(v: HealthVerdict): string {
  switch (v) {
    case "local":
      return "Local only";
    case "signed-out":
      return "Signed out";
    case "no-access":
      return "No access";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting";
    case "syncing":
      return "Syncing";
    case "attention":
      return "Needs attention";
    case "healthy":
      return "Healthy";
  }
}

/** The tone a verdict paints in. Maps to the `--success/--warning/--danger`
 *  families in `health.css`; `muted` is the deliberate no-colour case, because
 *  a local vault is not in a degraded state — it simply isn't syncing. */
export function verdictTone(
  v: HealthVerdict,
): "good" | "busy" | "warn" | "bad" | "muted" {
  switch (v) {
    case "healthy":
      return "good";
    case "connecting":
    case "syncing":
      return "busy";
    case "attention":
    case "offline":
      return "warn";
    case "signed-out":
    case "no-access":
      return "bad";
    case "local":
      return "muted";
  }
}

/**
 * Which of a check's kinds a filter chip is offering, in the user's words.
 * The model's `HealthIssueKind` is an engineer's vocabulary ("materialize-
 * failed"); these are the four or five characters a chip can carry.
 */
export function kindLabel(kind: HealthIssueKind): string {
  switch (kind) {
    case "too-large":
      return "Too large";
    case "upload-failed":
      return "Upload failed";
    case "register-failed":
      return "Not registered";
    case "limit":
      return "Plan limit";
    case "unregistered":
      return "Not on server yet";
    case "no-access":
      return "No access";
    case "left-behind":
      return "Left on disk";
    case "materialize-failed":
      return "Couldn't write";
    case "orphan-history":
      return "Leftover history";
  }
}

/**
 * The fill step of one cell in the activity strip: 0 for a week with nothing
 * in it, then four levels up to the busiest week in the window.
 *
 * Buckets rather than a continuous opacity on purpose. The v1 chart scaled bar
 * HEIGHT by the same ratio, and a vault whose whole year of edits landed in one
 * week drew eleven invisible stubs beside one full-height block. Four steps
 * against a coloured ground keep every non-zero week legible, and the count
 * printed inside the cell carries the exact number anyway.
 */
export function activityLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 1;
  const ratio = Math.min(1, count / max);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** "14:07" in the device's own timezone — the timeline's left column. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Local calendar day, as a stable grouping key. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** The heading over one day of the timeline: "Today", "Yesterday", "12 Sep". */
export function dayLabel(ms: number, now: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "Unknown";
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - 86_400_000)) return "Yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// ── Activity strip cells (laid out by `heatmapRange.ts`) ─────────────────────

export interface ActivityCell {
  /** 0-based column, oldest week first. */
  col: number;
  /** 0 = Sunday … 6 = Saturday, like GitHub's rows. */
  row: number;
  /** Local midnight of the day, ms. */
  date: number;
  count: number;
  /** 0..4 shade. */
  level: 0 | 1 | 2 | 3 | 4;
  today: boolean;
}

/** "Tue 3 Sep · 2 notes" — the cell tooltip. */
export function activityCellTitle(cell: ActivityCell): string {
  const d = new Date(cell.date);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const when = cell.today ? "Today" : `${day} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${when} · ${cell.count.toLocaleString()} ${cell.count === 1 ? "note" : "notes"}`;
}
