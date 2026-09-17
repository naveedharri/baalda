// The format registry is the single authority for "what is this file?", so the
// things worth pinning are the ones a drifting table used to get wrong: an
// extension that surfaces in the sidebar but opens nothing, a MIME that cannot
// be turned back into an extension, and the embed form a dropped file takes.

import { describe, expect, it } from "vitest";
import {
  embedMarkdown,
  extForMime,
  FORMATS,
  formatFor,
  isNoteExt,
  isOpenable,
  maxBytesFor,
  mimeForPath,
  NOTE_EXTS,
  OCTET_STREAM,
  SURFACED_EXTS,
  viewerFor,
} from "../formats";

const allExts = FORMATS.flatMap((f) => f.exts);

describe("formatFor", () => {
  it("resolves every registered extension, in any case", () => {
    for (const ext of allExts) {
      expect(formatFor(`file.${ext}`)?.exts, ext).toContain(ext);
      expect(formatFor(`FILE.${ext.toUpperCase()}`)?.exts, ext).toContain(ext);
    }
  });

  it("registers each extension exactly once", () => {
    expect(new Set(allExts).size).toBe(allExts.length);
  });

  it("reads the extension off the file name, not the directory", () => {
    expect(formatFor("a.b/c.png")?.category).toBe("image");
    expect(formatFor("Projects/2026.Q1/notes.md")?.category).toBe("note");
    expect(formatFor("a.md/c")).toBeUndefined();
  });

  it("has no answer for a path with no extension, a dotfile, or a trailing dot", () => {
    expect(formatFor("Makefile")).toBeUndefined();
    expect(formatFor("LICENSE")).toBeUndefined();
    expect(formatFor(".gitignore")).toBeUndefined();
    expect(formatFor("dir/.env")).toBeUndefined();
    expect(formatFor("weird.")).toBeUndefined();
    expect(formatFor("")).toBeUndefined();
  });

  it("does not know file types we never registered", () => {
    expect(formatFor("archive.rar")).toBeUndefined();
    expect(formatFor("app.exe")).toBeUndefined();
  });
});

describe("the table's own invariants", () => {
  // The original bug: `txt`/`markdown`/`mdx`/`canvas` were surfaced in the tree
  // and did nothing when clicked.
  it("never surfaces a format that cannot be opened", () => {
    for (const f of FORMATS) {
      if (f.surface) expect(f.openable, f.exts.join("/")).toBe(true);
    }
  });

  it("keeps SURFACED_EXTS sorted and free of source code", () => {
    expect([...SURFACED_EXTS]).toEqual([...SURFACED_EXTS].sort());
    for (const ext of ["js", "ts", "tsx", "css", "java"]) {
      expect(SURFACED_EXTS, ext).not.toContain(ext);
      expect(isOpenable(`x.${ext}`), ext).toBe(true); // openable, just not listed
    }
  });

  it("keeps the CRDT family and the `syncAs: note` set the same list", () => {
    const syncedAsNotes = FORMATS.filter((f) => f.syncAs === "note").flatMap((f) => f.exts);
    expect(new Set(syncedAsNotes)).toEqual(new Set(NOTE_EXTS));
  });

  it("gives every format a canonical MIME", () => {
    for (const f of FORMATS) expect(f.mimes.length, f.exts.join("/")).toBeGreaterThan(0);
  });
});

