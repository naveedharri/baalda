// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalOnlyGroup, PRO_FILES_LINE, RemoteOnlyGroup, placeRows } from "../HealthPlaceGroups";
import type { HealthActions, HealthInventory } from "../../lib/health/types";

let container: HTMLDivElement;
let root: Root;
const actions = {
  syncNow: vi.fn(async () => {}),
  retryLocalFiles: vi.fn(async () => {}),
  deleteLocalFiles: vi.fn(async (paths: string[]) => ({ deleted: paths, failed: [] })),
  downloadFiles: vi.fn(async () => {}),
  removeServerFile: vi.fn(async () => {}),
} as unknown as HealthActions & Record<string, ReturnType<typeof vi.fn>>;

const inventory: HealthInventory = {
  local: { notes: 0, folders: 0, files: 0, total: 0 },
  localReady: true,
  server: { notes: 0, folders: 0, files: 0, total: 0 },
  serverState: "current",
  deviceOnlyNotes: ["b.md", "a.md"],
  deviceOnlyFolders: ["Dir"],
  deviceOnlyFiles: ["z.pdf", "y.png"],
  serverOnlyNotes: ["r.md"],
  serverOnlyFolders: [],
  serverOnlyFiles: ["s.pdf"],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (label: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent === label);
async function click(label: string, scope: ParentNode = container) {
  const b = button(label, scope);
  expect(b, label).toBeDefined();
  await act(async () => b!.click());
}

describe("placeRows", () => {
  it("orders notes, folders, files, alphabetical within each", () => {
    expect(placeRows(["b.md", "a.md"], ["Dir"], ["z.pdf", "y.png"]).map((r) => r.path))
      .toEqual(["a.md", "b.md", "Dir", "y.png", "z.pdf"]);
  });
});

describe("Only on this computer", () => {
  it("puts a checkbox on every row and names the selection in the delete confirm", async () => {
    await act(async () => root.render(createElement(LocalOnlyGroup, {
      inventory, actions, filesBlocked: true, onOpen: vi.fn(), onShow: vi.fn(), stale: false,
    })));
    expect(container.textContent).toContain("Only on this computer · 5 items");
    expect(container.textContent).toContain(PRO_FILES_LINE);
    expect(button("Select files")).toBeUndefined();
    // Notes, folders and files are all selectable.
    for (const p of ["a.md", "b.md", "Dir", "y.png", "z.pdf"]) {
      expect(container.querySelector(`input[aria-label="Select ${p}"]`), p).not.toBeNull();
    }
    expect(button("Delete selected (1)")).toBeUndefined();
    const check = async (p: string) =>
      act(async () => (container.querySelector(`input[aria-label="Select ${p}"]`) as HTMLInputElement).click());
    await check("a.md");
    await check("Dir");
    await check("y.png");
    await click("Delete selected (3)");
    expect(actions.deleteLocalFiles).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Delete 1 note, 1 folder, 1 file from this computer?");
    expect(dialog.textContent).toContain("only on this computer");
    expect(dialog.textContent).toContain("Folders are deleted with everything inside them.");
    await click("Delete", dialog);
    expect(actions.deleteLocalFiles).toHaveBeenCalledWith(["a.md", "Dir", "y.png"]);
  });

  it("leaves out the folder warning when no folder is selected, and Select all picks everything", async () => {
    await act(async () => root.render(createElement(LocalOnlyGroup, {
      inventory, actions, filesBlocked: false, onOpen: vi.fn(), onShow: vi.fn(), stale: false,
    })));
    expect(container.textContent).not.toContain(PRO_FILES_LINE);
    await act(async () => (container.querySelector('input[aria-label="Select b.md"]') as HTMLInputElement).click());
    await click("Delete selected (1)");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Delete 1 note from this computer?");
    expect(dialog.textContent).not.toContain("Folders are deleted");
    await click("Cancel", dialog);
    await click("Select all");
    expect(button("Delete selected (5)")).toBeDefined();
  });
});

describe("Only on the Remote Vault", () => {
  it("selects files only and offers bulk download and removal", async () => {
    await act(async () => root.render(createElement(RemoteOnlyGroup, {
      inventory: { ...inventory, serverOnlyFiles: ["s.pdf", "t.png"] },
      actions, downloadsBlocked: false, showCheckAgain: true, stale: false,
    })));
    expect(container.textContent).toContain("Only on the Remote Vault · 3 items");
    expect(container.querySelector('input[aria-label="Select r.md"]')).toBeNull();
    expect(container.querySelector(".health-place-checkslot")).not.toBeNull();
    await click("Download all");
    expect(actions.downloadFiles).toHaveBeenLastCalledWith(["s.pdf", "t.png"]);
    await act(async () => (container.querySelector('input[aria-label="Select t.png"]') as HTMLInputElement).click());
    await click("Download selected (1)");
    expect(actions.downloadFiles).toHaveBeenLastCalledWith(["t.png"]);
    await act(async () => (container.querySelector('input[aria-label="Select s.pdf"]') as HTMLInputElement).click());
    await click("Remove from server (1)");
    expect(actions.removeServerFile).not.toHaveBeenCalled();
    await click("Remove from server", document.querySelector('[role="alertdialog"]')!);
    expect(actions.removeServerFile).toHaveBeenCalledWith("s.pdf");
  });

  it("uses the shared Pro line and hides downloads when blocked", async () => {
    await act(async () => root.render(createElement(RemoteOnlyGroup, {
      inventory, actions, downloadsBlocked: true, showCheckAgain: false, stale: false,
    })));
    expect(container.textContent).toContain(PRO_FILES_LINE);
    expect(button("Download")).toBeUndefined();
    expect(button("Download all")).toBeUndefined();
    await act(async () => (container.querySelector('input[aria-label="Select s.pdf"]') as HTMLInputElement).click());
    expect(button("Download selected (1)")).toBeUndefined();
    expect(button("Remove from server (1)")).toBeDefined();
  });
});
