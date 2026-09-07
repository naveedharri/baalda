/**
 * Does a right-click inside the file tree belong to the vault root?
 *
 * Right-clicking blank space in the sidebar used to do nothing at all: only
 * rows carried an `onContextMenu`, so the gap under the last note — and the
 * whole "No notes yet" placeholder, where a "New note" item matters most —
 * had no menu. The fix is one handler on the `.filetree` container, which
 * then has to tell "blank space" apart from the things inside it that own
 * their own right-click:
 *
 * - `.tree-row` — the per-node menu (it also stops propagation itself; this
 *   test is the belt to that braces, and what keeps the two apart if the
 *   `stopPropagation` call is ever dropped).
 * - `.filetree-head` / `.filetree-selectbar` — toolbars. A right-click on the
 *   sort button must not open a menu behind the popover it just opened.
 * - `.context-menu` — an already-open menu, including the sort popover.
 *   Right-clicking a menu item must not tear the menu down and rebuild it.
 * - `.modal-backdrop` — `ShareDialog` renders inside `.filetree`, so without
 *   this a right-click in the share dialog would bubble out to the tree.
 *
 * Pure and DOM-shaped rather than React-shaped (one `closest` call, no event),
 * so the rule reads as a list and tests as a table.
 */

/** Everything inside `.filetree` that handles its own right-click. */
const OWNS_OWN_MENU = [
  ".tree-row",
  ".filetree-head",
  ".filetree-selectbar",
  ".context-menu",
  ".modal-backdrop",
].join(", ");

export function isBlankTreeTarget(el: Element | null): boolean {
  if (!el) return false;
  return el.closest(OWNS_OWN_MENU) === null;
}
