// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AccessTreeResponse, BulkAccessResource, MemberOverview, TeamAccessMode } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  BOARD_COLUMNS,
  notAppliedMessage,
  columnRows,
  firstName,
  moveMessage,
  neighbourMode,
  ownModes,
  topLevelRows,
  type BoardRow,
  type SummaryMode,
} from "../lib/accessBoard";
import { createAccessSummaryBatcher } from "../lib/accessSummaryBatch";
import { accessResourceType, ancestorPaths, entriesFromServer, rowsFromEntries, type AccessRow } from "../lib/accessTree";
import { isNarrowing, reduceAccessCopy, type ReduceScope } from "../lib/membersAccess";
import { markSelfAccessChange } from "../lib/sync/selfAccessChanges";
import { ConfirmDialog } from "./ConfirmDialog";
import { iconForPath } from "./FileTree";
import { MenuSelect } from "./MenuSelect";
import { Spinner } from "./Spinner";
import { toast } from "../lib/toast";

/** One batcher for the board: a render's reads go out as one request. */
const summaries = createAccessSummaryBatcher({
  many: (orgId, groups, userIds) => authManager.api.resolveAccessSummaries(orgId, groups, userIds),
  one: async (orgId, resources, userIds) => (await authManager.api.resolveAccessSummary(orgId, resources, userIds)).mode,
});

