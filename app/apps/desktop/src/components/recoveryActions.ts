/* The side-effecting half of the recovery-copy actions (the pure half is
   `recoveryCopies.ts`): open a copy or a Trash preview read-only, open a
   compare, restore a copy over the current note (through its live editor, so
   through the CRDT) or beside it, delete a copy. */
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { noteLabel } from "../lib/notePath";
import { liveView, replaceWholeDoc, waitForLiveView } from "./liveEditorViews";
import {
  copyTabTitle,
  originalPathOf,
  siblingRecoveredPath,
  stampTime,
  type CopyRef,
} from "./recoveryCopies";
import { compareTabId, REVIEW_TAB_ID, textTabId, type TextSource } from "./virtualTabs";

/** How long "Replace current note" waits for the note's editor to mount. */
export const LIVE_VIEW_WAIT_MS = 8000;

const copySource = (ref: CopyRef): TextSource => ({ type: "copy", ...ref });

function copyTime(ref: CopyRef, fallback?: number): number {
  return stampTime(ref.stamp) ?? fallback ?? Date.now();
}

function show(): void {
  // The actions live in Settings → Health; what they open is behind it.
  useStore.getState().dismissSettings();
}

export function openCopy(ref: CopyRef, modified?: number): void {
  const source = copySource(ref);
  useStore.getState().openVirtualTab({
    kind: "text",
    id: textTabId(source),
    title: copyTabTitle(ref.relPath, copyTime(ref, modified)),
    subtitle: `${ipcTrashPath(ref)}`,
    source,
  });
  show();
}

export function openTrashPreview(docId: string, relPath: string): void {
  const source: TextSource = { type: "trash", docId };
  useStore.getState().openVirtualTab({
    kind: "text",
    id: textTabId(source),
    title: `${noteLabel(relPath)} (deleted)`,
    subtitle: "In Trash",
    source,
  });
  show();
}

export function openCompare(
  left: { label: string; source: TextSource },
  notePath: string,
): void {
  const right = { label: `Current: ${noteLabel(notePath)}`, source: { type: "note", path: notePath } as TextSource };
  useStore.getState().openVirtualTab({
    kind: "compare",
    id: compareTabId(left.source, right.source),
    title: `Compare ${noteLabel(notePath)}`,
    left,
    right,
  });
  show();
}

export function compareCopy(ref: CopyRef, notePath = originalPathOf(ref.relPath), modified?: number): void {
  openCompare({ label: copyTabTitle(ref.relPath, copyTime(ref, modified)), source: copySource(ref) }, notePath);
}

export function compareTrash(docId: string, relPath: string): void {
  openCompare({ label: `${noteLabel(relPath)} (deleted)`, source: { type: "trash", docId } }, relPath);
}

export function ipcTrashPath(ref: CopyRef): string {
  return `.context/trash/${ref.stamp}/${ref.relPath}`;
}

function epoch(): ipc.VaultEpoch {
  return useStore.getState().vault?.epoch;
}

/** Open `path` (unless it is already the mounted note) and wait for its editor. */
async function liveViewFor(path: string) {
  const now = liveView(path);
  if (now) {
    useStore.getState().activateVirtualTab(null);
    return now;
  }
  await useStore.getState().openNoteByPath(path);
  const view = await waitForLiveView(path, LIVE_VIEW_WAIT_MS);
  if (!view) throw new Error("The note did not open in time. Open it and try again.");
  return view;
}

/**
 * Replace the note at `notePath` with `text` as ONE editor transaction on its
 * live editor. In a synced vault that goes through yCollab into the note's
 * Y.Text exactly like typing, so it merges and syncs; never a disk write.
 */
export async function replaceNoteText(notePath: string, text: string): Promise<void> {
  if (!(await ipc.noteExists(notePath, epoch()))) {
    throw new Error("There is no current note at that path. Restore it as a new note instead.");
  }
  const view = await liveViewFor(notePath);
  replaceWholeDoc(view, text);
}

export async function restoreCopyReplace(ref: CopyRef, notePath = originalPathOf(ref.relPath)): Promise<void> {
  const text = await ipc.readTrashCopy(ref.stamp, ref.relPath, epoch());
  await replaceNoteText(notePath, text);
}

/** First free `<stem> (recovered…).<ext>` beside `path`, checked on disk. */
export async function freeSiblingPath(path: string): Promise<string> {
  const taken = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const candidate = siblingRecoveredPath(path, (p) => taken.has(p.toLowerCase()));
    if (!(await ipc.noteExists(candidate, epoch()))) return candidate;
    taken.add(candidate.toLowerCase());
  }
  throw new Error("Could not find a free name for the recovered note.");
}

/**
 * Create `<stem> (recovered).<ext>` beside the original with `text`: the
 * store's create action makes (and registers) an empty note and opens it, then
 * the text goes in through its live editor like any edit.
 */
export async function restoreTextAsSibling(originalPath: string, text: string): Promise<string> {
  const target = await freeSiblingPath(originalPath);
  const slash = target.lastIndexOf("/");
  const dir = slash === -1 ? "" : target.slice(0, slash);
  const name = target.slice(slash + 1);
  const created = await useStore.getState().createNoteAt(dir, name);
  if (!created) throw new Error("This folder does not accept new notes right now.");
  const view = await waitForLiveView(created, LIVE_VIEW_WAIT_MS);
  if (!view) throw new Error("The recovered note was created but did not open. Its copy is still in trash.");
  useStore.getState().activateVirtualTab(null);
  replaceWholeDoc(view, text);
  return created;
}

export async function restoreCopyAsSibling(ref: CopyRef): Promise<string> {
  const text = await ipc.readTrashCopy(ref.stamp, ref.relPath, epoch());
  return restoreTextAsSibling(originalPathOf(ref.relPath), text);
}

export async function deleteCopy(ref: CopyRef): Promise<void> {
  await ipc.deleteTrashCopy(ref.stamp, ref.relPath, epoch());
  // A tab showing a copy that no longer exists would only error on refresh.
  const s = useStore.getState();
  const src = copySource(ref);
  for (const t of s.virtualTabs) {
    const uses =
      (t.kind === "text" && t.id === textTabId(src)) ||
      (t.kind === "compare" && t.left.source.type === "copy" && t.id === compareTabId(src, t.right.source));
    if (uses) s.closeVirtualTab(t.id);
  }
}

/** Open (or focus) the single "Review changes" tab. */
export function openReviewTab(): void {
  useStore.getState().openVirtualTab({ kind: "review", id: REVIEW_TAB_ID, title: "Review changes" });
}
