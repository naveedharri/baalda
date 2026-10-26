// The sync host around the pure engine: a server switch must never let a run
// plan one server's manifest against another server's markers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  skillsTargets: vi.fn(),
  skillsScan: vi.fn(),
  skillsInstall: vi.fn(),
  skillsRemove: vi.fn(),
}));
vi.mock("../../ipc", () => ipcMock);
vi.mock("../../serverFeatures", () => ({ serverFeatures: async () => new Set(["skills"]) }));
vi.mock("../../toast", () => ({ toast: vi.fn() }));

import { pauseSkillsSync, startSkillsSync } from "../syncHost";

const OLD = "https://old.test";
const NEW = "https://new.test";

const target = (t: string) => ({ target: t, root: "/r", rootExists: true, toolInstalled: true, detectedTools: [] });
// One of OLD's skills, installed for this user.
const installedOld = {
  name: "a",
  status: "managed",
  marker: { skillId: "s", orgId: "o-old", serverUrl: OLD, userId: "u", name: "a", version: 1, bundleSha256: "h", files: {} },
  editedFiles: [],
};
// NEW's manifest knows nothing of o-old: planned against OLD it would remove `a`.
const newManifest = {
  serverTime: "t",
  orgs: [{ orgId: "o-new", orgName: "N", orgSlug: "n", role: "member", skills: [] }],
};

function apiAt(url: { current: string }, onManifest?: () => void) {
  return {
    getBaseUrl: () => url.current,
    getHealth: vi.fn(),
    getSkillVersion: vi.fn(),
    getSkillsManifest: vi.fn(async () => {
      onManifest?.();
      return newManifest;
    }),
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  ipcMock.skillsTargets.mockResolvedValue([target("claude")]);
  ipcMock.skillsScan.mockResolvedValue([installedOld]);
  ipcMock.skillsInstall.mockResolvedValue({ status: "installed", backupPath: null, detail: null });
  ipcMock.skillsRemove.mockResolvedValue({ status: "removed", backupPath: null });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("skills host across a server switch", () => {
  it("a manifest fetched after the client moved plans nothing", async () => {
    const url = { current: OLD };
    // The switch repoints the shared client while the manifest is in flight.
    const api = apiAt(url, () => {
      url.current = NEW;
    });
    const stop = startSkillsSync({ api: api as never, getServerUrl: () => OLD, userId: "u" });
    await settle();
    expect(api.getSkillsManifest).toHaveBeenCalledTimes(1);
    expect(ipcMock.skillsRemove).not.toHaveBeenCalled();
    expect(ipcMock.skillsInstall).not.toHaveBeenCalled();
    stop();
  });

  it("a paused host starts no run; resuming runs once", async () => {
    const url = { current: OLD };
    const api = apiAt(url);
    // Pause lands before the first run gets past its first check.
    const stop = startSkillsSync({ api: api as never, getServerUrl: () => OLD, userId: "u" });
    const resume = pauseSkillsSync();
    await settle();
    expect(api.getSkillsManifest).not.toHaveBeenCalled();
    resume();
    await settle();
    expect(api.getSkillsManifest).toHaveBeenCalledTimes(1);
    // Same server, a manifest without o-old: our copy is removed as usual.
    expect(ipcMock.skillsRemove).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pause with no host is a no-op", () => {
    expect(() => pauseSkillsSync()()).not.toThrow();
  });
});
