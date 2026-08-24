import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Tree,
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
  narrowPins,
  removeFromOrder,
  renameInOrder,
} from "../lib/ordering";
import { sortTree, TREE_SORTS } from "../lib/tree/sort";
import { LOCK_TITLES, lockScopesByPath, type LockScope } from "../lib/locks";
import { previewKind } from "../lib/preview";
import {
  buildTreeSyncIndex,
  rowSyncMark,
  type TreeSyncIndex,
} from "../lib/syncRollup";
import { embedDroppedFile } from "../lib/attachments";
import { toast } from "../lib/toast";
import { deletePaths } from "../lib/vault/mutatePaths";
import { AsyncButton } from "./AsyncButton";
import { Spinner } from "./Spinner";
import { activeNoteEditable, insertIntoActiveNote } from "../lib/editor/activeView";
import { useStore } from "../store";
import { shareResourceId } from "../lib/api";
import { syncManager } from "../lib/sync/docSession";
import type { VaultPeer } from "../lib/sync/vaultSyncEngine";
import { PRESENCE_OFFLINE, ringShowsColor, statusTone } from "../lib/presence/color";
import { characterSvg } from "./Identity";
import { ShareDialog, type ShareTarget } from "./ShareDialog";
import { placeMenu, type Placement } from "../lib/menuPlacement";

/** Tooltip on every root-create affordance while the vault's root is frozen. */
const ROOT_FROZEN_HINT =
  "This vault's root is frozen — new notes and folders go inside a folder.";

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

/**
 * Where a hand-drag would land if it were released right now: an insertion line
 * between two rows (`top`/`indent` place it), or inside a folder. `null` means
 * the pointer is over somewhere nothing may be dropped.
 */
type DropAt =
  | { kind: "line"; destDir: string; index: number; top: number; indent: number }
  | { kind: "into"; destDir: string }
  | null;

/** Do two drop targets mean the same thing? Guards a re-render per pointer move. */
function sameDrop(a: DropAt, b: DropAt): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "into" || b.kind === "into") return a.destDir === b.destDir;
  return a.destDir === b.destDir && a.index === b.index && a.top === b.top;
}

