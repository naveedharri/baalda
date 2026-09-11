/**
 * A note's name, derived from its path — the ONE label rule.
 *
 * A note's title is its file name. The Rust index keeps a richer `title`
 * (frontmatter `title:` → first H1 → stem, see `src-tauri/src/parse.rs
 * derive_title`) because wikilinks resolve by basename *then* title and the
 * search index has a title column — but the UI never shows that one. The tab
 * strip, the sidebar and the window all read the filename through here, which is
 * why they can no longer disagree.
 *
 * `sanitizeFileStem` came from the retired `lib/editor/titleFollow.ts` (the
 * "title follows heading" rule, removed once new notes stopped being seeded with
 * an H1); Stage 2's inline title commits a rename through it.
 */

/** Characters no filesystem we ship on accepts in a name (plus control chars). */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\/:*?"<>|\x00-\x1f]/g;
const MAX_STEM = 100;

/** The extensions a note-shaped file hides in the UI. */
const NOTE_EXT = /\.(md|html?)$/i;

/** `Notes/Untitled.md` → `Untitled`. Strips ANY extension (used for renames). */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[^.]+$/, "");
}

/**
 * The label the UI shows for a file at `path`. Notes and pages hide their
 * extension (the same rule the rename input uses); every other file type keeps
 * it, because the extension is how you tell two previews apart.
 */
export function noteLabel(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return displayName(base, false);
}

/**
 * `noteLabel`'s name-level twin, for callers that already hold a directory
 * entry rather than a path (the sidebar rows). One rule, two arities.
 */
export function displayName(name: string, isDir: boolean): string {
  return isDir ? name : name.replace(NOTE_EXT, "");
}

/** Turn a title into something a file can be called, or null if nothing usable
 *  survives (a title of only punctuation, say). */
export function sanitizeFileStem(title: string): string | null {
  const stem = title
    .replace(UNSAFE, "")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot hides the file from the vault (dotfiles are ignored); a
    // trailing dot is illegal on Windows.
    .replace(/^\.+|[.\s]+$/g, "")
    .slice(0, MAX_STEM)
    .trim();
  return stem.length > 0 ? stem : null;
}
