// SPDX-License-Identifier: Apache-2.0
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BulkAccessResource, MemberOverview, TeamAccessMode } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  BOARD_COLUMNS,
  orderByRecent,
  notAppliedMessage,
  columnRows,
  firstName,
  moveMessage,
  neighbourMode,
  ownModes,
  topLevelRows,
  accessWriteFailureMessage,
  revertModes,
  BULK_WRITE_TIMEOUT_MS,
  expandableKeys,
  visibleBoardRows,
  type BoardRow,
  type SummaryMode,
} from "../lib/accessBoard";
import { createAccessSummaryBatcher } from "../lib/accessSummaryBatch";
import { ACCESS_MAP_REREAD_MAX } from "../lib/accessBoardLoad";
import { useAccessMap, type AccessMap } from "./useAccessMap";
import { accessResourceType, ancestorPaths, entriesFromServer, rowsFromEntries, type AccessRow } from "../lib/accessTree";
import { needsAccessConfirm, reduceAccessCopy, type ReduceScope } from "../lib/membersAccess";
import { markSelfAccessChange } from "../lib/sync/selfAccessChanges";
import { ConfirmDialog } from "./ConfirmDialog";
import { iconForPath } from "./FileTree";
import { MenuSelect } from "./MenuSelect";
import { BoardPendingRows, BoardSkeleton } from "./MemberProfileSkeletons";
import { toast } from "../lib/toast";
import { buildOrgRowsByPath } from "../lib/accessMode";
import { itemLockRows, resourceIdsByPath } from "../lib/locks";
import { useStore } from "../store";

const LOCKED_TITLE = "Locked for everyone — unlock it from the sidebar to allow editing";

/** One batcher for the board: a render's reads go out as one request. */
const summaries = createAccessSummaryBatcher({
  many: (orgId, groups, userIds) => authManager.api.resolveAccessSummaries(orgId, groups, userIds),
  one: async (orgId, resources, userIds) => (await authManager.api.resolveAccessSummary(orgId, resources, userIds)).mode,
});

/** A row with no summary this long after queueing counts as failed. */
const BOARD_SUMMARY_TIMEOUT_MS = 5000;
/** Pixels a press must travel before it becomes a drag (FileTree uses the same). */
const DRAG_THRESHOLD = 4;
/** How long the landing (slide-in, ring pulse, tint fade) and leaving animations run, plus slack. */
const LAND_MS = 1500;
/** First-visit drag hint: once per device, after the rows have loaded. */
export const DRAG_HINT_KEY = "context.accessBoard.dragHintShown";
export const DRAG_HINT_DELAY_MS = 1200;
const DRAG_HINT_MS = 1800;

const resourceOf = (row: { kind: AccessRow["kind"]; id: string }): BulkAccessResource => ({
  resourceType: accessResourceType(row.kind),
  resourceId: row.id,
});

type EverythingChoice = TeamAccessMode | "reset";

interface Confirm {
  title: string;
  button: string;
  outcome: string;
  danger: boolean;
  apply: () => Promise<void>;
}

export interface MemberAccessBoardProps {
  orgId: string;
  /** The note collection whose folders and notes are listed. */
  vaultId: string;
  member: MemberOverview;
  /** The member is the signed-in user. */
  isSelf: boolean;
  /** False: the columns still show, but nothing can be moved. */
  canSetAccess: boolean;
  /** Everyone's vault-wide level; null when the vault was never shared or is unknown. */
  everyoneMode: TeamAccessMode | null;
  /** This person's own vault-wide level ("custom" when it varies; null unknown). */
  personVaultMode: TeamAccessMode | "custom" | null;
  /** One folder or note was written. */
  onItemWritten: () => void;
  /** A vault-wide change (Set everything to, Add all, Reset). */
  onChanged: () => Promise<void>;
  /** The host already shows a vault-wide control: skip "Set everything to". */
  hideSetEverything?: boolean;
  /** The Access tab's shared load (tree + modes). Absent: the board loads its own. */
  accessMap?: AccessMap;
}

/**
 * One person's access as a board: three columns, each listing the folders and
 * notes at that level, with the ancestors that lead to them greyed out. A row
 * moves by drag and drop or by its arrows; every move is ONE bulk write for
 * that resource scoped to this person, broad changes ask first, and a toast
 * says what changed.
 */
