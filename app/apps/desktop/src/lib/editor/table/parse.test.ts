// Table parsing, asserted at exact document offsets.
//
// Spans are the whole contract: every table edit is a replacement of one of
// them, so an off-by-one here writes a cell's text into the pipe beside it.
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parseTable } from "./parse";

const docOf = (src: string) => Text.of(src.split("\n"));
const model = (src: string) => parseTable(docOf(src), 0, src.length);

const SRC = ["| a | b |", "| --- | ---: |", "| 1 | 2 |"].join("\n");

describe("parseTable", () => {
  it("reads header, delimiter and body with trimmed doc-absolute spans", () => {
    const m = model(SRC);
    expect(m.columns).toBe(2);
    expect(m.rows).toHaveLength(1);
    expect(m.header.cells.map((c) => c.raw)).toEqual(["a", "b"]);
    // `| a | b |` — the content spans skip the padding on both sides.
    expect(m.header.cells[0]!.span).toEqual({ from: 2, to: 3 });
    expect(m.header.cells[1]!.span).toEqual({ from: 6, to: 7 });
    expect(m.header.cells[0]!.segment).toEqual({ from: 1, to: 4 });
    expect(m.rows[0]!.cells.map((c) => c.raw)).toEqual(["1", "2"]);
    expect(m.rows[0]!.cells[0]!.span).toEqual({ from: 27, to: 28 });
    expect(m.from).toBe(0);
    expect(m.to).toBe(SRC.length);
  });

  it("reads the alignments off the delimiter row", () => {
    expect(model(SRC).aligns).toEqual([null, "right"]);
    expect(model(["| a |", "| :-: |", "| 1 |"].join("\n")).aligns).toEqual(["center"]);
    expect(model(["| a |", "| :-- |", "| 1 |"].join("\n")).aligns).toEqual(["left"]);
  });

  it("treats `\\|` as a literal pipe, not a separator", () => {
    const src = "| a \\| b | c |\n| --- | --- |";
    const m = model(src);
    expect(m.header.cells.map((c) => c.raw)).toEqual(["a \\| b", "c"]);
    expect(m.header.cells[0]!.span).toEqual({ from: 2, to: 8 });
  });

  it("gives an empty cell a zero-length span inside its padding", () => {
    const m = model("|  | b |\n| --- | --- |");
    expect(m.header.cells.map((c) => c.raw)).toEqual(["", "b"]);
    // One character in, so writing into it reads `| x |`, not `| x|`.
    expect(m.header.cells[0]!.span).toEqual({ from: 2, to: 2 });
  });

  it("makes the leading and trailing pipes optional", () => {
    const m = model("a | b\n--- | ---\n1 | 2");
    expect(m.header.leadingPipe).toBe(false);
    expect(m.header.trailingPipe).toBe(false);
    expect(m.header.cells.map((c) => c.raw)).toEqual(["a", "b"]);
    expect(m.header.cells[0]!.span).toEqual({ from: 0, to: 1 });
    expect(m.rows[0]!.cells.map((c) => c.raw)).toEqual(["1", "2"]);
  });

  it("describes ragged rows instead of repairing them", () => {
    const short = model(["| a | b | c |", "| --- | --- | --- |", "| 1 |"].join("\n"));
    expect(short.columns).toBe(3);
    expect(short.rows[0]!.cells.map((c) => c.raw)).toEqual(["1"]);

    const long = model(["| a | b |", "| --- | --- |", "| 1 | 2 | 3 |"].join("\n"));
    // A cell somebody typed is never dropped, so the widest row sets the count.
    expect(long.columns).toBe(3);
    expect(long.rows[0]!.cells.map((c) => c.raw)).toEqual(["1", "2", "3"]);
  });

  it("handles CRLF line endings", () => {
    const doc = Text.of(["| a | b |\r", "| --- | --- |\r", "| 1 | 2 |\r"]);
    const m = parseTable(doc, 0, doc.length);
    expect(m.header.cells.map((c) => c.raw)).toEqual(["a", "b"]);
    expect(m.header.trailingPipe).toBe(true);
    expect(m.rows[0]!.cells.map((c) => c.raw)).toEqual(["1", "2"]);
    // The `\r` is trailing whitespace, so it stays outside the last cell's span.
    expect(m.rows[0]!.cells[1]!.raw).toBe("2");
  });

  it("survives a range with no delimiter row", () => {
    const m = model("| a | b |");
    expect(m.delimiter).toBeNull();
    expect(m.aligns).toEqual([]);
    expect(m.rows).toEqual([]);
  });
});
