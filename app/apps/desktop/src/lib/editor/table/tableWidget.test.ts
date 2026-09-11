// @vitest-environment jsdom
//
// The editable table through a real EditorView and a real React root.
//
// The gate assertions:
//   1. a table is ALWAYS the rendered table — clicking a cell opens an input
//      inside it and never flips the block to `| a | b |` source;
//   2. a commit is ONE transaction whose result differs from the source in that
//      cell only;
//   3. the widget's host node survives an edit (`updateDOM` returns true), or a
//      teammate's keystroke would destroy the input under the caret.
import { cursorCharLeft, cursorCharRight } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createEditorState } from "../index";

interface Mounted {
  view: EditorView;
  txs: Transaction[];
}

function mount(doc: string): Mounted {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const txs: Transaction[] = [];
  const view = new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
      extraExtensions: [
        EditorView.updateListener.of((u) => txs.push(...u.transactions)),
      ],
    } as never),
    parent,
  });
  return { view, txs };
}

const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
const DOC = ["Intro.", "", TABLE, "", "Tail."].join("\n");

const cells = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLElement>(".cm-md-table th, .cm-md-table td")];

const cellTexts = (view: EditorView) =>
  [...view.dom.querySelectorAll(".cm-md-table .cm-md-cell-content")].map(
    (c) => c.textContent,
  );

/**
 * Let React land its update. In the app a discrete click flushes in the same
 * frame; under jsdom the concurrent root schedules it a tick later, so every
 * interaction here is followed by one.
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

const openInput = (view: EditorView) =>
  view.dom.querySelector<HTMLInputElement>(".cm-md-cell-input");

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Type into a React-controlled input the way a person would. */
function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
}