export function MemberAccessBoard({
  orgId,
  vaultId,
  member,
  isSelf,
  canSetAccess,
  everyoneMode,
  personVaultMode,
  onItemWritten,
  onChanged,
  hideSetEverything = false,
  accessMap,
}: MemberAccessBoardProps) {
  // The Access tab shares one load with the List; standalone, load our own.
  const ownMap = useAccessMap(vaultId, member.userId, !accessMap);
  const map = accessMap ?? ownMap;
  const serverTree = map.tree;
  const [summaryModes, setSummaryModes] = useState<ReadonlyMap<string, SummaryMode>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  // Seed from the shared load during render, so the first frame with a tree
  // already carries every mode (no climbing counts, no summary reads).
  const [seededSeq, setSeededSeq] = useState(0);
  if (map.seq !== seededSeq) {
    setSeededSeq(map.seq);
    if (map.modes) {
      setSummaryModes(new Map(map.modes));
      setFailed(new Set());
    }
  }
  const inflight = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TeamAccessMode | null>(null);
  /** Armed press: becomes a drag once it travels DRAG_THRESHOLD. */
  const probe = useRef<{
    key: string; x: number; y: number; dx: number; dy: number; width: number;
    pointerId: number; source: HTMLElement;
  } | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  /** Each column's horizontal band, measured once when a drag starts. */
  const bands = useRef<Array<{ mode: TeamAccessMode; left: number; right: number }>>([]);
  const boardTop = useRef(0);
  const dragging = useRef<string | null>(null);
  const overRef = useRef<TeamAccessMode | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  /** The row that just moved (plays the land animation) and the gap it left. */
  const [landing, setLanding] = useState<{ key: string; token: number } | null>(null);
  /** Rows moved during this board session, newest first: they float to the
   *  top of their level in the tree. Never persisted. */
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [leaving, setLeaving] = useState<{ mode: TeamAccessMode; index: number; token: number } | null>(null);
  const motionSeq = useRef(0);
  /** Folders opened on the board, by row key. Everything starts collapsed:
   *  a large vault would otherwise draw every row of every folder. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setExpanded(new Set()); }, [member.userId, vaultId]);
  const toggleExpanded = useCallback((key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);

  useEffect(() => { if (map.error) setError(map.error); }, [map.error]);

  const entries = useMemo(() => (serverTree ? entriesFromServer(serverTree) : []), [serverTree]);
  // Every folder open: the board shows the whole tree.
  const allRows = useMemo(
    () => rowsFromEntries(entries, new Set(entries.filter((e) => e.kind === "folder").map((e) => e.path))),
    [entries],
  );
  const rowByKey = useMemo(() => new Map(allRows.map((r) => [r.key, r])), [allRows]);
  // Team-wide locks ("Lock for everyone"): an org `locked`/`readonly` row on the
  // item or an ancestor caps EVERYONE at view, so Can edit can never apply.
  // Same data and rule as the List view's "View (locked)".
  const storeLocks = useStore((s) => s.locks);
  const storeTree = useStore((s) => s.tree);
  const teamLocked = useMemo(() => {
    const orgRows = buildOrgRowsByPath(entries, resourceIdsByPath(storeTree), null, itemLockRows(storeLocks ?? []), []);
    const capped = (p: string) => {
      const set = orgRows.get(p);
      return !!set && (set.has("locked") || set.has("readonly"));
    };
    if (orgRows.size === 0) return new Set<string>();
    return new Set(allRows.filter((r) => capped(r.path) || ancestorPaths(r.path).some(capped)).map((r) => r.key));
  }, [entries, allRows, storeLocks, storeTree]);
  // A mixed folder with no answered children sits at the person's own
  // vault-wide level, else Everyone's.
  const fallback: TeamAccessMode = personVaultMode && personVaultMode !== "custom" ? personVaultMode : everyoneMode ?? "private";
  const own = useMemo(() => ownModes(allRows, summaryModes, fallback), [allRows, summaryModes, fallback]);
  const columns = useMemo(
    () => BOARD_COLUMNS.map((c) => {
      const rows = columnRows(allRows, own, c.mode);
      let count = 0;
      for (const r of rows) if (!r.grey) count++;
      return { ...c, rows, count, display: orderByRecent(rows, recent) };
    }),
    [allRows, own, recent],
  );
  // What each column draws: one linear pass per column, redone on a toggle.
  const views = useMemo(() => columns.map((c) => visibleBoardRows(c.display, expanded)), [columns, expanded]);

  /**
   * Answers are buffered and applied in ONE state update per microtask: a
   * batch of 200 rows resolves together, and applying each answer on its own
   * copied the whole map (and rebuilt the whole board model) once per row —
   * quadratic on a vault of thousands of rows.
   */
  const answers = useRef<{ modes: Map<string, SummaryMode>; failed: Set<string>; scheduled: boolean }>({
    modes: new Map(), failed: new Set(), scheduled: false,
  });
  const flushAnswers = () => {
    const buf = answers.current;
    buf.scheduled = false;
    if (!live.current) return;
    const modes = buf.modes;
    const failedKeys = buf.failed;
    buf.modes = new Map();
    buf.failed = new Set();
    if (modes.size > 0) {
      setSummaryModes((prev) => {
        const next = new Map(prev);
        for (const [k, m] of modes) next.set(k, m);
        return next;
      });
    }
    setFailed((prev) => {
      let next: Set<string> | null = null;
      for (const k of failedKeys) {
        if (modes.has(k) || prev.has(k)) continue;
        (next ??= new Set(prev)).add(k);
      }
      for (const k of modes.keys()) {
        if (!(next ?? prev).has(k)) continue;
        (next ??= new Set(prev)).delete(k);
      }
      return next ?? prev;
    });
  };
  const queueAnswer = (key: string, mode: SummaryMode | null) => {
    const buf = answers.current;
    if (mode === null) buf.failed.add(key);
    else { buf.modes.set(key, mode); buf.failed.delete(key); }
    if (buf.scheduled) return;
    buf.scheduled = true;
    queueMicrotask(flushAnswers);
  };

  const readModes = (targets: readonly AccessRow[]) => {
    for (const row of targets) {
      if (inflight.current.has(row.key)) continue;
      inflight.current.add(row.key);
      const markFailed = () => {
        if (!live.current) return;
        queueAnswer(row.key, null);
      };
      const timer = window.setTimeout(markFailed, BOARD_SUMMARY_TIMEOUT_MS);
      summaries
        .read(orgId, resourceOf(row), [member.userId], () => !live.current)
        .then((m) => {
          if (!live.current) return;
          queueAnswer(row.key, m);
        })
        .catch(markFailed)
        .finally(() => {
          window.clearTimeout(timer);
          inflight.current.delete(row.key);
        });
    }
  };

  useEffect(() => {
    readModes(allRows.filter((row) => !summaryModes.has(row.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows]);

  // Back online: re-read every row that failed or never answered, so the
  // board shows the server's truth rather than what it guessed while offline.
  useEffect(() => {
    const retry = () => {
      const stale = allRows.filter((row) => failed.has(row.key) || !summaryModes.has(row.key));
      if (stale.length === 0) return;
      if (map.complete && stale.length > ACCESS_MAP_REREAD_MAX) void map.reload();
      else readModes(stale);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, failed, summaryModes, map.complete, map.reload]);

  /** Up to 200 rows: re-read them. More: one reload of the whole map (when the server has it). */
  const rereadOrReload = (targets: readonly AccessRow[]) => {
    if (map.complete && targets.length > ACCESS_MAP_REREAD_MAX) void map.reload();
    else readModes(targets);
  };

  const who = firstName(member);
  const fullName = member.name || member.email || member.userId;

  /**
   * One bulk write for this person. `rows` empty = the vault resource.
   * Optimistic: the written rows and their subtrees read `mode` at once, then
   * those plus their ancestors are re-read. Reverts on failure.
   */
  const write = async (rows: readonly AccessRow[], mode: TeamAccessMode, except?: string): Promise<boolean> => {
    const vaultWide = rows.length === 0;
    const resources = vaultWide ? [{ resourceType: "vault" as const, resourceId: orgId }] : rows.map(resourceOf);
    // A row is affected when it, or one of its ancestors, was written: one
    // set lookup per path level instead of scanning every written row.
    const written = new Set(rows.map((w) => w.path));
    const affected = vaultWide
      ? allRows
      : allRows.filter((r) => written.has(r.path) || ancestorPaths(r.path).some((a) => written.has(a)));
    const affectedKeys = new Set(affected.map((r) => r.key));
    const ancestors = new Set(rows.flatMap((r) => ancestorPaths(r.path)));
    const before = summaryModes;
    setBusy(true);
    setError(null);
    setSummaryModes((prev) => {
      const next = new Map(prev);
      for (const r of affected) next.set(r.key, mode);
      return next;
    });
    try {
      if (isSelf) markSelfAccessChange(resources.map((r) => r.resourceId));
      await authManager.api.setBulkAccess(orgId, {
        resources,
        audience: { type: "users", userIds: [member.userId] },
        mode,
      }, { timeoutMs: BULK_WRITE_TIMEOUT_MS });
      if (!live.current) return true;
      rereadOrReload(allRows.filter((r) => r.key !== except && (affectedKeys.has(r.key) || ancestors.has(r.path))));
      if (vaultWide) await onChanged();
      else onItemWritten();
      return true;
    } catch (cause) {
      if (live.current) {
        // Put the moved rows back, then ask the server what is true: the
        // write is atomic, but a lost answer can hide one that DID commit.
        setSummaryModes((prev) => revertModes(prev, before, affected.map((r) => r.key)));
        toast(accessWriteFailureMessage(cause), "error");
        rereadOrReload(allRows.filter((r) => affectedKeys.has(r.key) || ancestors.has(r.path)));
      }
      return false;
    } finally {
      if (live.current) setBusy(false);
    }
  };

  /** Ask before taking access away; widening runs at once. */
  const guarded = (from: TeamAccessMode | "custom" | null, to: TeamAccessMode, scope: ReduceScope, run: () => Promise<void>) => {
    if (to === "open" || !needsAccessConfirm(from, to)) return void run();
    setConfirm({ ...reduceAccessCopy(scope, to), danger: to === "private", apply: run });
  };

  /** Play the move: the row lands in its new column, its old slot closes. */
  const animateMove = (row: AccessRow, from: TeamAccessMode) => {
    motionSeq.current += 1;
    const token = motionSeq.current;
    const source = views[columns.findIndex((c) => c.mode === from)] ?? [];
    const index = source.findIndex((v) => !v.item.grey && v.item.row.key === row.key);
    setLanding({ key: row.key, token });
    setRecent((prev) => [row.key, ...prev.filter((k) => k !== row.key)]);
    setLeaving(index >= 0 ? { mode: from, index, token } : null);
    window.setTimeout(() => {
      if (!live.current) return;
      setLanding((l) => (l?.token === token ? null : l));
      setLeaving((l) => (l?.token === token ? null : l));
    }, LAND_MS);
  };

  /**
   * Move one row to `to`: arrows and drops both land here. Applied at once,
   * even when lowering: one row is cheap to move back, and a toast says what changed.
   */
  const move = (row: AccessRow, to: TeamAccessMode) => {
    if (!canSetAccess || busy) return;
    const fromOwn = own.get(row.key);
    if (!fromOwn || fromOwn === to) return;
    if (to === "open" && teamLocked.has(row.key)) {
      toast(`${row.name} is locked for everyone. Unlock it from the sidebar first.`, "neutral");
      return;
    }
    animateMove(row, fromOwn);
    void (async () => {
      if (!(await write([row], to, row.key))) return;
      // Say it worked only once the server agrees: re-read this row directly
      // (not through readModes, whose in-flight dedupe could hand back an
      // answer from before the write) and let the board show the truth.
      let actual: SummaryMode;
      try {
        actual = await summaries.read(orgId, resourceOf(row), [member.userId], () => !live.current);
      } catch {
        if (live.current) toast(`Saved, but couldn't check ${row.name} yet.`, "neutral");
        return;
      }
      if (!live.current) return;
      setSummaryModes((prev) => new Map(prev).set(row.key, actual));
      if (actual === to) toast(moveMessage(who, isSelf, row.name, to));
      else toast(notAppliedMessage(row.name, actual), "error");
    })();
  };

  const setEverything = (choice: EverythingChoice) => {
    if (!canSetAccess || busy) return;
    if (choice === "reset") {
      setConfirm({
        title: isSelf ? "Reset your access to the vault default?" : `Reset ${who}'s access to the vault default?`,
        button: "Reset",
        outcome: isSelf
          ? "Your own settings are removed; you get what every member gets."
          : "Their own settings are removed; they get what every member gets.",
        danger: false,
        apply: resetToDefault,
      });
      return;
    }
    guarded(personVaultMode, choice, { kind: "person", name: fullName, self: isSelf }, async () => {
      await write([], choice);
    });
  };

  /** Back to what every member gets: one request deletes this person's own rows. */
  const resetToDefault = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isSelf) markSelfAccessChange([orgId, ...entries.map((e) => e.id)]);
      await authManager.api.resetMemberAccess(orgId, member.userId);
      if (!live.current) return;
      if (map.complete) await map.reload();
      else {
        setSummaryModes(new Map());
        readModes(allRows);
      }
      await onChanged();
    } catch (cause) {
      if (live.current) toast(accessWriteFailureMessage(cause), "error");
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const addAll = (mode: TeamAccessMode) => setEverything(mode);

  const removeAll = (column: readonly BoardRow[]) => {
    if (!canSetAccess || busy) return;
    const tops = topLevelRows(column);
    if (tops.length === 0) return;
    const count = tops.length;
    setConfirm({
      title: `Move ${count} ${count === 1 ? "item" : "items"} to No access?`,
      button: "Remove access",
      outcome: reduceAccessCopy({ kind: "person", name: fullName, self: isSelf }, "private").outcome,
      danger: true,
      apply: async () => {
        if (!(await write(tops, "private"))) return;
        const what = count === 1 ? tops[0].name : `${count} items`;
        toast(moveMessage(who, isSelf, what, "private"));
      },
    });
  };

  const locked = !canSetAccess || busy;

  /**
   * Pointer-driven drag, the same approach as the sidebar tree: Tauri's
   * `dragDropEnabled` (needed for dropping files from Finder) swallows HTML5
   * drag events in the webview, so `draggable` rows never start a drag there.
   * A press arms a probe; past DRAG_THRESHOLD a ghost follows the pointer
   * (moved by hand, no re-render per pixel) and the column under it, found
   * through elementFromPoint, is the drop target — the whole column, header
   * and empty placeholder included.
   */
  const beginProbe = (row: AccessRow, e: React.PointerEvent<HTMLElement>) => {
    if (locked || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const box = e.currentTarget.getBoundingClientRect();
    probe.current = {
      key: row.key, x: e.clientX, y: e.clientY, dx: e.clientX - box.left, dy: e.clientY - box.top, width: box.width,
      pointerId: e.pointerId, source: e.currentTarget,
    };
  };

  const placeGhost = (x: number, y: number) => {
    const p = probe.current;
    const ghost = ghostRef.current;
    if (!p || !ghost) return;
    ghost.style.width = `${p.width}px`;
    ghost.style.transform = `translate3d(${x - p.dx}px, ${y - p.dy}px, 0)`;
  };

  /** Measure the column bands: the drop target is the whole column, not the card. */
  const measureBands = () => {
    const board = boardRef.current;
    boardTop.current = board?.getBoundingClientRect().top ?? 0;
    bands.current = [...(board?.querySelectorAll<HTMLElement>(".access-board-column") ?? [])].flatMap((el) => {
      const mode = el.dataset.mode;
      if (mode !== "open" && mode !== "readonly" && mode !== "private") return [];
      const r = el.getBoundingClientRect();
      return r.width > 0 ? [{ mode, left: r.left, right: r.right }] : [];
    });
  };

  /**
   * The column whose horizontal band holds `x`, anywhere from the board's top
   * down to the bottom of the viewport — so the empty space under a short
   * column still targets it. elementFromPoint is the fallback (gaps, no layout).
   */
  const columnAt = (x: number, y: number): TeamAccessMode | null => {
    if (y >= boardTop.current - 8) {
      const band = bands.current.find((b) => x >= b.left && x <= b.right);
      if (band) return band.mode;
    }
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    const col = hit instanceof Element ? hit.closest<HTMLElement>(".access-board-column") : null;
    const mode = col?.dataset.mode;
    return mode === "open" || mode === "readonly" || mode === "private" ? mode : null;
  };

  const moveRef = useRef(move);
  moveRef.current = move;
  const beginProbeRef = useRef(beginProbe);
  beginProbeRef.current = beginProbe;
  /** Stable for every row, so a memoised row re-renders only when its own props change. */
  const onRowArrow = useCallback((row: AccessRow, from: TeamAccessMode, step: -1 | 1) => {
    const to = neighbourMode(from, step);
    if (to) moveRef.current(row, to);
  }, []);
  const onRowPointerDown = useCallback((row: AccessRow, e: React.PointerEvent<HTMLElement>) => {
    beginProbeRef.current(row, e);
  }, []);
  const rowByKeyRef = useRef(rowByKey);
  rowByKeyRef.current = rowByKey;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    const clear = () => {
      const p = probe.current;
      if (p) {
        try { if (p.source.hasPointerCapture?.(p.pointerId)) p.source.releasePointerCapture(p.pointerId); } catch { /* gone */ }
      }
      probe.current = null;
      dragging.current = null;
      overRef.current = null;
      document.body.classList.remove("access-board-grabbing");
      setDragKey(null);
      setOverColumn(null);
    };
    const onMove = (e: PointerEvent) => {
      const p = probe.current;
      if (!p) return;
      if (!dragging.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
        if (lockedRef.current) { clear(); return; }
        dragging.current = p.key;
        window.getSelection()?.removeAllRanges();
        try { p.source.setPointerCapture?.(p.pointerId); } catch { /* pointer already gone */ }
        measureBands();
        document.body.classList.add("access-board-grabbing");
        setDragKey(p.key);
      }
      // Ours now: no text selection rides along with the drag.
      e.preventDefault();
      placeGhost(e.clientX, e.clientY);
      const over = columnAt(e.clientX, e.clientY);
      if (over !== overRef.current) {
        overRef.current = over;
        setOverColumn(over);
      }
    };
    const onUp = (e: PointerEvent) => {
      const key = dragging.current;
      const over = key ? columnAt(e.clientX, e.clientY) ?? overRef.current : null;
      clear();
      if (!key) return;
      // A press that travelled is not a click on whatever it ended over.
      const swallow = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, true);
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      const row = rowByKeyRef.current.get(key);
      if (row && over) moveRef.current(row, over);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragging.current) clear();
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("access-board-grabbing");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The ghost mounts with the drag; put it under the pointer before paint.
  useLayoutEffect(() => {
    if (dragKey && probe.current) placeGhost(probe.current.x, probe.current.y);
  }, [dragKey]);

  const { loading, failedCount } = useMemo(() => {
    let pending = false;
    let failures = 0;
    for (const r of allRows) {
      const answered = summaryModes.has(r.key);
      if (!answered && !failed.has(r.key)) pending = true;
      else if (!answered) failures++;
    }
    return { loading: serverTree !== null && pending, failedCount: failures };
  }, [serverTree, allRows, summaryModes, failed]);
  const dragRow = dragKey ? rowByKey.get(dragKey) : undefined;

  // Bring a landed row into view (its column may be scrolled, or the pinned
  // group may sit above the fold).
  useEffect(() => {
    if (!landing) return;
    const el = [...(boardRef.current?.querySelectorAll<HTMLElement>(".access-board-row[data-row-key]") ?? [])]
      .find((r) => r.dataset.rowKey === landing.key);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [landing, own]);

  /**
   * The one-time "these rows move" nudge: a real movable row lifts, slides
   * toward its neighbour column and settles back, the neighbour tinting while
   * it holds. CSS only (driven by `data-hint` and a column class) — no write,
   * no state beyond the hint itself, and any press cancels it.
   */
  const [hint, setHint] = useState<{ key: string; dir: "left" | "right"; target: TeamAccessMode } | null>(null);
  const hintArmed = useRef(false);
  const ready = serverTree !== null && !loading && allRows.length > 0 && canSetAccess;
  useEffect(() => {
    if (!ready || hintArmed.current) return;
    hintArmed.current = true;
    try {
      if (window.localStorage.getItem(DRAG_HINT_KEY)) return;
    } catch {
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let stop: number | undefined;
    const start = window.setTimeout(() => {
      if (!live.current || dragging.current || probe.current) return;
      for (let i = 0; i < columns.length; i++) {
        const first = columns[i].rows.find((r) => !r.grey);
        if (!first) continue;
        const step = i < columns.length - 1 ? 1 : -1;
        setHint({ key: first.row.key, dir: step > 0 ? "right" : "left", target: columns[i + step].mode });
        try { window.localStorage.setItem(DRAG_HINT_KEY, "1"); } catch { /* best effort */ }
        stop = window.setTimeout(() => { if (live.current) setHint(null); }, DRAG_HINT_MS);
        return;
      }
    }, DRAG_HINT_DELAY_MS);
    return () => {
      window.clearTimeout(start);
      if (stop !== undefined) window.clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => {
    if (!hint) return;
    const cancel = () => setHint(null);
    window.addEventListener("pointerdown", cancel, true);
    return () => window.removeEventListener("pointerdown", cancel, true);
  }, [hint]);

  return (
    <div ref={boardRef} className={`access-board${dragKey ? " is-dragging" : ""}`}>
      <div className="access-board-head">
        <p className="access-board-intro"><span className="access-board-intro-drag">Drag</span> rows between columns, or use the arrows. Changes save right away.</p>
        {!hideSetEverything && <MenuSelect<EverythingChoice | "none">
          value="none"
          options={[
            { value: "open", label: "Can edit", hint: "Every folder and note" },
            { value: "readonly", label: "Can view", hint: "Read only" },
            { value: "private", label: "No access", hint: `Hide everything from ${isSelf ? "you" : who}` },
            { value: "reset", label: "Reset to vault default", hint: "Back to what every member gets" },
          ]}
          triggerContent="Set everything to"
          disabled={locked}
          ariaLabel="Set everything to"
          triggerClassName="member-access-pill is-lg access-board-everything"
          menuClassName="access-menu access-board-everything-menu"
          onSelect={(v) => { if (v !== "none") setEverything(v); }}
        />}
      </div>
      {error && <div className="auth-error">{error}</div>}
      {!serverTree ? (
        error ? null : <BoardSkeleton />
      ) : (
        <div className="access-board-columns">
          {columns.map((col, i) => {
            const count = col.count;
            const view = views[i];
            const actions: Array<{ value: ColumnAction; label: string; hint: string }> = [
              { value: "expand", label: "Expand all", hint: "Show what's inside every folder" },
              { value: "collapse", label: "Collapse all", hint: "Show only the top level" },
              { value: "add", label: "Add all", hint: "Move every folder and note here" },
            ];
            if (col.mode !== "private") {
              actions.push({ value: "remove", label: "Remove all", hint: "Move everything here to No access" });
            }
            return (
              <section
                key={col.mode}
                className={`access-board-column${overColumn === col.mode ? " is-over" : ""}${hint?.target === col.mode ? " is-hint-target" : ""}`}
                aria-label={col.title}
                data-mode={col.mode}
              >
                <header className="access-board-column-head">
                  <span className="access-board-column-title">
                    {col.title} <span className="access-board-count">{count}</span>
                  </span>
                  <MenuSelect<ColumnAction | "none">
                    value="none"
                    // Expand and collapse only change the view, so they stay
                    // offered when moves are not (busy writes are guarded).
                    options={canSetAccess ? actions : actions.filter((a) => a.value === "expand" || a.value === "collapse")}
                    triggerContent={dots}
                    caret={false}
                    ariaLabel={`${col.title} actions`}
                    triggerClassName="row-more-btn access-board-column-more"
                    menuClassName="access-menu access-board-column-menu"
                    onSelect={(v) => {
                      if (v === "expand") {
                        const keys = expandableKeys(col.display);
                        setExpanded((prev) => new Set([...prev, ...keys]));
                      } else if (v === "collapse") {
                        const keys = new Set(expandableKeys(col.display));
                        setExpanded((prev) => new Set([...prev].filter((k) => !keys.has(k))));
                      } else if (v === "add") addAll(col.mode);
                      else if (v === "remove") removeAll(col.rows);
                    }}
                  />
                </header>
                <ul className="access-board-list" role="list">
                  {/* At the top: a moved row lands first in its level. */}
                  {overColumn === col.mode && dragKey && own.get(dragKey) !== col.mode && (
                    <li className="access-board-drop-line" aria-hidden="true" />
                  )}
                  {view.flatMap(({ item: r, expandable, descendants }, index) => {
                    const out: React.ReactNode[] = [];
                    if (leaving?.mode === col.mode && leaving.index === index) {
                      out.push(<li key={`gap-${leaving.token}`} className="access-board-gap" aria-hidden="true" />);
                    }
                    out.push(
                      <BoardRowItem
                        key={r.row.key}
                        item={r}
                        canLeft={i > 0 && !(teamLocked.has(r.row.key) && neighbourMode(col.mode, -1) === "open")}
                        teamLocked={teamLocked.has(r.row.key)}
                        canRight={i < BOARD_COLUMNS.length - 1}
                        disabled={locked}
                        dragging={dragKey === r.row.key}
                        landing={landing?.key === r.row.key && !r.grey}
                        hint={hint?.key === r.row.key && !r.grey ? hint.dir : null}
                        expandable={expandable}
                        expanded={expanded.has(r.row.key)}
                        descendants={descendants}
                        mode={col.mode}
                        onToggle={toggleExpanded}
                        onArrow={onRowArrow}
                        onPointerDown={onRowPointerDown}
                      />,
                    );
                    return out;
                  })}
                  {leaving?.mode === col.mode && leaving.index >= view.length && (
                    <li key={`gap-${leaving.token}`} className="access-board-gap" aria-hidden="true" />
                  )}
                  {col.rows.length === 0 && <li className="access-board-empty">Nothing here</li>}
                </ul>
                {i === 0 && loading && <BoardPendingRows />}
              </section>
            );
          })}
        </div>
      )}
      {failedCount > 0 && (
        <p className="access-board-failed muted">
          Couldn't load access for {failedCount} {failedCount === 1 ? "item" : "items"}.
        </p>
      )}
      <p className="access-board-hint">
        A folder includes what's inside unless you move it out. Gray folders only show the path. Up to 5 levels deep.
      </p>
      {dragRow && (
        <div ref={ghostRef} className="access-board-ghost" aria-hidden="true">
          <span className="access-board-icon">{rowGlyph(dragRow)}</span>
          <span className="access-board-name">{dragRow.name}</span>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.button}
          tone={confirm.danger ? "danger" : "accent"}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { await confirm.apply(); setConfirm(null); }}
        >
          <p>{confirm.outcome}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

type ColumnAction = "expand" | "collapse" | "add" | "remove";

/**
 * One row. Memoised: every handler it gets is stable and every other prop is a
 * primitive or the row's own BoardRow, so a drag, a column highlight, a landing
 * or a toggle elsewhere re-renders only the rows whose own props changed.
 */
export const BoardRowItem = memo(function BoardRowItem({
  item, canLeft, canRight, disabled, dragging, landing, hint, teamLocked, expandable, expanded, descendants, mode, onToggle,
  onArrow, onPointerDown,
}: {
  item: BoardRow;
  canLeft: boolean;
  canRight: boolean;
  disabled: boolean;
  dragging: boolean;
  /** Just moved here: play the land animation. */
  landing: boolean;
  /** First-visit nudge toward this side, or null. */
  hint: "left" | "right" | null;
  /** Capped at view for everyone by a team lock. */
  teamLocked: boolean;
  /** A folder with rows under it in this column: draw the toggle. */
  expandable: boolean;
  expanded: boolean;
  /** Interactive rows under it in this column. */
  descendants: number;
  /** The column this row sits in (the arrows step from it). */
  mode: TeamAccessMode;
  onToggle: (key: string) => void;
  onArrow: (row: AccessRow, from: TeamAccessMode, step: -1 | 1) => void;
  onPointerDown: (row: AccessRow, e: React.PointerEvent<HTMLElement>) => void;
}) {
  if (import.meta.env?.MODE === "test") boardRowRenders.count++;
  const { row, grey, indent } = item;
  const style = { paddingLeft: `${8 + indent * 16}px` };
  // The List view's twisty: a real button (never a drag handle; beginProbe
  // ignores presses on buttons), or a same-width spacer so names line up.
  const twisty = expandable ? (
    <button
      type="button"
      className={`member-access-twisty${expanded ? " is-open" : ""}`}
      aria-label={expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
      aria-expanded={expanded}
      onClick={() => onToggle(row.key)}
    >
      {chevron("m9 6 6 6-6 6")}
    </button>
  ) : (
    <span className="member-access-twisty" aria-hidden="true" />
  );
  if (grey) {
    return (
      <li className="access-board-row is-path" style={style} aria-disabled="true" data-path={row.path}>
        {twisty}
        <span className="access-board-icon" aria-hidden="true">{rowGlyph(row)}</span>
        <span className="access-board-name">{row.name}</span>
      </li>
    );
  }
  return (
    <li
      className={`access-board-row${dragging ? " is-dragging" : ""}${landing ? " is-landing" : ""}`}
      style={style}
      data-path={row.path}
      data-movable={disabled ? "false" : "true"}
      data-row-key={row.key}
      data-pulse={landing ? "true" : undefined}
      data-hint={hint ?? undefined}
      onPointerDown={(e) => onPointerDown(row, e)}
    >
      {twisty}
      <span className="access-board-icon" aria-hidden="true">{rowGlyph(row)}</span>
      <span className="access-board-name">{row.name}</span>
      {expandable && !expanded && descendants > 0 && (
        <span className="access-board-count access-board-descendants" title={`${descendants} inside`}>{descendants}</span>
      )}
      {teamLocked && (
        <span className="access-board-lock" title={LOCKED_TITLE} aria-label={LOCKED_TITLE} role="img">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </span>
      )}
      <span className="access-board-arrows">
        <button
          type="button"
          className="access-board-arrow"
          aria-label={`Move ${row.name} left`}
          disabled={disabled || !canLeft}
          onClick={() => onArrow(row, mode, -1)}
        >
          {chevron("m15 6-6 6 6 6")}
        </button>
        <button
          type="button"
          className="access-board-arrow"
          aria-label={`Move ${row.name} right`}
          disabled={disabled || !canRight}
          onClick={() => onArrow(row, mode, 1)}
        >
          {chevron("m9 6 6 6-6 6")}
        </button>
      </span>
    </li>
  );
});

/** Test probe: how many times a board row rendered (counted under vitest only). */
export const boardRowRenders = { count: 0 };

const dots = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
    <circle cx="8" cy="8" r="1.4" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
  </svg>
);

const chevron = (d: string) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

function rowGlyph(row: AccessRow): React.ReactNode {
  if (row.kind === "folder") return svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />);
  if (row.kind === "file") return iconForPath(row.path);
  return svg(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /></>);
}
