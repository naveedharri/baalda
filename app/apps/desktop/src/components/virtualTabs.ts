/* Editor-area tabs that are not notes: a recovery copy opened read-only, a
   deleted note's preview, a compare view, the reconnect review. They live in
   their own store list (`virtualTabs`) with their own active id, so
   `openNote` — which sync, backlinks, versions and sharing all read — never
   holds a path that is not a real note. Session-only, dropped on vault switch. */

/** Where one side of a compare (or a read-only view) gets its text. */
export type TextSource =
  | { type: "copy"; stamp: string; relPath: string }
  | { type: "trash"; docId: string }
  | { type: "note"; path: string }
  /** One stored server version of a note (Activity's "Shrunk" compare). */
  | { type: "version"; docId: string; versionId: number };

export type VirtualTab =
  | { kind: "text"; id: string; title: string; source: TextSource; subtitle?: string }
  | {
      kind: "compare";
      id: string;
      title: string;
      left: { label: string; source: TextSource };
      right: { label: string; source: TextSource };
    }
  | { kind: "review"; id: string; title: string };

export const REVIEW_TAB_ID = "review";

export function sourceKey(s: TextSource): string {
  switch (s.type) {
    case "copy":
      return `copy:${s.stamp}/${s.relPath}`;
    case "trash":
      return `trash:${s.docId}`;
    case "note":
      return `note:${s.path}`;
    case "version":
      return `version:${s.docId}@${s.versionId}`;
  }
}

/** Single instance per (kind, source): opening the same thing twice focuses it. */
export function textTabId(s: TextSource): string {
  return `text|${sourceKey(s)}`;
}

export function compareTabId(left: TextSource, right: TextSource): string {
  return `compare|${sourceKey(left)}|${sourceKey(right)}`;
}

/** Insert or replace by id, never moving an existing tab. */
export function upsertTab(tabs: readonly VirtualTab[], tab: VirtualTab): VirtualTab[] {
  const i = tabs.findIndex((t) => t.id === tab.id);
  if (i === -1) return [...tabs, tab];
  const next = tabs.slice();
  next[i] = tab;
  return next;
}

/** After closing `id`, the tab to activate: its right neighbour, else left, else none. */
export function neighbourAfterClose(tabs: readonly VirtualTab[], id: string): string | null {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return null;
  return tabs[i + 1]?.id ?? tabs[i - 1]?.id ?? null;
}
