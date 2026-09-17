// @vitest-environment jsdom
//
// What an `![alt](src)` becomes when `src` is NOT an image.
//
// Before the format registry this was a two-way ternary — PDF or <img> — so a
// note that embedded a video, a spreadsheet or a `.docx` rendered a broken
// image: the note claimed a file was there and showed a torn page. Every one of
// these is an INLINE replace widget that merely reads as a block, so none may
// carry `cm-block-inset` (the class is for real block decorations, which are
// siblings of `.cm-line` and miss its inset; an inline widget already has it,
// and a second copy double-indents it).

import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

// The chip and the CSV table reach for the vault through IPC; jsdom has no
// Tauri, and a rejected stat must not be the reason a widget fails to render.
vi.mock("../ipc", () => ({
  openExternal: vi.fn(),
  fileStat: vi.fn(async () => ({ size: 4_200_000, modified: null })),
  readBinaryFile: vi.fn(async () => new TextEncoder().encode("a,b\n1,2\n")),
}));

import { createEditorState } from "./index";
import { setFocused } from "./reveal";

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({
      doc,
      getTitles: () => [],
      onNavigate: () => {},
    } as never),
    parent,
  });
}

describe("live-preview embeds by format", () => {
  it("renders a video embed as a <video controls>", () => {
    const view = mount("Before.\n\n![clip](/attachments/x.mp4)\n");
    const el = view.contentDOM.querySelector("video.cm-md-video") as HTMLVideoElement;
    expect(el).not.toBeNull();
    expect(el.controls).toBe(true);
    // A note full of clips must cost a few headers, not a few hundred MB.
    expect(el.preload).toBe("metadata");
    expect(el.classList.contains("cm-block-inset")).toBe(false);
    view.destroy();
  });

  it("renders an audio embed as an <audio controls>", () => {
    const view = mount("![song](/attachments/x.mp3)\n");
    const el = view.contentDOM.querySelector("audio.cm-md-audio") as HTMLAudioElement;
    expect(el).not.toBeNull();
    expect(el.controls).toBe(true);
    expect(el.classList.contains("cm-block-inset")).toBe(false);
    view.destroy();
  });

  it("renders a CSV embed as a table host", () => {
    const view = mount("![rows](/attachments/x.csv)\n");
    const el = view.contentDOM.querySelector(".cm-md-csv");
    expect(el).not.toBeNull();
    expect(el!.classList.contains("cm-block-inset")).toBe(false);
    view.destroy();
  });

  it("renders anything else as a named file chip, not a broken image", () => {
    const view = mount("![report](/attachments/x.docx)\n");
    const chip = view.contentDOM.querySelector(".cm-md-file-chip");
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".cm-md-file-chip-name")?.textContent).toBe("x.docx");
    expect(chip!.classList.contains("cm-block-inset")).toBe(false);
    expect(view.contentDOM.querySelector("img.cm-md-img")).toBeNull();
    view.destroy();
  });

  it("still renders an image as an inline <img> and a PDF as a framed embed", () => {
    const img = mount("![photo](/attachments/x.png)\n");
    expect(img.contentDOM.querySelector("img.cm-md-img")).not.toBeNull();
    img.destroy();
    const pdf = mount("![spec](/attachments/x.pdf)\n");
    expect(pdf.contentDOM.querySelector(".cm-md-pdf")).not.toBeNull();
    pdf.destroy();
  });

  it("gives an unknown extension the chip too — never a dead render", () => {
    const view = mount("![thing](/attachments/x.xyzzy)\n");
    expect(view.contentDOM.querySelector(".cm-md-file-chip")).not.toBeNull();
    view.destroy();
  });

  it("shows the source again when the caret is on the embed", () => {
    // The TOKEN-scope reveal rule is the whole feel of the editor; a new widget
    // must not become a construct you cannot edit.
    const view = mount("![clip](/attachments/x.mp4)\n");
    view.dispatch({ effects: setFocused.of(true) });
    view.dispatch({ selection: { anchor: 3 } });
    expect(view.contentDOM.querySelector("video.cm-md-video")).toBeNull();
    view.destroy();
  });
});
