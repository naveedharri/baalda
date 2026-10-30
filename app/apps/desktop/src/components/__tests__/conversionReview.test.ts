import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversionReviewDialog } from "../ConversionReviewDialog";
import {
  candidateDetail,
  candidateTitle,
  kindLabel,
  REVIEW_UNCHECKED_NOTE,
  splitForReview,
} from "../../lib/vaultKeys/conversionReview";

const candidates = [
  { kind: "mcp_token", id: "t1", hash: "h", label: "Claude Desktop", createdBy: "Sara", lastUsedAt: "2026-10-28T10:00:00Z" },
  { kind: "oauth_grant", id: "g1", hash: "h", label: "ChatGPT", createdBy: "Lee", lastUsedAt: null },
  { kind: "public_link", id: "l1", hash: "h", label: "Plans/Q4.md", createdBy: null },
];

describe("conversion review", () => {
  it("names each kind in plain words", () => {
    expect(kindLabel("mcp_token")).toBe("MCP token");
    expect(kindLabel("oauth_grant")).toBe("Claude/ChatGPT connection");
    expect(kindLabel("public_link")).toBe("Public link");
    expect(candidateTitle({ kind: "public_link", id: "x", hash: "h" })).toBe("Public link");
    expect(candidateDetail(candidates[0], () => "1d ago")).toBe("MCP token · created by Sara · last used 1d ago");
    expect(candidateDetail(candidates[1], () => "?")).toBe("Claude/ChatGPT connection · created by Lee · never used");
  });

  it("lists every connection, all checked, and says what unchecking means", () => {
    const html = renderToStaticMarkup(
      createElement(ConversionReviewDialog, { candidates, onSubmit: () => {}, onLater: () => {} }),
    );
    for (const name of ["Claude Desktop", "ChatGPT", "Plans/Q4.md", "created by Sara", "Public link"]) {
      expect(html).toContain(name);
    }
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(3);
    expect(html).toContain(REVIEW_UNCHECKED_NOTE);
    expect(html).toContain("Keep all and continue");
    expect(html).toContain("Not now");
  });

  it("sorts candidates: this device's answers, then the server's record, else undecided", () => {
    const list = [
      { kind: "mcp_token", id: "a", hash: "h" },
      { kind: "mcp_token", id: "b", hash: "h", allowed: true },
      { kind: "mcp_token", id: "c", hash: "h", excluded: true },
      { kind: "mcp_token", id: "d", hash: "h" },
    ];
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    const none = splitForReview(list, undefined, true);
    expect(ids(none.keep)).toEqual(["b"]);
    expect(ids(none.exclude)).toEqual([]);
    expect(ids(none.undecided)).toEqual(["a", "d"]);
    const mine = splitForReview(list, new Map([["mcp_token:a", true], ["mcp_token:d", false], ["mcp_token:c", false]]), true);
    expect(ids(mine.keep)).toEqual(["a", "b"]);
    // "c" is already excluded on the server: not re-sent.
    expect(ids(mine.exclude)).toEqual(["d"]);
    expect(mine.undecided).toEqual([]);
    // Without review support everything not excluded is kept, as before.
    expect(ids(splitForReview(list, undefined, false).keep)).toEqual(["a", "b", "d"]);
  });
});
