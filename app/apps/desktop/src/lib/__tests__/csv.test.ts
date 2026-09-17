// The delimited-text reader behind the CSV/TSV viewer.
//
// Two things are being pinned. The GRAMMAR — quotes, doubled quotes, every
// line ending, ragged rows — because a parser that gets one of those wrong
// does not fail loudly, it silently shows the wrong table. And the CAPS,
// because they are the reason this is hand-rolled at all: a 100 000-row export
// must come back as 2 000 rows plus an honest count, without the parser having
// built the other 98 000.

import { describe, expect, it } from "vitest";
import { delimiterFor, parseDelimited } from "../csv";

describe("delimiterFor", () => {
  it("is a tab only for .tsv", () => {
    expect(delimiterFor("data/report.tsv")).toBe("\t");
    expect(delimiterFor("data/REPORT.TSV")).toBe("\t");
    expect(delimiterFor("data/report.csv")).toBe(",");
    expect(delimiterFor("report")).toBe(",");
  });
});

describe("parseDelimited", () => {
  it("reads plain rows", () => {
    const t = parseDelimited("a,b,c\n1,2,3");
    expect(t.rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    expect(t.totalRows).toBe(2);
    expect(t.totalCols).toBe(3);
    expect(t.truncated).toBe(false);
  });

  it("keeps a comma inside a quoted field", () => {
    const t = parseDelimited('name,note\n"Doe, Jane",hi');
    expect(t.rows[1]).toEqual(["Doe, Jane", "hi"]);
  });

  it("keeps a newline inside a quoted field", () => {
    const t = parseDelimited('a,"line one\nline two",c');
    expect(t.rows).toEqual([["a", "line one\nline two", "c"]]);
    expect(t.totalRows).toBe(1);
  });

  it('collapses "" to one quote', () => {
    const t = parseDelimited('a,"she said ""hi""",c');
    expect(t.rows[0]).toEqual(["a", 'she said "hi"', "c"]);
  });

  it("handles a quoted field that is only quotes", () => {
    expect(parseDelimited('"""",x').rows[0]).toEqual(['"', "x"]);
    expect(parseDelimited('"",x').rows[0]).toEqual(["", "x"]);
  });

  it("treats a bare quote mid-field as a literal", () => {
    // Nothing in RFC 4180 covers `a"b`; Excel writes it and every reader has
    // to show it rather than swallow the rest of the file as a quoted run.
    expect(parseDelimited('a"b,c').rows[0]).toEqual(['a"b', "c"]);
  });

  it("accepts CRLF, LF and a lone CR", () => {
    for (const eol of ["\r\n", "\n", "\r"]) {
      const t = parseDelimited(`a,b${eol}1,2`);
      expect(t.rows).toEqual([
        ["a", "b"],
        ["1", "2"],
      ]);
    }
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseDelimited("a,b\n1,2\n").totalRows).toBe(2);
    expect(parseDelimited("a,b\r\n1,2\r\n").totalRows).toBe(2);
  });

  it("keeps a blank line in the middle as a row", () => {
    // Dropping it would renumber every row after it, and a row number is how
    // someone cross-references the file they opened.
    const t = parseDelimited("a\n\nb");
    expect(t.rows).toEqual([["a"], [""], ["b"]]);
  });

  it("leaves ragged rows ragged", () => {
    const t = parseDelimited("a,b,c\n1\n2,3");
    expect(t.rows).toEqual([["a", "b", "c"], ["1"], ["2", "3"]]);
    expect(t.totalCols).toBe(3);
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseDelimited("﻿a,b").rows[0]).toEqual(["a", "b"]);
  });

  it("splits on tabs for tsv", () => {
    const t = parseDelimited("a\tb\n1\t2", { delimiter: "\t" });
    expect(t.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    // A comma is ordinary content in a tsv.
    expect(parseDelimited("a,x\tb", { delimiter: "\t" }).rows[0]).toEqual(["a,x", "b"]);
  });

  it("takes the rest of the file when a quote is never closed", () => {
    const t = parseDelimited('a,"unterminated\nstill going');
    expect(t.rows).toEqual([["a", "unterminated\nstill going"]]);
  });

  it("returns nothing for an empty file", () => {
    const t = parseDelimited("");
    expect(t.rows).toEqual([]);
    expect(t.totalRows).toBe(0);
    expect(t.truncated).toBe(false);
  });

  it("caps rows while still counting them", () => {
    const rows = 100_000;
    const text = Array.from({ length: rows }, (_, i) => `${i},v${i}`).join("\n");
    const t = parseDelimited(text, { maxRows: 2000, maxCols: 200 });
    expect(t.rows.length).toBe(2000);
    expect(t.totalRows).toBe(rows);
    expect(t.truncated).toBe(true);
    // The kept rows are the FIRST ones, in order — a viewer that showed the
    // last 2 000 would be lying about "showing the first".
    expect(t.rows[0]).toEqual(["0", "v0"]);
    expect(t.rows[1999]).toEqual(["1999", "v1999"]);
    // And nothing past the cap was materialised.
    expect(t.rows.flat().length).toBe(4000);
  });

  it("caps columns while still counting them", () => {
    const wide = Array.from({ length: 500 }, (_, i) => `c${i}`).join(",");
    const t = parseDelimited(wide, { maxCols: 200 });
    expect(t.rows[0].length).toBe(200);
    expect(t.totalCols).toBe(500);
    expect(t.truncated).toBe(true);
  });

  it("is not truncated when the caps are not reached", () => {
    const t = parseDelimited("a,b\n1,2", { maxRows: 2000, maxCols: 200 });
    expect(t.truncated).toBe(false);
  });
});