describe("mimeForPath / extForMime", () => {
  it("round-trips every canonical MIME", () => {
    for (const f of FORMATS) {
      const mime = f.mimes[0];
      const ext = extForMime(mime);
      expect(ext, mime).toBeDefined();
      expect(mimeForPath(`file.${ext}`), mime).toBe(mime);
    }
  });

  it("answers with the canonical spelling of a shared MIME", () => {
    expect(mimeForPath("a.jpeg")).toBe("image/jpeg");
    expect(extForMime("image/jpeg")).toBe("jpg");
  });

  it("ignores MIME parameters and case", () => {
    expect(extForMime("TEXT/CSV; charset=utf-8")).toBe("csv");
  });

  it("falls back to octet-stream, and has no ext for an unknown MIME", () => {
    expect(mimeForPath("thing.rar")).toBe(OCTET_STREAM);
    expect(mimeForPath("Makefile")).toBe(OCTET_STREAM);
    expect(extForMime("application/x-nonsense")).toBeUndefined();
  });

  it("uses the IANA Office types", () => {
    expect(mimeForPath("a.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mimeForPath("a.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mimeForPath("a.pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });
});

describe("viewerFor", () => {
  it("routes each family to its viewer", () => {
    expect(viewerFor("a.md")).toBe("editor");
    expect(viewerFor("a.txt")).toBe("editor");
    expect(viewerFor("a.html")).toBe("html");
    expect(viewerFor("a.canvas")).toBe("code");
    expect(viewerFor("a.png")).toBe("image");
    expect(viewerFor("a.pdf")).toBe("pdf");
    expect(viewerFor("a.mp4")).toBe("video");
    expect(viewerFor("a.mp3")).toBe("audio");
    expect(viewerFor("a.csv")).toBe("csv");
    expect(viewerFor("a.docx")).toBe("docx");
    expect(viewerFor("a.xlsx")).toBe("xlsx");
    expect(viewerFor("a.json")).toBe("code");
  });

  it("gives an unknown type the card rather than a dead click", () => {
    expect(viewerFor("a.rar")).toBe("card");
    expect(viewerFor("Makefile")).toBe("card");
    expect(viewerFor("a.pptx")).toBe("card");
    expect(viewerFor("a.zip")).toBe("card");
  });
});

describe("embedMarkdown", () => {
  it("uses the ![]() form with the stem as label for images and block embeds", () => {
    expect(embedMarkdown("Holiday photo.png", "/attachments/ab12.png")).toBe(
      "![Holiday photo](/attachments/ab12.png)",
    );
    expect(embedMarkdown("Q3.pdf", "/attachments/cd34.pdf")).toBe("![Q3](/attachments/cd34.pdf)");
    expect(embedMarkdown("demo.mp4", "/attachments/ef56.mp4")).toBe(
      "![demo](/attachments/ef56.mp4)",
    );
    expect(embedMarkdown("rows.csv", "/attachments/07ab.csv")).toBe("![rows](/attachments/07ab.csv)");
  });

  it("uses the []() chip form, keeping the extension, for everything else", () => {
    expect(embedMarkdown("Plan.docx", "/attachments/11aa.docx")).toBe(
      "[Plan.docx](/attachments/11aa.docx)",
    );
    expect(embedMarkdown("bundle.zip", "/attachments/22bb.zip")).toBe(
      "[bundle.zip](/attachments/22bb.zip)",
    );
    // Unknown types are chips too — that is today's behaviour for a bare link.
    expect(embedMarkdown("thing.rar", "/attachments/33cc.rar")).toBe(
      "[thing.rar](/attachments/33cc.rar)",
    );
    expect(embedMarkdown("Makefile", "/attachments/44dd")).toBe("[Makefile](/attachments/44dd)");
  });

  it("labels by the file name even when handed a path", () => {
    expect(embedMarkdown("Sub/dir/shot.png", "/attachments/55ee.png")).toBe(
      "![shot](/attachments/55ee.png)",
    );
  });
});

describe("maxBytesFor", () => {
  it("gates attachments at the server's 25 MB blob ceiling", () => {
    expect(maxBytesFor("png")).toBe(25 * 1024 * 1024);
    expect(maxBytesFor("mp4")).toBe(25 * 1024 * 1024);
    expect(maxBytesFor(".DOCX")).toBe(25 * 1024 * 1024);
  });

  it("gates notes at MAX_NOTE_BYTES", () => {
    expect(maxBytesFor("md")).toBe(10 * 1024 * 1024);
  });

  it("defaults for an unknown extension", () => {
    expect(maxBytesFor("rar")).toBe(25 * 1024 * 1024);
  });
});

describe("isNoteExt", () => {
  it("accepts the CRDT family, in any case", () => {
    for (const ext of NOTE_EXTS) {
      expect(isNoteExt(`a.${ext}`), ext).toBe(true);
      expect(isNoteExt(`a.${ext.toUpperCase()}`), ext).toBe(true);
    }
  });

  it("rejects everything that syncs as an attachment", () => {
    for (const p of ["a.png", "a.pdf", "a.csv", "a.docx", "a.json", "Makefile", ".gitignore"]) {
      expect(isNoteExt(p), p).toBe(false);
    }
  });
});

describe("transcodeTo", () => {
  it("marks exactly the formats a Linux webview cannot decode", () => {
    const transcoded = FORMATS.filter((f) => f.transcodeTo === "png").flatMap((f) => f.exts);
    expect(new Set(transcoded)).toEqual(new Set(["heic", "heif", "tiff", "tif"]));
  });
});
