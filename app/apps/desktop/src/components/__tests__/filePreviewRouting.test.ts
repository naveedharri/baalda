// @vitest-environment jsdom
//
// The router from a path to a viewer (`FilePreview`), and the card every
// failure falls back to.
//
// The invariant under test is the one the whole format work exists to
// establish: EVERY openable path opens into something, and nothing is ever a
// dead click. So there is one assertion per `ViewerKind` — the leaf marks
// itself with `data-viewer`, which is all this suite knows about it — plus the
// two ends of the fallback chain: a type the registry has never heard of, and
// a media file this engine cannot decode.
//
// Written in `.ts` with `createElement` (no JSX, no React Testing Library —
// neither is available here; `vitest.config.ts` includes only
// `src/**/*.test.ts`), following `healthView.test.ts`. Unlike that one this
// needs a real DOM: the leaves are `React.lazy`, so the tree has to mount and
// settle before there is anything to assert on.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fileStat = vi.fn(async () => ({ size: 1234, modified: null }));
const readBinaryFile = vi.fn(async () => new TextEncoder().encode("a,b\n1,2"));
const openInFileManager = vi.fn(async () => {});
const revealInFileManager = vi.fn(async () => {});

vi.mock("../../lib/ipc", () => ({
  fileStat: (...a: unknown[]) => fileStat(...(a as [])),
  readBinaryFile: (...a: unknown[]) => readBinaryFile(...(a as [])),
  openInFileManager: (...a: unknown[]) => openInFileManager(...(a as [])),
  revealInFileManager: (...a: unknown[]) => revealInFileManager(...(a as [])),
  revealLabel: () => "Reveal in Finder",
  readNote: async () => "<p>hi</p>",
  writeNote: async () => {},
  onFileChanged: async () => () => {},
}));

// The store is read two ways — a selector in `FilePreview`, `getState()` in the
// leaves — so the fake answers both.
const state = { vault: { path: "/Vault", epoch: 1 } };
vi.mock("../../store", () => ({
  useStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
    getState: () => state,
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));

// The two converter packages: the routing test cares that the leaf mounted,
// not that a real docx parsed, and loading them for real would pull jszip and
// an XML DOM into a jsdom run.
vi.mock("mammoth", () => ({
  default: { convertToHtml: async () => ({ value: "<p>doc</p>", messages: [] }) },
}));
vi.mock("read-excel-file/browser", () => ({
  default: async () => [{ sheet: "Sheet1", data: [["a", "b"]] }],
}));

const { FilePreview } = await import("../FilePreview");
const { FileCard } = await import("../viewers/FileCard");

// Warm every lazy leaf before the first render. They are `React.lazy` in the
// app for the code split, and in a test that only means each one resolves some
// unpredictable number of ticks after mount; importing them here puts them in
// the module registry so a couple of flushes is always enough.
await Promise.all([
  import("../viewers/VideoView"),
  import("../viewers/AudioView"),
  import("../viewers/CsvView"),
  import("../viewers/CodeView"),
  import("../viewers/DocxView"),
  import("../viewers/XlsxView"),
]);

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // jsdom answers "" to every `canPlayType` (it has no decoders at all), which
  // is exactly the signal `VideoView`/`AudioView` read as "this engine can't
  // play it". Say yes by default; the codec test says no explicitly.
  HTMLMediaElement.prototype.canPlayType = () => "maybe";
  // React 19 wants this flag for `act`.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Mount and let the lazy chunk, its effects and their promises settle. */
async function mount(el: React.ReactElement) {
  await act(async () => {
    root.render(el);
  });
  // Each leaf is two awaits deep (the lazy chunk, then its own effect's IPC),
  // and a resolved-promise flush is not enough to walk a dynamic import — so
  // yield to the macrotask queue a few times.
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const viewerOf = () => host.querySelector("[data-viewer]")?.getAttribute("data-viewer") ?? null;

describe("FilePreview routing", () => {
  // One path per ViewerKind the router can reach. `editor` is not here on
  // purpose: that family never gets to FilePreview — `Editor.tsx` keeps it.
  const cases: [string, string][] = [
    ["Pictures/shot.png", "image"],
    ["Docs/contract.pdf", "pdf"],
    ["Media/demo.mp4", "video"],
    ["Media/theme.mp3", "audio"],
    ["Data/rows.csv", "csv"],
    ["Data/config.json", "code"],
    ["Docs/brief.docx", "docx"],
    ["Data/book.xlsx", "xlsx"],
    ["Decks/pitch.pptx", "card"],
  ];

  for (const [path, viewer] of cases) {
    it(`opens ${path} with the ${viewer} viewer`, async () => {
      await mount(createElement(FilePreview, { path }));
      expect(viewerOf()).toBe(viewer);
    });
  }

  it("gives an unknown type the card rather than a dead pane", async () => {
    await mount(createElement(FilePreview, { path: "misc/thing.wat" }));
    expect(viewerOf()).toBe("card");
    expect(host.textContent).toContain("thing.wat");
  });

  it("keeps HtmlView for an .html page", async () => {
    await mount(createElement(FilePreview, { path: "site/index.html" }));
    expect(host.querySelector(".html-view")).not.toBeNull();
  });

  it("falls back to the card when the engine cannot decode the media", async () => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = () => "";
    try {
      await mount(createElement(FilePreview, { path: "Media/clip.webm" }));
      expect(viewerOf()).toBe("card");
      expect(host.textContent).toContain("can't decode");
    } finally {
      HTMLMediaElement.prototype.canPlayType = original;
    }
  });

  it("renders the CSV rows it read", async () => {
    await mount(createElement(FilePreview, { path: "Data/rows.csv" }));
    const headers = [...host.querySelectorAll("th")].map((th) => th.textContent);
    expect(headers).toEqual(["#", "a", "b"]);
    expect(host.textContent).toContain("2 rows");
  });
});

describe("FileCard", () => {
  it("names the file, states its size and offers both OS actions", async () => {
    fileStat.mockResolvedValueOnce({ size: 2 * 1024 * 1024, modified: null });
    await mount(
      createElement(FileCard, { path: "Decks/pitch.pptx", abs: "/Vault/Decks/pitch.pptx" }),
    );
    expect(host.textContent).toContain("pitch.pptx");
    expect(host.textContent).toContain("2.0 MB");

    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Open externally",
      "Reveal in Finder",
    ]);
    await act(async () => {
      buttons[0].click();
    });
    expect(openInFileManager).toHaveBeenCalledWith("/Vault/Decks/pitch.pptx");
    await act(async () => {
      buttons[1].click();
    });
    expect(revealInFileManager).toHaveBeenCalledWith("/Vault/Decks/pitch.pptx");
  });

  it("shows the content hash of an attachment named by one", async () => {
    await mount(
      createElement(FileCard, {
        path: "attachments/0123456789abcdef.zip",
        abs: "/Vault/attachments/0123456789abcdef.zip",
        reason: "Archives open in your file manager.",
      }),
    );
    expect(host.textContent).toContain("0123456789abcdef");
    expect(host.textContent).toContain("Archives open in your file manager.");
  });

  it("still names a file whose stat failed", async () => {
    fileStat.mockRejectedValueOnce(new Error("gone"));
    await mount(createElement(FileCard, { path: "a/b.zip", abs: "/Vault/a/b.zip" }));
    expect(host.textContent).toContain("b.zip");
  });
});
