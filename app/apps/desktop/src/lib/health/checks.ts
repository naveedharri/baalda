// The integrity checks the Health page shows, in the order they appear.
//
// Rust (`src-tauri/src/checks.rs`, `ipc.vaultChecks`) only reports counts and
// the affected files per `VaultCheckId`; everything a person reads about a check
// lives here, so the wording can be reviewed in one place and a new check is one
// Rust arm plus one row below.
//
// Pure data + two pure helpers, so it is unit-tested without React.

import type { VaultCheckId, VaultCheckResult, VaultChecks } from "./types";

/** How loudly a FAILING check should read. `info` is housekeeping, not a fault. */
export type CheckSeverity = "info" | "warn" | "error";

/**
 * Which of the page's actions make sense on this check's items / as a whole.
 *
 * The first five are PER ITEM (a button on one row); the rest act on the whole
 * check. An action whose name ends in `-all` is the bulk form of the per-item
 * action above it and reaches exactly the items the row LISTS, never the ones
 * the count implies but Rust capped away.
 */
export type CheckAction =
  // per item
  | "open"
  | "reveal"
  | "delete"
  | "export-copy"
  | "reset-history"
  // the whole check
  | "delete-all"
  | "export-all"
  | "reset-history-all"
  | "rename-legal"
  | "reclaim"
  | "empty-trash"
  | "rebuild-index"
  | "sync-now";

/**
 * Every word a bulk or heal button says, in one table.
 *
 * `{n}` is the number of items the action will touch and `{check}` the check's
 * own label; `planCheckAction` (lib/health/checkActions.ts) substitutes both.
 * Wording lives HERE, with the check definitions, so a reviewer reads what the
 * page will say without opening a component.
 */
export interface CheckActionWording {
  /** Button label. */
  label: string;
  /** Past tense, for the result line: "Deleted 12 of 12". */
  verb: string;
  /** Present participle, for the progress line: "Deleting 3 of 12…". */
  gerund: string;
  /** Present when the action must be confirmed before it runs. */
  confirm?: {
    title: string;
    body: string;
    confirmLabel: string;
    tone: "danger" | "accent";
  };
}

export const CHECK_ACTIONS: Record<CheckAction, CheckActionWording> = {
  open: { label: "Open", verb: "Opened", gerund: "Opening" },
  reveal: { label: "Reveal", verb: "Revealed", gerund: "Revealing" },
  delete: { label: "Delete", verb: "Deleted", gerund: "Deleting" },
  "export-copy": { label: "Save a copy", verb: "Saved", gerund: "Saving" },
  "reset-history": { label: "Reset history", verb: "Reset", gerund: "Resetting" },

  "delete-all": {
    label: "Delete all",
    verb: "Deleted",
    gerund: "Deleting",
    confirm: {
      title: "Delete {n} {check}?",
      body:
        "They are removed from this vault and from every device that syncs it — the " +
        "same delete the sidebar makes. A vault checkpoint can bring them back.",
      confirmLabel: "Delete all",
      tone: "danger",
    },
  },
  "export-all": {
    label: "Save copies",
    verb: "Saved",
    gerund: "Saving",
  },
  "reset-history-all": {
    label: "Reset history",
    verb: "Reset",
    gerund: "Resetting",
    confirm: {
      title: "Reset the history of {n} notes?",
      body:
        "Each note starts over from the file on disk. The text you have now is kept, " +
        "but the edit history behind it is discarded on every device, and undo cannot " +
        "reach past this point.",
      confirmLabel: "Reset history",
      tone: "danger",
    },
  },
  "rename-legal": {
    label: "Rename to legal names",
    verb: "Renamed",
    gerund: "Renaming",
    confirm: {
      title: "Rename {n} files?",
      body:
        "Each offending character becomes `-`, a trailing dot or space is dropped, and " +
        "a name Windows reserves gets a leading `_`. The file keeps its identity, its " +
        "history and its place, so this is a rename and not a new note — but a " +
        "[[wikilink]] that used the old name will need updating. Folders are left alone.",
      confirmLabel: "Rename them",
      tone: "accent",
    },
  },
  reclaim: { label: "Reclaim", verb: "Reclaimed", gerund: "Reclaiming" },
  "empty-trash": {
    label: "Empty trash",
    verb: "Removed",
    gerund: "Emptying",
    confirm: {
      title: "Empty the recovery copies?",
      body:
        "These files can include local edits that could not be synced and deleted-note copies " +
        "kept by earlier versions. Emptying permanently deletes them. Notes still in the vault are untouched.",
      confirmLabel: "Empty trash",
      tone: "danger",
    },
  },
  "rebuild-index": {
    label: "Rebuild index",
    verb: "Rebuilt",
    gerund: "Rebuilding",
  },
  "sync-now": { label: "Sync now", verb: "Synced", gerund: "Syncing" },
};

