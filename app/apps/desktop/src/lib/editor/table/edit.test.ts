// Table edit planners.
//
// Every case applies the planned changes to the source and compares the WHOLE
// result, because the property that matters is what did NOT change: editing one
// cell must not re-pad a column, reorder a row, or normalise somebody's `---:`.
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  escapeCellText,
  planDeleteColumn,
  planDeleteRow,
  planFillCell,
  planInsertColumn,
  planInsertRow,
  planSetAlignment,
  planSetCell,
  type SpanChange,
} from "./edit";
import { parseTable } from "./parse";

const model = (src: string) => parseTable(Text.of(src.split("\n")), 0, src.length);

function apply(src: string, changes: SpanChange[]): string {
  let out = src;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}

const SRC = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

describe("planSetCell", () => {
  it("replaces one cell and leaves every other byte alone", () => {
    const m = model(SRC);
    expect(apply(SRC, planSetCell(m.header.cells[1]!, "B"))).toBe(
      ["| a | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("keeps odd padding exactly as the writer left it", () => {
    const src = ["|a   |   b|", "| --- | --- |"].join("\n");
    const m = model(src);
    expect(apply(src, planSetCell(m.header.cells[0]!, "z"))).toBe(
      ["|z   |   b|", "| --- | --- |"].join("\n"),
    );
  });

  it("escapes a typed pipe and leaves an already-escaped one alone", () => {
    const m = model(SRC);
    expect(apply(SRC, planSetCell(m.header.cells[0]!, "x|y"))).toBe(
      ["| x\\|y | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );
    expect(escapeCellText("x\\|y")).toBe("x\\|y");
  });

  it("collapses newlines — a table row is one line", () => {
    const m = model(SRC);
    expect(apply(SRC, planSetCell(m.header.cells[0]!, "one\ntwo"))).toBe(
      ["| one two | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("writes into an empty cell without eating its padding", () => {
    const src = ["|  | b |", "| --- | --- |"].join("\n");
    const m = model(src);
    expect(apply(src, planSetCell(m.header.cells[0]!, "z"))).toBe(
      ["| z | b |", "| --- | --- |"].join("\n"),
    );
  });

  it("empties a cell to an empty span", () => {
    const m = model(SRC);
    expect(apply(SRC, planSetCell(m.header.cells[0]!, ""))).toBe(
      ["|  | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("plans nothing when the text is unchanged", () => {
    expect(planSetCell(model(SRC).header.cells[0]!, "a")).toEqual([]);
  });
});

describe("planFillCell", () => {
  it("extends a ragged row to reach a column it does not have", () => {
    const src = ["| a | b | c |", "| --- | --- | --- |", "| 1 |"].join("\n");
    const m = model(src);
    expect(apply(src, planFillCell(m.rows[0]!, 2, "z"))).toBe(
      ["| a | b | c |", "| --- | --- | --- |", "| 1 |  | z |"].join("\n"),
    );
  });

  it("closes an open-ended row before appending to it", () => {
    const src = ["a | b", "--- | ---", "1"].join("\n");
    const m = model(src);
    expect(apply(src, planFillCell(m.rows[0]!, 1, "z"))).toBe(
      ["a | b", "--- | ---", "1 | z |"].join("\n"),
    );
  });
});

describe("planInsertRow", () => {
  it("adds an empty row after the one named", () => {
    expect(apply(SRC, planInsertRow(model(SRC), 0))).toBe(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", "|  |  |"].join("\n"),
    );
  });

  it("puts -1 directly under the delimiter", () => {
    expect(apply(SRC, planInsertRow(model(SRC), -1))).toBe(
      ["| a | b |", "| --- | --- |", "|  |  |", "| 1 | 2 |"].join("\n"),
    );
  });
});

describe("planDeleteRow", () => {
  it("takes the row and the newline that ended the line above", () => {
    expect(apply(SRC, planDeleteRow(model(SRC), 0))).toBe(
      ["| a | b |", "| --- | --- |"].join("\n"),
    );
  });

  it("refuses a row that is not there", () => {
    expect(planDeleteRow(model(SRC), 7)).toEqual([]);
  });
});

describe("planInsertColumn", () => {
  it("touches every row, and gives the delimiter a delimiter cell", () => {
    expect(apply(SRC, planInsertColumn(model(SRC), 0))).toBe(
      ["| a |  | b |", "| --- | --- | --- |", "| 1 |  | 2 |"].join("\n"),
    );
  });

  it("adds a first column with -1", () => {
    expect(apply(SRC, planInsertColumn(model(SRC), -1))).toBe(
      ["|  | a | b |", "| --- | --- | --- |", "|  | 1 | 2 |"].join("\n"),
    );
  });

  it("adds a last column past a row with no trailing pipe", () => {
    const src = ["a | b", "--- | ---", "1 | 2"].join("\n");
    expect(apply(src, planInsertColumn(model(src), 1))).toBe(
      ["a | b |  |", "--- | --- | --- |", "1 | 2 |  |"].join("\n"),
    );
  });

  it("skips a ragged row that has no such column", () => {
    const src = ["| a | b |", "| --- | --- |", "| 1 |"].join("\n");
    expect(apply(src, planInsertColumn(model(src), 1))).toBe(
      ["| a | b |  |", "| --- | --- | --- |", "| 1 |"].join("\n"),
    );
  });
});

describe("planDeleteColumn", () => {
  it("removes a middle column and its separator", () => {
    expect(apply(SRC, planDeleteColumn(model(SRC), 1))).toBe(
      ["| a |", "| --- |", "| 1 |"].join("\n"),
    );
  });

  it("removes the first column and keeps the leading pipe", () => {
    expect(apply(SRC, planDeleteColumn(model(SRC), 0))).toBe(
      ["| b |", "| --- |", "| 2 |"].join("\n"),
    );
  });

  it("refuses to delete the only column", () => {
    const src = ["| a |", "| --- |", "| 1 |"].join("\n");
    expect(planDeleteColumn(model(src), 0)).toEqual([]);
  });
});

describe("planSetAlignment", () => {
  it("rewrites only the delimiter cell's colons", () => {
    expect(apply(SRC, planSetAlignment(model(SRC), 0, "center"))).toBe(
      ["| a | b |", "| :---: | --- |", "| 1 | 2 |"].join("\n"),
    );
    expect(apply(SRC, planSetAlignment(model(SRC), 1, "right"))).toBe(
      ["| a | b |", "| --- | ---: |", "| 1 | 2 |"].join("\n"),
    );
  });

  it("keeps a long dash run as long as it was", () => {
    const src = ["| a |", "| ------- |"].join("\n");
    expect(apply(src, planSetAlignment(model(src), 0, "left"))).toBe(
      ["| a |", "| :------- |"].join("\n"),
    );
  });

  it("plans nothing without a delimiter row", () => {
    expect(planSetAlignment(model("| a | b |"), 0, "left")).toEqual([]);
  });
});
