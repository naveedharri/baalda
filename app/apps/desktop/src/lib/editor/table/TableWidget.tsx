/**
 * The editable GFM table.
 *
 * A table in live preview is ALWAYS the rendered table — clicking one must not
 * flip it back to `| a | b |` source (Obsidian 1.5 behaviour, and the single
 * thing people notice about a markdown editor's tables). Every other block
 * widget in `livePreview.ts` hides itself when the caret reaches its lines;
 * this one never does, because there is nothing to reveal: the cells ARE the
 * editing surface.
 *
 * Clicking a cell mounts a single-line `<input>` holding that cell's RAW
 * markdown. It is a real input, not a contenteditable, for the same reason the
 * inline title is: an input emits no MutationRecords, so CM6's DOMObserver
 * never force-flushes the widget's DOM out from under the caret, and
 * `ignoreEvent()` keeps every editor keymap inert while it has focus.
 *
 * Every commit is ONE transaction built from the pure planners in `./edit`,
 * carrying no selection change. It is an ordinary editor-origin transaction, so
 * yCollab ships it, the bridge egests it to the `.md`, and Yjs undo treats a
 * cell edit as one step.
 *
 * Two position rules are load-bearing:
 *  - RENDERING reads the widget's own `source` string (self-contained, offsets
 *    relative to 0). The widget's DOM outlives a document change, so an offset
 *    captured at render time can be stale by the time a click arrives.
 *  - COMMITTING re-derives the table from the LIVE document at the widget's
 *    current position (`view.posAtDOM(host)` → `tableAt`), the same discipline
 *    the Properties panel uses when it re-finds a property by key. A teammate
 *    inserting a paragraph above cannot make a cell edit land at a stale offset.
 */

import { syntaxTree } from "@codemirror/language";
import { type EditorState, Text, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createElement, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openExternal } from "../../ipc";
import { placeMenu, type Placement } from "../../menuPlacement";
import { ReactWidget } from "../reactWidget";
import {
  planDeleteColumn,
  planDeleteRow,
  planFillCell,
  planInsertColumn,
  planInsertRow,
  planSetAlignment,
  type SpanChange,
} from "./edit";
import {
  type CellAlign,
  displayRowCount,
  parseTable,
  rowOf,
  type TableModel,
} from "./parse";
import { renderCellInto } from "./render";

/** Shared with the other block replace widgets — see `BLOCK_INSET_CLASS`. */
const INSET = "cm-block-inset";

export interface TableWidgetOptions {
  /** Follow a `[[wikilink]]` clicked inside a cell. */
  onNavigate?: (target: string) => void;
  readOnly?: boolean;
}

/** Derived, not imported: `@lezer/common` is transitive (see `./render`). */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** The table covering `pos` in the live document, re-parsed with live offsets. */
export function tableAt(state: EditorState, pos: number): TableModel | null {
  const tree = syntaxTree(state);
  for (const at of [pos, pos + 1]) {
    if (at > state.doc.length) continue;
    let node: SyntaxNode | null = tree.resolveInner(at, 1);
    while (node) {
      if (node.name === "Table") return parseTable(state.doc, node.from, node.to);
      node = node.parent;
    }
  }
  return null;
}

function dispatchChanges(view: EditorView, changes: SpanChange[]): void {
  if (changes.length === 0) return;
  view.dispatch({
    changes: [...changes].sort((a, b) => a.from - b.from),
    // No selection change, deliberately: the caret stays wherever the document
    // had it, so a cell edit cannot scroll the note or move somebody's place.
    annotations: Transaction.userEvent.of("input.table"),
    scrollIntoView: false,
  });
}

// ---- The widget ------------------------------------------------------------

export class TableWidget extends ReactWidget {
  constructor(
    readonly source: string,
    private readonly opts: TableWidgetOptions,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.opts.readOnly === this.opts.readOnly;
  }

  protected hostClass(): string {
    return `cm-md-table ${INSET}`;
  }

  protected render(view: EditorView, host: HTMLElement): ReactNode {
    return createElement(EditableTable, {
      view,
      host,
      source: this.source,
      readOnly: this.opts.readOnly ?? false,
      onNavigate: this.opts.onNavigate,
    });
  }

  get estimatedHeight(): number {
    return 34 * (this.source.split("\n").length - 1) + 24;
  }
}

// ---- The component ---------------------------------------------------------

interface Editing {
  /** 0 = header row, 1..n = body row n-1. The delimiter row is never shown. */
  row: number;
  col: number;
  /** Where to put the caret on mount; `null` = end of the text. */
  caret: number | null;
}

