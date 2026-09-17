// @vitest-environment jsdom
//
// Paste routing: which dropped/pasted FILE the app takes (and under which
// extension it stores it), and distinguishing raw HTML *source* (→ a ```html
// preview fence) from prose.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { extForFile, fenceHtml, looksLikeHtmlSource, smartPaste } from "./paste";

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

describe("extForFile", () => {
  it("prefers the MIME, which canonicalises the spelling", () => {
    // A `.jfif` IS a JPEG; storing it under the canonical extension is what
    // keeps one format from having two names in `attachments/`.
    expect(extForFile(new File([], "photo.jfif", { type: "image/jpeg" }))).toBe("jpg");
    expect(extForFile(new File([], "clip.m4v", { type: "video/mp4" }))).toBe("mp4");
  });

  it("falls back to the file NAME, which is all a Finder drag carries", () => {
    // Finder drags routinely arrive with `type: ""`. Asking only about the MIME
    // is what made every non-image drop fall through to CodeMirror, which
    // pastes the file's name as text.
    expect(extForFile(new File([], "report.docx", { type: "" }))).toBe("docx");
    expect(extForFile(new File([], "notes.TXT", { type: "" }))).toBe("txt");
  });

  it("never answers empty, even for a type nothing knows", () => {
    expect(extForFile(new File([], "mystery", { type: "" }))).toBe("bin");
    expect(extForFile(new File([], "mystery", { type: "application/x-thing" }))).toBe("xthing");
  });
});

/** A clipboard/drag payload carrying one File, as the browser shapes it. */
function transferWith(file: File, text = ""): DataTransfer {
  return {
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    files: [file],
    getData: (flavor: string) => (flavor === "text/plain" ? text : ""),
  } as unknown as DataTransfer;
}

function pasteInto(view: EditorView, data: DataTransfer | null, text = ""): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: data ?? { items: [], files: [], getData: () => text },
  });
  view.contentDOM.dispatchEvent(event);
}

describe("smartPaste file handling", () => {
  function mount(save: (b: Uint8Array, ext: string) => Promise<string>) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: EditorState.create({ doc: "", extensions: [smartPaste(save)] }),
      parent,
    });
  }

  it("saves a NON-image file and embeds it as a chip link", async () => {
    const save = vi.fn(async (_b: Uint8Array, ext: string) => `/attachments/abc.${ext}`);
    const view = mount(save);
    pasteInto(view, transferWith(new File([new Uint8Array([1])], "report.docx", { type: "" })));
    await vi.waitFor(() => expect(view.state.doc.toString()).not.toBe(""));
    expect(save).toHaveBeenCalledWith(expect.any(Uint8Array), "docx");
    // `[]()`, not `![]()`: nothing renders a docx inside a note, so the link
    // keeps the extension visible — the name is all the reader gets.
    expect(view.state.doc.toString()).toBe("[report.docx](/attachments/abc.docx)");
    view.destroy();
  });

  it("still embeds an image with the `![]()` form", async () => {
    const save = vi.fn(async (_b: Uint8Array, ext: string) => `/attachments/abc.${ext}`);
    const view = mount(save);
    pasteInto(view, transferWith(new File([new Uint8Array([1])], "shot.png", { type: "image/png" })));
    await vi.waitFor(() => expect(view.state.doc.toString()).not.toBe(""));
    expect(view.state.doc.toString()).toBe("![shot](/attachments/abc.png)");
    view.destroy();
  });

  it("recognises a file by its name when the drag carries no MIME", async () => {
    const save = vi.fn(async (_b: Uint8Array, ext: string) => `/attachments/abc.${ext}`);
    const view = mount(save);
    pasteInto(view, transferWith(new File([new Uint8Array([1])], "clip.mp4", { type: "" })));
    await vi.waitFor(() => expect(view.state.doc.toString()).not.toBe(""));
    expect(save).toHaveBeenCalledWith(expect.any(Uint8Array), "mp4");
    expect(view.state.doc.toString()).toBe("![clip](/attachments/abc.mp4)");
    view.destroy();
  });

  it("leaves a plain-text paste to CodeMirror", () => {
    const save = vi.fn(async () => "/attachments/x.png");
    const view = mount(save);
    pasteInto(view, null, "just some prose");
    // Nothing was saved, and the text landed through CodeMirror's own handler.
    expect(save).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("just some prose");
    view.destroy();
  });
});
