// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingFileActions } from "../MissingFileActions";
import type { HealthActions } from "../../lib/health/types";

let container: HTMLDivElement;
let root: Root;
const downloadFiles = vi.fn(async (_paths: readonly string[]) => {});
const removeServerFile = vi.fn(async (_path: string) => {});
const openUpgrade = vi.fn();
const actions = { downloadFiles, removeServerFile, openUpgrade } as unknown as HealthActions;
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
async function render(blocked = false) {
  await act(async () => root.render(createElement(MissingFileActions, {
    paths: ["a.pdf", "b.pdf"], actions, blocked, showUpgrade: true,
  })));
}
async function click(label: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll("button")].find(b => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
describe("missing-file controls", () => {
  it("downloads one or all selected missing paths", async () => {
    await render();
    await click("Download");
    expect(downloadFiles).toHaveBeenLastCalledWith(["a.pdf"]);
    await click("Download all missing files");
    expect(downloadFiles).toHaveBeenLastCalledWith(["a.pdf", "b.pdf"]);
  });
  it("shows download errors instead of claiming success", async () => {
    downloadFiles.mockRejectedValueOnce(new Error("The server has no bytes for a.pdf"));
    await render();
    await click("Download");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("no bytes for a.pdf");
  });
  it("requires confirmation and displays a deletion permission refusal", async () => {
    removeServerFile.mockRejectedValueOnce(new Error("No write access"));
    await render();
    await click("Remove from server");
    expect(removeServerFile).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("permanently");
    await click("Remove from server", dialog);
    expect(removeServerFile).toHaveBeenCalledWith("a.pdf");
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("No write access");
  });
  it("explains the Pro restriction and offers upgrade without a futile download", async () => {
    await render(true);
    expect(container.textContent).toContain("including files uploaded before the restriction");
    await click("Download");
    expect(downloadFiles).not.toHaveBeenCalled();
    await click("Upgrade to Pro");
    expect(openUpgrade).toHaveBeenCalled();
  });
});
