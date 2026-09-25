// Does a `[[wiki-link]]` point at a note that exists?
//
// The editor greys out a link that resolves to nothing, and a click on one does
// nothing (it used to create the note at the vault root). Both need the SAME
// answer Rust gives when the link is clicked, so `isWikilinkResolved` mirrors
// `index.rs resolve_wikilink` over the in-memory `store.titles` list:
//
//   target = strip `|alias`, strip `#heading`, trim, strip trailing `.md`
//   1. a note's full relative path (without `.md`)   — case-insensitive
//   2. a note's basename (without `.md`)             — case-insensitive
//   3. a note's title                                — case-insensitive
//
// Rust has a fourth rule — a tree binary (`[[Q3 report.xlsx]]`) by path or
// basename — and `titles` lists notes only, so a target that names a surfaced
// non-note file type is never greyed: we cannot see the files table from here,
// and a link that still opens must not look dead.

import type { NoteTitle } from "../ipc";
import { SURFACED_EXTS, isNoteExt } from "../formats";

/** The resolution target of a link's inner text, exactly as Rust derives it. */
export function wikilinkTarget(inner: string): string {
  let t = inner.split("|")[0]!.split("#")[0]!.trim();
  // `trim_end_matches(".md")` strips repeatedly and is case-sensitive.
  while (t.endsWith(".md")) t = t.slice(0, -3);
  return t;
}

interface TitleIndex {
  paths: Set<string>;
  bases: Set<string>;
  titles: Set<string>;
}

const indexCache = new WeakMap<readonly NoteTitle[], TitleIndex>();

function indexFor(titles: readonly NoteTitle[]): TitleIndex {
  const cached = indexCache.get(titles);
  if (cached) return cached;
  const idx: TitleIndex = { paths: new Set(), bases: new Set(), titles: new Set() };
  for (const t of titles) {
    const path = t.path.toLowerCase();
    // Rust matches `<target>.md`, so only `.md` paths answer rules 1 and 2.
    if (path.endsWith(".md")) {
      const stem = path.slice(0, -3);
      idx.paths.add(stem);
      idx.bases.add(stem.slice(stem.lastIndexOf("/") + 1));
    }
    if (t.title) idx.titles.add(t.title.toLowerCase());
  }
  indexCache.set(titles, idx);
  return idx;
}

const SURFACED = new Set(SURFACED_EXTS);

/** Names a surfaced non-note file (Rust's binary fallback); not judged here. */
function looksLikeFileTarget(target: string): boolean {
  const name = target.slice(target.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return SURFACED.has(ext) && !isNoteExt(name);
}

/** Would Rust `resolve_wikilink` find something for this link's inner text? */
export function isWikilinkResolved(inner: string, titles: readonly NoteTitle[]): boolean {
  const target = wikilinkTarget(inner);
  if (!target) return false;
  if (looksLikeFileTarget(target)) return true;
  const idx = indexFor(titles);
  const lower = target.toLowerCase();
  if (idx.paths.has(lower)) return true;
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (idx.bases.has(base)) return true;
  return idx.titles.has(lower);
}

/** What a click does: open the resolved path, or nothing at all. */
export function wikilinkClickAction(
  resolved: { path: string } | null | undefined,
): { kind: "open"; path: string } | { kind: "none" } {
  return resolved ? { kind: "open", path: resolved.path } : { kind: "none" };
}
