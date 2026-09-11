import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the ipc module so importing seed.ts doesn't pull in `@tauri-apps/api`
// (unavailable in the Node test env). We only need writeNote here.
vi.mock("../../ipc", () => ({ writeNote: vi.fn(async () => {}) }));

import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import {
  STARTER_NOTES,
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

  it("writes the full interlinked starter set, welcome note first", async () => {
    const path = await seedWelcomeContent();
    expect(path).toBe(WELCOME_NOTE_PATH);

    const written = writeNote.mock.calls.map((c) => c[0]);
    // Every note in the starter set is written, in declared order.
    expect(written).toEqual(STARTER_NOTES.map((n) => n.path));
    expect(written[0]).toBe(WELCOME_NOTE_PATH);
    expect(written.length).toBe(18);
    // No starter note begins with a `# Title`: the file name IS the title (the
    // editor's inline title shows it), so a heading would duplicate it.
    expect(writeNote.mock.calls[0][1]).toMatch(/^Baalda is your/);
    for (const [, body] of writeNote.mock.calls) expect(body).not.toMatch(/^# /);
  });

  it("every wikilink target resolves to another starter note (no dangling links)", () => {
    // Basenames the starter set defines (how links resolve — see resolve_all_links).
    const basenames = new Set(
      STARTER_NOTES.map((n) => n.path.replace(/^.*\//, "").replace(/\.md$/, "")),
    );
    for (const note of STARTER_NOTES) {
      // `[[Target]]` / `[[Target|alias]]` — mirror the Rust WIKILINK_RE
      // (`[^\]\n]+`, so a bare `[[` syntax hint on its own line never matches).
      for (const m of note.body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
        const target = m[1].split("|")[0].split("#")[0].trim();
        // Skip the literal syntax examples like `[[wikilink]]` shown in prose.
        if (/^wikilinks?$/i.test(target)) continue;
        expect(basenames, `${note.path} → [[${target}]]`).toContain(target);
      }
    }
  });

  it("returns null (never throws) when a write fails", async () => {
    writeNote.mockRejectedValueOnce(new Error("disk full"));
    await expect(seedWelcomeContent()).resolves.toBeNull();
  });
});
