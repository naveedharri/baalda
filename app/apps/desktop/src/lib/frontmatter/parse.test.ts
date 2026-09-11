// The spans are the deliverable, not the values: every property edit is a
// replacement of one of them, so an off-by-one here writes into the wrong place
// in someone's file. Each case asserts the offsets, not just the parse.
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { findFrontmatter } from "../editor/frontmatter";
import { parseFrontmatter, type ParseResult } from "./parse";

function parse(src: string): ParseResult {
  const doc = Text.of(src.split("\n"));
  const fm = findFrontmatter(doc);
  if (!fm) throw new Error("no frontmatter in fixture");
  return parseFrontmatter(doc, fm);
}

/** The slice a planner would replace, so a span assertion reads literally. */
function slice(src: string, span: { from: number; to: number }): string {
  return src.slice(span.from, span.to);
}

describe("parseFrontmatter — accepted shapes", () => {
  it("reads a plain scalar with exact spans", () => {
    const src = "---\nstatus: draft\n---\nBody.";
    const r = parse(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0]!;
    expect(e.key).toBe("status");
    expect(slice(src, e.keySpan)).toBe("status");
    expect(slice(src, e.valueSpan)).toBe(" draft");
    expect(slice(src, e.lineSpan)).toBe("status: draft");
    expect(e.value).toEqual({ kind: "text", value: "draft" });
    expect(e.raw).toBe(" draft");
  });

  it("classifies numbers, checkboxes, dates and datetimes", () => {
    const r = parse(
      [
        "---",
        "count: 12",
        "ratio: -1.5",
        "code: 007",
        "done: true",
        "due: 2026-09-11",
        "at: 2026-09-11T08:30:00Z",
        "---",
        "",
      ].join("\n"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.value)).toEqual([
      { kind: "number", value: 12 },
      { kind: "number", value: -1.5 },
      // A leading zero is a code, not a number — turning it into one would
      // silently rewrite the file on the next edit.
      { kind: "text", value: "007" },
      { kind: "checkbox", value: true },
      { kind: "date", value: "2026-09-11" },
      { kind: "datetime", value: "2026-09-11T08:30:00Z" },
    ]);
  });

  it("reads a flow list and keeps its style", () => {
    const src = "---\ntags: [youtube, ai]\n---\n";
    const r = parse(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.entries[0]!;
    expect(e.value).toEqual({ kind: "list", value: ["youtube", "ai"] });
    expect(e.listStyle).toBe("flow");
    expect(slice(src, e.valueSpan)).toBe(" [youtube, ai]");
  });

  it("reads a block list, spanning its item lines", () => {
    const src = "---\ntags:\n  - youtube\n  - ai\n---\nBody.";
    const r = parse(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.entries[0]!;
    expect(e.value).toEqual({ kind: "list", value: ["youtube", "ai"] });
    expect(e.listStyle).toBe("block");
    expect(e.listIndent).toBe("  ");
    expect(slice(src, e.valueSpan)).toBe("\n  - youtube\n  - ai");
    expect(slice(src, e.lineSpan)).toBe("tags:\n  - youtube\n  - ai");
  });

  it("reads an unindented block list too", () => {
    const r = parse("---\ntags:\n- a\n- b\n---\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]!.value).toEqual({ kind: "list", value: ["a", "b"] });
    expect(r.entries[0]!.listIndent).toBe("");
  });

  it("reads an empty value as empty text, spanning the line's tail", () => {
    const src = "---\nstatus:\n---\n";
    const r = parse(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.entries[0]!;
    expect(e.value).toEqual({ kind: "text", value: "" });
    expect(slice(src, e.valueSpan)).toBe("");
    expect(e.valueSpan.from).toBe(src.indexOf("status:") + "status:".length);
  });

  it("unquotes strings and keeps a colon inside one", () => {
    const src = '---\ntitle: "Notes: a sequel"\nother: \'it\'\'s fine\'\n---\n';
    const r = parse(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]!.value).toEqual({ kind: "text", value: "Notes: a sequel" });
    expect(slice(src, r.entries[0]!.valueSpan)).toBe(' "Notes: a sequel"');
    expect(r.entries[1]!.value).toEqual({ kind: "text", value: "it's fine" });
  });

  it("skips comment lines and stops a value at a trailing comment", () => {
    const src = "---\n# a note\nstatus: draft # why\n---\n";
    const r = parse(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toHaveLength(1);
    expect(slice(src, r.entries[0]!.valueSpan)).toBe(" draft");
  });

  it("handles an empty block and a CRLF document", () => {
    const empty = parse("---\n---\nBody.");
    expect(empty).toEqual({ ok: true, entries: [] });
    const crlf = parse("---\r\nstatus: draft\r\n---\r\nBody.");
    expect(crlf.ok).toBe(true);
    if (!crlf.ok) return;
    expect(crlf.entries[0]!.value).toEqual({ kind: "text", value: "draft" });
  });

  it("reads an empty flow list as no items", () => {
    const r = parse("---\ntags: []\n---\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]!.value).toEqual({ kind: "list", value: [] });
  });
});

describe("parseFrontmatter — refusals (the panel never writes these)", () => {
  const cases: Array<[string, string]> = [
    ["nested", "---\nmeta:\n  author: me\n---\n"],
    ["nested", "---\ntags:\n  - k: v\n---\n"],
    ["unsupported-scalar", "---\nbody: |\n  a block scalar\n---\n"],
    ["unsupported-scalar", "---\nref: &anchor\n---\n"],
    ["duplicate-key", "---\nstatus: a\nstatus: b\n---\n"],
    ["malformed", "---\nno colon here\n---\n"],
    ["malformed", "---\n\tstatus: a\n---\n"],
    ["malformed", "---\n- orphan item\n---\n"],
  ];
  for (const [reason, src] of cases) {
    it(`refuses with "${reason}": ${JSON.stringify(src.split("\n")[1])}`, () => {
      expect(parse(src)).toEqual({ ok: false, reason });
    });
  }
});
