/* What one Activity row says, collapsed and expanded (ActivityFeed.tsx).
   Collapsed: the kind chip, a short message and the relative time on line 1,
   the note path on line 2. Expanded: the full path(s), the explanation that
   used to live only in a native tooltip, secondary facts and the exact time.
   Pure, so the wording is tested without a DOM. */
import { clockDate, clockTime, formatBytes, relativeTime, splitPath } from "../lib/health/format";
import { noteLabel } from "../lib/notePath";
import { ACTIVITY_HINT, type ActivityRow } from "./activityRows";

export interface ActivityRowText {
  label: string;
  /** Line 1, after the chip. Never empty. */
  message: string;
  /** "13 min ago". */
  when: string;
  /** Line 2 while collapsed; "" when the row is not about one note. The head
   *  hides it while expanded, so the body never shows it twice. */
  path: string;
  /** Full paths the expanded body lists, each once; never one the message
   *  already names (that row gets its folder as a fact instead). */
  bodyPaths: string[];
  /** Paths a grant covered beyond `bodyPaths`. */
  morePaths: number;
  /** The plain-words explanation of this kind of row. */
  detail: string;
  /** Secondary facts for the expanded row, never repeating `message`. */
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

/** "In Projects/Q3" for a note the message already names; nothing at the root. */
function folderFact(path: string): string[] {
  const { dir } = splitPath(path);
  return dir ? [`In ${dir.replace(/\/$/, "")}`] : [];
}

/** A recovery-copy location without the filename the row already names. */
function savedIn(location: string, path: string): string {
  const name = splitPath(path).name;
  const { dir, name: last } = splitPath(location);
  return last === name && dir ? `Copy saved in ${dir}` : location;
}

export function activityRowText(row: ActivityRow, now: number): ActivityRowText {
  const base = {
    label: row.label,
    when: relativeTime(row.at, now),
    path: row.path,
    morePaths: 0,
    absoluteTime: clockDate(row.at),
  };
  const name = row.path ? noteLabel(row.path) : row.label;
  /** The message names the note: the body adds only its folder. */
  const named = (message: string, detail: string, facts: string[]): ActivityRowText => ({
    ...base,
    message,
    bodyPaths: [],
    detail,
    facts: [...(row.path ? folderFact(row.path) : []), ...facts.filter((f) => f !== message)],
  });
  /** The message is a sentence: the body shows the full path once. */
  const sentence = (message: string, detail: string, facts: string[]): ActivityRowText => ({
    ...base,
    message,
    bodyPaths: row.path ? [row.path] : [],
    detail,
    facts: facts.filter((f) => f !== message),
  });

  switch (row.type) {
    case "reconcile": {
      const facts = [
        ...(row.item.newPath ? [`Renamed to ${row.item.newPath}`] : []),
        ...(row.item.detail && row.item.detail !== row.path ? [savedIn(row.item.detail, row.path)] : []),
      ];
      return named(name, ACTIVITY_HINT.reconcile, facts);
    }
    case "trash": {
      const facts = [
        ...(row.item.deletedBy ? [`Deleted by ${row.item.deletedBy.name}`] : []),
        `Purges on ${formatDate(row.item.purgeAfter)}`,
        ...(row.item.hasUnsyncedContributions
          ? ["Someone's edits arrived after it was deleted. Review before it is purged."]
          : []),
      ];
      return named(name, ACTIVITY_HINT.trash, facts);
    }
    case "copy":
      return named(name, ACTIVITY_HINT.copy, [
        formatBytes(row.copy.bytes),
        `Copy saved in .context/trash/${row.copy.stamp}/`,
      ]);
    case "held":
      return sentence(capitalize(row.text), ACTIVITY_HINT.held, ["Restoring on this device"]);
    case "shrunk":
      return sentence(capitalize(row.text), ACTIVITY_HINT.shrunk, row.event.deleted ? ["The note is deleted now."] : []);
    case "paused": {
      const facts = row.event.held
        ? [`Paused until ${clockTime(Date.parse(row.event.heldUntil))}`]
        : [row.event.releasedAt ? "Released early" : "Ended"];
      return sentence(capitalize(row.text), ACTIVITY_HINT.paused, facts);
    }
    case "access": {
      if (row.event.kind === "granted") {
        const all = row.event.paths ?? [];
        const bodyPaths = [...new Set(all)].filter((p) => p !== row.path);
        return {
          ...base,
          message: capitalize(row.text),
          bodyPaths,
          morePaths: Math.max(0, row.event.count - all.length),
          detail: ACTIVITY_HINT.access,
          facts: [],
        };
      }
      return sentence(capitalize(row.text), ACTIVITY_HINT.access, []);
    }
    case "failed":
      return sentence(capitalize(row.text), ACTIVITY_HINT.failed, []);
    case "invitation": {
      const by = row.invitation.inviterName ? [`Sent by ${row.invitation.inviterName}`] : [];
      return sentence(capitalize(row.text), ACTIVITY_HINT.invitation, by);
    }
  }
}
