/**
 * Validating a name typed into the inline title.
 *
 * The title IS the filename (see `lib/notePath.ts`), so committing one is a
 * rename, never a document edit. This module is the pure half: it decides
 * whether a typed stem is a legal name and what path it would produce. It does
 * no I/O — the collision check needs `ipc.noteExists` and lives in the widget.
 *
 * Deliberately REJECTS rather than sanitizes. `sanitizeFileStem` is right for a
 * programmatic rename (a dangling wikilink, the old title-follow), where nobody
 * is watching; a person typing a filename deserves to be told which character
 * the filesystem will not take, not to watch it silently disappear.
 */

import { MAX_STEM, stemOf, UNSAFE_STEM } from "../notePath";

export type TitleRefusal =
  | "empty"
  | "unchanged"
  | "illegal-chars"
  | "leading-dot"
  | "too-long";

export type TitleCheck =
  | { ok: true; nextPath: string; stem: string }
  | { ok: false; reason: TitleRefusal };

/** What to show under the title for each refusal. `unchanged` is silent. */
export const TITLE_REFUSAL_MESSAGE: Record<TitleRefusal, string> = {
  empty: "A note needs a name.",
  unchanged: "",
  "illegal-chars": 'A name can\'t contain / \\ : * ? " < > |',
  "leading-dot": "A name can't start with a dot.",
  "too-long": "That name is too long.",
};

/** The directory part of a vault-relative path (`""` at the root). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The extension a note keeps across a rename (`.md`, `.html`, …). */
function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

/**
 * Validate a typed stem against the note's current path. Returns the path the
 * rename would target; the caller still has to check for a collision, which is
 * async and case-insensitive (macOS) — see `InlineTitle`.
 */
export function planInlineTitleRename(currentPath: string, typed: string): TitleCheck {
  const stem = typed.trim();
  if (stem === "") return { ok: false, reason: "empty" };
  // Reset the global regex's lastIndex by constructing the test fresh.
  if (new RegExp(UNSAFE_STEM.source).test(stem)) {
    return { ok: false, reason: "illegal-chars" };
  }
  if (stem.startsWith(".")) return { ok: false, reason: "leading-dot" };
  if (stem.length > MAX_STEM) return { ok: false, reason: "too-long" };
  // A trailing dot is illegal on Windows and invisible on macOS; trimming it is
  // the one sanitization worth doing silently, because nobody types it on
  // purpose and refusing it would be baffling.
  const clean = stem.replace(/\.+$/, "").trim();
  if (clean === "") return { ok: false, reason: "empty" };
  if (clean === stemOf(currentPath)) return { ok: false, reason: "unchanged" };
  const dir = dirOf(currentPath);
  const nextPath = `${dir === "" ? "" : `${dir}/`}${clean}${extOf(currentPath)}`;
  return { ok: true, nextPath, stem: clean };
}