/** A row with no summary this long after queueing counts as failed. */
const BOARD_SUMMARY_TIMEOUT_MS = 5000;
/** Pixels a press must travel before it becomes a drag (FileTree uses the same). */
const DRAG_THRESHOLD = 4;
/** How long the landing / leaving animations run, plus slack. */
const LAND_MS = 420;
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
}: MemberAccessBoardProps) {
  const [serverTree, setServerTree] = useState<AccessTreeResponse | null>(null);
  const [summaryModes, setSummaryModes] = useState<ReadonlyMap<string, SummaryMode>>(() => new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
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
  const [leaving, setLeaving] = useState<{ mode: TeamAccessMode; index: number; token: number } | null>(null);
  const motionSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    authManager.api.listAccessTree(vaultId)
      .then((t) => { if (alive) setServerTree(t); })
      .catch(() => { if (alive) setError("Couldn't load this vault's folders."); });
    return () => { alive = false; };
  }, [vaultId]);

  const entries = useMemo(() => (serverTree ? entriesFromServer(serverTree) : []), [serverTree]);
  // Every folder open: the board shows the whole tree.
  const allRows = useMemo(
    () => rowsFromEntries(entries, new Set(entries.filter((e) => e.kind === "folder").map((e) => e.path))),
    [entries],
  );
  const rowByKey = useMemo(() => new Map(allRows.map((r) => [r.key, r])), [allRows]);
  // A mixed folder with no answered children sits at the person's own
  // vault-wide level, else Everyone's.
  const fallback: TeamAccessMode = personVaultMode && personVaultMode !== "custom" ? personVaultMode : everyoneMode ?? "private";
  const own = useMemo(() => ownModes(allRows, summaryModes, fallback), [allRows, summaryModes, fallback]);
  const columns = useMemo(
    () => BOARD_COLUMNS.map((c) => ({ ...c, rows: columnRows(allRows, own, c.mode) })),
    [allRows, own],
  );

  const readModes = (targets: readonly AccessRow[]) => {
    for (const row of targets) {
      if (inflight.current.has(row.key)) continue;
      inflight.current.add(row.key);
      const markFailed = () => {
        if (!live.current) return;
        setFailed((prev) => (prev.has(row.key) ? prev : new Set(prev).add(row.key)));
      };
      const timer = window.setTimeout(markFailed, BOARD_SUMMARY_TIMEOUT_MS);
      summaries
        .read(orgId, resourceOf(row), [member.userId], () => !live.current)
        .then((m) => {
          if (!live.current) return;
          setSummaryModes((prev) => new Map(prev).set(row.key, m));
          setFailed((prev) => {
            if (!prev.has(row.key)) return prev;
            const next = new Set(prev);
            next.delete(row.key);
            return next;
          });
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
    const affected = vaultWide
      ? allRows
      : allRows.filter((r) => rows.some((w) => r.path === w.path || r.path.startsWith(`${w.path}/`)));
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
      });
      if (!live.current) return true;
      readModes(allRows.filter((r) => r.key !== except && (affected.includes(r) || ancestors.has(r.path))));
      if (vaultWide) await onChanged();
      else onItemWritten();
      return true;
    } catch (cause) {
      if (live.current) {
        setSummaryModes(before);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    } finally {
      if (live.current) setBusy(false);
    }
  };

  /** Ask before taking access away; widening runs at once. */
  const guarded = (from: TeamAccessMode | "custom" | null, to: TeamAccessMode, scope: ReduceScope, run: () => Promise<void>) => {
    if (to === "open" || !isNarrowing(from, to)) return void run();
    setConfirm({ ...reduceAccessCopy(scope, to), danger: to === "private", apply: run });
  };

  /** Play the move: the row lands in its new column, its old slot closes. */
  const animateMove = (row: AccessRow, from: TeamAccessMode) => {
    motionSeq.current += 1;
    const token = motionSeq.current;
    const source = columns.find((c) => c.mode === from)?.rows ?? [];
    const index = source.findIndex((r) => r.row.key === row.key);
    setLanding({ key: row.key, token });
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
      setSummaryModes(new Map());
      readModes(allRows);
      await onChanged();
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : String(cause));
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

  const loading = serverTree !== null && allRows.some((r) => !summaryModes.has(r.key) && !failed.has(r.key));
  const failedCount = allRows.filter((r) => failed.has(r.key) && !summaryModes.has(r.key)).length;
  const dragRow = dragKey ? rowByKey.get(dragKey) : undefined;

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
        <div className="member-profile-loading">{error ? null : <Spinner />}</div>
      ) : (
        <div className="access-board-columns">
          {columns.map((col, i) => {
            const count = col.rows.filter((r) => !r.grey).length;
            const actions: Array<{ value: "add" | "remove"; label: string; hint: string }> = [
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
                  <MenuSelect<"add" | "remove" | "none">
                    value="none"
                    options={actions}
                    triggerContent={dots}
                    caret={false}
                    disabled={locked}
                    ariaLabel={`${col.title} actions`}
                    triggerClassName="row-more-btn access-board-column-more"
                    menuClassName="access-menu access-board-column-menu"
                    onSelect={(v) => {
                      if (v === "add") addAll(col.mode);
                      else if (v === "remove") removeAll(col.rows);
                    }}
                  />
                </header>
                <ul className="access-board-list" role="list">
                  {col.rows.flatMap((r, index) => {
                    const item = (
                      <BoardRowItem
                        key={r.row.key}
                        item={r}
                        canLeft={i > 0}
                        canRight={i < BOARD_COLUMNS.length - 1}
                        disabled={locked}
                        dragging={dragKey === r.row.key}
                        landing={landing?.key === r.row.key && !r.grey}
                        hint={hint?.key === r.row.key && !r.grey ? hint.dir : null}
                        onArrow={(step) => {
                          const to = neighbourMode(col.mode, step);
                          if (to) move(r.row, to);
                        }}
                        onPointerDown={(e) => beginProbe(r.row, e)}
                      />
                    );
                    return leaving?.mode === col.mode && leaving.index === index
                      ? [<li key={`gap-${leaving.token}`} className="access-board-gap" aria-hidden="true" />, item]
                      : [item];
                  })}
                  {leaving?.mode === col.mode && leaving.index >= col.rows.length && (
                    <li key={`gap-${leaving.token}`} className="access-board-gap" aria-hidden="true" />
                  )}
                  {col.rows.length === 0 && <li className="access-board-empty">Nothing here</li>}
                  {overColumn === col.mode && dragKey && own.get(dragKey) !== col.mode && (
                    <li className="access-board-drop-line" aria-hidden="true" />
                  )}
                </ul>
                {i === 0 && loading && <div className="access-board-loading"><Spinner /></div>}
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

function BoardRowItem({ item, canLeft, canRight, disabled, dragging, landing, hint, onArrow, onPointerDown }: {
  item: BoardRow;
  canLeft: boolean;
  canRight: boolean;
  disabled: boolean;
  dragging: boolean;
  /** Just moved here: play the land animation. */
  landing: boolean;
  /** First-visit nudge toward this side, or null. */
  hint: "left" | "right" | null;
  onArrow: (step: -1 | 1) => void;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
}) {
  const { row, grey, indent } = item;
  const style = { paddingLeft: `${8 + indent * 16}px` };
  if (grey) {
    return (
      <li className="access-board-row is-path" style={style} aria-disabled="true" data-path={row.path}>
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
      data-hint={hint ?? undefined}
      onPointerDown={onPointerDown}
    >
      <span className="access-board-icon" aria-hidden="true">{rowGlyph(row)}</span>
      <span className="access-board-name">{row.name}</span>
      <span className="access-board-arrows">
        <button
          type="button"
          className="access-board-arrow"
          aria-label={`Move ${row.name} left`}
          disabled={disabled || !canLeft}
          onClick={() => onArrow(-1)}
        >
          {chevron("m15 6-6 6 6 6")}
        </button>
        <button
          type="button"
          className="access-board-arrow"
          aria-label={`Move ${row.name} right`}
          disabled={disabled || !canRight}
          onClick={() => onArrow(1)}
        >
          {chevron("m9 6 6 6-6 6")}
        </button>
      </span>
    </li>
  );
}

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
