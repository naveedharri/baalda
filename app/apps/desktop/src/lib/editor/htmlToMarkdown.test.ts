// @vitest-environment jsdom
//
// The paste path converts a rich `text/html` clipboard (Notion, Google Docs, the
// web) to clean Markdown so raw HTML never lands in the buffer — where it would
// parse into a document-spanning HTMLBlock that live-preview renders as a single
// un-editable widget and traps the caret. These tests pin the conversion.

import { describe, expect, it } from "vitest";
import { htmlClipboardToMarkdown } from "./htmlToMarkdown";

describe("htmlClipboardToMarkdown", () => {
  it("converts headings and paragraphs", () => {
    const md = htmlClipboardToMarkdown(
      "<h1>Title</h1><p>First para.</p><h2>Sub</h2><p>Second para.</p>"
    );
    expect(md).toBe("# Title\n\nFirst para.\n\n## Sub\n\nSecond para.");
  });

  it("converts inline emphasis, code, and links", () => {
    const md = htmlClipboardToMarkdown(
      "<p>Some <strong>bold</strong>, <em>italic</em>, <code>code</code> and a <a href=\"https://ex.com\">link</a>.</p>"
    );
    expect(md).toBe(
      "Some **bold**, *italic*, `code` and a [link](https://ex.com)."
    );
  });

  it("keeps trailing spaces outside emphasis markers", () => {
    const md = htmlClipboardToMarkdown("<p>a <strong>bold </strong>b</p>");
    expect(md).toBe("a **bold** b");
  });

  it("converts nested bullet lists with indentation", () => {
    const md = htmlClipboardToMarkdown(
      "<ul><li>one<ul><li>one-a</li><li>one-b</li></ul></li><li>two</li></ul>"
    );
    expect(md).toBe("- one\n  - one-a\n  - one-b\n- two");
  });

  it("converts ordered lists honoring start", () => {
    const md = htmlClipboardToMarkdown(
      "<ol start=\"3\"><li>third</li><li>fourth</li></ol>"
    );
    expect(md).toBe("3. third\n4. fourth");
  });

  it("converts a table to GFM pipes", () => {
    const md = htmlClipboardToMarkdown(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
    );
    expect(md).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("converts blockquotes", () => {
    const md = htmlClipboardToMarkdown("<blockquote><p>quoted</p></blockquote>");
    expect(md).toBe("> quoted");
  });

  it("preserves code blocks with language", () => {
    const md = htmlClipboardToMarkdown(
      "<pre><code class=\"language-js\">const x = 1;\n</code></pre>"
    );
    expect(md).toBe("```js\nconst x = 1;\n```");
  });

  it("NEVER emits raw HTML tags — the whole point (no cursor-trap)", () => {
    const notion =
      "<div class=\"notion-page\"><h1>Doc</h1><div><p>Hello <b>world</b></p>" +
      "<ul><li>item</li></ul></div><figure><img src=\"x.png\" alt=\"pic\"></figure></div>";
    const md = htmlClipboardToMarkdown(notion);
    expect(md).not.toMatch(/<[a-z]/i);
    expect(md).toContain("# Doc");
    expect(md).toContain("Hello **world**");
    expect(md).toContain("- item");
    expect(md).toContain("![pic](x.png)");
  });

  it("strips script/style content entirely", () => {
    const md = htmlClipboardToMarkdown(
      "<p>safe</p><script>alert(1)</script><style>.x{}</style>"
    );
    expect(md).toBe("safe");
  });

  it("returns empty string for content-free HTML (caller falls back to plain text)", () => {
    expect(htmlClipboardToMarkdown("<meta charset=\"utf-8\">")).toBe("");
    expect(htmlClipboardToMarkdown("")).toBe("");
  });

  it("flattens plain wrapped text to just the text", () => {
    expect(htmlClipboardToMarkdown("<meta charset=\"utf-8\">just text")).toBe(
      "just text"
    );
  });
});
