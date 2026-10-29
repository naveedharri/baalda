import { describe, expect, it, vi } from "vitest";
import {
  createClipboardClearer,
  SENSITIVE_CLIPBOARD_CLEAR_MS,
  SENSITIVE_COPIED_MESSAGE,
  sha256HexOfText,
} from "./clipboard";

/** A fake clipboard + clock: the clearer only sees hashes and `clearIf`. */
function harness() {
  let board: string | null = null;
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  let now = 0;
  const clearIf = vi.fn(async (hash: string) => {
    if (board === null || (await sha256HexOfText(board)) !== hash) return false;
    board = null;
    return true;
  });
  const clearer = createClipboardClearer({
    sha256Hex: sha256HexOfText,
    clearIf,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, live: true };
      timers.push(t);
      return t;
    },
    cancelTimer: (t) => {
      (t as { live: boolean }).live = false;
    },
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers) {
      if (t.live && t.at <= now) {
        t.live = false;
        t.fn();
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    clearer,
    clearIf,
    advance,
    copy: (text: string) => {
      board = text;
    },
    board: () => board,
  };
}

describe("sensitive clipboard clear", () => {
  it("clears the vault key words after 60 s when the clipboard still holds them", async () => {
    const h = harness();
    h.copy("alpha bravo charlie");
    await h.clearer.schedule("alpha bravo charlie");
    await h.advance(SENSITIVE_CLIPBOARD_CLEAR_MS - 1);
    expect(h.board()).toBe("alpha bravo charlie");
    await h.advance(1);
    expect(h.board()).toBeNull();
    expect(h.clearIf).toHaveBeenCalledTimes(1);
  });

  it("leaves the clipboard alone when the person copied something else", async () => {
    const h = harness();
    h.copy("alpha bravo charlie");
    await h.clearer.schedule("alpha bravo charlie");
    h.copy("my grocery list");
    await h.advance(SENSITIVE_CLIPBOARD_CLEAR_MS);
    expect(h.board()).toBe("my grocery list");
  });

  it("a second sensitive copy replaces the first clear (one wipe, 60 s after the latest)", async () => {
    const h = harness();
    h.copy("first words");
    await h.clearer.schedule("first words");
    await h.advance(30_000);
    h.copy("second words");
    await h.clearer.schedule("second words");
    await h.advance(30_000);
    expect(h.clearIf).not.toHaveBeenCalled();
    expect(h.board()).toBe("second words");
    await h.advance(30_000);
    expect(h.clearIf).toHaveBeenCalledTimes(1);
    expect(h.board()).toBeNull();
  });

  it("keeps only a hash while waiting, and a failing native clear is swallowed", async () => {
    const seen: string[] = [];
    let fire: (() => void) | null = null;
    const clearer = createClipboardClearer({
      sha256Hex: sha256HexOfText,
      clearIf: async (hash) => {
        seen.push(hash);
        throw new Error("not under Tauri");
      },
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      cancelTimer: () => {},
    });
    await clearer.schedule("abandon ability able");
    fire!();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([await sha256HexOfText("abandon ability able")]);
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tells the person in the copy toast", () => {
    expect(SENSITIVE_COPIED_MESSAGE).toBe("Copied. Cleared from the clipboard in 60 seconds.");
  });
});
