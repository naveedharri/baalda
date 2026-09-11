// Every assertion here applies the planned changes to the original text and
// compares the WHOLE result. That is the only way to state the property that
// matters: an edit to one value leaves every other byte — comments, quoting,
// key order, the fences — exactly as it was.
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { findFrontmatter } from "../editor/frontmatter";
import {
  planAddProperty,
  planDeleteProperty,
  planRenameKey,
  planSetValue,
  quoteScalar,
  type SpanChange,
} from "./edit";
import { parseFrontmatter, type PropEntry, type PropValue } from "./parse";

function entries(src: string): PropEntry[] {
  const doc = Text.of(src.split("\n"));
  const fm = findFrontmatter(doc);
  if (!fm) throw new Error("no frontmatter in fixture");
  const r = parseFrontmatter(doc, fm);
  if (!r.ok) throw new Error(`fixture did not parse: ${r.reason}`);
  return r.entries;
}

function entry(src: string, key: string): PropEntry {
  const e = entries(src).find((x) => x.key === key);
  if (!e) throw new Error(`no property ${key}`);
  return e;
}

/** Apply span changes right-to-left so earlier offsets stay valid. */
function apply(src: string, changes: SpanChange[]): string {
  let out = src;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}

const text = (value: string): PropValue => ({ kind: "text", value });
const list = (...value: string[]): PropValue => ({ kind: "list", value });

describe("planSetValue", () => {
  const src = [
    "---",
    "# keep me",
    "title: 'Old name'",
    "tags: [a, b]",
    "count: 3",
    "done: false",
    "---",
    "",
    "Body stays put.",
  ].join("\n");

  it("touches only the edited value", () => {
    const out = apply(src, planSetValue(entry(src, "count"), { kind: "number", value: 9 }));
    expect(out).toBe(src.replace("count: 3", "count: 9"));
  });

  it("keeps a flow list flow", () => {
    const out = apply(src, planSetValue(entry(src, "tags"), list("a", "b", "c")));
    expect(out).toBe(src.replace("tags: [a, b]", "tags: [a, b, c]"));
  });

  it("keeps a block list block, at its own indent", () => {
    const block = "---\ntags:\n  - a\n  - b\n---\nBody.";
    const out = apply(block, planSetValue(entry(block, "tags"), list("a", "c")));
    expect(out).toBe("---\ntags:\n  - a\n  - c\n---\nBody.");
  });

  it("fills an empty value without disturbing the colon", () => {
    const empty = "---\nstatus:\n---\nBody.";
    const out = apply(empty, planSetValue(entry(empty, "status"), text("draft")));
    expect(out).toBe("---\nstatus: draft\n---\nBody.");
  });

  it("clears a value back to a bare key", () => {
    const out = apply(src, planSetValue(entry(src, "title"), text("")));
    expect(out).toBe(src.replace("title: 'Old name'", "title:"));
  });

  it("quotes a wikilink, a colon and an edge space", () => {
    const out = apply(src, planSetValue(entry(src, "title"), text("[[Other Note]]")));
    expect(out).toBe(src.replace("title: 'Old name'", 'title: "[[Other Note]]"'));
    expect(quoteScalar('a "b"')).toBe('"a \\"b\\""');
    const colon = apply(src, planSetValue(entry(src, "title"), text("Notes: a sequel")));
    expect(colon).toContain('title: "Notes: a sequel"');
    const spaced = apply(src, planSetValue(entry(src, "title"), text(" padded ")));
    expect(spaced).toContain('title: " padded "');
  });

  it("writes nothing when the value is unchanged", () => {
    expect(planSetValue(entry(src, "count"), { kind: "number", value: 3 })).toEqual([]);
  });

  it("keeps a trailing comment on the line", () => {
    const commented = "---\nstatus: draft # why\n---\n";
    const out = apply(commented, planSetValue(entry(commented, "status"), text("final")));
    expect(out).toBe("---\nstatus: final # why\n---\n");
  });
});

describe("planRenameKey", () => {
  it("replaces the key token only", () => {
    const src = "---\nstatus: draft\n---\n";
    expect(apply(src, planRenameKey(entry(src, "status"), "state"))).toBe(
      "---\nstate: draft\n---\n",
    );
  });

  it("is a no-op for an unchanged or empty name", () => {
    const src = "---\nstatus: draft\n---\n";
    expect(planRenameKey(entry(src, "status"), "status")).toEqual([]);
    expect(planRenameKey(entry(src, "status"), "  ")).toEqual([]);
  });
});

describe("planDeleteProperty", () => {
  it("removes the line and its newline, leaving the rest byte-identical", () => {
    const src = "---\na: 1\nb: 2\nc: 3\n---\nBody.";
    const doc = Text.of(src.split("\n"));
    expect(apply(src, planDeleteProperty(doc, entry(src, "b")))).toBe(
      "---\na: 1\nc: 3\n---\nBody.",
    );
  });

  it("removes every line of a block list", () => {
    const src = "---\ntags:\n  - a\n  - b\nnext: 1\n---\n";
    const doc = Text.of(src.split("\n"));
    expect(apply(src, planDeleteProperty(doc, entry(src, "tags")))).toBe(
      "---\nnext: 1\n---\n",
    );
  });

  it("leaves an empty block behind when the last property goes", () => {
    const src = "---\nonly: 1\n---\nBody.";
    const doc = Text.of(src.split("\n"));
    expect(apply(src, planDeleteProperty(doc, entry(src, "only")))).toBe(
      "---\n---\nBody.",
    );
  });
});

describe("planAddProperty", () => {
  function add(src: string, key: string, value: PropValue): string {
    const doc = Text.of(src.split("\n"));
    const fm = findFrontmatter(doc);
    const parsed = fm ? parseFrontmatter(doc, fm) : null;
    const list = parsed?.ok ? parsed.entries : [];
    return apply(src, planAddProperty(doc, fm, list, key, value));
  }

  it("appends after the last property", () => {
    expect(add("---\na: 1\n---\nBody.", "b", text("x"))).toBe(
      "---\na: 1\nb: x\n---\nBody.",
    );
  });

  it("appends after a block list's last item", () => {
    expect(add("---\ntags:\n  - a\n---\nBody.", "b", text(""))).toBe(
      "---\ntags:\n  - a\nb:\n---\nBody.",
    );
  });

  it("fills an empty block", () => {
    expect(add("---\n---\nBody.", "a", text("1"))).toBe("---\na: 1\n---\nBody.");
  });

  it("creates the block on a note that has none, without welding the body", () => {
    expect(add("Body text.", "a", text("1"))).toBe("---\na: 1\n---\nBody text.");
  });

  it("creates the block on an empty note with no spurious blank line", () => {
    expect(add("", "a", text(""))).toBe("---\na:\n---\n");
  });
});
