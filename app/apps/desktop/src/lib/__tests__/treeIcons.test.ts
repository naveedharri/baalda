// The sidebar glyph for a file, derived from the format registry.
//
// A vault that holds videos, spreadsheets and archives alongside notes is
// unreadable when every row is the same page icon, and a wrong glyph is a
// quiet lie — this is the pure half of that mapping (the JSX lives with
// `FileTree`, which has no React test harness; see docs/INTERACTIONS.md).

import { describe, expect, it } from "vitest";
import { FORMATS } from "../formats";
import { iconKeyForPath } from "../treeIcons";

describe("iconKeyForPath", () => {
  it("maps each family to its glyph", () => {
    expect(iconKeyForPath("Notes/Idea.md")).toBe("file");
    expect(iconKeyForPath("Notes/List.txt")).toBe("file");
    expect(iconKeyForPath("page.html")).toBe("html");
    expect(iconKeyForPath("page.HTM")).toBe("html");
    expect(iconKeyForPath("a/b/photo.JPG")).toBe("image");
    expect(iconKeyForPath("spec.pdf")).toBe("pdf");
    expect(iconKeyForPath("budget.xlsx")).toBe("sheet");
    expect(iconKeyForPath("rows.csv")).toBe("sheet");
    expect(iconKeyForPath("rows.tsv")).toBe("sheet");
    expect(iconKeyForPath("report.docx")).toBe("doc");
    expect(iconKeyForPath("deck.pptx")).toBe("slides");
    expect(iconKeyForPath("clip.mp4")).toBe("media");
    expect(iconKeyForPath("song.mp3")).toBe("media");
    expect(iconKeyForPath("bundle.zip")).toBe("archive");
    expect(iconKeyForPath("data.json")).toBe("code");
    expect(iconKeyForPath("board.canvas")).toBe("code");
    expect(iconKeyForPath("script.py")).toBe("code");
  });

  it("falls back to the page icon for anything unknown", () => {
    // A row can only exist for a surfaced type, but the tree also shows what a
    // pull materialised, and an unknown extension must never crash a render.
    expect(iconKeyForPath("Makefile")).toBe("file");
    expect(iconKeyForPath(".gitignore")).toBe("file");
    expect(iconKeyForPath("archive.tar.zst")).toBe("file");
  });

  it("answers for every surfaced format — no row can be glyph-less", () => {
    for (const format of FORMATS) {
      if (!format.surface) continue;
      for (const ext of format.exts) {
        expect(iconKeyForPath(`file.${ext}`), ext).toBeTruthy();
      }
    }
  });
});
