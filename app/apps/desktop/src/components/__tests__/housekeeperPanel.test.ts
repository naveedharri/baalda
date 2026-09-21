// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { HousekeeperView } from "../HousekeeperPanel";
import { ApiError } from "../../lib/api";
const api = vi.hoisted(() => ({ housekeeperStatus: vi.fn(), housekeeperRepair: vi.fn(), housekeeperSuggest: vi.fn(), housekeeperEdit: vi.fn(), housekeeperDiagnose: vi.fn() }));
vi.mock("../../lib/auth/authManager", () => ({ authManager: { api } }));
vi.mock("../../lib/sync/docSession", () => ({ syncManager: { registry: {} } }));
vi.mock("../../store", () => ({ useStore: vi.fn() }));
let root: Root; let host: HTMLDivElement;
const notes = [{ id: "source", path: "Launch.md", title: "Launch" }];
const diagnostics = { checks: [{ id: "broken-links", count: 1 }], sync: { pending: 0, failed: 0, unsynced: 0 } };
const finding = { id: "broken-links", count: 1, priority: "soon", label: "Review next", title: "Missing links", guidance: "Review targets", action: "review-links" };
const suggestion = { id: "proposal", sourcePath: "Launch.md", targetPath: "Pricing.md", before: "[[Price]]", after: "[[Pricing]]", model: "jev" };
const props = { vaultId: "vault", notes, diagnostics, brokenLinkNotes: [{ path: "Launch.md", docId: "source" }] };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  api.housekeeperStatus.mockResolvedValue({ available: true, provider: "OpenRouter", model: "jev" });
  api.housekeeperDiagnose.mockResolvedValue({ checked: 15, model: "jev", findings: [finding] });
  api.housekeeperSuggest.mockResolvedValue({ considered: 1, remaining: 0, suggestions: [suggestion] });
  api.housekeeperEdit.mockResolvedValue({ revision: "next", undoId: "undo" });
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label)!;
async function render(extra: Partial<Parameters<typeof HousekeeperView>[0]> = {}) { await act(async () => root.render(createElement(HousekeeperView, { ...props, ...extra }))); }
async function click(label: string) { await act(async () => button(label).click()); }
async function preview() { await click("Scan vault"); await click("Review link fixes"); await click("Find a fix"); }
it("starts with a scan, with no fixed repair tools or automatic provider requests", async () => {
  await render();
  expect(button("Scan vault")).toBeDefined();
  expect(host.textContent).not.toContain("Link repair");
  expect(button("Find suggested fixes")).toBeUndefined();
  expect(api.housekeeperDiagnose).not.toHaveBeenCalled();
});
it("local and Free vaults cannot request AI analysis", async () => {
  await render({ vaultId: null });
  expect(api.housekeeperStatus).not.toHaveBeenCalled();
  expect(button("Scan vault")).toBeUndefined();
  api.housekeeperStatus.mockRejectedValue(new ApiError(402, "Pro required"));
  await render();
  expect(button("Scan vault")).toBeUndefined();
  expect(host.textContent).toContain("requires a Pro subscription");
});
it("uses freshly collected evidence before asking the model", async () => {
  const collectDiagnostics = vi.fn().mockResolvedValue(diagnostics);
  await render({ collectDiagnostics }); await click("Scan vault");
  expect(collectDiagnostics).toHaveBeenCalledOnce();
  expect(api.housekeeperDiagnose).toHaveBeenCalledWith("vault", diagnostics);
  expect(button("Find a fix")).toBeUndefined();
  await click("Review link fixes"); expect(button("Find a fix")).toBeDefined();
});
it("model-driven link review, apply and undo remain separate", async () => {
  await render(); await preview();
  expect(api.housekeeperSuggest).toHaveBeenCalledWith("vault", "source", 0, undefined);
  expect(host.querySelector("del")?.textContent).toBe("[[Price]]");
  expect(api.housekeeperEdit).not.toHaveBeenCalled();
  await click("Apply fix"); expect(api.housekeeperEdit).toHaveBeenCalledWith("vault", "apply", "proposal");
  await click("Undo fix"); expect(api.housekeeperEdit).toHaveBeenCalledWith("vault", "undo", "undo");
});
it("does not invent link repair when the model recommends inspection", async () => {
  api.housekeeperDiagnose.mockResolvedValue({ checked: 15, model: "jev", findings: [{ ...finding, action: "inspect" }] });
  const renderFindingDetails = vi.fn(() => createElement("p", null, "Local evidence"));
  await render({ renderFindingDetails }); await click("Scan vault"); await click("Inspect finding");
  expect(host.textContent).toContain("Local evidence"); expect(button("Find a fix")).toBeUndefined();
});
it("stale edits clear the preview", async () => {
  await render(); await preview(); api.housekeeperEdit.mockRejectedValue(new ApiError(409, "Note changed. Scan again."));
  await click("Apply fix"); expect(button("Apply fix")).toBeUndefined(); expect(host.textContent).toContain("Note changed");
});
it("late inference cannot populate another vault", async () => {
  let resolve!: (value: unknown) => void;
  api.housekeeperDiagnose.mockReturnValue(new Promise(r => { resolve = r; }));
  await render(); await click("Scan vault");
  await act(async () => root.render(createElement(HousekeeperView, { ...props, key: "other", vaultId: "other" })));
  await act(async () => resolve({ checked: 15, model: "jev", findings: [finding] }));
  expect(button("Review link fixes")).toBeUndefined();
});
it("recommended repairs recheck Pro and run only when selected", async () => {
  const onDiagnosticAction = vi.fn().mockResolvedValue("Index rebuilt");
  api.housekeeperDiagnose.mockResolvedValue({ checked: 15, model: "jev", findings: [{ ...finding, id: "stale-index", action: "rebuild-index" }] });
  await render({ onDiagnosticAction }); await click("Scan vault");
  expect(onDiagnosticAction).not.toHaveBeenCalled(); await click("Rebuild index");
  expect(onDiagnosticAction).toHaveBeenCalledWith("stale-index", "rebuild-index");
  await click("Scan vault"); api.housekeeperStatus.mockRejectedValue(new ApiError(402, "Pro required")); await click("Rebuild index");
  expect(onDiagnosticAction).toHaveBeenCalledTimes(1);
});

it("prepares a property repair with a loading state and never applies it automatically", async () => {
  let resolve!: (value: unknown) => void;
  api.housekeeperRepair.mockReturnValue(new Promise(r => { resolve = r; }));
  api.housekeeperDiagnose.mockResolvedValue({ checked: 15, model: "jev", findings: [{ ...finding, id: "bad-frontmatter", action: "review-properties" }] });
  await render({ repairNotes: { "bad-frontmatter": [{ path: "Launch.md", docId: "source" }] } });
  await click("Scan vault"); await click("Prepare fixes"); await click("Prepare fix");
  expect(api.housekeeperRepair).toHaveBeenCalledWith("vault", "source", "bad-frontmatter", undefined);
  expect(host.textContent).toContain("Preparing fix…");
  expect(api.housekeeperEdit).not.toHaveBeenCalled();
  await act(async () => resolve({ considered: 1, remaining: 0, suggestions: [{ ...suggestion, label: "Close the properties block" }] }));
  expect(host.textContent).toContain("Close the properties block");
  expect(button("Apply fix")).toBeDefined();
  expect(api.housekeeperEdit).not.toHaveBeenCalled();
});
