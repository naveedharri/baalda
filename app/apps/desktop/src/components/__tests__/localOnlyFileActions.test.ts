// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalOnlyFileActions } from "../LocalOnlyFileActions";
import type { HealthActions } from "../../lib/health/types";

let container: HTMLDivElement;
let root: Root;
const retryLocalFiles = vi.fn(async (_paths: readonly string[]) => {});
const deleteLocalFiles = vi.fn(async (paths: readonly string[]) => ({
  deleted: [...paths],
  failed: [] as Array<{ path: string; reason: string }>,
}));
const onShow = vi.fn();
const actions = { retryLocalFiles, deleteLocalFiles } as unknown as HealthActions;
const PATHS = ["shots/a.png", "shots/b.png", "shots/c.png"];

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
  await act(async () => root.render(createElement(LocalOnlyFileActions, {
    paths: PATHS, actions, blocked, onShow,
  })));
}
function button(label: string, scope: ParentNode = container) {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent === label);
}
async function click(label: string, scope: ParentNode = container) {
  const b = button(label, scope);
  expect(b).toBeDefined();
  await act(async () => b!.click());
}
async function check(index: number) {
  const box = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index];
  await act(async () => box.click());
}

describe("local-only file controls", () => {
  it("retries every file, or only the selected ones", async () => {
    await render();
    await click("Retry all");
    expect(retryLocalFiles).toHaveBeenLastCalledWith(PATHS);

    await check(0);
    await check(2);
    await click("Retry selected (2)");
    expect(retryLocalFiles).toHaveBeenLastCalledWith(["shots/a.png", "shots/c.png"]);
  });

  it("deletes only after a confirm that says the copy is the only one", async () => {
    await render();
    expect(button("Delete selected")?.disabled).toBe(true);

    await click("Select all");
    await click("Delete selected (3)");
    expect(deleteLocalFiles).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("only copy");
    await click("Delete", dialog);
    expect(deleteLocalFiles).toHaveBeenCalledWith(PATHS);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Deleted 3 files.");
  });

  it("keeps the dialog open and names what failed", async () => {
    deleteLocalFiles.mockResolvedValueOnce({
      deleted: ["shots/a.png"],
      failed: [{ path: "shots/b.png", reason: "Permission denied" }],
    });
    await render();
    await check(0);
    await check(1);
    await click("Delete selected (2)");
    const dialog = container.querySelector('[role="alertdialog"]')!;
    await click("Delete", dialog);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("shots/b.png: Permission denied");
  });

  it("offers no retry when the plan blocks these file types", async () => {
    await render(true);
    expect(button("Retry all")).toBeUndefined();
    expect(container.textContent).toContain("requires Pro");
    await click("Show");
    expect(onShow).toHaveBeenCalledWith("shots/a.png");
  });
});
