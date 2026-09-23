// @vitest-environment jsdom
// The Left-on-disk group's bulk actions: "Re-register all" runs the per-item
// remedy for every file; "Delete all local copies" asks first, naming the count.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthView } from "../HealthTab";
import type { HealthActions, HealthIssue, VaultHealthSnapshot } from "../../lib/health/types";

vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
import { toast } from "../../lib/toast";

let container: HTMLDivElement;
let root: Root;

const actions = {
  reregister: vi.fn(async (_path: string) => {}),
  deleteNote: vi.fn(async (_path: string) => {}),
  syncNow: vi.fn(async () => {}),
  openNote: vi.fn(),
} as unknown as HealthActions & {
  reregister: ReturnType<typeof vi.fn>;
  deleteNote: ReturnType<typeof vi.fn>;
};

function leftBehind(path: string): HealthIssue {
  return {
    key: `orphan:${path}`,
    docId: `doc-${path}`,
    path,
    kind: "left-behind",
    severity: "error",
    title: "Left on disk — not on the Remote Vault",
    why: "Deleted on the server. It was kept here.",
    remedies: ["open", "reveal", "reregister", "export-copy", "delete", "copy-details"],
    code: null,
    explanation: { meaning: "m", next: "n", fixes: [], safety: "only-here" },
    facts: [],
    autoRetries: false,
  };
}

function snapshot(paths: string[]): VaultHealthSnapshot {
  return {
    report: {
      verdict: "attention",
      headline: "h",
      detail: "d",
      stages: [],
      counts: { total: 3, synced: 0, pending: 0, failed: 0, unsynced: 0, unreported: 0 },
      issues: paths.map(leftBehind),
      lastSyncedAt: null,
      serverHost: "api.baalda.com",
    },
    inventory: {
      local: { notes: 3, folders: 0, files: 0, total: 3 },
      localReady: true,
      server: null,
      serverState: "unavailable",
      deviceOnlyNotes: [],
      serverOnlyNotes: [],
      deviceOnlyFolders: [],
      serverOnlyFolders: [],
      deviceOnlyFiles: [],
      serverOnlyFiles: [],
    },
    stats: null,
    statsError: null,
    checks: null,
    log: [],
    loading: false,
    refresh: vi.fn(),
    actions,
  };
}

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

const PATHS = ["Old/a.md", "Old/b.md", "c.md"];

async function render(paths = PATHS) {
  await act(async () =>
    root.render(createElement(HealthView, { snapshot: snapshot(paths), mode: "overview" })),
  );
}
function button(label: string, scope: ParentNode = container) {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent === label);
}
async function click(label: string, scope: ParentNode = container) {
  const b = button(label, scope);
  expect(b).toBeDefined();
  await act(async () => b!.click());
}

describe("Left on disk bulk actions", () => {
  it("re-registers every file through the per-item remedy", async () => {
    await render();
    expect(container.textContent).toContain("3 notes left on disk");
    expect(container.textContent).not.toContain("Left on disk — not on the Remote Vault");
    // The actions sit on the group header, and progress is never painted as a
    // status line inside the list.
    const head = container.querySelector(".health-difference-grouphead")!;
    expect(head.querySelector('[aria-label="Left on disk"]')).not.toBeNull();
    await click("Re-register all");
    expect(actions.reregister.mock.calls.map((c) => c[0])).toEqual(PATHS);
    expect(actions.deleteNote).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Re-registering");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Re-registered 3 files"));
  });

  it("reports each failed item instead of claiming success", async () => {
    actions.reregister.mockImplementation(async (p: string) => {
      if (p === "Old/b.md") throw new Error("vault isn't reconciled yet");
    });
    await render();
    await click("Re-register all");
    expect(actions.reregister).toHaveBeenCalledTimes(3);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Old/b.md");
    expect(alert?.textContent).toContain("vault isn't reconciled yet");
    expect(container.textContent).toContain("Re-registered 2 of 3; 1 failed");
  });

  it("deletes all local copies only after a confirmation that names the count", async () => {
    await render();
    await click("Delete all local copies");
    expect(actions.deleteNote).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Delete 3 local copies?");
    expect(dialog.textContent).toContain("may be the only copies");

    await click("Cancel", dialog);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(actions.deleteNote).not.toHaveBeenCalled();

    await click("Delete all local copies");
    await click("Delete all", document.querySelector('[role="alertdialog"]')!);
    expect(actions.deleteNote.mock.calls.map((c) => c[0])).toEqual(PATHS);
    expect(actions.reregister).not.toHaveBeenCalled();
  });

  it("keeps the per-item actions on each row", async () => {
    await render(["solo.md"]);
    expect(button("Re-register all")).toBeDefined();
    expect(container.querySelectorAll(".health-issue").length).toBe(1);
  });
});

describe("Left on disk progress", () => {
  it("shows the spinner in the pressed button, not a line in the section", async () => {
    let finish!: () => void;
    actions.reregister.mockImplementation(() => new Promise<void>((r) => { finish = r; }));
    await render(["solo.md"]);
    await click("Re-register all");
    const pressed = button("Re-register all")!;
    expect(pressed.getAttribute("aria-busy")).toBe("true");
    expect(pressed.disabled).toBe(true);
    expect(button("Delete all local copies")!.disabled).toBe(true);
    expect(container.textContent).not.toMatch(/Re-registering|of 1…/);
    await act(async () => finish());
  });
});
