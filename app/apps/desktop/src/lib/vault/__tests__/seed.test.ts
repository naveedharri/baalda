import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the ipc module so importing seed.ts doesn't pull in `@tauri-apps/api`
// (unavailable in the Node test env). We only need writeNote here.
vi.mock("../../ipc", () => ({ writeNote: vi.fn(async () => {}) }));

import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import {
  WELCOME_NOTE_PATH,
  seedWelcomeContent,
  vaultIsEmpty,
} from "../seed";

const writeNote = vi.mocked(ipc.writeNote);

function dir(children: TreeNode[]): TreeNode {
  return { id: "root", name: "", path: "", isDir: true, children };
}
function note(path: string): TreeNode {
  return { id: path, name: path, path, isDir: false };
}

describe("vaultIsEmpty", () => {
  it("is true for a vault with no children", () => {
    expect(vaultIsEmpty(dir([]))).toBe(true);
    expect(vaultIsEmpty({ id: "r", name: "", path: "", isDir: true })).toBe(true);
  });

  it("is false once any note or folder exists", () => {
    expect(vaultIsEmpty(dir([note("a.md")]))).toBe(false);
    expect(vaultIsEmpty(dir([dir([])]))).toBe(false);
  });
});

describe("seedWelcomeContent", () => {
  beforeEach(() => writeNote.mockClear());

  it("writes a root welcome note plus a Getting Started walkthrough", async () => {
    const path = await seedWelcomeContent();
    expect(path).toBe(WELCOME_NOTE_PATH);

    const written = writeNote.mock.calls.map((c) => c[0]);
    expect(written).toEqual([
      "Welcome.md",
      "Getting Started/How Baalda works.md",
    ]);
    // Welcome note leads with its own H1 (write_note is full-file, no auto title).
    expect(writeNote.mock.calls[0][1]).toMatch(/^# Welcome to Baalda/);
  });

  it("returns null (never throws) when a write fails", async () => {
    writeNote.mockRejectedValueOnce(new Error("disk full"));
    await expect(seedWelcomeContent()).resolves.toBeNull();
  });
});
