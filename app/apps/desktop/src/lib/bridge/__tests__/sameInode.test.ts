// Compare-and-swap egest (#216). Two docs can end up writing ONE file: a moved
// folder left behind as a symbolic link (`Old -> Business/Old`) keeps the old
// doc id mapped at `Old/n.md` while the real file got a new identity at
// `Business/Old/n.md`. The watcher reports only the real path, so the stale doc
// never sees the other doc's writes — and a blind egest from it put its older
// text over the newer file. With the compare-and-swap the stale write is
// refused, the newer file is merged in, and only then is the doc written out.

import { describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../noteBridge";
import type { BridgeIO } from "../types";
import { FakePersistence, sha256Hex } from "./helpers";

/** An in-memory FS where several paths can name one inode, like a symlink. */
class InodeFs {
  private inodes = new Map<number, string>();
  private paths = new Map<string, number>();
  private next = 1;
  writes: Array<{ path: string; result: "written" | "stale" }> = [];

  create(path: string, content: string): void {
    const ino = this.next++;
    this.inodes.set(ino, content);
    this.paths.set(path, ino);
  }
  link(alias: string, target: string): void {
    const ino = this.paths.get(target);
    if (ino === undefined) throw new Error(`no ${target}`);
    this.paths.set(alias, ino);
  }
  get(path: string): string | undefined {
    const ino = this.paths.get(path);
    return ino === undefined ? undefined : this.inodes.get(ino);
  }
  io(persistence: FakePersistence, opts: { cas: boolean }): BridgeIO {
    return {
      readFile: async (p) => {
        const v = this.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFileAtomic: async (p, c, docId, expectedSha) => {
        if (opts.cas && expectedSha != null && sha256Hex(this.get(p) ?? "") !== expectedSha) {
          this.writes.push({ path: p, result: "stale" });
          return "stale";
        }
        const ino = this.paths.get(p);
        if (ino === undefined) this.create(p, c);
        else this.inodes.set(ino, c);
        if (docId) persistence.diskBases.set(docId, sha256Hex(c));
        this.writes.push({ path: p, result: "written" });
        return "written";
      },
      sha256: sha256Hex,
      persistence,
      onError: () => {},
    };
  }
}

const REAL = "Business/Old/n.md";
const LINK = "Old/n.md";
const SEED = "# Plan\n\nfirst line\n";

async function scenario(cas: boolean) {
  const fs = new InodeFs();
  fs.create(REAL, SEED);
  fs.link(LINK, REAL);
  const persistence = new FakePersistence();
  const io = fs.io(persistence, { cas });
  const fresh = await NoteBridge.open(io, { docId: "new-id", path: REAL });
  const stale = await NoteBridge.open(io, { docId: "old-id", path: LINK });

  // The real identity gets the newer text and writes it out.
  fresh.edit((t) => t.insert(t.length, "newer line from the real path\n"));
  await vi.advanceTimersByTimeAsync(300);
  expect(fs.get(REAL)).toContain("newer line from the real path");

  // The stale identity never saw that write (no watcher event names its path)
  // and now egests an edit of its own.
  stale.edit((t) => t.insert(0, "> stale doc edit\n"));
  await vi.advanceTimersByTimeAsync(300);
  // A refused write re-reads the file (150 ms ingest) and writes again (300 ms).
  await vi.advanceTimersByTimeAsync(1000);
  return { fs, fresh, stale };
}

describe("compare-and-swap egest", () => {
  it("two bridges over one inode: the stale doc must not clobber", async () => {
    vi.useFakeTimers();
    try {
      const { fs, fresh, stale } = await scenario(true);
      const onDisk = fs.get(REAL)!;
      // The newer text survives, AND the stale doc's own edit is kept: the
      // refused write merged the file in three-way instead of replacing it.
      expect(onDisk).toContain("newer line from the real path");
      expect(onDisk).toContain("> stale doc edit");
      expect(stale.serialize()).toBe(onDisk);
      expect(fs.writes.filter((w) => w.path === LINK).map((w) => w.result)).toEqual([
        "stale",
        "written",
      ]);
      fresh.destroy();
      stale.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("without the check, the same sequence loses the newer text (the #216 bug)", async () => {
    vi.useFakeTimers();
    try {
      const { fs, fresh, stale } = await scenario(false);
      expect(fs.get(REAL)).not.toContain("newer line from the real path");
      fresh.destroy();
      stale.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an external edit inside the egest window is merged, not overwritten", async () => {
    vi.useFakeTimers();
    try {
      const fs = new InodeFs();
      fs.create("n.md", SEED);
      const persistence = new FakePersistence();
      const bridge = await NoteBridge.open(fs.io(persistence, { cas: true }), {
        docId: "d",
        path: "n.md",
      });
      bridge.edit((t) => t.insert(t.length, "typed\n"));
      // An AI rewrites the heading before the 300 ms egest fires, and its
      // watcher event has not reached the bridge yet.
      fs.create("n.md", SEED.replace("# Plan", "# Plan (edited by AI)"));
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(1000);
      const onDisk = fs.get("n.md")!;
      expect(onDisk).toContain("# Plan (edited by AI)");
      expect(onDisk).toContain("typed");
      expect(bridge.serialize()).toBe(onDisk);
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writeThrough stays unconditional: it fills a file the caller just created", async () => {
    vi.useFakeTimers();
    try {
      const fs = new InodeFs();
      fs.create("n.md", SEED);
      const persistence = new FakePersistence();
      const bridge = await NoteBridge.open(fs.io(persistence, { cas: true }), {
        docId: "d",
        path: "n.md",
      });
      // The registry replaces the file with a 0-byte placeholder behind the
      // bridge's back, then asks it to write its text through.
      fs.create("n.md", "");
      expect(await bridge.writeThrough()).toBe(true);
      expect(fs.get("n.md")).toBe(SEED);
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