/**
 * Actions that act on the vault as a whole rather than on the listed items, so
 * "12 of 12" would be meaningless for them and a capped item list costs them
 * nothing.
 */
export const WHOLE_VAULT_ACTIONS: ReadonlySet<CheckAction> = new Set<CheckAction>([
  "reclaim",
  "empty-trash",
  "rebuild-index",
  "sync-now",
]);

export interface CheckDefinition {
  id: VaultCheckId;
  /** Section the check is grouped under. */
  group: "files" | "names" | "links" | "storage";
  label: string;
  /** What the check looks for — shown when it passes too, so a green row still
   *  tells you what was verified. */
  looksFor: string;
  /** Why it matters when it fails, in the user's terms. One or two sentences. */
  whyItMatters: string;
  /** What to do about it. Prose, best first. */
  howToFix: string[];
  severity: CheckSeverity;
  /** Per-item actions, in order. */
  itemActions: CheckAction[];
  /**
   * The ONE action that makes the finding go away by itself — mechanical, safe
   * to run without reading the list first. It is the row's primary button and
   * reads as "Heal"; everything else waits in `bulkActions`.
   *
   * A check with no `heal` is one where the right fix is a judgement call
   * (which of two colliding names is wrong? what should a 240-character path
   * be shortened TO?) or where the data is simply gone (a missing image). Those
   * keep their instructions, deliberately: a heal that guesses is worse than a
   * sentence that explains.
   */
  heal?: CheckAction;
  /** Bulk forms of the per-item actions, in order, as buttons in the row header. */
  bulkActions?: CheckAction[];
  /** The check reports a byte total worth showing next to the count. */
  showsBytes?: boolean;
}

