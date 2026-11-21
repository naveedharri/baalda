// @vitest-environment jsdom
// Fix… → Use team version replaces the skill in EVERY AI tool folder in one
// click (it used to fix one per click), with a spinner while it works.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ release: (() => {}) as () => void }));
const replaceNameTakenSkill = vi.hoisted(() => vi.fn(() => new Promise<void>((r) => (h.release = r))));
const results = vi.hoisted(() => [
  { orgId: "o1", skillId: "s1", name: "roaster", target: "claude", state: "conflict", conflict: "other_owner" },
  { orgId: "o1", skillId: "s1", name: "roaster", target: "agents", state: "conflict", conflict: "other_owner" },
]);
vi.mock("../../../lib/skills/syncHost", () => ({
  applyTeamSkillVersion: vi.fn(),
  checkSkillsNow: vi.fn(),
  getSkillsDeviceState: () => ({ results, targets: [] }),
  isSkillOnThisDevice: () => true,
  keepMySkill: vi.fn(),
  replaceNameTakenSkill,
  quietNextAdd: vi.fn(),
  setSkillOnThisDevice: vi.fn(),
  useSkillsDeviceState: () => ({ results, targets: [] }),
}));
vi.mock("../../../lib/skills/prefs", () => ({
  loadSkillsPrefs: () => ({ targets: { claude: true, agents: true } }),
  onSkillsPrefsChanged: () => () => {},
}));
vi.mock("../../../lib/skills/deviceScan", () => ({ useDeviceScan: () => ({ status: "loading" }) }));
vi.mock("../../../lib/ipc", () => ({ revealInFileManager: vi.fn(), revealLabel: () => "Reveal in Finder" }));
vi.mock("../../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../../../store", () => ({ useStore: (sel: (s: { serverUrl: string }) => unknown) => sel({ serverUrl: "http://x" }) }));

import { InstallControl } from "../SkillAvailability";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Fix… Use team version", () => {
  let root: Root;
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("replaces both folders in one click and shows a spinner meanwhile", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const skill = { id: "s1", name: "roaster", delivery: "required", myAccess: "required" } as never;
    await act(async () => root.render(createElement(InstallControl, { orgId: "o1", skill, canManage: false })));
    const fix = document.querySelector(".skills-fix-btn") as HTMLButtonElement;
    expect(fix.textContent).toContain("Fix");
    await act(async () => fix.click());
    const team = [...document.querySelectorAll('[role="menuitem"]')].find((li) => li.textContent?.includes("Use team version")) as HTMLElement;
    await act(async () => team.click());
    expect(replaceNameTakenSkill).toHaveBeenCalledTimes(1);
    expect(replaceNameTakenSkill).toHaveBeenCalledWith("o1", "s1", ["claude", "agents"]);
    const busy = document.querySelector(".skills-fix-btn") as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toContain("Replacing");
    expect(busy.querySelector(".btn-spinner")).not.toBeNull();
    await act(async () => h.release());
    expect((document.querySelector(".skills-fix-btn") as HTMLButtonElement).disabled).toBe(false);
  });
});
