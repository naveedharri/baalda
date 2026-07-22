// @vitest-environment jsdom
//
// Paste routing helpers: distinguishing raw HTML *source* (→ a ```html preview
// fence) from prose, and building a safe fence around it.

import { describe, expect, it } from "vitest";
import { fenceHtml, looksLikeHtmlSource } from "./paste";

describe("looksLikeHtmlSource", () => {
  it("detects a full HTML document", () => {
    expect(
      looksLikeHtmlSource("<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>")
    ).toBe(true);
  });

  it("detects an HTML fragment", () => {
    expect(looksLikeHtmlSource("<div class=\"x\">hello</div>")).toBe(true);
    expect(looksLikeHtmlSource("  <p>indented</p>")).toBe(true);
    expect(looksLikeHtmlSource("<br>")).toBe(true);
    expect(looksLikeHtmlSource("<!-- a comment -->")).toBe(true);
  });

  it("does NOT flag prose that merely contains angle brackets", () => {
    expect(looksLikeHtmlSource("a < b and c > d")).toBe(false);
    expect(looksLikeHtmlSource("email me <at> nowhere")).toBe(false);
    expect(looksLikeHtmlSource("just some text")).toBe(false);
    expect(looksLikeHtmlSource("")).toBe(false);
  });

  it("does NOT flag Markdown that starts with a wikilink or heading", () => {
    expect(looksLikeHtmlSource("[[Welcome]]")).toBe(false);
    expect(looksLikeHtmlSource("# Heading")).toBe(false);
  });
});

describe("fenceHtml", () => {
  it("wraps HTML in a ```html fence", () => {
    expect(fenceHtml("<h1>Hi</h1>")).toBe("```html\n<h1>Hi</h1>\n```");
  });

  it("trims a single trailing newline before closing the fence", () => {
    expect(fenceHtml("<h1>Hi</h1>\n")).toBe("```html\n<h1>Hi</h1>\n```");
  });

  it("uses a longer fence when the source itself contains backticks", () => {
    const src = "<p>```</p>";
    const out = fenceHtml(src);
    expect(out.startsWith("````html\n")).toBe(true);
    expect(out.endsWith("\n````")).toBe(true);
    expect(out).toContain(src);
  });
});