describe("the editable table widget", () => {
  it("renders the table's cells, delimiter row hidden", () => {
    const { view } = mount(DOC);
    const table = view.dom.querySelector(".cm-md-table table");
    expect(table).not.toBeNull();
    expect(cellTexts(view)).toEqual(["a", "b", "1", "2"]);
    // Two displayed rows, never three: the `| --- |` row is plumbing.
    expect(table!.querySelectorAll("tr")).toHaveLength(2);
    view.destroy();
  });

  it("stays rendered when the caret is on its lines", () => {
    const { view } = mount(DOC);
    view.dispatch({ selection: { anchor: DOC.indexOf("| 1 | 2 |") + 3 } });
    // The old behaviour showed raw source here. Clicking a table must not.
    expect(view.dom.querySelector(".cm-md-table table")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("---");
    view.destroy();
  });

  it("opens an input holding the RAW cell markdown, with the table still mounted", async () => {
    const { view } = mount(["| a | b |", "| --- | --- |", "| **x** | 2 |"].join("\n"));
    const cell = cells(view).find((c) => c.textContent === "x")!;
    expect(cell).toBeTruthy();
    click(cell);
    await settle();
    const input = openInput(view);
    expect(input).not.toBeNull();
    expect(input!.value).toBe("**x**"); // the source, not the rendered form
    // No flicker to source: the <table> is still a child of the content DOM.
    expect(view.contentDOM.querySelector(".cm-md-table table")).not.toBeNull();
    view.destroy();
  });

  it("commits one transaction that changes only that cell", async () => {
    const { view, txs } = mount(DOC);
    click(cells(view)[0]!); // header cell "a"
    await settle();
    const input = openInput(view)!;
    typeInto(input, "one");
    await settle();
    txs.length = 0;
    key(input, "Enter");
    expect(txs).toHaveLength(1);
    expect(view.state.doc.toString()).toBe(DOC.replace("| a | b |", "| one | b |"));
    view.destroy();
  });

  it("reverts on Escape", async () => {
    const { view } = mount(DOC);
    click(cells(view)[2]!);
    await settle();
    const input = openInput(view)!;
    typeInto(input, "nope");
    await settle();
    key(input, "Escape");
    await settle();
    expect(openInput(view)).toBeNull();
    expect(view.state.doc.toString()).toBe(DOC);
    view.destroy();
  });

  it("moves to the next cell on Tab and the previous on Shift-Tab", async () => {
    const { view } = mount(DOC);
    click(cells(view)[0]!); // header "a"
    await settle();
    key(openInput(view)!, "Tab");
    await settle();
    expect(openInput(view)!.value).toBe("b");
    expect(document.activeElement).toBe(openInput(view));
    key(openInput(view)!, "Tab");
    await settle();
    expect(openInput(view)!.value).toBe("1");
    key(openInput(view)!, "Tab", { shiftKey: true });
    await settle();
    expect(openInput(view)!.value).toBe("b");
    view.destroy();
  });

  it("adds a row when Enter is pressed on the last one", async () => {
    const { view } = mount(DOC);
    click(cells(view)[2]!); // last row, first column
    await settle();
    key(openInput(view)!, "Enter");
    await settle();
    expect(view.state.doc.toString()).toBe(
      DOC.replace("| 1 | 2 |", "| 1 | 2 |\n|  |  |"),
    );
    // …and the caret is in the new row's first cell.
    expect(openInput(view)!.value).toBe("");
    view.destroy();
  });

  it("commits on blur, once", async () => {
    const { view, txs } = mount(DOC);
    click(cells(view)[1]!); // header "b"
    await settle();
    const input = openInput(view)!;
    typeInto(input, "bee");
    await settle();
    txs.length = 0;
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    expect(txs).toHaveLength(1);
    expect(view.state.doc.toString()).toBe(DOC.replace("| a | b |", "| a | bee |"));
    view.destroy();
  });

  it("still commits the NEXT cell on blur after a Tab", async () => {
    // Regression: a "skip the next blur" flag set by Tab outlived the blur it
    // was meant for and swallowed the following cell's real commit.
    const { view } = mount(DOC);
    click(cells(view)[0]!);
    await settle();
    key(openInput(view)!, "Tab");
    await settle();
    const input = openInput(view)!;
    typeInto(input, "bee");
    await settle();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    expect(view.state.doc.toString()).toBe(DOC.replace("| a | b |", "| a | bee |"));
    view.destroy();
  });

  it("keeps the SAME host node after an edit to another cell", async () => {
    const { view } = mount(DOC);
    const before = view.contentDOM.querySelector(".cm-md-table");
    expect(before).not.toBeNull();
    click(cells(view)[3]!); // "2"
    await settle();
    typeInto(openInput(view)!, "two");
    await settle();
    key(openInput(view)!, "Enter");
    await settle();
    expect(view.state.doc.toString()).toContain("| 1 | two |");
    expect(view.contentDOM.querySelector(".cm-md-table")).toBe(before);
    view.destroy();
  });

  it("leaves the table on ArrowUp from the first row", async () => {
    const { view } = mount(DOC);
    click(cells(view)[0]!);
    await settle();
    key(openInput(view)!, "ArrowUp");
    await settle();
    expect(view.state.selection.main.head).toBeLessThan(DOC.indexOf("| a | b |"));
    view.destroy();
  });

  it("leaves the table on ArrowDown from the last row", async () => {
    const { view } = mount(DOC);
    click(cells(view)[2]!);
    await settle();
    key(openInput(view)!, "ArrowDown");
    await settle();
    expect(view.state.selection.main.head).toBeGreaterThan(DOC.indexOf("| 1 | 2 |"));
    view.destroy();
  });

  it("swallows the pointer press, leaving the document selection alone", async () => {
    // Regression: the widget sits inside a contenteditable host, so a mousedown
    // the browser still handled started a native selection at the table's
    // atomic edge and the click's few pixels of travel dragged it back over the
    // inline title and the paragraph above.
    const { view, txs } = mount(DOC);
    view.dispatch({ selection: { anchor: 3 } });
    const before = view.state.selection;
    txs.length = 0;
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    cells(view)[2]!.dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection).toBe(before);
    // …and no transaction of our own moved it either.
    expect(txs.filter((t) => t.selection !== undefined)).toHaveLength(0);
    view.destroy();
  });

  it("lets a press inside the open input through, so the caret can move", async () => {
    const { view } = mount(DOC);
    click(cells(view)[2]!);
    await settle();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    openInput(view)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });

  it("commits the open cell when another cell is clicked", async () => {
    // Blur cannot be relied on here: the wrapper cancels the mousedown, so
    // focus never leaves the input by itself.
    const { view } = mount(DOC);
    click(cells(view)[0]!);
    await settle();
    typeInto(openInput(view)!, "hdr");
    await settle();
    click(cells(view)[2]!);
    await settle();
    expect(view.state.doc.toString()).toBe(DOC.replace("| a | b |", "| hdr | b |"));
    expect(openInput(view)!.value).toBe("1");
    view.destroy();
  });

  it("adds a row from the bar and puts the caret in it", async () => {
    const { view } = mount(DOC);
    const bar = view.dom.querySelector<HTMLButtonElement>(".cm-md-add-row")!;
    click(bar);
    await settle();
    expect(view.state.doc.toString()).toBe(
      DOC.replace("| 1 | 2 |", "| 1 | 2 |\n|  |  |"),
    );
    expect(openInput(view)).not.toBeNull();
    expect(openInput(view)!.value).toBe("");
    view.destroy();
  });

  it("adds a column from the bar, delimiter row included", async () => {
    const { view } = mount(DOC);
    click(view.dom.querySelector(".cm-md-add-col")!);
    await settle();
    expect(view.state.doc.toString()).toBe(
      DOC.replace(TABLE, ["| a | b |  |", "| --- | --- | --- |", "| 1 | 2 |  |"].join("\n")),
    );
    // The new cells are empty but present, so the column is not a hairline.
    expect(cellTexts(view)).toHaveLength(6);
    view.destroy();
  });

  it("renders `<script>` in a cell as literal text", () => {
    const { view } = mount(
      ["| a |", "| --- |", "| <script>alert(1)</script> |"].join("\n"),
    );
    const cell = cells(view).find((c) => c.textContent?.includes("script"))!;
    expect(cell.textContent).toBe("<script>alert(1)</script>");
    expect(cell.querySelector("script")).toBeNull();
    view.destroy();
  });

  it("renders inline markdown without its markers", () => {
    const { view } = mount(
      ["| a | b |", "| --- | --- |", "| **bold** | `code` |"].join("\n"),
    );
    const table = view.dom.querySelector(".cm-md-table table")!;
    expect(table.querySelector("strong")?.textContent).toBe("bold");
    expect(table.querySelector("code")?.textContent).toBe("code");
    view.destroy();
  });

  it("renders a `[[wikilink]]` with its alias and target", () => {
    const { view } = mount(["| a |", "| --- |", "| [[Note A\\|Alias]] |"].join("\n"));
    const link = view.dom.querySelector<HTMLElement>(".cm-md-table .cm-wikilink")!;
    expect(link.textContent).toBe("Alias");
    expect(link.dataset.target).toBe("Note A");
    view.destroy();
  });

  it("is read-only when the state is", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: createEditorState({
        doc: TABLE,
        getTitles: () => [],
        onNavigate: () => {},
        extraExtensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
      } as never),
      parent,
    });
    click(cells(view)[0]!);
    await settle();
    expect(openInput(view)).toBeNull();
    expect(view.dom.querySelector(".cm-md-add-row")).toBeNull();
    view.destroy();
  });

  it("steps the caret across the table instead of into it", () => {
    // jsdom has no layout, so vertical motion cannot be exercised honestly
    // here; horizontal motion tests the same guarantee — the table's range is
    // atomic (./atomic.ts), so no arrow key can park the caret inside it.
    const { view } = mount(DOC);
    const start = DOC.indexOf(TABLE);
    const end = start + TABLE.length;
    view.dispatch({ selection: { anchor: start } });
    cursorCharRight(view);
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(end);
    view.dispatch({ selection: { anchor: end } });
    cursorCharLeft(view);
    expect(view.state.selection.main.head).toBeLessThanOrEqual(start);
    view.destroy();
  });
});
