/* What one Activity row says, collapsed and expanded (ActivityFeed.tsx).
   Collapsed: the kind chip, a short message and the relative time on line 1,
   the note path on line 2. Expanded: the full path(s), the explanation that
   used to live only in a native tooltip, secondary facts and the exact time.
   Pure, so the wording is tested without a DOM. */
import { clockDate, clockTime, formatBytes, relativeTime } from "../lib/health/format";
import { noteLabel } from "../lib/notePath";
import { ACTIVITY_HINT, type ActivityRow } from "./activityRows";

export interface ActivityRowText {
  label: string;
  /** Line 1, after the chip. Never empty. */
  message: string;
  /** "13 min ago". */
  when: string;
  /** Line 2; "" when the row is not about one note. */
  path: string;
  /** A rename's destination, shown after the path. */
  newPath: string | null;
  /** Every path the expanded row lists (a grant names several). */
  paths: string[];
  /** Paths a grant covered beyond `paths`. */
  morePaths: number;
  /** The plain-words explanation of this kind of row. */
  detail: string;
  /** Secondary facts for the expanded row ("Deleted by Sam", "2 KB"). */
  facts: string[];
  /** "19:34, 8 Oct 2026". */
  absoluteTime: string;
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function activityRowText(row: ActivityRow, now: number): ActivityRowText {
  const base = {
    label: row.label,
    when: relativeTime(row.at, now),
    path: row.path,
    newPath: null as string | null,
    paths: row.path ? [row.path] : [],
    morePaths: 0,
    absoluteTime: clockDate(row.at),
  };
  const named = row.path ? noteLabel(row.path) : row.label;

  switch (row.type) {
    case "reconcile": {
      const newPath = row.item.newPath ?? null;
      const facts = row.item.detail && row.item.detail !== row.path ? [row.item.detail] : [];
      return {
        ...base,
        message: newPath ? `${named} renamed to ${noteLabel(newPath)}` : named,
        newPath,
        detail: ACTIVITY_HINT.reconcile,
        facts,
      };
    }
    case "trash": {
      const facts = [
        ...(row.item.deletedBy ? [`Deleted by ${row.item.deletedBy.name}`] : []),
        `Purges on ${formatDate(row.item.purgeAfter)}`,
        ...(row.item.hasUnsyncedContributions
          ? ["Someone's edits arrived after it was deleted. Review before it is purged."]
          : []),
      ];
      const by = row.item.deletedBy ? `Deleted by ${row.item.deletedBy.name}` : named;
      return { ...base, message: by, detail: ACTIVITY_HINT.trash, facts };
    }
    case "copy":
      return {
        ...base,
        message: `${named} · ${formatBytes(row.copy.bytes)}`,
        detail: ACTIVITY_HINT.copy,
        facts: [`Saved at .context/trash/${row.copy.stamp}/${row.copy.relPath}`],
      };
    case "held":
      return { ...base, message: capitalize(row.text), detail: ACTIVITY_HINT.held, facts: ["Restoring on this device"] };
    case "shrunk":
      return {
        ...base,
        message: capitalize(row.text),
        detail: ACTIVITY_HINT.shrunk,
        facts: row.event.deleted ? ["The note is deleted now."] : [],
      };
    case "paused": {
      const facts = row.event.held
        ? [`Paused until ${clockTime(Date.parse(row.event.heldUntil))}`]
        : [row.event.releasedAt ? "Released early" : "Ended"];
      return { ...base, message: capitalize(row.text), detail: ACTIVITY_HINT.paused, facts };
    }
    case "access": {
      if (row.event.kind === "granted") {
        const paths = [...(row.event.paths ?? [])];
        return {
          ...base,
          message: capitalize(row.text),
          paths,
          morePaths: Math.max(0, row.event.count - paths.length),
          detail: ACTIVITY_HINT.access,
          facts: [],
        };
      }
      return { ...base, message: capitalize(row.text), detail: ACTIVITY_HINT.access, facts: [] };
    }
    case "failed":
      return { ...base, message: capitalize(row.text), detail: ACTIVITY_HINT.failed, facts: [] };
    case "invitation": {
      const by = row.invitation.inviterName ? [`Sent by ${row.invitation.inviterName}`] : [];
      return { ...base, message: capitalize(row.text), detail: ACTIVITY_HINT.invitation, facts: by };
    }
  }
}
