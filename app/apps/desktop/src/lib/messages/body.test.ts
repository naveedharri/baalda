import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody, parseMessageBody } from "./body";

const html = (text: string) => renderToStaticMarkup(createElement(MessageBody, { text, onOpenLink: () => {} }));

describe("message body", () => {
  it("splits paragraphs on blank lines and breaks single newlines", () => {
    expect(html("One\ntwo\n\nThree")).toBe("<p>One<br/>two</p><p>Three</p>");
  });

  it("renders bold and https links", () => {
    expect(html("Be **careful**. See https://baalda.com/help.")).toBe(
      '<p>Be <b>careful</b>. See <a href="https://baalda.com/help">https://baalda.com/help</a>.</p>',
    );
  });

  it("never injects HTML", () => {
    const out = html('<img src=x onerror="alert(1)"> **<script>x</script>**');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img");
  });

  it("links only https", () => {
    const runs = parseMessageBody("http://a.com javascript:alert(1) https://ok.com").flat();
    expect(runs.filter((r) => r.t === "link").map((r) => (r as { v: string }).v)).toEqual(["https://ok.com"]);
  });
});
