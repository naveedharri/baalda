// Which rows the Access panel's item list shows.
//
// Pure, and separate from the component, because three rules here are subtle
// enough to need a test holding them still:
//
//  1. The list is built from the SERVER's structure, not from this machine's
//     disk. An item set to Private leaves the disk (a revocation that leaves a
//     readable copy behind is cosmetic), and the panel used to draw its rows
//     from the disk — so making something Private removed the only row you
//     could un-Private it from. A restriction you cannot see is one you cannot
//     lift.
//  2. A tree binary (`.pdf`, `.xlsx`, `.mp4`) is a row here like a note. It is
//     a `files` row on the server, which is a doc_id, which is a thing the
//     resolver already enforces — so leaving it out of this list made it the
//     one item in a vault whose access could be enforced but never set.
//  3. In the local-tree fallback, a folder with `childrenLoaded` unset is
//     *expandable, not empty*. The sidebar loads folders lazily, so an
//     un-clicked folder arrives with no children — and calling that "nothing
//     inside" hid every note the user hadn't already opened elsewhere.

import { formatFor } from "./formats";
import type { TreeNode } from "./ipc";

/**
 * What one administrable row IS.
 *
 * `note` and `file` are two different rows and ONE share resource type — see
 * {@link accessResourceType}. The server calls both `file` because both are
 * docs to the resolver (`locateDoc` reads `notes` and `files` in one union), so
 * a `.pdf` takes a grant, a lock and a deny exactly as a `.md` does. They are
 * split here only because the panel has to say "this file" instead of "this
 * note" and draw the right glyph.
 */
export type AccessKind = "folder" | "note" | "file";

/** One folder, note or file the panel can administer, before nesting is worked out. */
export interface AccessEntry {
  kind: AccessKind;
  /** Server id: a folder id, or a note's/file's doc_id. */
  id: string;
  /** Vault-relative path. */
  path: string;
  /** Folders only. `undefined` means "not listed yet" — see rule 3 above. */
  hasChildren?: boolean;
}

export interface AccessRow extends AccessEntry {
  key: string;
  name: string;
  depth: number;
  /** Folders only: offer a twisty? */
  expandable: boolean;
}

export interface AccessTreeResolvers {
  /** Server folder id for a vault-relative path, or null if unregistered. */
  folderId: (path: string) => string | null;
  /** doc_id for a vault-relative note path, or null if unregistered. */
  docId: (path: string) => string | null;
  /** `files` row id for a vault-relative binary path, or null if unregistered. */
  fileId: (path: string) => string | null;
}

/**
 * The `shares.resource_type` a row is administered under.
 *
 * Notes and files share one namespace — the server's `file` — because both are
 * doc_ids and every ACL surface (`resolveResource`, `buildAccessContext`,
 * `effectivePermission`) resolves them through the same union. Anything that
 * talks to the share API goes through here rather than passing `kind` straight
 * down, which is what keeps the two-way split above from leaking onto the wire.
 */
export function accessResourceType(kind: AccessKind): "folder" | "file" {
  return kind === "folder" ? "folder" : "file";
}

/** basename, optionally without the `.md` a note's title never shows. */
export function accessRowName(path: string, stripMd = false): string {
  const last = path.split("/").pop() ?? path;
  return stripMd ? last.replace(/\.md$/i, "") : last;
}

/**
 * Entries from the server's structure listing (`listAccessTree`).
 *
 * This is the authoritative source: it is not ACL-filtered, so it includes the
 * items the caller has shut themselves out of — which are exactly the ones they
 * need to reach in order to change their minds.
 */
export function entriesFromServer(input: {
  folders: Array<{ id: string; path: string }>;
  notes: Array<{ id: string; relPath: string }>;
  /** `files` rows — the tree binaries. Absent from an older server. */
  files?: Array<{ id: string; path: string }>;
}): AccessEntry[] {
  const files = input.files ?? [];
  const folderPaths = input.folders.map((f) => f.path);
  const allPaths = [
    ...folderPaths,
    ...input.notes.map((n) => n.relPath),
    ...files.map((f) => f.path),
  ];
  const hasChildren = (dir: string) => allPaths.some((p) => p.startsWith(`${dir}/`));
  return [
    ...input.folders.map((f) => ({
      kind: "folder" as const,
      id: f.id,
      path: f.path,
      hasChildren: hasChildren(f.path),
    })),
    ...input.notes.map((n) => ({ kind: "note" as const, id: n.id, path: n.relPath })),
    ...files.map((f) => ({ kind: "file" as const, id: f.id, path: f.path })),
  ];
}

