import { describe, expect, it } from "vitest";
import { relAssetPath, renderNoteHtml, stripFrontmatter } from "../src/render/note-html.js";

/**
 * The public page's renderer is escape-FIRST: every entity is escaped before
 * any markdown transform runs, so the only tags in the output are the ones the
 * renderer itself generates. These tests pin that property — they are the
 * reason the server can render hostile note content without a sanitizer dep.
 */

const noAssets = { assetUrl: () => null };
const passAssets = { assetUrl: (rel: string) => `/p/tok/a/${rel}` };

describe("renderNoteHtml — hostile input", () => {
  it("escapes raw HTML — a script tag renders as literal text", () => {
    const { bodyHtml } = renderNoteHtml(`<script>alert(1)</script>`, noAssets);
    expect(bodyHtml).not.toContain("<script>");
    expect(bodyHtml).toContain("&#60;script&#62;");
  });

  it("keeps HTML escaped inside code fences and code spans", () => {
    const { bodyHtml } = renderNoteHtml(
      "```\n<img src=x onerror=alert(1)>\n```\nand `<b>inline</b>`",
      noAssets,
    );
    expect(bodyHtml).not.toContain("<img");
    expect(bodyHtml).not.toContain("<b>");
    expect(bodyHtml).toContain("<pre><code>");
  });

  it("refuses javascript:/data: link targets — they stay plain text", () => {
    const { bodyHtml } = renderNoteHtml(
      "[x](javascript:alert(1)) and [y](data:text/html,hi)",
      noAssets,
    );
    expect(bodyHtml).not.toContain("<a ");
    expect(bodyHtml).not.toContain("javascript:alert(1)\" ");
  });

  it("quotes in a link url cannot break out of the href attribute", () => {
    const { bodyHtml } = renderNoteHtml(`[x](https://e.com/"onmouseover="alert(1))`, noAssets);
    expect(bodyHtml).not.toContain('" onmouseover');
  });

  it("digit-bracketed text is not confused with internal placeholders", () => {
    const { bodyHtml } = renderNoteHtml("call `x` at 555 1234 5", noAssets);
    expect(bodyHtml).toContain("555 1234 5");
    expect(bodyHtml).toContain("<code>x</code>");
  });
});

describe("renderNoteHtml — markdown subset", () => {
  it("renders headings, emphasis, lists, quotes, hr", () => {
    const { bodyHtml } = renderNoteHtml(
      "# Title\n\n**bold** and *it* and ~~gone~~\n\n- one\n- two\n  1. nested\n\n> quoted\n\n---",
      noAssets,
    );
    expect(bodyHtml).toContain("<h1>Title</h1>");
    expect(bodyHtml).toContain("<strong>bold</strong>");
    expect(bodyHtml).toContain("<em>it</em>");
    expect(bodyHtml).toContain("<del>gone</del>");
    expect(bodyHtml).toContain("<ul>");
    expect(bodyHtml).toContain("<ol>");
    expect(bodyHtml).toContain("<li>nested</li>");
    expect(bodyHtml).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(bodyHtml).toContain("<hr />");
  });

  it("https links render as anchors with noopener/noreferrer", () => {
    const { bodyHtml } = renderNoteHtml("[site](https://example.com/a?b=1&c=2)", noAssets);
    expect(bodyHtml).toContain('rel="noopener noreferrer"');
    expect(bodyHtml).toContain(">site</a>");
  });

  it("wikilinks (incl. alias and embeds) are inert spans, never anchors", () => {
    const { bodyHtml } = renderNoteHtml("[[Secret Note]] [[a|Alias]] ![[embed.md]]", noAssets);
    expect(bodyHtml).toContain('<span class="wikilink">Secret Note</span>');
    expect(bodyHtml).toContain('<span class="wikilink">Alias</span>');
    expect(bodyHtml).toContain('<span class="wikilink">embed.md</span>');
    expect(bodyHtml).not.toContain("<a ");
  });

  it("renders GFM tables with alignment, header, and safe cells", () => {
    const md = [
      "| Part | Points |",
      "|---|:---:|",
      "| **one** | a · b |",
      "| <script>x</script> | [s](https://e.com) |",
    ].join("\n");
    const { bodyHtml } = renderNoteHtml(md, noAssets);
    expect(bodyHtml).toContain('<div class="md-table"><table>');
    expect(bodyHtml).toContain("<th>Part</th>");
    expect(bodyHtml).toContain('<th style="text-align:center">Points</th>');
    expect(bodyHtml).toContain("<td><strong>one</strong></td>");
    expect(bodyHtml).not.toContain("<script>");
    expect(bodyHtml).toContain('href="https://e.com"');
  });

  it("a table straight after prose is a table, and a lone pipe line is prose", () => {
    const { bodyHtml } = renderNoteHtml("intro line\n| a | b |\n|---|---|\n| 1 | 2 |", noAssets);
    expect(bodyHtml).toContain("<p>intro line</p>");
    expect(bodyHtml).toContain("<td>1</td>");
    const lone = renderNoteHtml("just a | pipe in prose", noAssets).bodyHtml;
    expect(lone).toContain("<p>just a | pipe in prose</p>");
    expect(lone).not.toContain("<table>");
  });

  it("strips frontmatter", () => {
    const { bodyHtml } = renderNoteHtml("---\ntags: [x]\n---\nBody here", noAssets);
    expect(bodyHtml).not.toContain("tags:");
    expect(bodyHtml).toContain("Body here");
  });

  it("rewrites vault-relative images through assetUrl (leading slash included)", () => {
    const { bodyHtml } = renderNoteHtml(
      "![pic](/attachments/ab12.png) ![two](attachments/cd34.jpg)",
      passAssets,
    );
    expect(bodyHtml).toContain('src="/p/tok/a/attachments/ab12.png"');
    expect(bodyHtml).toContain('src="/p/tok/a/attachments/cd34.jpg"');
  });

  it("refuses traversal image paths and renders external images as links", () => {
    const { bodyHtml } = renderNoteHtml(
      "![up](../etc/passwd) ![ext](https://evil.com/x.png)",
      passAssets,
    );
    expect(bodyHtml).not.toContain("<img");
    expect(bodyHtml).toContain('<a href="https://evil.com/x.png"');
  });
});

describe("stripFrontmatter / relAssetPath", () => {
  it("leaves notes without frontmatter alone", () => {
    expect(stripFrontmatter("no frontmatter\n---\nlater")).toBe("no frontmatter\n---\nlater");
  });

  it("relAssetPath normalizes and refuses", () => {
    expect(relAssetPath("/attachments/x.png")).toBe("attachments/x.png");
    expect(relAssetPath("attachments/x.png")).toBe("attachments/x.png");
    expect(relAssetPath("../x.png")).toBeNull();
    expect(relAssetPath("a/../x.png")).toBeNull();
    expect(relAssetPath("https://e.com/x.png")).toBeNull();
    expect(relAssetPath("//host/x.png")).toBeNull();
    expect(relAssetPath("a\\b.png")).toBeNull();
  });
});
