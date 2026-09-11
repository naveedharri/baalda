/**
 * Property edits as minimal span replacements.
 *
 * Every planner here returns CM6 change specs and dispatches nothing — the
 * caller turns them into an ordinary editor-origin transaction, which is what
 * makes a property edit indistinguishable from typing: yCollab puts it in the
 * Y.Text, the bridge egests it to the `.md` file, Rust re-indexes, and Yjs undo
 * treats it as one step. No path in here rewrites the block.
 *
 * The invariant the tests assert: applying a planner's changes leaves every
 * byte outside the edited span identical. Editing `status` cannot reorder keys,
 * reformat `tags`, or drop a comment.
 */

import type { Text } from "@codemirror/state";
import type { FrontmatterRange } from "../editor/frontmatter";
import type { PropEntry, PropValue } from "./parse";

export interface SpanChange {
  from: number;
  to: number;
  insert: string;
}

/** Default indent for a block list we are creating from nothing. */
const LIST_INDENT = "  ";

/**
 * Does this scalar need quoting to survive a YAML round-trip? Conservative on
 * purpose — a spurious pair of quotes is cosmetic, a missing pair changes what
 * the file means. `[[Note]]` is the case that bites: unquoted it parses as a
 * nested flow sequence.
 */
function needsQuotes(s: string): boolean {
  if (s === "") return false; // an empty value is written as `key:`
  if (s !== s.trim()) return true; // leading/trailing space
  if (/[:#,[\]{}&*!|>'"%@`]/.test(s)) return true;
  if (/^[-?]/.test(s)) return true;
  if (/[\n\r\t]/.test(s)) return true;
  return false;
}

/** Double-quote a scalar, escaping what YAML requires inside double quotes. */
export function quoteScalar(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function scalarToken(s: string): string {
  return needsQuotes(s) ? quoteScalar(s) : s;
}

/**
 * Serialize a value INCLUDING its separator from the key's colon — a leading
 * space for scalars and flow lists, a leading newline for a block list, and the
 * empty string for an empty value (`key:`). One function, so no caller has to
 * sniff the byte before the span it is replacing.
 */
export function serializeValue(
  value: PropValue,
  style: "flow" | "block" = "flow",
  indent = LIST_INDENT,
): string {
  switch (value.kind) {
    case "checkbox":
      return value.value ? " true" : " false";
    case "number":
      return ` ${value.value}`;
    case "list": {
      if (value.value.length === 0) return " []";
      if (style === "block") {
        return `\n${value.value
          .map((item) => `${indent}- ${scalarToken(item)}`)
          .join("\n")}`;
      }
      return ` [${value.value.map(scalarToken).join(", ")}]`;
    }
    default: {
      const text = String(value.value);
      return text === "" ? "" : ` ${scalarToken(text)}`;
    }
  }
}

/** Replace one property's value, and nothing else. */
export function planSetValue(entry: PropEntry, next: PropValue): SpanChange[] {
  const insert = serializeValue(
    next,
    // A list keeps the style it already had; a scalar becoming a list gets the
    // flow form, which is what Obsidian writes for a fresh one.
    next.kind === "list" ? (entry.listStyle ?? "flow") : "flow",
    entry.listIndent ?? LIST_INDENT,
  );
  if (insert === entry.raw) return [];
  return [{ from: entry.valueSpan.from, to: entry.valueSpan.to, insert }];
}

/** Rename one property's key, leaving its value untouched. */
export function planRenameKey(entry: PropEntry, nextKey: string): SpanChange[] {
  const key = nextKey.trim();
  if (key === "" || key === entry.key) return [];
  return [
    {
      from: entry.keySpan.from,
      to: entry.keySpan.to,
      insert: needsQuotes(key) ? quoteScalar(key) : key,
    },
  ];
}

/**
 * Remove a property: its logical line(s) plus the newline that ended them.
 * Deleting the last property leaves `---\n---`, an empty-but-valid block —
 * removing the fences would be a bigger edit than the user asked for.
 */
export function planDeleteProperty(doc: Text, entry: PropEntry): SpanChange[] {
  const to = Math.min(doc.length, entry.lineSpan.to + 1);
  return [{ from: entry.lineSpan.from, to, insert: "" }];
}

/**
 * Add a property. With a block present it becomes one new line after the last
 * property (or the only line of an empty block); with no block at all it brings
 * the fences with it.
 */
export function planAddProperty(
  doc: Text,
  fm: FrontmatterRange | null,
  entries: readonly PropEntry[],
  key: string,
  value: PropValue,
): SpanChange[] {
  const line = `${needsQuotes(key) ? quoteScalar(key) : key}:${serializeValue(value)}`;
  if (!fm) {
    // A body that already starts with text must not be welded to the closing
    // fence, and an empty note must not gain a spurious blank line — both fall
    // out of ending the insert with exactly one newline.
    return [{ from: 0, to: 0, insert: `---\n${line}\n---\n` }];
  }
  const last = entries.length > 0 ? entries[entries.length - 1]! : null;
  if (last) {
    return [{ from: last.lineSpan.to, to: last.lineSpan.to, insert: `\n${line}` }];
  }
  // An empty `---\n---` block: the new line goes in front of the closing fence.
  const at = doc.line(fm.closeLine).from;
  return [{ from: at, to: at, insert: `${line}\n` }];
}
