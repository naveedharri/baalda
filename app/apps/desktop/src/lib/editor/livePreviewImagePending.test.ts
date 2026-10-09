// @vitest-environment jsdom
//
// A teammate's pasted image arrives as text before its bytes. The embed must
// hold its place with a visible placeholder (never a broken image or a bare
// link) and load as soon as the binary mirror announces the file.

import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

// jsdom has no matchMedia; the store's appearance code asks for it on import.
vi.hoisted(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })) as never;
  }
});

vi.mock("../ipc", () => ({
  openExternal: vi.fn(),
  fileStat: vi.fn(async () => ({ size: 1, modified: null })),
  readBinaryFile: vi.fn(async () => new Uint8Array()),
}));

import { announceAttachmentArrived } from "../attachmentArrivals";
import { createEditorState } from "./index";

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: createEditorState({ doc, getTitles: () => [], onNavigate: () => {} } as never),
    parent,
  });
}

describe("image embed whose file is not here yet", () => {
  it.each([
    "/attachments/2a8962a8b6cb08ae.png",
    "attachments/2a8962a8b6cb08ae.png",
    "./attachments/2a8962a8b6cb08ae.png",
  ])("shows a placeholder, then reloads the image when %s arrives", (src) => {
    const view = mount(`intro\n\n![Screenshot](${src})\n`);
    const img = view.contentDOM.querySelector("img.cm-md-img") as HTMLImageElement;
    expect(img).not.toBeNull();
    const before = img.src;
    img.dispatchEvent(new Event("error"));
    const pending = view.contentDOM.querySelector(".cm-md-img-pending");
    expect(pending?.textContent).toBe("Downloading image…");
    expect(img.style.display).toBe("none");

    announceAttachmentArrived("attachments/other.png");
    expect(img.src).toBe(before);
    announceAttachmentArrived("attachments/2a8962a8b6cb08ae.png");
    expect(img.src).not.toBe(before);
    expect(img.src).toContain("v=");

    img.dispatchEvent(new Event("load"));
    expect(view.contentDOM.querySelector(".cm-md-img-pending")).toBeNull();
    expect(img.style.display).toBe("");
    view.destroy();
  });
});
