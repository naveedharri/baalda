// What counts as an EMPTY file for the ingest truncation guard (#256).
//
// The guard used to refuse only a file of exactly 0 characters. AI agents and
// scripts that rewrite or retire a note rarely leave that: they leave "\n", a
// few blank lines, or the frontmatter block with nothing under it — and each of
// those passed the guard and was diff-merged into a large note as a near-total
// delete, then pushed to every teammate. The server's shrink guard
// (`versions/shrink-guard.ts isSharpShrink`) already judges on trimmed text with
// a 200-character floor, so the two sides now agree on what "empty" means.
//
// Pure and dependency-free so the rule is pinned by a unit test, not a socket.

/**
 * Below this many meaningful characters a doc is small enough that a blank
 * file replacing it is plausibly a person clearing a short note in another
 * editor, so it still applies. Matches the server's `SHRINK_MIN_CHARS`.
 */
export const BLANK_INGEST_MIN_CHARS = 200;

/**
 * A leading YAML frontmatter block: `---` on the first line (after an optional
 * BOM), then anything, then a closing `---` or `...` line. An unclosed block is
 * NOT frontmatter — it is body text that happens to start with a rule.
 */
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** The note's body: everything after a leading frontmatter block, if any. */
export function noteBody(text: string): string {
  const m = FRONTMATTER_RE.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** How many characters of real content a note holds (body, trimmed). */
export function meaningfulLength(text: string): number {
  return noteBody(text).trim().length;
}

/**
 * Should an ingest of `fileText` over a doc holding `docText` be refused as a
 * blank-file truncation? Only ever answers true for a file with no body at all
 * (whitespace and/or bare frontmatter) replacing a doc with at least
 * {@link BLANK_INGEST_MIN_CHARS} characters of body. A file that keeps ANY body
 * text is a partial edit and is never refused here, however much it removes.
 *
 * The exact-0-byte rule is separate and stricter (any populated doc), and stays
 * where it is in `NoteBridge.ingestFromFile`.
 */
export function isBlankTruncation(docText: string, fileText: string): boolean {
  if (meaningfulLength(fileText) > 0) return false;
  return meaningfulLength(docText) >= BLANK_INGEST_MIN_CHARS;
}