/**
 * Entries from the local sidebar tree — the fallback for a listing that hasn't
 * arrived (or was refused). Carries rule 3: an un-listed folder is expandable.
 *
 * An unregistered folder is skipped as an entry (it can't own a share) but is
 * still walked into, so registered notes beneath it stay reachable.
 */
export function entriesFromTree(
  tree: TreeNode | null,
  resolve: AccessTreeResolvers,
): AccessEntry[] {
  const out: AccessEntry[] = [];
  const walk = (node: TreeNode): void => {
    if (!node.isDir) {
      // A binary is administered through its `files` row, so a path this device
      // has not registered yet is skipped: with no doc_id there is nothing a
      // share could name. Notes answer the same way through `docId`.
      if (formatFor(node.path)?.syncAs === "attachment") {
        const fileId = resolve.fileId(node.path);
        if (fileId) out.push({ kind: "file", id: fileId, path: node.path });
        return;
      }
      const docId = resolve.docId(node.path);
      if (docId) out.push({ kind: "note", id: docId, path: node.path });
      return;
    }
    const folderId = resolve.folderId(node.path);
    if (folderId) {
      out.push({
        kind: "folder",
        id: folderId,
        path: node.path,
        hasChildren: node.childrenLoaded !== true ? undefined : (node.children?.length ?? 0) > 0,
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const child of tree?.children ?? []) walk(child);
  return out;
}

/**
 * Nest a flat entry list into indented rows, leaving a collapsed folder's
 * contents out.
 *
 * Depth and parentage come from the path, which is the only thing both sources
 * agree on. Sorted folders-first then alphabetically within each level, so the
 * list is stable however the server ordered it.
 */
export function rowsFromEntries(
  entries: readonly AccessEntry[],
  expanded: ReadonlySet<string>,
): AccessRow[] {
  const sorted = [...entries].sort((a, b) => {
    const ad = a.path.split("/").length;
    const bd = b.path.split("/").length;
    // Compare level by level so a folder always precedes its own contents.
    const aParts = a.path.split("/");
    const bParts = b.path.split("/");
    for (let i = 0; i < Math.min(ad, bd); i++) {
      if (aParts[i] === bParts[i]) continue;
      // Notes and files sort together as one leaf class, interleaved by name:
      // they sit side by side in the vault and a second tier would only make a
      // folder's `.pdf` harder to find than its `.md`.
      const aLeaf = i === ad - 1 && a.kind !== "folder";
      const bLeaf = i === bd - 1 && b.kind !== "folder";
      if (aLeaf !== bLeaf) return aLeaf ? 1 : -1; // folders before notes and files
      return aParts[i].localeCompare(bParts[i]);
    }
    return ad - bd;
  });

  const collapsed = sorted
    .filter((e) => e.kind === "folder" && !expanded.has(e.path))
    .map((e) => `${e.path}/`);
  const hidden = (path: string) => collapsed.some((prefix) => path.startsWith(prefix));

  return sorted
    .filter((e) => !hidden(e.path))
    .map((e) => ({
      ...e,
      key: `${e.kind}:${e.id}`,
      name: accessRowName(e.path, e.kind === "note"),
      depth: e.path.split("/").length - 1,
      // `undefined` (not listed yet) counts as expandable — refusing the twisty
      // on an un-listed folder is the bug rule 3 exists to prevent.
      expandable: e.kind === "folder" && e.hasChildren !== false,
    }));
}

/** Has the sidebar already listed this folder's contents? */
export function folderChildrenLoaded(tree: TreeNode | null, path: string): boolean {
  const find = (node: TreeNode): TreeNode | null => {
    if (node.path === path) return node;
    for (const child of node.children ?? []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const child of tree?.children ?? []) {
    const hit = find(child);
    if (hit) return hit.childrenLoaded === true;
  }
  return false;
}

/** Every folder path above `path` — what has to be open for it to be visible. */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