interface CellMenu {
  x: number;
  y: number;
  row: number;
  col: number;
}

function EditableTable({
  view,
  host,
  source,
  readOnly,
  onNavigate,
}: {
  view: EditorView;
  host: HTMLElement;
  source: string;
  readOnly: boolean;
  onNavigate?: (target: string) => void;
}) {
  // Rendered from the widget's own source, never from live offsets — see the
  // module comment. `Text.of` makes the same parser usable off-document.
  const model = useMemo(
    () => parseTable(Text.of(source.split("\n")), 0, source.length),
    [source],
  );

  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState<CellMenu | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** The cell's source when the draft began, to spot a concurrent edit. */
  const rawAtStart = useRef("");
  /**
   * The cell whose draft we already wrote, as `row:col`. Its blur must not
   * write again. A plain boolean flag would be wrong: removing a focused
   * element does not reliably fire blur, so a "skip the next blur" flag can
   * outlive the blur it was meant for and swallow the NEXT cell's real one.
   * Keyed by cell, and cleared whenever a cell is opened, it cannot.
   */
  const handledCell = useRef<string | null>(null);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  /** The table as the DOCUMENT has it right now, at this widget's position. */
  const liveModel = useCallback((): TableModel | null => {
    try {
      return tableAt(view.state, view.posAtDOM(host));
    } catch {
      return null;
    }
  }, [view, host]);

  const rowCount = displayRowCount(model);
  const columns = model.columns;

  const cellRaw = useCallback(
    (r: number, c: number): string => rowOf(model, r)?.cells[c]?.raw ?? "",
    [model],
  );

  /**
   * Write `text` into (r, c) plus whatever `extra` adds, as ONE transaction.
   * Both halves are planned against the same live model, so their offsets are
   * in the same coordinate space and CM6 maps them together.
   */
  const commit = useCallback(
    (r: number, c: number, text: string, extra?: (live: TableModel) => SpanChange[]) => {
      const live = liveModel();
      if (!live) {
        setNote("This table moved while you were typing; the edit was not saved.");
        return;
      }
      const changes: SpanChange[] = [];
      const row = rowOf(live, r);
      if (row) {
        const cell = row.cells[c];
        if (cell && cell.raw !== rawAtStart.current) {
          setNote("Changed by someone else while you were typing.");
        }
        changes.push(...planFillCell(row, c, text));
      }
      if (extra) changes.push(...extra(live));
      dispatchChanges(view, changes);
    },
    [view, liveModel],
  );

  const startEdit = useCallback(
    (r: number, c: number, caret: number | null) => {
      if (readOnly) return;
      // Moving between cells commits explicitly rather than relying on blur:
      // the wrapper cancels the mousedown's default (see `swallowPointer`), so
      // focus does not leave the open input on its own and no blur would fire.
      if (editing && (editing.row !== r || editing.col !== c)) {
        handledCell.current = `${editing.row}:${editing.col}`;
        commit(editing.row, editing.col, draft);
      }
      const raw = cellRaw(r, c);
      handledCell.current = null;
      rawAtStart.current = raw;
      setDraft(raw);
      setEditing({ row: r, col: c, caret });
    },
    [readOnly, cellRaw, editing, draft, commit],
  );

  /** Commit the open cell, then open another one (or none). */
  const commitAndGo = useCallback(
    (next: { row: number; col: number } | null, extra?: (live: TableModel) => SpanChange[]) => {
      if (!editing) return;
      handledCell.current = `${editing.row}:${editing.col}`;
      commit(editing.row, editing.col, draft, extra);
      if (!next) {
        setEditing(null);
        return;
      }
      // The document just changed; read the next cell from the NEW text.
      const after = liveModel();
      const raw = after ? (rowOf(after, next.row)?.cells[next.col]?.raw ?? "") : "";
      rawAtStart.current = raw;
      setDraft(raw);
      setEditing({ row: next.row, col: next.col, caret: null });
    },
    [editing, draft, commit, liveModel],
  );

  /** Put the caret in the document just before or just after the table. */
  const leaveTable = useCallback(
    (side: "before" | "after") => {
      if (editing) {
        handledCell.current = `${editing.row}:${editing.col}`;
        commit(editing.row, editing.col, draft);
      }
      setEditing(null);
      const live = liveModel();
      view.focus();
      if (!live) return;
      const anchor =
        side === "before"
          ? Math.max(0, live.from - 1)
          : Math.min(view.state.doc.length, live.to + 1);
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
    },
    [editing, draft, commit, liveModel, view],
  );

  // Focus the open cell's input and place the caret. The input is keyed by
  // (row, col), so moving cells remounts it and this runs for the new one.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !editing) return;
    if (document.activeElement === el) return;
    el.focus();
    const caret = editing.caret ?? el.value.length;
    const at = Math.max(0, Math.min(caret, el.value.length));
    el.setSelectionRange(at, at);
  }, [editing]);

  // ---- structural actions (menu + hover affordances) ----

  const structural = useCallback(
    (plan: (live: TableModel) => SpanChange[]) => {
      const live = liveModel();
      if (!live) return;
      dispatchChanges(view, plan(live));
    },
    [view, liveModel],
  );

  const insertRowAt = (displayRow: number, where: "above" | "below") =>
    structural((live) =>
      planInsertRow(live, where === "above" ? displayRow - 2 : displayRow - 1),
    );

  /** The bar under the table: a new last row, with the caret already in it. */
  const addRowAtEnd = () => {
    const live = liveModel();
    if (!live) return;
    dispatchChanges(view, planInsertRow(live, live.rows.length - 1));
    const after = liveModel();
    handledCell.current = null;
    rawAtStart.current = "";
    setDraft("");
    setEditing({ row: after ? displayRowCount(after) - 1 : rowCount, col: 0, caret: null });
  };

  /** The bar down the right edge: a new last column. */
  const addColumnAtEnd = () => structural((live) => planInsertColumn(live, live.columns - 1));

  /**
   * Cancel the browser's own handling of a pointer press inside the widget.
   *
   * `ignoreEvent()` keeps CodeMirror's handlers away, but the widget still sits
   * inside a `contenteditable` host, so without this the BROWSER starts a
   * native selection at the nearest editable position — the table's atomic edge
   * — and the click's few pixels of travel drag it back over the title and the
   * paragraph above. Form controls are exempt: an input needs the default to
   * place its own caret.
   */
  const swallowPointer = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, button")) return;
    e.preventDefault();
  };

  const onCellKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editing) return;
    const { row, col } = editing;
    const lastRow = rowCount - 1;
    if (e.key === "Escape") {
      e.preventDefault();
      // Revert: the draft is dropped, so the cell's blur must not write it.
      handledCell.current = `${row}:${col}`;
      setEditing(null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (row >= lastRow) {
        // Obsidian: Enter on the last row grows the table.
        commitAndGo({ row: row + 1, col }, (live) => planInsertRow(live, live.rows.length - 1));
      } else {
        commitAndGo({ row: row + 1, col });
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const forward = !e.shiftKey;
      const flat = row * columns + col + (forward ? 1 : -1);
      const total = rowCount * columns;
      const wrapped = ((flat % total) + total) % total;
      commitAndGo({ row: Math.floor(wrapped / columns), col: wrapped % columns });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (row === 0) leaveTable("before");
      else commitAndGo({ row: row - 1, col });
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (row === lastRow) leaveTable("after");
      else commitAndGo({ row: row + 1, col });
    }
  };

  const onCellClick = (e: React.MouseEvent, r: number, c: number) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLElement>(".cm-md-link");
    if (link?.dataset.href) {
      e.preventDefault();
      void openExternal(link.dataset.href);
      return;
    }
    const wiki = target.closest<HTMLElement>(".cm-wikilink");
    if (wiki?.dataset.target && onNavigate) {
      e.preventDefault();
      onNavigate(wiki.dataset.target);
      return;
    }
    startEdit(r, c, caretFromClick(e, cellRaw(r, c)));
  };

  /** A cell's interior: its input while it is open, its rendered markdown otherwise. */
  const cellBody = (r: number, c: number) => {
    const open = editing?.row === r && editing.col === c;
    if (!open) return <CellContent raw={cellRaw(r, c)} />;
    return (
      <input
        ref={inputRef}
        className="cm-md-cell-input"
        value={draft}
        spellCheck
        aria-label={`Row ${r + 1}, column ${c + 1}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (handledCell.current === `${r}:${c}`) {
            handledCell.current = null;
            return;
          }
          commit(r, c, draft);
          setEditing(null);
        }}
        onKeyDown={onCellKeyDown}
      />
    );
  };

  /** The props every cell shares, header or body. */
  const cellProps = (r: number, c: number) => ({
    className: editing?.row === r && editing.col === c ? "cm-md-cell-open" : undefined,
    style: model.aligns[c] ? { textAlign: model.aligns[c]! } : undefined,
    onContextMenu: (e: React.MouseEvent) => {
      if (readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, row: r, col: c });
    },
    onClick: (e: React.MouseEvent) => onCellClick(e, r, c),
  });

  const bodyRows = Array.from({ length: rowCount - 1 }, (_, i) => i + 1);
  const cols = Array.from({ length: columns }, (_, i) => i);

  return (
    <div className="cm-md-table-wrap" onMouseDown={swallowPointer}>
      <div className="cm-md-table-row">
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} {...cellProps(0, c)}>
                  {cellBody(0, c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((r) => (
              <tr key={r}>
                {cols.map((c) => (
                  <td key={c} {...cellProps(r, c)}>
                    {cellBody(r, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!readOnly && (
          <button
            type="button"
            className="cm-md-add-col"
            aria-label="Add column"
            onClick={addColumnAtEnd}
          >
            +
          </button>
        )}
      </div>
      {!readOnly && (
        <button type="button" className="cm-md-add-row" aria-label="Add row" onClick={addRowAtEnd}>
          +
        </button>
      )}
      {note && <p className="cm-md-table-note">{note}</p>}
      {menu && (
        <CellContextMenu
          menu={menu}
          canDeleteRow={menu.row > 0}
          canDeleteColumn={columns > 1}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            setMenu(null);
            switch (action) {
              case "row-above":
                insertRowAt(menu.row, "above");
                break;
              case "row-below":
                insertRowAt(menu.row, "below");
                break;
              case "col-left":
                structural((live) => planInsertColumn(live, menu.col - 1));
                break;
              case "col-right":
                structural((live) => planInsertColumn(live, menu.col));
                break;
              case "row-delete":
                structural((live) => planDeleteRow(live, menu.row - 1));
                break;
              case "col-delete":
                structural((live) => planDeleteColumn(live, menu.col));
                break;
              default:
                structural((live) =>
                  planSetAlignment(live, menu.col, action.slice("align-".length) as CellAlign),
                );
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Where in the RAW text the click landed. Only answerable when the rendered
 * text and the source are the same string (a plain cell, which is most of
 * them); with markdown in the way there is no honest mapping, so the caret
 * goes to the end.
 */
function caretFromClick(e: React.MouseEvent, raw: string): number | null {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".cm-md-cell-content");
  if (!cell || cell.textContent !== raw) return null;
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!range || !cell.contains(range.startContainer)) return null;
  return range.startOffset;
}

/** One cell's rendered markdown. Imperative DOM, so nothing is ever HTML. */
function CellContent({ raw }: { raw: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) renderCellInto(el, raw);
  }, [raw]);
  // `cm-md-cell` is the block whose max-width bounds a column's natural size.
  return <span ref={ref} className="cm-md-cell cm-md-cell-content" />;
}

type MenuAction =
  | "row-above"
  | "row-below"
  | "col-left"
  | "col-right"
  | "row-delete"
  | "col-delete"
  | "align-left"
  | "align-center"
  | "align-right";

/**
 * The cell's right-click menu, portalled to `document.body` and placed with the
 * app's shared `placeMenu` — the same measure-then-place dance the file tree and
 * the tab strip use, so it flips and clamps at the window edges like they do.
 */
function CellContextMenu({
  menu,
  canDeleteRow,
  canDeleteColumn,
  onClose,
  onAction,
}: {
  menu: CellMenu;
  canDeleteRow: boolean;
  canDeleteColumn: boolean;
  onClose: () => void;
  onAction: (action: MenuAction) => void;
}) {
  const ref = useRef<HTMLUListElement | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos(
      placeMenu(
        { x: menu.x, y: menu.y },
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [menu]);

  const item = (action: MenuAction, label: string, enabled = true) => (
    <li
      key={action}
      className={enabled ? undefined : "disabled"}
      onClick={() => enabled && onAction(action)}
    >
      {label}
    </li>
  );

  return createPortal(
    <ul
      ref={ref}
      className="context-menu menu-portal cm-md-table-menu"
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={
        pos
          ? { position: "fixed", left: pos.left, top: pos.top, right: "auto", maxHeight: pos.maxHeight }
          : { position: "fixed", left: 0, top: 0, right: "auto", visibility: "hidden" }
      }
    >
      {item("row-above", "Insert row above", menu.row > 0)}
      {item("row-below", "Insert row below")}
      {item("col-left", "Insert column left")}
      {item("col-right", "Insert column right")}
      {item("row-delete", "Delete row", canDeleteRow)}
      {item("col-delete", "Delete column", canDeleteColumn)}
      {item("align-left", "Align left")}
      {item("align-center", "Align center")}
      {item("align-right", "Align right")}
    </ul>,
    document.body,
  );
}