export const CHECK_DEFINITIONS: CheckDefinition[] = [
  // ── Files ────────────────────────────────────────────────────────────────
  {
    id: "empty-notes",
    group: "files",
    label: "Empty notes",
    looksFor: "Notes whose file is 0 bytes.",
    whyItMatters:
      "An empty note syncs fine, but a note that used to have text and is now empty " +
      "usually means a save that never landed or a file another app truncated.",
    howToFix: [
      "Open the note — if it should have content, restore it from Versioning.",
      "Delete notes you never filled in — Delete all clears every one listed here at once.",
    ],
    severity: "info",
    itemActions: ["open", "reveal", "delete"],
    bulkActions: ["delete-all"],
  },
  {
    id: "unreadable-notes",
    group: "files",
    label: "Unreadable notes",
    looksFor: "Note files that are not valid text (not UTF-8, or binary).",
    whyItMatters:
      "Baalda cannot open, index or sync a note it cannot read as text. These files are " +
      "skipped silently everywhere else, so this is the only place you will see them.",
    howToFix: [
      "Open the file in a text editor and save it as UTF-8.",
      "If it is not really a note (an image or export with a .md name), move it out of the vault or rename it.",
      "Save copies puts all of them in one folder outside the vault before you delete them.",
    ],
    severity: "error",
    itemActions: ["reveal", "export-copy", "delete"],
    bulkActions: ["export-all", "delete-all"],
  },
  {
    id: "bad-frontmatter",
    group: "files",
    label: "Broken properties block",
    looksFor:
      "A note that starts with --- but the properties block never closes, or holds lines that are not key: value.",
    whyItMatters:
      "Properties Baalda cannot read are shown as plain text and never touched, so nothing is " +
      "lost — but tags and dates in that block will not be found by search or filters.",
    howToFix: [
      "Open the note and close the block with a line containing only ---.",
      "Keep one property per line as key: value.",
      "Baalda will not repair this for you: properties it cannot read are never rewritten, " +
        "because a guess at what you meant would silently change your data.",
    ],
    severity: "warn",
    itemActions: ["open", "reveal"],
  },
  {
    id: "oversized-notes",
    group: "files",
    label: "Notes over the size limit",
    looksFor: "Notes at or above 10 MB, the most the Remote Vault accepts for one note.",
    whyItMatters:
      "A note this size cannot be uploaded, so its only copy is on this device. Large notes " +
      "are almost always pasted images or data tables.",
    howToFix: [
      "Move big images and files into attachments and link to them.",
      "Split the note, or save a copy outside the vault and shorten it — Save copies puts " +
        "all of them in one folder in a single step.",
    ],
    severity: "error",
    itemActions: ["open", "reveal", "export-copy"],
    bulkActions: ["export-all"],
    showsBytes: true,
  },
  {
    id: "stale-index",
    group: "files",
    label: "Search index out of date",
    looksFor: "Notes that changed on disk after they were last indexed, or whose file is gone.",
    whyItMatters:
      "Search, tags, backlinks and the graph read the index, so a stale row means results " +
      "that miss recent edits or point at a file that no longer exists.",
    howToFix: [
      "Heal rebuilds the index — it reads every note again and takes a few seconds.",
    ],
    severity: "warn",
    itemActions: ["open", "reveal"],
    heal: "rebuild-index",
  },
  {
    id: "unindexed-markdown",
    group: "files",
    label: "Markdown not picked up",
    looksFor: "Markdown files on disk that have no entry in the index.",
    whyItMatters:
      "A file the index never saw is invisible to search and is not synced — usually one " +
      "that was copied in while Baalda was not running.",
    howToFix: [
      "Heal rebuilds the index so these files become notes.",
      "Sync now then registers them with the Remote Vault.",
    ],
    severity: "warn",
    itemActions: ["reveal"],
    heal: "rebuild-index",
    bulkActions: ["sync-now"],
  },

  // ── Names & paths ────────────────────────────────────────────────────────
  {
    id: "case-collisions",
    group: "names",
    label: "Names that differ only by case",
    looksFor: "Two paths that are the same once you ignore upper and lower case.",
    whyItMatters:
      "On a Mac or Windows these are ONE file; on the Remote Vault and on Linux they are two. " +
      "That mismatch is the single most common cause of a note that keeps re-syncing forever.",
    howToFix: [
      "Rename one of the pair so the names differ by more than case.",
      "Baalda will not pick for you: only you know which of the two names is the " +
        "right one, and renaming the wrong one moves the note your links point at.",
    ],
    severity: "error",
    itemActions: ["reveal"],
  },
  {
    id: "illegal-names",
    group: "names",
    label: "Names Windows cannot use",
    looksFor:
      'Names containing < > : " | ? *, ending in a dot or a space, or reserved words such as CON or NUL.',
    whyItMatters:
      "A teammate on Windows cannot create these files, so their vault silently misses them.",
    howToFix: [
      "Heal renames every FILE listed here to the same name without the offending " +
        "character (it becomes `-`, a trailing dot or space is dropped, and a reserved " +
        "Windows name gets a leading `_`). The note keeps its identity and its history.",
      "Folders are left to you — renaming one moves everything inside it.",
      "A wikilink that used the old name needs updating afterwards.",
    ],
    severity: "warn",
    itemActions: ["reveal"],
    heal: "rename-legal",
  },
  {
    id: "long-paths",
    group: "names",
    label: "Very long paths",
    looksFor: "Paths longer than 200 characters from the vault root.",
    whyItMatters: "Windows and some backup tools refuse paths past 260 characters in total.",
    howToFix: [
      "Shorten the folder or file name.",
      "Baalda will not shorten it for you — a name truncated by a machine stops " +
        "saying what the note is.",
    ],
    severity: "info",
    itemActions: ["reveal"],
  },
  {
    id: "duplicate-titles",
    group: "names",
    label: "Notes with the same title",
    looksFor: "Two or more notes sharing one title.",
    whyItMatters:
      "A [[wikilink]] to that title is ambiguous, so it may open a different note than you meant.",
    howToFix: [
      "Give one of them a more specific title, or link by path.",
      "Nothing here is broken, so Baalda changes no titles on its own: which of the " +
        "two should be renamed is yours to say.",
    ],
    severity: "info",
    itemActions: ["open", "reveal"],
  },

  // ── Links ────────────────────────────────────────────────────────────────
  {
    id: "broken-links",
    group: "links",
    label: "Links to missing notes",
    looksFor: "[[wikilinks]] that point at no note in the vault.",
    whyItMatters: "Clicking one creates a new empty note instead of opening what you meant.",
    howToFix: [
      "Open the source note and fix the link if it is a typo.",
      "If the link is intentional, create the note yourself with the name and location you want.",
    ],
    severity: "info",
    itemActions: ["open"],
  },
  {
    id: "missing-embeds",
    group: "links",
    label: "Missing images and attachments",
    looksFor: "![[embeds]] and ![](images) whose file is not in the vault.",
    whyItMatters:
      "The note shows a broken image. Usually the file was never copied in, or was deleted " +
      "from attachments while a note still used it.",
    howToFix: [
      "Drop the file back into the note, or remove the embed.",
      "Baalda cannot heal this one: the bytes are not in the vault, so there is " +
        "nothing to point the embed at.",
    ],
    severity: "warn",
    itemActions: ["open"],
  },

  // ── Storage ──────────────────────────────────────────────────────────────
  {
    id: "heavy-history",
    group: "storage",
    label: "Notes with heavy edit history",
    looksFor: "Notes whose local edit history is many times the size of the note itself.",
    whyItMatters:
      "History this large slows opening and syncing the note and can push it over the Remote Vault's " +
      "limit even when the text is small.",
    howToFix: [
      "Reset the note's history — it keeps the text and starts a fresh history on every device.",
      "Heal does that for every note listed here in one pass.",
    ],
    severity: "warn",
    itemActions: ["open", "reset-history"],
    heal: "reset-history-all",
    showsBytes: true,
  },
  {
    id: "orphan-history",
    group: "storage",
    label: "Leftover edit history",
    looksFor: "Edit history for notes this vault no longer has.",
    whyItMatters: "It only takes up space. Nothing you can see depends on it.",
    howToFix: ["Heal reclaims it. Nothing you can see changes."],
    severity: "info",
    itemActions: [],
    heal: "reclaim",
    showsBytes: true,
  },
  {
    id: "trash",
    group: "storage",
    label: "Recovery copies",
    looksFor:
      "Unsent local edits Baalda preserved, plus deleted-note copies kept by earlier versions.",
    whyItMatters:
      "They may contain changes that could not be synced, and they take up space until emptied.",
    howToFix: ["Review the copies, then empty them when you are sure you no longer need them."],
    severity: "info",
    itemActions: ["reveal"],
    bulkActions: ["empty-trash"],
    showsBytes: true,
  },
];

