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

/**
 * Characters no filesystem we ship on accepts in a name (plus control chars).
 * Exported because the inline title REFUSES them where `sanitizeFileStem`
 * strips them — same set, two policies (see `lib/editor/titlePlan.ts`).
 * It is a `g` regex, so callers that only test must reset `lastIndex` (or build
 * their own from `.source`).
 */
// eslint-disable-next-line no-control-regex
export const UNSAFE_STEM = /[\\/:*?"<>|\x00-\x1f]/g;
const UNSAFE = UNSAFE_STEM;
/** Longest name we will write. Filesystems allow more; this is a sanity cap. */
export const MAX_STEM = 100;

/** The extensions a note-shaped file hides in the UI. */
const NOTE_EXT = /\.(md|html?)$/i;

/**
 * Does this path open in the CodeMirror note editor — i.e. does it ride the
 * md↔CRDT bridge?
 *
 * The CRDT note family (`formats.ts NOTE_EXTS`, mirrored in Rust `vault.rs`) is
 * md/markdown/mdx + txt/html/htm/canvas: all seven sync as server `notes`. Two
 * of them do NOT open in the editor:
 *   • `.html`/`.htm` render in `HtmlView` (plain read/write, no bridge);
 *   • `.canvas` renders in the read-only code viewer until there is a canvas
 *     editor.
 * Promoting either into the bridge is its own change; until then this is the
 * ONE test for "the editor owns this buffer", so the open-time registration,
 * the editor mount and the sync layer cannot disagree about it. Every other
 * caller wants `isNoteExt` (the sync family) or `isOpenable` (the click gate).
 */
export function isEditorNote(path: string): boolean {
  return /\.(md|markdown|mdx|txt)$/i.test(path);
}

/**
 * Is this note's text actually MARKDOWN?
 *
 * The narrower half of {@link isEditorNote}: `.txt` opens in the same editor
 * and rides the same bridge, but its bytes are prose. Giving it the markdown
 * grammar would make a shopping list's `# eggs` render as a heading and a
 * `*star*` disappear into italics — in a file the user chose precisely because
 * it has no syntax. So the grammar (and with it every syntax-tree-driven
 * decoration: live preview, blocks, folds, callouts) is markdown-only, and
 * `lib/editor/index.ts baseExtensions` is the one place that asks.
 */
export function isMarkdownNote(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

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