interface MenuState {
  x: number;
  y: number;
  /** Bottom edge to use if the menu has to open upward — see `placeMenu`. */
  flipY?: number;
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
/* Sort menu — descending bars, the conventional "sort" mark. */
const ICON_SORT = (
  <TreeSvg>
    <path d="M4 6h13M4 12h9M4 18h5" />
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
  const rootFrozen = useStore((s) => s.rootFrozen);
  const itemOrder = useStore((s) => s.itemOrder);
  const treeSort = useStore((s) => s.treeSort);
  const docSyncState = useStore((s) => s.docSyncState);
  const docIdByPath = useStore((s) => s.docIdByPath);
  const titles = useStore((s) => s.titles);
  const [containerRef, dim] = useDimensions();
  const treeRef = useRef<TreeApi<TreeNode> | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Resolved once the menu has been measured; null means "not placed yet", which
  // is also what keeps it invisible for that one frame.
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [menuPos, setMenuPos] = useState<Placement | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  // Which way the fold toggle points: false → "collapse all", true → "expand all".
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  // The sort popover under the toolbar's sort button.
  const [sortOpen, setSortOpen] = useState(false);
  // True while an OS drag hovers the tree, for the drop-target highlight.
  const [dropActive, setDropActive] = useState(false);
  // True while the user is dragging a ROW of this tree (react-arborist's own
  // HTML5 drag), which is a different thing entirely from an OS file drag —
  // see the listener below for why the two have to be told apart. Deliberately
  // a ref and a CSS class rather than React state: see `dragstart` below.
  const rowDrag = useRef(false);
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

  // Per-row sync indicators, rolled up for the WHOLE vault in one O(N) pass —
  // never per rendered row, which would be O(subtree) each and quadratic on a
  // large vault, re-run on every progress emission.
  //
  // `null` when sync is off, and that is deliberate: a local-only vault gets no
  // indicators at all. Badging every row "not synced" in a vault the user never
  // asked to sync is an alarm about nothing.
  //
  // Note the denominator comes from `titles` + `docIdByPath`, NOT from `tree`:
  // the tree is lazily loaded, so a folder nobody expanded would roll up nothing
  // and read as fully synced.
  const syncIndex = useMemo<TreeSyncIndex | null>(
    () =>
      syncEnabled
        ? buildTreeSyncIndex({
            docIdByPath,
            docSyncState,
            localNotePaths: titles.map((t) => t.path),
          })
        : null,
    [syncEnabled, docIdByPath, docSyncState, titles],
  );

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

  // Two layers, in this order and only this order: sort what nobody arranged,
  // then pin what somebody did. `applyOrder` leaves unranked items in the order
  // it received them, so a folder dragged into place keeps its spot while
  // everything untouched — including that folder's own contents — follows the
  // sort. Flipping these two would make every sort change wipe the arrangement.
  const data = useMemo<TreeNode[]>(
    () => applyOrder(sortTree(tree?.children ?? [], treeSort), "", itemOrder),
    [tree, itemOrder, treeSort],
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
  // first time it's expanded, fetch its real children on demand. Keyed off
  // `childrenLoaded` rather than an empty array, so a folder we've listed and
  // found genuinely empty isn't re-fetched on every expand.
  const onToggle = (id: string) => {
    const node = nodeByPath.get(id);
    if (node?.isDir && node.childrenLoaded !== true) {
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
    const paths = [...selected];
    const store = useStore.getState();
    setBulkProgress({ done: 0, total: paths.length });
    // Shared with the single-item delete below. It used to be a hand-copied loop
    // that removed the files but never told the server, so every deleted note
    // came back as an empty file on the next registry pull.
    const { deleted, failed } = await deletePaths(paths, {
      // Pinned to the vault this bulk delete was asked for: every lap after the
      // first runs past an await, and a delete that landed in the vault the user
      // switched to would destroy a same-named file they never selected.
      epoch: store.vault?.epoch,
      deleteDisk: (p, epoch) => ipc.deletePath(p, epoch),
      unregister: (p) => syncManager.registry.deletePath(p),
      onProgress: (done, total) => setBulkProgress({ done, total }),
    });
    // A refused delete (offline, or no permission on the server) leaves the item
    // in place everywhere — silence here is what used to read as "it came back".
    if (failed.length > 0) {
      toast(
        failed.length === 1
          ? `Couldn't delete "${failed[0].path}" — ${failed[0].reason}`
          : `Couldn't delete ${failed.length} items — ${failed[0].reason}`,
        "error",
      );
    }
    let order = store.itemOrder;
    for (const p of deleted) {
      order = removeFromOrder(order, p);
      if (openNote && (openNote.path === p || openNote.path.startsWith(p + "/"))) {
        store.closeNote();
      }
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
    const close = () => {
      setMenu(null);
      setSortOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  // Measure the menu, then decide where it actually goes. This has to be a
  // LAYOUT effect: it runs (and the re-render it schedules runs) before the
  // browser paints, so the menu is never visibly drawn at the unplaced position.
  // The `rise-in` animation only translates, so the measured box is the real one.
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setMenuPos(
      placeMenu(
        { x: menu.x, y: menu.y, flipY: menu.flipY },
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [menu]);

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

  /**
   * Announce an outcome. Was a pill local to this component; now the shared
   * toast, so an import result and (say) an export failure speak the same
   * language and stack in the same corner instead of the sidebar owning a
   * private notification surface nothing else could reach.
   */
  const flashStatus = toast;

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
  // An HTML5 drag started anywhere in the app (selecting text in the editor and
  // dragging it, say) is, at the OS level, a drag session over this same window
  // — so Tauri reports it as `enter`/`over` exactly like a file from Finder, and
  // the sidebar would throw up its "drop files here" frame for it. Only a drag
  // from OUTSIDE should light that, so in-app drags are flagged here and the
  // listener below skips them. A ref, because that listener is registered once
  // and closes over its scope. (The tree's own reordering no longer uses HTML5
  // drag at all — see the pointer-drag block further down.)
  useEffect(() => {
    const start = () => {
      rowDrag.current = true;
    };
    const end = () => {
      rowDrag.current = false;
    };
    window.addEventListener("dragstart", start, true);
    // `dragend` ends a drag that started; the rest are belt-and-braces for one
    // that never did. A stuck flag would swallow real file drops, so
    // over-clearing is strictly the safer error — every clear is idempotent.
    for (const ev of ["dragend", "drop", "mouseup", "pointerup", "blur"]) {
      window.addEventListener(ev, end, true);
    }
    return () => {
      window.removeEventListener("dragstart", start, true);
      for (const ev of ["dragend", "drop", "mouseup", "pointerup", "blur"]) {
        window.removeEventListener(ev, end, true);
      }
    };
  }, []);

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
        // Our own row drag, reported to us as if it came from the OS. Ignore it
        // outright — including the `drop`, whose `paths` are empty anyway, so
        // reacting could only ever mean flashing the frame or a stray import.
        if (rowDrag.current) return;
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
            const summary = await ipc.importPaths(
              dest,
              p.paths,
              useStore.getState().vault?.epoch,
            );
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
    if (rootBlocked(dir)) return;
    try {
      // Captured BEFORE the native picker — the longest await in the app, and
      // `dir` came from the tree that was on screen when it opened.
      const epoch = useStore.getState().vault?.epoch;
      const sources = await ipc.pickFiles();
      if (!sources || sources.length === 0) return;
      const summary = await ipc.importPaths(dir, sources, epoch);
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
    if (rootBlocked(dir)) return;
    try {
      const epoch = useStore.getState().vault?.epoch; // before the dialog
      const src = await ipc.pickFolder();
      if (!src) return;
      const summary = await ipc.importPaths(dir, [src], epoch);
      await refreshAll();
      await registerImported(summary);
      announceImport(summary);
    } catch (e) {
      console.error("import folder failed", e);
      flashStatus("Import failed", "error");
    }
  }

  /**
   * Show one note/folder in the OS file manager.
   *
   * Notes really are files on disk — that's the product — so being able to get
   * to one from the sidebar is the shortest bridge between the app and the rest
   * of the machine. The absolute path is the vault root joined with the
   * vault-relative path the tree already knows.
   */
  async function revealNode(node: NodeApi<TreeNode>) {
    setMenu(null);
    const root = useStore.getState().vault?.path;
    if (!root) return;
    try {
      await ipc.revealInFileManager(`${root}/${node.data.path}`);
    } catch (e) {
      console.error("reveal failed", e);
      toast("Couldn't open that in the file manager", "error");
    }
  }

  /** Export a node: a folder → chosen destination dir; a note → Save dialog. */
  async function exportNode(node: NodeApi<TreeNode>) {
    setMenu(null);
    try {
      const epoch = useStore.getState().vault?.epoch; // before the dialog
      const dest = node.data.isDir
        ? await ipc.pickFolder()
        : await ipc.saveFile(basename(node.data.path));
      if (!dest) return;
      // Pinned so a switch during the dialog can't export the OTHER vault's notes
      // to the destination the user chose for this one.
      await ipc.exportPath(node.data.path, dest, epoch);
      // Export writes outside the vault, so nothing in the app changes to show it
      // worked. Silence here read as "the menu item is broken"; a whole folder
      // export can also take a while, and this is the only sign it finished.
      flashStatus(`Exported ${basename(node.data.path)}`);
    } catch (e) {
      console.error("export failed", e);
      flashStatus("Export failed", "error");
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
      // Epoch-pinned like the bulk move below: this runs across awaits, so a vault
      // switch mid-rename must be refused by Rust rather than applied over there.
      await ipc.renamePath(oldPath, newPath, useStore.getState().vault?.epoch);
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

  const applyMove = async (dragIds: string[], destDir: string, index: number) => {
    // dragIds are node ids === current paths. Their paths after the drop only
    // change when the parent folder changes (a reorder keeps the same path).
    const from = dragIds;
    // Dragging something OUT to a frozen root is a root create by another name.
    // Reordering things already at the root is fine — the shape doesn't change.
    if (
      destDir === "" &&
      rootFrozen &&
      dragIds.some((p) => p.includes("/"))
    ) {
      toast("This vault's root is frozen — drop this inside a folder.", "error");
      return;
    }
    const to = from.map((p) => {
      const dest = destDir ? `${destDir}/${basename(p)}` : basename(p);
      return dest;
    });

    // 1) Persist the arrangement first so a same-folder reorder feels instant
    //    (no disk change, no round-trip). Cross-folder drops snap into place
    //    after the tree refresh below re-materializes the moved paths.
    const store = useStore.getState();
    const destChildren = childrenAt(data, destDir);
    const siblings = destChildren.map((n) => n.path);
    // Folder-ness of every path the new order can mention: the destination's own
    // children, plus the dragged items under their POST-drop paths (on a
    // cross-folder drop they aren't among the destination's children yet).
    const dirPaths = new Set<string>([
      ...destChildren.filter((n) => n.isDir).map((n) => n.path),
      ...from.flatMap((p, i) => (nodeByPath.get(p)?.isDir ? [to[i]] : [])),
    ]);
    const isDir = (p: string) => dirPaths.has(p);
    let order = store.itemOrder;
    for (let i = 0; i < from.length; i++) {
      if (from[i] !== to[i]) order = moveSubtreeOrder(order, from[i], to[i]);
    }
    order = {
      ...order,
      [destDir]: narrowPins(
        computeReorder(siblings, from, to, index),
        isDir,
        to,
        store.itemOrder[destDir],
      ),
    };
    store.setItemOrder(order);

    // 2) Apply cross-folder moves on disk (a pure reorder has from === to).
    // Epoch-pinned for the same reason as `bulkDelete` — this is a loop of writes
    // across awaits, so it must stay bound to the vault the drop happened in.
    const moveEpoch = store.vault?.epoch;
    let movedOnDisk = false;
    for (let i = 0; i < from.length; i++) {
      if (from[i] === to[i]) continue;
      try {
        await ipc.renamePath(from[i], to[i], moveEpoch);
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

  // ---- Reordering by hand (a pointer drag, deliberately not HTML5 DnD) ------
  //
  // react-arborist reorders via react-dnd's HTML5 backend, and inside a Tauri
  // webview that can never complete: wry's `performDragOperation` returns YES
  // and skips `super` whenever its drag-drop handler claims the event, and
  // tauri-runtime-wry's handler claims EVERY event unconditionally. So WKWebView
  // never dispatches `drop` to the page, `onMove` never fires, and a dragged row
  // just springs back. Turning the window's `dragDropEnabled` off would fix that
  // and break the thing it exists for — dropping files in from Finder, which
  // needs real filesystem paths the DataTransfer API will not give us.
  //
  // So the tree's own drag is done with pointer events, which nothing intercepts.
  // The drop still lands in `applyMove`, so the ordering rules (and their tests)
  // are shared with every other path.

  /** How far the pointer must travel before a press becomes a drag, in px. */
  const DRAG_THRESHOLD = 4;

  // The armed press: a row is under the finger but hasn't moved far enough yet.
  const probe = useRef<{ path: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ path: string } | null>(null);
  // The folder a drop would land INSIDE, when the pointer is over one. This is
  // the only per-move value that goes through React, and it changes about once
  // per folder rather than once per pixel.
  const [dropInto, setDropInto] = useState<string | null>(null);
  // The insertion line is moved by writing its transform directly. Routing it
  // through state instead would re-render every row in the tree on every
  // pointermove — which is what made the drag feel shaky rather than tracked.
  const lineRef = useRef<HTMLDivElement | null>(null);
  // These refs are the AUTHORITY during a drag; the state above is only its
  // render. Pointer events arrive faster than React re-renders, so a ref
  // assigned at render time would still read `null` on the move right after
  // the one that started the drag. Written by hand, beside each setState.
  const dropAtRef = useRef<DropAt>(null);
  const dragRef = useRef<string | null>(null);

  /** A path may not be dropped into itself or anywhere under itself. */
  const wouldSwallowItself = (moving: string, destDir: string) =>
    destDir === moving || destDir.startsWith(moving + "/");

  /**
   * Resolve a pointer position to a drop. Rows are hit-tested through the DOM
   * rather than by arithmetic on `rowHeight`, because the list is virtualized
   * and scrolled — the DOM already knows exactly which row is where.
   *
   * A row's top and bottom quarters mean "put it between these two"; a folder's
   * middle half means "put it inside". Files have no inside, so their middle
   * band reads as "after this file" — the whole row stays a usable target.
   *
   * The folder band is HYSTERETIC: easy to leave (0.28–0.72 to enter) but held
   * until 0.18–0.82 once you're in it. Without that, a hand resting on the
   * boundary flickers between "inside this folder" and "above it" several times
   * a second, which is the single thing that makes a drag feel unreliable.
   */
  function planDrop(moving: string, clientX: number, clientY: number): DropAt {
    const container = containerRef.current;
    if (!container) return null;
    const box = container.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right) return null;
    if (clientY < box.top) return null;

    // Rows are measured, not hit-tested. `elementFromPoint` looked obvious and
    // was the bug: a `.tree-row` is only as tall as its content, while the slot
    // arborist positions it in is `rowHeight` tall, so there is a dead band
    // between every pair of rows. Sweeping the pointer up the list crossed one
    // of those on the way to each new row, the hit test came back empty, and
    // the "nothing under the pointer" branch threw the line to the bottom of
    // the tree — the line appearing to leap to the end at random.
    //
    // Measuring instead means every pixel of the list belongs to exactly one
    // row, so the target changes once per row and never blinks elsewhere.
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".tree-row"));
    const rects = rows.map((el) => el.getBoundingClientRect());
    if (!rows.length) {
      return { kind: "line", destDir: "", index: 0, top: 0, indent: 0 };
    }

    let hit = -1;
    for (let i = 0; i < rects.length; i++) {
      if (clientY >= rects[i].top && clientY < rects[i].bottom) {
        hit = i;
        break;
      }
    }
    if (hit < 0) {
      // Genuinely past the last row: append to the vault root. That is the only
      // drop with no row of its own, and it still has to work.
      const last = rects[rects.length - 1];
      if (clientY >= last.bottom) {
        const roots = childrenAt(data, "");
        return {
          kind: "line",
          destDir: "",
          index: roots.length,
          top: last.bottom - box.top,
          indent: 0,
        };
      }
      // Otherwise the pointer is above the first row or in a dead band between
      // two: hand it to the nearest row by centre, so the gap belongs to the
      // row it looks like it belongs to.
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < rects.length; i++) {
        const d = Math.abs(clientY - (rects[i].top + rects[i].height / 2));
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      hit = best;
    }

    const row = rows[hit];
    const r = rects[hit];
    const path = row.dataset.treePath ?? "";
    const isDir = row.dataset.treeIsdir === "1";
    // Clamped: a pointer in a dead band sits slightly outside the row it was
    // assigned to, and an unclamped fraction there reads as a wild -0.3 / 1.4.
    const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    const parent = parentDir(path);
    const siblings = childrenAt(data, parent).map((n) => n.path);
    const at = siblings.indexOf(path);
    const lineIndent = r.left - box.left + 16;

    const held = dropAtRef.current;
    const holding = held?.kind === "into" && held.destDir === path;
    const lo = holding ? 0.18 : 0.28;
    if (isDir && frac > lo && frac < 1 - lo) {
      return wouldSwallowItself(moving, path) ? null : { kind: "into", destDir: path };
    }
    const after = frac >= 0.5;
    if (wouldSwallowItself(moving, parent)) return null;
    return {
      kind: "line",
      destDir: parent,
      index: at < 0 ? siblings.length : at + (after ? 1 : 0),
      top: (after ? r.bottom : r.top) - box.top,
      indent: lineIndent,
    };
  }

  /** Arm a press. It only becomes a drag once the pointer actually travels. */
  function beginProbe(path: string, x: number, y: number) {
    probe.current = { path, x, y };
  }

  // One window-level listener pair for the whole tree, live only while a press
  // is armed or a drag is running. Window scope because the pointer routinely
  // leaves the row — and often the sidebar — mid-drag.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = probe.current;
      if (!p) return;
      if (!dragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        if (!nodeByPath.has(p.path)) return;
        dragRef.current = p.path;
        setDrag({ path: p.path });
        containerRef.current?.classList.add("row-dragging");
      }
      const next = planDrop(p.path, e.clientX, e.clientY);
      if (sameDrop(next, dropAtRef.current)) return;
      const wasInto = dropAtRef.current?.kind === "into" ? dropAtRef.current.destDir : null;
      dropAtRef.current = next;
      // The line: moved by hand, so it glides between slots (CSS transitions the
      // transform) without React touching a single row.
      const line = lineRef.current;
      if (line) {
        if (next?.kind === "line") {
          line.style.transform = `translateY(${next.top - 1}px)`;
          line.style.left = `${next.indent}px`;
          line.style.opacity = "1";
        } else {
          line.style.opacity = "0";
        }
      }
      // The folder highlight is the one thing React still owns — it changes per
      // folder, not per pixel.
      const nowInto = next?.kind === "into" ? next.destDir : null;
      if (nowInto !== wasInto) setDropInto(nowInto);
    };
    /** Tear the drag down without committing it. */
    const clear = () => {
      probe.current = null;
      dragRef.current = null;
      dropAtRef.current = null;
      containerRef.current?.classList.remove("row-dragging");
      if (lineRef.current) lineRef.current.style.opacity = "0";
      setDrag(null);
      setDropInto(null);
    };
    const up = () => {
      const p = probe.current;
      const plan = dropAtRef.current;
      const dragging = dragRef.current;
      clear();
      // A press that never travelled is a click; the row's own onClick has it.
      if (!dragging) return;
      // A press that DID travel is not. If it happens to end over the row it
      // started on, the browser still fires a click there — which would toggle
      // the folder you just finished moving. Swallow exactly that one.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (!p || !plan) return;
      const index = plan.kind === "into" ? childrenAt(data, plan.destDir).length : plan.index;
      void applyMove([p.path], plan.destDir, index);
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) clear();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", cancel);
    };
    // `data`/`nodeByPath` are read through the closure and change as the tree
    // does; re-binding on each is cheaper than the staleness bugs otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, nodeByPath]);

  /**
   * Refuse a create/import at the vault root when the root is frozen.
   *
   * Client-side first, purely so the user gets a sentence instead of a failed
   * write — the server enforces the same latch and is the authority. Only the
   * root is affected; anything nested is untouched.
   */
  function rootBlocked(dir: string): boolean {
    if (dir !== "" || !rootFrozen) return false;
    toast(
      "This vault's root is frozen — create this inside a folder instead.",
      "error",
    );
    return true;
  }

  async function createUniqueNote(dir: string) {
    if (rootBlocked(dir)) return;
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
    if (rootBlocked(dir)) return;
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
    const store = useStore.getState();
    // Same helper as `bulkDelete`, including the epoch pin this call was missing:
    // an unpinned delete that lands after a vault switch destroys a same-named
    // file in a vault the user wasn't even looking at.
    const { deleted, failed } = await deletePaths([node.data.path], {
      epoch: store.vault?.epoch,
      deleteDisk: (p, epoch) => ipc.deletePath(p, epoch),
      unregister: (p) => syncManager.registry.deletePath(p),
    });
    if (failed.length > 0) {
      toast(`Couldn't delete "${failed[0].path}" — ${failed[0].reason}`, "error");
    }
    if (deleted.length === 0) return;
    store.setItemOrder(removeFromOrder(store.itemOrder, node.data.path));
    if (openNote && (openNote.path === node.data.path || openNote.path.startsWith(node.data.path + "/"))) {
      store.closeNote();
    }
    await refreshAll();
  }

  const menuDir = menu?.node
    ? menu.node.data.isDir
      ? menu.node.data.path
      : parentDir(menu.node.data.path)
    : "";
  // Create/import from this menu would land at a frozen root.
  const menuCreateBlocked = menuDir === "" && rootFrozen;

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
    // `row-dragging` is added/removed imperatively by the drag listener above,
    // never through React — see the comment there.
    <div className={`filetree${dropActive ? " drop-active" : ""}`} ref={containerRef}>
      <div className="filetree-head">
        <span className="section-label">Notes</span>
        <div className="filetree-actions">
          <button
            className="tree-tool"
            title={rootFrozen ? ROOT_FROZEN_HINT : "New note"}
            aria-label="New note"
            disabled={rootFrozen}
            onClick={() => createUniqueNote("")}
          >
            {ICON_NEW_NOTE}
          </button>
          <button
            className="tree-tool"
            title={rootFrozen ? ROOT_FROZEN_HINT : "New folder"}
            aria-label="New folder"
            disabled={rootFrozen}
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
          {/* Sort lives beside the fold toggle: both answer "how is this list
              laid out", neither creates anything. The popover is anchored to
              this button rather than reusing the row context menu, because the
              choice is vault-wide and belongs to the header, not to a row. */}
          <div className="tree-sort-wrap" onClick={(e) => e.stopPropagation()}>
            <button
              className={`tree-tool${sortOpen ? " on" : ""}`}
              title={`Sort: ${TREE_SORTS.find((s) => s.id === treeSort)?.label}`}
              aria-label="Sort notes"
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              // The wrapper swallows this click so the window-level dismiss
              // can't close the popover we're opening — which also means a row
              // menu left open would survive it, so close that here.
              onClick={() => {
                setMenu(null);
                setSortOpen((v) => !v);
              }}
            >
              {ICON_SORT}
            </button>
            {sortOpen && (
              <ul className="context-menu tree-sort-menu" role="menu">
                <li className="menu-heading">Sort notes by</li>
                {TREE_SORTS.map((s) => (
                  <li
                    key={s.id}
                    role="menuitemradio"
                    aria-checked={treeSort === s.id}
                    className={treeSort === s.id ? "is-on" : undefined}
                    title={s.hint}
                    onClick={() => {
                      useStore.getState().setTreeSort(s.id);
                      setSortOpen(false);
                    }}
                  >
                    <span className="menu-tick" aria-hidden="true">
                      {treeSort === s.id ? "✓" : ""}
                    </span>
                    {s.label}
                  </li>
                ))}
                {/* Says out loud what the two layers do, because the rule is
                    invisible otherwise: someone who has dragged rows around
                    needs to know this button won't undo that. */}
                <li className="menu-note">
                  Folders and notes you've dragged into place keep their
                  position.
                </li>
              </ul>
            )}
          </div>
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
                  {/* One server round trip per selected item, so a lock over a
                      large selection is a real wait. `replaceLabel` swaps the
                      padlock for the spinner — an icon button has no room for
                      both, and a 28px control that grows would push its
                      neighbours under the cursor mid-click. */}
                  <AsyncButton
                    className="selbar-icon"
                    onClick={bulkLock}
                    replaceLabel
                    title="Lock selected"
                    aria-label="Lock selected"
                  >
                    {ICON_LOCK}
                  </AsyncButton>
                  <AsyncButton
                    className="selbar-icon"
                    onClick={bulkUnlock}
                    replaceLabel
                    title="Unlock selected"
                    aria-label="Unlock selected"
                  >
                    {ICON_UNLOCK}
                  </AsyncButton>
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
          // Arborist's own drag is HTML5-based and cannot complete inside this
          // webview (see the pointer-drag block above), so it is switched off
          // entirely rather than left to start drags that die silently — which
          // is also what stopped a refused drag smearing a text selection
          // across the rows, and what stopped Tauri mistaking a row drag for a
          // file drop and throwing up the "drop files here" frame.
          disableDrag
          disableDrop
          rowClassName="tree-rowwrap"
        >
          {(props) => (
            <Node
              {...props}
              dropInto={dropInto}
              dragging={drag?.path === props.node.data.path}
              onDragProbe={beginProbe}
              selectedPath={openNote?.path ?? null}
              lock={lockByPath.get(props.node.data.path) ?? null}
              syncIndex={syncIndex}
              presenceByDoc={presenceByDoc}
              color={itemColors[props.node.data.path]}
              onMenu={(x, y, node, flipY) => setMenu({ x, y, flipY, node })}
              selectMode={selectMode}
              checked={selected.has(props.node.data.path)}
              onToggleCheck={toggleSelect}
            />
          )}
        </Tree>
      )}

      {/* The insertion line. Mounted for the whole drag and moved by transform
          (see the pointermove handler) so it glides between slots instead of
          being torn down and rebuilt at each one. Positioned against
          `.filetree`, which is the frame of reference `planDrop` measures in. */}
      {drag && <div className="drop-cursor" ref={lineRef} aria-hidden="true" />}

      {menu && (
        <ul
          className="context-menu"
          ref={menuRef}
          style={
            menuPos
              ? { left: menuPos.left, top: menuPos.top, maxHeight: menuPos.maxHeight }
              : // Rendered off the anchor for the measuring pass only, and hidden
                // so that pass can't flash on screen at the wrong place.
                { left: menu.x, top: menu.y, visibility: "hidden" }
          }
        >
          {/* Creating at a frozen root is refused; the items stay clickable so
              the refusal toast can say why, but they read as unavailable. */}
          <li
            className={menuCreateBlocked ? "disabled" : undefined}
            title={menuCreateBlocked ? ROOT_FROZEN_HINT : undefined}
            onClick={() => createUniqueNote(menuDir)}
          >
            New note
          </li>
          <li
            className={menuCreateBlocked ? "disabled" : undefined}
            title={menuCreateBlocked ? ROOT_FROZEN_HINT : undefined}
            onClick={() => createUniqueFolder(menuDir)}
          >
            New folder
          </li>
          <li
            className={menuCreateBlocked ? "menu-sep-item disabled" : "menu-sep-item"}
            title={menuCreateBlocked ? ROOT_FROZEN_HINT : undefined}
            onClick={() => void importFilesInto(menuDir)}
          >
            Import files…
          </li>
          <li
            className={menuCreateBlocked ? "disabled" : undefined}
            title={menuCreateBlocked ? ROOT_FROZEN_HINT : undefined}
            onClick={() => void importFolderInto(menuDir)}
          >
            Import folder…
          </li>
          {menu.node && <li onClick={() => void exportNode(menu.node!)}>Export…</li>}
          {menu.node && (
            <li onClick={() => void revealNode(menu.node!)}>{ipc.revealLabel()}</li>
          )}
          {menu.node && <li onClick={() => menu.node!.edit()}>Rename</li>}
          {/* The same vault-wide sort as the header button. A per-folder sort
              would be a third arrangement layer fighting the other two, so
              there is one setting and it is reachable from both places. */}
          <li className="menu-heading menu-sep-item">Sort notes by</li>
          {TREE_SORTS.map((s) => (
            <li
              key={s.id}
              role="menuitemradio"
              aria-checked={treeSort === s.id}
              className={treeSort === s.id ? "is-on" : undefined}
              title={s.hint}
              onClick={() => useStore.getState().setTreeSort(s.id)}
            >
              <span className="menu-tick" aria-hidden="true">
                {treeSort === s.id ? "✓" : ""}
              </span>
              {s.label}
            </li>
          ))}
          {/* Only offered where there IS an arrangement to drop — this clears
              the hand-made order for one folder so its contents fall back to
              the sort above, and leaves every other folder's alone. */}
          {(itemOrder[menuDir]?.length ?? 0) > 0 && (
            <li
              className="menu-sep-item"
              title={
                menu.node?.data.isDir
                  ? "Forget the drag-and-drop arrangement inside this folder"
                  : "Forget the drag-and-drop arrangement in this folder"
              }
              onClick={() =>
                useStore.getState().setItemOrder(clearOrderAt(itemOrder, menuDir))
              }
            >
              Reset manual order
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
    </div>
  );
}

interface NodeExtra {
  selectedPath: string | null;
  lock: LockScope | null;
  /** Whole-vault sync roll-up; null when sync is off (no indicators at all). */
  syncIndex: TreeSyncIndex | null;
  /** docId -> teammates currently viewing that note (drives presence dots). */
  presenceByDoc: Map<string, VaultPeer[]>;
  /** Item color id (vault-local preference) — tints the type glyph. */
  color: string | undefined;
  onMenu: (x: number, y: number, node: NodeApi<TreeNode>, flipY?: number) => void;
  /** Multi-select: when on, rows show a checkbox and hide per-row actions. */
  selectMode: boolean;
  checked: boolean;
  onToggleCheck: (path: string) => void;
  /** Arms a hand-drag on this row; it only starts once the pointer travels. */
  onDragProbe: (path: string, x: number, y: number) => void;
  /** This row is the one being dragged (it lifts and dims). */
  dragging: boolean;
  /** The folder a drop would land inside, if the pointer is over one. */
  dropInto: string | null;
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

/**
 * The row's sync tell: one quiet dot, or — for a folder that hasn't settled — the
 * count of notes inside it still waiting to reach the server.
 *
 * Sized and positioned like `.tree-lock` (its neighbour) and built from the same
 * `.sync-dot` element and semantic tone tokens the vault-level `.sync-badge`
 * uses, so "synced" looks the same everywhere in the app. One span, no layout
 * shift while settled, nothing at all when there is nothing to say.
 */
function TreeSyncMark({
  node,
  index,
}: {
  node: NodeApi<TreeNode>;
  index: TreeSyncIndex;
}) {
  const mark = rowSyncMark(node.data, index);
  if (!mark) return null;
  return (
    <span className={`tree-sync ${mark.state}`} title={mark.title} aria-label={mark.title}>
      {mark.progress != null ? (
        <span className="tree-sync-pct">
          {mark.progress.synced}/{mark.progress.total}
        </span>
      ) : (
        <span className="sync-dot" aria-hidden="true" />
      )}
    </span>
  );
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
  selectedPath,
  lock,
  syncIndex,
  presenceByDoc,
  color,
  onMenu,
  selectMode,
  checked,
  onToggleCheck,
  onDragProbe,
  dragging,
  dropInto,
}: NodeRendererProps<TreeNode> & NodeExtra) {
  const isDir = node.data.isDir;
  // Only a folder we have actually listed can be called empty. An unexpanded one
  // also carries `children: []`, and claiming "empty" for it is a flat lie about
  // a folder that may hold hundreds of notes.
  const isEmpty =
    isDir && node.data.childrenLoaded === true && (node.data.children?.length ?? 0) === 0;
  const isSelected = !isDir && node.data.path === selectedPath;
  // Subscribed as a boolean rather than by pulling the path and comparing, so a
  // note opening elsewhere in the tree doesn't re-render every other row — this
  // component is instantiated once per visible row.
  const isOpening = useStore((s) => s.openingNotePath === node.data.path);
  const colorValue = itemColorValue(color);
  const peers = peersForNode(node, presenceByDoc);
  // Compose arborist's per-level indent with the row's base inset so every
  // glyph on a level shares one left edge (no chevron column to misalign).
  // 20 = 12 base + 8 compensating the tree's full-bleed negative margin.
  const indent = typeof style.paddingLeft === "number" ? style.paddingLeft : 0;
  return (
    <div
      style={{ ...style, paddingLeft: indent + 20 }}
      data-tree-dir={isDir ? node.data.path : parentDir(node.data.path)}
      // Read back by `planDrop`, which hit-tests rows through the DOM: the
      // list is virtualized and scrolled, so the DOM is the only thing that
      // knows where a row actually is.
      data-tree-path={node.data.path}
      data-tree-isdir={isDir ? "1" : "0"}
      className={`tree-row${isSelected ? " selected" : ""}${isDir ? " is-dir" : ""}${
        dropInto === node.data.path ? " drop-target" : ""
      }${dragging ? " dragging" : ""}${checked ? " checked" : ""}${
        // Pre-selects the row the instant it's clicked, so the selection doesn't
        // wait on `getNoteMeta` + `registerNote` to come back from the server.
        isOpening ? " opening" : ""
      }`}
      aria-busy={isOpening || undefined}
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
      onPointerDown={(e) => {
        // Left button only, and never from the row's own controls (⋯, the
        // select checkbox) — those are buttons, not handles. Selection mode
        // is for picking rows, not moving them.
        if (e.button !== 0 || selectMode) return;
        if ((e.target as HTMLElement).closest("button, input, .tree-check")) return;
        onDragProbe(node.data.path, e.clientX, e.clientY);
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
        {/* The glyph slot is the row's own status light: while a note is being
            opened it becomes the spinner. Reusing the slot rather than adding one
            keeps the label from shifting sideways as the state changes. */}
        {isOpening ? (
          <Spinner size="xs" tone="accent" />
        ) : isDir ? (
          node.isOpen && !isEmpty ? (
            ICON_FOLDER_OPEN
          ) : (
            ICON_FOLDER
          )
        ) : isHtmlPath(node.data.path) ? (
          ICON_HTML
        ) : (
          ICON_FILE
        )}
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
          {syncIndex && <TreeSyncMark node={node} index={syncIndex} />}
          <SidebarPresence peers={peers} />
          {!selectMode && (
          <button
            className="tree-more"
            title="More actions"
            aria-label={`Actions for ${displayName(node.data.name, isDir)}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              // Below the ⋯ button normally; above it when there's no room, so a
              // flipped menu never lands on top of the button that opened it.
              onMenu(r.left, r.bottom + 4, node, r.top - 4);
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