export const CHECK_BY_ID: ReadonlyMap<VaultCheckId, CheckDefinition> = new Map(
  CHECK_DEFINITIONS.map((d) => [d.id, d]),
);

export const CHECK_GROUP_LABELS: Record<CheckDefinition["group"], string> = {
  files: "Files",
  names: "Names & paths",
  links: "Links",
  storage: "Storage",
};

/** One check joined to its result, ready to render. */
export interface CheckRow {
  def: CheckDefinition;
  result: VaultCheckResult;
  passed: boolean;
}

/**
 * Join definitions to results in definition order. A result Rust did not send
 * (older binary) renders as passed-with-zero rather than vanishing, so the list
 * always has the same rows and a missing check is visible as "0", not absent.
 */
export function checkRows(checks: VaultChecks | null): CheckRow[] {
  const byId = new Map(checks?.results.map((r) => [r.id, r]) ?? []);
  return CHECK_DEFINITIONS.map((def) => {
    const result = byId.get(def.id) ?? { id: def.id, count: 0, items: [] };
    return { def, result, passed: result.count === 0 };
  });
}

export interface CheckSummary {
  total: number;
  passed: number;
  /** Failing checks by their severity. */
  errors: number;
  warnings: number;
  infos: number;
  /** "All 15 checks passed" / "2 checks need a look · 1 is housekeeping". */
  headline: string;
}

export function summarizeChecks(rows: CheckRow[]): CheckSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const r of rows) {
    if (r.passed) continue;
    if (r.def.severity === "error") errors++;
    else if (r.def.severity === "warn") warnings++;
    else infos++;
  }
  const passed = rows.length - errors - warnings - infos;
  const attention = errors + warnings;
  let headline: string;
  if (attention === 0 && infos === 0) headline = `All ${rows.length} checks passed`;
  else if (attention === 0) {
    headline = `${passed} of ${rows.length} checks passed · ${infos} housekeeping`;
  } else {
    headline =
      `${attention} check${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} a look` +
      (infos > 0 ? ` · ${infos} housekeeping` : "");
  }
  return { total: rows.length, passed, errors, warnings, infos, headline };
}
