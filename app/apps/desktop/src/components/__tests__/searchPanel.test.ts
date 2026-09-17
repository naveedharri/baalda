// The search result row: what a FILE hit looks like, and the one security
// contract the panel carries.
//
// Like `healthView.test.ts`, this drives React through `react-dom/server` —
// React Testing Library is not a dependency of this workspace — and is written
// in `.ts` with `createElement` because `vitest.config.ts` includes only
// `src/**/*.test.ts`. `SearchHit` is exported from the panel precisely so the
// row can be rendered without the store, the Tauri host or an effect.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The panel module imports both at load time; neither is reachable under vitest.
vi.mock("../../lib/ipc", () => ({
  searchNotes: vi.fn(async () => []),
  onFilesIndexed: vi.fn(async () => () => {}),
}));
vi.mock("../../store", () => ({ useStore: { getState: () => ({}) } }));

import { SearchHit } from "../SearchPanel";
import type { SearchResult } from "../../lib/ipc";

function hit(over: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "1",
    path: "Notes/Alpha.md",
    title: "Alpha",
    snippet: "some <mark>text</mark>",
    kind: "note",
    ext: "md",
    ...over,
  };
}

const render = (result: SearchResult) =>
  renderToStaticMarkup(createElement(SearchHit, { result }));

describe("SearchHit", () => {
  it("badges a file hit with its extension and leaves notes unbadged", () => {
    const file = render(
      hit({ path: "Reports/Q3.docx", kind: "file", ext: "docx", title: "Q3" }),
    );
    expect(file).toContain("Q3.docx");
    expect(file).toContain("search-ext");
    expect(file).toContain(">docx<");

    // `noteLabel` drops a note's `.md`; a binary keeps its extension, which is
    // half of what tells the two apart at a glance.
    const note = render(hit());
    expect(note).toContain(">Alpha<");
    expect(note).not.toContain("search-ext");
  });

  it("falls back to a generic tag when the path has no extension", () => {
    const out = render(hit({ path: "Archive/readme", kind: "file", ext: null }));
    expect(out).toContain(">file<");
  });

  it("renders the Rust snippet as HTML, which only <mark> survives", () => {
    // Rust escapes the body and then puts its own sentinels back as <mark>
    // (index.rs `mark_snippet`), so anything else arrives already escaped —
    // including text pulled out of a binary, whose control characters
    // `extract.rs` strips so they cannot forge a tag.
    const out = render(
      hit({
        kind: "file",
        ext: "csv",
        path: "data.csv",
        snippet: "totals <mark>marmalade</mark> &lt;script&gt;alert(1)&lt;/script&gt;",
      }),
    );
    expect(out).toContain("<mark>marmalade</mark>");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });
});
