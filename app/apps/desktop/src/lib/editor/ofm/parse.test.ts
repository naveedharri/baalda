// The Obsidian-flavoured parser extensions, asserted at the level that matters:
// the SYNTAX TREE. Every decoration in the editor is keyed off node names, so a
// node that is named wrong or never produced is a feature that silently does
// nothing — which is exactly the failure mode `MarkdownParser.configure()` has
// for a duplicate node name (it skips it, without a word).

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { ofmMarkdown } from "./index";

function nodes(doc: string): string[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM, ...ofmMarkdown] })],
  });
  const found: string[] = [];
  syntaxTree(state).iterate({ enter: (n) => void found.push(n.name) });
  return found;
}

/** The document text covered by the first node of that name. */
function textOf(doc: string, name: string): string | null {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM, ...ofmMarkdown] })],
  });
  let out: string | null = null;
  syntaxTree(state).iterate({
    enter: (n) => {
      if (out === null && n.name === name) out = doc.slice(n.from, n.to);
    },
  });
  return out;
}

describe("==highlight==", () => {
  it("parses a highlight with its marks", () => {
    expect(nodes("a ==marked== b")).toContain("Highlight");
    expect(textOf("a ==marked== b", "Highlight")).toBe("==marked==");
  });

  it("refuses a run of three or more equals (setext underlines, `a === b`)", () => {
    expect(nodes("a ===not=== b")).not.toContain("Highlight");
    expect(nodes("Title\n===")).not.toContain("Highlight");
  });

  it("respects flanking: `== x ==` is not emphasis", () => {
    expect(nodes("a == x == b")).not.toContain("Highlight");
  });

  it("leaves ==x== inside an inline code span alone", () => {
    expect(nodes("a `==x==` b")).not.toContain("Highlight");
  });

  it("leaves ==x== inside a fenced code block alone", () => {
    expect(nodes("```\n==x==\n```")).not.toContain("Highlight");
  });

  it("nests inside emphasis", () => {
    const found = nodes("*a ==b== c*");
    expect(found).toContain("Emphasis");
    expect(found).toContain("Highlight");
  });
});

describe("%%comments%%", () => {
  it("parses an inline comment under an OFM-specific node name", () => {
    expect(nodes("text %%aside%% more")).toContain("OfmComment");
    expect(textOf("text %%aside%% more", "OfmComment")).toBe("%%aside%%");
  });

  it("parses a %%-fenced block", () => {
    const doc = "before\n\n%%\nhidden\nlines\n%%\n\nafter";
    expect(nodes(doc)).toContain("OfmCommentBlock");
    expect(textOf(doc, "OfmCommentBlock")).toContain("hidden");
  });

  it("still yields CommentBlock for an HTML comment", () => {
    // The collision guard. @lezer/markdown already owns `Comment`/`CommentBlock`,
    // and `configure()` SILENTLY skips a duplicate node name — so naming ours
    // `Comment` would have left this passing while `%%…%%` quietly never parsed.
    expect(nodes("before\n\n<!-- html comment -->\n\nafter")).toContain("CommentBlock");
  });
});

describe("#tags", () => {
  const isTag = (doc: string) => nodes(doc).includes("Hashtag");

  it("accepts a plain tag and a nested one", () => {
    expect(isTag("a #tag here")).toBe(true);
    expect(textOf("a #nested/tag here", "Hashtag")).toBe("#nested/tag");
  });

  it("accepts a tag that starts with digits but is not all digits", () => {
    expect(isTag("plan #2026goals")).toBe(true);
    expect(isTag("issue #2026")).toBe(false);
  });

  it("accepts a tag in parentheses", () => {
    expect(textOf("see (#tag) there", "Hashtag")).toBe("#tag");
  });

  it("refuses a hash inside a word", () => {
    expect(isTag("foo#bar")).toBe(false);
  });

  it("refuses an ATX heading's hash", () => {
    expect(isTag("# Heading")).toBe(false);
    expect(nodes("# Heading")).toContain("HeaderMark");
  });

  it("refuses a hash inside a code span", () => {
    expect(isTag("a `#tag` b")).toBe(false);
  });
});
