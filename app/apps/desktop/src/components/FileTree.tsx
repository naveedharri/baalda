import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Tree,
  type CursorProps,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from "react-arborist";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { TreeNode } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { ITEM_COLORS, itemColorValue } from "../lib/appearance";
import {
  applyOrder,
  childrenAt,
  clearOrderAt,
  computeReorder,
  moveSubtreeOrder,
  removeFromOrder,
  renameInOrder,
} from "../lib/ordering";
import { LOCK_TITLES, lockScopesByPath, type LockScope } from "../lib/locks";
import { previewKind } from "../lib/preview";
import { embedDroppedFile } from "../lib/attachments";
import { activeNoteEditable, insertIntoActiveNote } from "../lib/editor/activeView";
import { useStore } from "../store";
import { shareResourceId } from "../lib/api";
import { syncManager } from "../lib/sync/docSession";
import type { VaultPeer } from "../lib/sync/vaultSyncEngine";
import { PRESENCE_OFFLINE, ringShowsColor, statusTone } from "../lib/presence/color";
import { characterSvg } from "./Identity";
import { ShareDialog, type ShareTarget } from "./ShareDialog";

interface Dimensions {
  width: number;
  height: number;
}

function useDimensions(): [React.RefObject<HTMLDivElement | null>, Dimensions] {
  const ref = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState<Dimensions>({ width: 240, height: 400 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setDim({ width: r.width, height: r.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, dim];
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Files the in-app editor can render: markdown notes and HTML pages. */
function isOpenablePath(path: string): boolean {
  return /\.(md|html?)$/i.test(path);
}

/** Resolve a client (CSS px) point to the vault-relative dir under it, using the
 *  `data-tree-dir` attribute each tree row carries. Falls back to the vault root. */
function dirAtClientPoint(x: number, y: number): string {
  const el = document.elementFromPoint(x, y);
  const row = el?.closest("[data-tree-dir]") as HTMLElement | null;
  return row?.dataset.treeDir ?? "";
}

interface MenuState {
  x: number;
  y: number;
  node: NodeApi<TreeNode> | null;
}

/* Toolbar glyphs — file+ / folder+ mirror the tree's own icons so the "create"
   actions read as "a new one of these"; the chevron pairs fold in / fan out. */
const ICON_NEW_NOTE = (
  <TreeSvg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M15 2v5h5" />
    <path d="M12 11v6M9 14h6" />
  </TreeSvg>
);
const ICON_NEW_FOLDER = (
  <TreeSvg>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 11v6M9 14h6" />
  </TreeSvg>
);
const ICON_COLLAPSE_ALL = (
  <TreeSvg>
    <path d="m7 4 5 5 5-5" />
    <path d="m7 20 5-5 5 5" />
  </TreeSvg>
);
const ICON_EXPAND_ALL = (
  <TreeSvg>
    <path d="m7 9 5-5 5 5" />
    <path d="m7 15 5 5 5-5" />
  </TreeSvg>
);
/* Select-mode toggle — a ticked checkbox reads as "pick items". */
const ICON_SELECT = (
  <TreeSvg>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
    <path d="m8 12 3 3 5-6" />
  </TreeSvg>
);
const ICON_CHECK = (
  <TreeSvg>
    <path d="m5 12 5 5 9-11" />
  </TreeSvg>
);
/* Bulk-action glyphs: open padlock / trash can (closed padlock is ICON_LOCK). */
const ICON_UNLOCK = (
  <TreeSvg>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.5-1.9" />
  </TreeSvg>
);
const ICON_TRASH = (
  <TreeSvg>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
  </TreeSvg>
);

export function FileTree() {
  const tree = useStore((s) => s.tree);
  const openNote = useStore((s) => s.openNote);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const locks = useStore((s) => s.locks);
  const vaultPresence = useStore((s) => s.vaultPresence);
  const session = useStore((s) => s.session);
  const members = useStore((s) => s.members);
  const itemColors = useStore((s) => s.itemColors);
  const itemOrder = useStore((s) => s.itemOrder);
  const [containerRef, dim] = useDimensions();
  const treeRef = useRef<TreeApi<TreeNode> | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  // Which way the fold toggle points: false → "collapse all", true → "expand all".
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  // True while an OS drag hovers the tree, for the drop-target highlight.
  const [dropActive, setDropActive] = useState(false);
  // Transient status pill shown after an import (from the menu or a drop).
  const [importStatus, setImportStatus] = useState<
    { text: string; tone: "success" | "error" | "neutral" } | null
  >(null);
  const importStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Multi-select: a mode toggle + the set of picked paths. Kept local to the
  // tree (react-arborist's own selection is left alone) so the bulk-action bar
  // only exists while selecting and doesn't crowd the normal browsing UI.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  // While a bulk delete runs: {done,total} drives a progress bar in the
  // selectbar so a large delete reads as "working", not "frozen".
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  // onActivate is captured by arborist; read the live mode through a ref.
  const selectModeRef = useRef(false);
  selectModeRef.current = selectMode;

  // Group live presence by the note (docId) each teammate is viewing, so a row
  // can look up "who's here" in O(1). Rebuilt only when the roster changes.
  const presenceByDoc = useMemo(() => {
    const map = new Map<string, VaultPeer[]>();
    for (const peer of vaultPresence) {
      if (!peer.docId) continue;
      const arr = map.get(peer.docId);
      if (arr) arr.push(peer);
      else map.set(peer.docId, [peer]);
    }
    return map;
  }, [vaultPresence]);

  // Resolve lock rows (server resource ids) to tree paths for the badges.
  const lockByPath = useMemo(
    () => (syncEnabled ? lockScopesByPath(tree, locks, session?.user.id) : new Map()),
    [tree, locks, syncEnabled, session?.user.id],
  );

  // Owners/admins can lock and unlock straight from the row menu.
  const myRole = members.find((m) => m.userId === session?.user.id)?.role;
  const canManage = myRole === "owner" || myRole === "admin";

  /** Resolve a path (+ kind) to a server share resource, if the vault is synced. */
  function shareTargetForPath(
    path: string,
    isDir: boolean,
    name: string,
  ): ShareTarget | null {
    if (!syncEnabled) return null;
    if (isDir) {
      const id = syncManager.registry.getFolderId(path);
      return id ? { resourceType: "folder", resourceId: id, title: name } : null;
    }
    const mapping = syncManager.registry.getMapping(path);
    return mapping
      ? { resourceType: "file", resourceId: mapping.docId, title: name }
      : null;
  }

  /** Resolve a tree node to a server share resource, if the vault is synced. */
  function shareTargetFor(node: NodeApi<TreeNode>): ShareTarget | null {
    return shareTargetForPath(node.data.path, node.data.isDir, node.data.name);
  }

  // Rust returns folders-first/alphabetical; layer the user's manual
  // arrangement on top so drag-to-reorder sticks.
  const data = useMemo<TreeNode[]>(
    () => applyOrder(tree?.children ?? [], "", itemOrder),
    [tree, itemOrder],
  );

  // Flatten the (arranged) tree so bulk actions can resolve any path — even a
  // collapsed one — to its node, and so "Select all" knows every path.
  const nodeByPath = useMemo(() => {
    const m = new Map<string, TreeNode>();
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        m.set(n.path, n);
        if (n.children) walk(n.children);
      }
    };
    walk(data);
    return m;
  }, [data]);

  const allSelected = nodeByPath.size > 0 && selected.size === nodeByPath.size;

  // Lazy loading: a folder arrives with an empty `children` placeholder; the
  // first time it's expanded, fetch its real children on demand. Genuinely
  // empty folders just re-fetch an empty list (harmless).
  const onToggle = (id: string) => {
    const node = nodeByPath.get(id);
    if (node?.isDir && (node.children?.length ?? 0) === 0) {
      void useStore.getState().loadChildren(id);
    }
  };

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(nodeByPath.keys()));
  }

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmDelete(false);
  }

  // A destructive delete arms a one-tap confirm; any change to the picks (or
  // leaving the count) disarms it so a stale "Delete N?" can't fire.
  useEffect(() => {
    setConfirmDelete(false);
  }, [selected]);

  async function bulkDelete() {
    // Deepest paths first so a folder's children are gone before the folder.
    const paths = [...selected].sort(
      (a, b) => b.split("/").length - a.split("/").length,
    );
    const store = useStore.getState();
    let order = store.itemOrder;
    setBulkProgress({ done: 0, total: paths.length });
    let done = 0;
    for (const p of paths) {
      try {
        await ipc.deletePath(p);
        order = removeFromOrder(order, p);
        if (openNote && (openNote.path === p || openNote.path.startsWith(p + "/"))) {
          store.closeNote();
        }
      } catch (e) {
        console.error("bulk delete failed", p, e);
      }
      setBulkProgress({ done: ++done, total: paths.length });
    }
    store.setItemOrder(order);
    await refreshAll();
    setBulkProgress(null);
    exitSelect();
  }

  async function bulkLock() {
    const store = useStore.getState();
    for (const p of selected) {
      const n = nodeByPath.get(p);
      if (!n) continue;
      const target = shareTargetForPath(p, n.isDir, n.name);
      if (!target) continue;
      // Skip anything already locked directly (avoids a duplicate share row).
      if (locks.some((l) => shareResourceId(l) === target.resourceId)) continue;
      try {
        await store.createLock(target.resourceType, target.resourceId, null);
      } catch (e) {
        console.error("bulk lock failed", p, e);
      }
    }
    exitSelect();
  }

  async function bulkUnlock() {
    const store = useStore.getState();
    for (const p of selected) {
      const n = nodeByPath.get(p);
      if (!n) continue;
      const target = shareTargetForPath(p, n.isDir, n.name);
      if (!target) continue;
      const lock = locks.find((l) => shareResourceId(l) === target.resourceId);
      if (!lock) continue;
      try {
        await store.removeLock(lock.id);
      } catch (e) {
        console.error("bulk unlock failed", p, e);
      }
    }
    exitSelect();
  }

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("click", close);
      if (importStatusTimer.current) clearTimeout(importStatusTimer.current);
    };
  }, []);

  async function refreshAll() {
    await useStore.getState().refreshTree();
    await useStore.getState().refreshTitles();
  }

  /**
   * After an import, register the new markdown notes on the server under their
   * LOCAL index doc_ids (via the same id the editor's bridge uses), so sync
   * doesn't fork a second identity for them. Without this an imported note lives
   * only on disk until the seed race, which the background feed could lose.
   * No-op when sync is off. Call after `refreshAll()` so the index has ids.
   */
  async function registerImported(summary: ipc.ImportSummary) {
    if (!useStore.getState().syncEnabled) return;
    const roots = summary.imported;
    const under = (p: string) => roots.some((r) => p === r || p.startsWith(`${r}/`));
    for (const t of useStore.getState().titles) {
      if (!t.path.toLowerCase().endsWith(".md") || !under(t.path)) continue;
      try {
        await syncManager.registry.registerNote(t.path, t.title, t.id);
      } catch (e) {
        console.warn("[import] registerNote failed", t.path, e);
      }
    }
  }

  /** Flash a short-lived status pill (auto-dismisses). */
  function flashStatus(text: string, tone: "success" | "error" | "neutral" = "success") {
    setImportStatus({ text, tone });
    if (importStatusTimer.current) clearTimeout(importStatusTimer.current);
    importStatusTimer.current = setTimeout(() => setImportStatus(null), 4500);
  }

  /** Announce an import outcome: green on success, neutral if nothing landed. */
  function announceImport(s: ipc.ImportSummary) {
    const files =
      s.files > 0 ? `Imported ${s.files} file${s.files === 1 ? "" : "s"}` : "Nothing imported";
    const text = s.skipped > 0 ? `${files} · ${s.skipped} skipped` : files;
    flashStatus(text, s.files > 0 ? "success" : "neutral");
  }

  // Import OS files/folders dropped onto the sidebar. Tauri intercepts the OS
  // drag-drop (the webview never sees an HTML5 drop) and hands us absolute
  // paths + a physical cursor position; we scope it to the tree and route the
  // drop into the folder under the pointer (or the vault root).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const insideTree = (px: number, py: number): { x: number; y: number } | null => {
      const scale = window.devicePixelRatio || 1;
      const x = px / scale;
      const y = py / scale;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
      return { x, y };
    };
    void (async () => {
      const un = await getCurrentWebview().onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDropActive(insideTree(p.position.x, p.position.y) !== null);
        } else if (p.type === "leave") {
          setDropActive(false);
        } else if (p.type === "drop") {
          setDropActive(false);
          if (!p.paths?.length) return;
          const pt = insideTree(p.position.x, p.position.y);
          // Dropped onto the open note (outside the tree, an editable editor is
          // live) → attach the files INTO that note's content rather than
          // importing them as sidebar entries.
          if (!pt && activeNoteEditable()) {
            try {
              const embeds: string[] = [];
              for (const path of p.paths) embeds.push(await embedDroppedFile(path));
              insertIntoActiveNote(embeds.join("\n"));
              await refreshAll();
            } catch (e) {
              console.error("attach (drop) failed", e);
              flashStatus("Couldn't attach file", "error");
            }
            return;
          }
          // Otherwise it's an import: into the folder under the pointer (a
          // sidebar drop) or the vault root (dropped on the main area with no
          // note open). Same import the menu uses — files or whole folders.
          const dest = pt ? dirAtClientPoint(pt.x, pt.y) : "";
          try {
            const summary = await ipc.importPaths(dest, p.paths);
            await refreshAll();
            await registerImported(summary);
            announceImport(summary);
            // A single image/PDF dropped on the empty main area → preview it.
            if (
              !pt &&
              summary.imported.length === 1 &&
              previewKind(summary.imported[0]) != null
            ) {
              await useStore.getState().openNoteByPath(summary.imported[0]);
            }
          } catch (e) {
            console.error("import (drop) failed", e);
            flashStatus("Import failed", "error");
          }
        }
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Pick files and import them into `dir` (vault-relative; "" = root). */
  async function importFilesInto(dir: string) {
    setMenu(null);
    try {
      const sources = await ipc.pickFiles();
      if (!sources || sources.length === 0) return;
      const summary = await ipc.importPaths(dir, sources);
      await refreshAll();
      await registerImported(summary);
      announceImport(summary);
    } catch (e) {
      console.error("import files failed", e);
      flashStatus("Import failed", "error");
    }
  }

  /** Pick a folder and import it into `dir`. */
  async function importFolderInto(dir: string) {
    setMenu(null);
    try {
      const src = await ipc.pickFolder();
      if (!src) return;
      const summary = await ipc.importPaths(dir, [src]);
      await refreshAll();
      await registerImported(summary);
      announceImport(summary);
    } catch (e) {
      console.error("import folder failed", e);
      flashStatus("Import failed", "error");
    }
  }

  /** Export a node: a folder → chosen destination dir; a note → Save dialog. */
  async function exportNode(node: NodeApi<TreeNode>) {
    setMenu(null);
    try {
      const dest = node.data.isDir
        ? await ipc.pickFolder()
        : await ipc.saveFile(basename(node.data.path));
      if (!dest) return;
      await ipc.exportPath(node.data.path, dest);
    } catch (e) {
      console.error("export failed", e);
    }
  }

  const onActivate = (node: NodeApi<TreeNode>) => {
    // In select mode a file click picks it (folders expand via the row / pick
    // via their checkbox) instead of opening the note.
    if (selectModeRef.current) {
      if (!node.data.isDir) toggleSelect(node.data.path);
      return;
    }
    if (!node.data.isDir) {
      // Notes/pages render in the editor; images/PDFs open in the file preview.
      // Any other binary is listed but not opened (nothing can render it).
      if (isOpenablePath(node.data.path) || previewKind(node.data.path) != null) {
        void useStore.getState().openNoteByPath(node.data.path);
      }
    }
  };

  const onRename = async ({ id, name, node }: { id: string; name: string; node: NodeApi<TreeNode> }) => {
    const oldPath = node.data.path;
    const dir = parentDir(oldPath);
    let newName = name.trim();
    if (!newName || newName === basename(oldPath)) return;
    // Re-attach the file's real extension. Notes/pages hide it in the rename
    // input; other file types show it, so only append when it's missing.
    if (!node.data.isDir) {
      const ext = basename(oldPath).match(/\.[^./\\]+$/)?.[0] ?? "";
      if (ext && !newName.toLowerCase().endsWith(ext.toLowerCase())) {
        newName = `${newName}${ext}`;
      }
    }
    const newPath = dir ? `${dir}/${newName}` : newName;
    if (newPath === oldPath) return;
    try {
      await ipc.renamePath(oldPath, newPath);
      // Propagate the rename/move to the server (folder subtree or single note;
      // doc_ids are preserved) so teammates see it live.
      try {
        await syncManager.registry.renamePath(oldPath, newPath);
      } catch (e) {
        console.warn("[sync] renamePath failed", oldPath, e);
      }
      // Keep the item's rank (and its subtree's arrangement) across the rename.
      const store = useStore.getState();
      store.setItemOrder(renameInOrder(store.itemOrder, oldPath, newPath));
      if (openNote && (openNote.path === oldPath || openNote.path.startsWith(oldPath + "/"))) {
        const updated = openNote.path.replace(oldPath, newPath);
        await useStore.getState().openNoteByPath(updated);
      }
      await refreshAll();
    } catch (e) {
      console.error("rename failed", e);
    }
    void id;
  };

  const onMove = async ({
    dragIds,
    parentNode,
    index,
  }: {
    dragIds: string[];
    parentNode: NodeApi<TreeNode> | null;
    index: number;
  }) => {
    const destDir = parentNode ? parentNode.data.path : "";
    // dragIds are node ids === current paths. Their paths after the drop only
    // change when the parent folder changes (a reorder keeps the same path).
    const from = dragIds;
    const to = from.map((p) => {
      const dest = destDir ? `${destDir}/${basename(p)}` : basename(p);
      return dest;
    });

    // 1) Persist the arrangement first so a same-folder reorder feels instant
    //    (no disk change, no round-trip). Cross-folder drops snap into place
    //    after the tree refresh below re-materializes the moved paths.
    const store = useStore.getState();
    const siblings = childrenAt(data, destDir).map((n) => n.path);
    let order = store.itemOrder;
    for (let i = 0; i < from.length; i++) {
      if (from[i] !== to[i]) order = moveSubtreeOrder(order, from[i], to[i]);
    }
    order = { ...order, [destDir]: computeReorder(siblings, from, to, index) };
    store.setItemOrder(order);

    // 2) Apply cross-folder moves on disk (a pure reorder has from === to).
    let movedOnDisk = false;
    for (let i = 0; i < from.length; i++) {
      if (from[i] === to[i]) continue;
      try {
        await ipc.renamePath(from[i], to[i]);
        try {
          await syncManager.registry.renamePath(from[i], to[i]);
        } catch (e) {
          console.warn("[sync] move propagate failed", from[i], e);
        }
        movedOnDisk = true;
        if (openNote && (openNote.path === from[i] || openNote.path.startsWith(from[i] + "/"))) {
          await useStore.getState().openNoteByPath(openNote.path.replace(from[i], to[i]));
        }
      } catch (e) {
        console.error("move failed", e);
      }
    }
    if (movedOnDisk) await refreshAll();
  };

  async function createUniqueNote(dir: string) {
    let name = "Untitled";
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? name : `${name} ${i}`;
      try {
        const path = await ipc.createNote(dir, candidate);
        await refreshAll();
        await useStore.getState().openNoteByPath(path);
        return;
      } catch {
        // name taken → try next
      }
    }
  }

  // Put a freshly created node straight into rename mode — same instant-rename
  // affordance a new note gets by opening in the editor. refreshAll() only
  // schedules the tree re-render, so poll a few frames until react-arborist has
  // the new row in its store, then reveal + select + edit it.
  function beginRename(path: string, tries = 0) {
    const tree = treeRef.current;
    if (tree?.get(path)) {
      tree.openParents(path);
      tree.select(path);
      void tree.scrollTo(path);
      void tree.edit(path);
      return;
    }
    if (tries < 30) requestAnimationFrame(() => beginRename(path, tries + 1));
  }

  async function createUniqueFolder(dir: string) {
    let name = "New Folder";
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? name : `${name} ${i}`;
      try {
        const path = await ipc.createFolder(dir, candidate);
        // Push the folder to the server immediately so teammates see it live and
        // it can be shared. A subsequent rename propagates via onRename.
        try {
          await syncManager.registry.registerFolder(path, candidate);
        } catch (e) {
          console.warn("[sync] registerFolder failed", path, e);
        }
        await refreshAll();
        beginRename(path);
        return;
      } catch {
        // taken → next
      }
    }
  }

  async function handleDelete(node: NodeApi<TreeNode>) {
    try {
      await ipc.deletePath(node.data.path);
      // Propagate the delete (folder subtree or note) to the server so it
      // disappears for teammates too.
      try {
        await syncManager.registry.deletePath(node.data.path);
      } catch (e) {
        console.warn("[sync] deletePath failed", node.data.path, e);
      }
      const store = useStore.getState();
      store.setItemOrder(removeFromOrder(store.itemOrder, node.data.path));
      if (openNote && (openNote.path === node.data.path || openNote.path.startsWith(node.data.path + "/"))) {
        useStore.getState().closeNote();
      }
      await refreshAll();
    } catch (e) {
      console.error("delete failed", e);
    }
  }

  const menuDir = menu?.node
    ? menu.node.data.isDir
      ? menu.node.data.path
      : parentDir(menu.node.data.path)
    : "";

  // The lock applied DIRECTLY to the menu's node (not inherited), so the menu
  // can offer Unlock with the right share id.
  const menuTarget = menu?.node ? shareTargetFor(menu.node) : null;
  const menuLock = menuTarget
    ? (locks.find((l) => shareResourceId(l) === menuTarget.resourceId) ?? null)
    : null;

  async function lockFromMenu(target: ShareTarget) {
    try {
      await useStore.getState().createLock(target.resourceType, target.resourceId, null);
    } catch (e) {
      console.error("lock failed", e);
    }
  }

  async function unlockFromMenu(shareId: string) {
    try {
      await useStore.getState().removeLock(shareId);
    } catch (e) {
      console.error("unlock failed", e);
    }
  }

  return (
    <div className={`filetree${dropActive ? " drop-active" : ""}`} ref={containerRef}>
      <div className="filetree-head">
        <span className="section-label">Notes</span>
        <div className="filetree-actions">
          <button
            className="tree-tool"
            title="New note"
            aria-label="New note"
            onClick={() => createUniqueNote("")}
          >
            {ICON_NEW_NOTE}
          </button>
          <button
            className="tree-tool"
            title="New folder"
            aria-label="New folder"
            onClick={() => createUniqueFolder("")}
          >
            {ICON_NEW_FOLDER}
          </button>
          <span className="tool-divider" aria-hidden="true" />
          {/* One fold toggle instead of a collapse/expand pair: each click runs
              the shown action and cross-fades to its opposite. */}
          <button
            className={`tree-tool tree-fold-toggle${treeCollapsed ? " collapsed" : ""}`}
            title={treeCollapsed ? "Expand all folders" : "Collapse all folders"}
            aria-label={treeCollapsed ? "Expand all folders" : "Collapse all folders"}
            onClick={() => {
              if (treeCollapsed) treeRef.current?.openAll();
              else treeRef.current?.closeAll();
              setTreeCollapsed(!treeCollapsed);
            }}
          >
            <span className="fold-icon fold-collapse" aria-hidden="true">
              {ICON_COLLAPSE_ALL}
            </span>
            <span className="fold-icon fold-expand" aria-hidden="true">
              {ICON_EXPAND_ALL}
            </span>
          </button>
          <span className="tool-divider" aria-hidden="true" />
          <button
            className={`tree-tool${selectMode ? " on" : ""}`}
            title={selectMode ? "Exit selection" : "Select items"}
            aria-label={selectMode ? "Exit selection" : "Select items"}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          >
            {ICON_SELECT}
          </button>
        </div>
      </div>
      {selectMode && bulkProgress ? (
        <div className="filetree-selectbar deleting">
          <span className="selbar-count">
            Deleting {bulkProgress.done} of {bulkProgress.total}…
          </span>
          <div
            className="selbar-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={bulkProgress.total}
            aria-valuenow={bulkProgress.done}
          >
            <span
              className="selbar-progress-fill"
              style={{
                width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      ) : selectMode ? (
        <div className="filetree-selectbar">
          <button
            className={`selbar-check${allSelected ? " on" : ""}`}
            title={allSelected ? "Clear selection" : "Select all"}
            aria-label={allSelected ? "Clear selection" : "Select all"}
            aria-checked={allSelected}
            role="checkbox"
            onClick={toggleSelectAll}
          >
            {allSelected && ICON_CHECK}
          </button>
          <span className="selbar-count">{selected.size} selected</span>
          {selected.size > 0 && (
            <div className="selbar-actions">
              {canManage && syncEnabled && (
                <>
                  <button
                    className="selbar-icon"
                    onClick={() => void bulkLock()}
                    title="Lock selected"
                    aria-label="Lock selected"
                  >
                    {ICON_LOCK}
                  </button>
                  <button
                    className="selbar-icon"
                    onClick={() => void bulkUnlock()}
                    title="Unlock selected"
                    aria-label="Unlock selected"
                  >
                    {ICON_UNLOCK}
                  </button>
                </>
              )}
              <button
                className={`selbar-icon danger${confirmDelete ? " armed" : ""}`}
                onClick={() =>
                  confirmDelete ? void bulkDelete() : setConfirmDelete(true)
                }
                title={confirmDelete ? `Delete ${selected.size}? Click to confirm` : "Delete selected"}
                aria-label={confirmDelete ? "Confirm delete" : "Delete selected"}
              >
                {ICON_TRASH}
              </button>
            </div>
          )}
        </div>
      ) : null}
      {data.length === 0 ? (
        <div className="filetree-empty">No notes yet</div>
      ) : (
        <Tree<TreeNode>
          ref={treeRef}
          className="filetree-scroll"
          data={data}
          idAccessor="id"
          openByDefault={false}
          width={dim.width}
          height={dim.height - 34 - (selectMode ? 36 : 0)}
          indent={14}
          rowHeight={32}
          onToggle={onToggle}
          onActivate={onActivate}
          onRename={onRename}
          onMove={onMove}
          renderCursor={DropCursor}
          rowClassName="tree-rowwrap"
        >
          {(props) => (
            <Node
              {...props}
              selectedPath={openNote?.path ?? null}
              lock={lockByPath.get(props.node.data.path) ?? null}
              presenceByDoc={presenceByDoc}
              color={itemColors[props.node.data.path]}
              onMenu={(x, y, node) => setMenu({ x, y, node })}
              selectMode={selectMode}
              checked={selected.has(props.node.data.path)}
              onToggleCheck={toggleSelect}
            />
          )}
        </Tree>
      )}

      {menu && (
        <ul className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <li onClick={() => createUniqueNote(menuDir)}>New note</li>
          <li onClick={() => createUniqueFolder(menuDir)}>New folder</li>
          <li className="menu-sep-item" onClick={() => void importFilesInto(menuDir)}>
            Import files…
          </li>
          <li onClick={() => void importFolderInto(menuDir)}>Import folder…</li>
          {menu.node && <li onClick={() => void exportNode(menu.node!)}>Export…</li>}
          {menu.node && <li onClick={() => menu.node!.edit()}>Rename</li>}
          {(itemOrder[menuDir]?.length ?? 0) > 0 && (
            <li
              title={
                menu.node?.data.isDir
                  ? "Sort this folder's contents alphabetically"
                  : "Sort this folder alphabetically"
              }
              onClick={() =>
                useStore.getState().setItemOrder(clearOrderAt(itemOrder, menuDir))
              }
            >
              Reset order (A–Z)
            </li>
          )}
          {menu.node && menuTarget && (
            <li onClick={() => setShareTarget(menuTarget)}>Share…</li>
          )}
          {menu.node && menuTarget && canManage && (
            menuLock ? (
              <li onClick={() => void unlockFromMenu(menuLock.id)}>Unlock</li>
            ) : (
              <li
                title="Read-only for everyone — changes won't sync"
                onClick={() => void lockFromMenu(menuTarget)}
              >
                Lock for everyone
              </li>
            )
          )}
          {menu.node && (
            <li className="menu-swatches" onClick={(e) => e.stopPropagation()}>
              <span
                className="swatch clear"
                title="Default color"
                onClick={() => {
                  useStore.getState().setItemColor(menu.node!.data.path, null);
                  setMenu(null);
                }}
              />
              {ITEM_COLORS.map((c) => (
                <span
                  key={c.id}
                  className={`swatch${itemColors[menu.node!.data.path] === c.id ? " on" : ""}`}
                  style={{ backgroundColor: c.value }}
                  title={c.label}
                  onClick={() => {
                    useStore.getState().setItemColor(menu.node!.data.path, c.id);
                    setMenu(null);
                  }}
                />
              ))}
            </li>
          )}
          {menu.node && (
            <li className="danger" onClick={() => handleDelete(menu.node!)}>
              Delete
            </li>
          )}
        </ul>
      )}

      {shareTarget && (
        <ShareDialog target={shareTarget} onClose={() => setShareTarget(null)} />
      )}

      {importStatus && (
        <div className={`filetree-status ${importStatus.tone}`} role="status">
          {importStatus.text}
        </div>
      )}
    </div>
  );
}

interface NodeExtra {
  selectedPath: string | null;
  lock: LockScope | null;
  /** docId -> teammates currently viewing that note (drives presence dots). */
  presenceByDoc: Map<string, VaultPeer[]>;
  /** Item color id (vault-local preference) — tints the type glyph. */
  color: string | undefined;
  onMenu: (x: number, y: number, node: NodeApi<TreeNode>) => void;
  /** Multi-select: when on, rows show a checkbox and hide per-row actions. */
  selectMode: boolean;
  checked: boolean;
  onToggleCheck: (path: string) => void;
}

function TreeSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICON_FOLDER = (
  <TreeSvg>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </TreeSvg>
);
const ICON_FOLDER_OPEN = (
  <TreeSvg>
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
  </TreeSvg>
);
const ICON_FILE = (
  <TreeSvg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M15 2v5h5" />
    <path d="M9 13h6M9 17h4" />
  </TreeSvg>
);
/* HTML pages render in-app; the code glyph tells them apart from notes. */
const ICON_HTML = (
  <TreeSvg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M15 2v5h5" />
    <path d="m10 12-2 2.5 2 2.5M14 12l2 2.5-2 2.5" />
  </TreeSvg>
);

/** Note titles hide the .md/.html extension — it's a notes list, not a file manager. */
function displayName(name: string, isDir: boolean): string {
  return isDir ? name : name.replace(/\.(md|html?)$/i, "");
}

function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

const ICON_LOCK = (
  <TreeSvg>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </TreeSvg>
);

/** Max faces in a sidebar row's presence cluster before the rest roll into +N. */
const MAX_ROW_AVATARS = 3;

/** Collect the docIds of every note under a folder (recursively), so a collapsed
 *  folder can roll up the presence of the notes hidden inside it. */
function descendantDocIds(node: TreeNode, out: string[]): void {
  for (const child of node.children ?? []) {
    if (child.isDir) {
      descendantDocIds(child, out);
    } else {
      const mapping = syncManager.registry.getMapping(child.path);
      if (mapping) out.push(mapping.docId);
    }
  }
}

/** Resolve the teammates to show on a row: the note's own viewers, or — for a
 *  collapsed folder — the union of everyone viewing a note inside it (deduped by
 *  user). An expanded folder shows nothing; its avatars live on the child rows. */
function peersForNode(
  node: NodeApi<TreeNode>,
  presenceByDoc: Map<string, VaultPeer[]>,
): VaultPeer[] {
  if (presenceByDoc.size === 0) return [];
  if (node.data.isDir) {
    if (node.isOpen) return [];
    const ids: string[] = [];
    descendantDocIds(node.data, ids);
    const seen = new Set<string>();
    const rolled: VaultPeer[] = [];
    for (const id of ids) {
      for (const peer of presenceByDoc.get(id) ?? []) {
        if (seen.has(peer.userId)) continue;
        seen.add(peer.userId);
        rolled.push(peer);
      }
    }
    return rolled;
  }
  const mapping = syncManager.registry.getMapping(node.data.path);
  return mapping ? (presenceByDoc.get(mapping.docId) ?? []) : [];
}

/** One presence face: the teammate's illustrated character ringed in their
 *  colour — the same treatment as the editor's PresenceAvatar, sized for a row. */
function SidebarAvatar({ peer }: { peer: VaultPeer }) {
  const svg = useMemo(
    () => characterSvg(peer.name || peer.userId || "?"),
    [peer.name, peer.userId],
  );
  const tone = statusTone(peer.status);
  const live = ringShowsColor(tone);
  return (
    <span
      className={`tree-presence-avatar tone-${tone}${live ? "" : " offline"}`}
      style={{ "--user-color": live ? peer.color : PRESENCE_OFFLINE } as CSSProperties}
      title={peer.name}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** The overlapping avatar cluster shown at the right edge of a row. */
function SidebarPresence({ peers }: { peers: VaultPeer[] }) {
  if (peers.length === 0) return null;
  const shown =
    peers.length > MAX_ROW_AVATARS ? peers.slice(0, MAX_ROW_AVATARS - 1) : peers;
  const overflow = peers.length - shown.length;
  const names = peers.map((p) => p.name).join(", ");
  return (
    <span className="tree-presence" title={names} aria-label={`Viewing: ${names}`}>
      {shown.map((p) => (
        <SidebarAvatar key={p.userId} peer={p} />
      ))}
      {overflow > 0 && (
        <span className="tree-presence-avatar tree-presence-overflow">+{overflow}</span>
      )}
    </span>
  );
}

function Node({
  node,
  style,
  dragHandle,
  selectedPath,
  lock,
  presenceByDoc,
  color,
  onMenu,
  selectMode,
  checked,
  onToggleCheck,
}: NodeRendererProps<TreeNode> & NodeExtra) {
  const isDir = node.data.isDir;
  const isEmpty = isDir && (node.data.children?.length ?? 0) === 0;
  const isSelected = !isDir && node.data.path === selectedPath;
  const colorValue = itemColorValue(color);
  const peers = peersForNode(node, presenceByDoc);
  // Compose arborist's per-level indent with the row's base inset so every
  // glyph on a level shares one left edge (no chevron column to misalign).
  // 20 = 12 base + 8 compensating the tree's full-bleed negative margin.
  const indent = typeof style.paddingLeft === "number" ? style.paddingLeft : 0;
  return (
    <div
      ref={dragHandle}
      style={{ ...style, paddingLeft: indent + 20 }}
      data-tree-dir={isDir ? node.data.path : parentDir(node.data.path)}
      className={`tree-row${isSelected ? " selected" : ""}${isDir ? " is-dir" : ""}${
        node.willReceiveDrop ? " drop-target" : ""
      }${node.isDragging ? " dragging" : ""}${checked ? " checked" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY, node);
      }}
      onMouseDown={(e) => {
        // The second press of a double-click otherwise makes WebKit start a
        // word/range selection (the stray blue bands between rows). Suppress it
        // only for the multi-click; the first press still drives click + drag.
        if (e.detail > 1) e.preventDefault();
      }}
      onClick={() => {
        if (isDir) node.toggle();
      }}
      onDoubleClick={(e) => {
        // Double-click a row to rename it in place (Finder-style). Stop the
        // event so a folder's toggle doesn't fight the rename that follows.
        // Disabled while selecting — a double-click there is just two picks.
        if (selectMode) return;
        e.stopPropagation();
        node.edit();
      }}
    >
      {selectMode && (
        <span
          className={`tree-check${checked ? " on" : ""}`}
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? "Deselect" : "Select"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(node.data.path);
          }}
        >
          {checked && ICON_CHECK}
        </span>
      )}
      <span
        className={`tree-glyph${isEmpty ? " is-empty" : ""}${colorValue ? " colored" : ""}`}
        style={colorValue ? { color: colorValue } : undefined}
        aria-hidden="true"
      >
        {isDir
          ? node.isOpen && !isEmpty
            ? ICON_FOLDER_OPEN
            : ICON_FOLDER
          : isHtmlPath(node.data.path)
            ? ICON_HTML
            : ICON_FILE}
      </span>
      {node.isEditing ? (
        <input
          className="tree-rename-input"
          autoFocus
          defaultValue={displayName(node.data.name, isDir)}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          // Clicking away commits the rename (Finder-style) rather than
          // discarding it. Guard on isEditing so the blur that fires when
          // Enter/Escape unmounts the input doesn't submit a second time
          // (or override an Escape-cancel).
          onBlur={(e) => {
            if (node.isEditing) node.submit(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") node.reset();
            if (e.key === "Enter") node.submit(e.currentTarget.value);
          }}
        />
      ) : (
        <>
          <span className="tree-label">{displayName(node.data.name, isDir)}</span>
          {isEmpty && !lock && <span className="tree-hint">empty</span>}
          {lock && (
            <span
              className={`tree-lock ${lock}`}
              title={LOCK_TITLES[lock]}
              aria-label={LOCK_TITLES[lock]}
            >
              {ICON_LOCK}
            </span>
          )}
          <SidebarPresence peers={peers} />
          {!selectMode && (
          <button
            className="tree-more"
            title="More actions"
            aria-label={`Actions for ${displayName(node.data.name, isDir)}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onMenu(r.left, r.bottom + 4, node);
            }}
          >
            <TreeSvg>
              <circle cx="5" cy="12" r="2.1" />
              <circle cx="12" cy="12" r="2.1" />
              <circle cx="19" cy="12" r="2.1" />
            </TreeSvg>
          </button>
          )}
        </>
      )}
    </div>
  );
}

/** Drag-and-drop insertion line, in the system accent instead of arborist blue. */
function DropCursor({ top, left }: CursorProps) {
  return <div className="drop-cursor" style={{ top: top - 1, left: left + 16 }} />;
}
