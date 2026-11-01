import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowLaunchUnlock, LAUNCH_UNLOCK_OFF_KEY, runLaunchUnlock } from "./launchUnlock";

// A remembered password that the server calls wrong (changed elsewhere) must
// not be retried on every launch: each try counts in the shared sign-in
// throttle, and enough launches would lock the person out of signing in.

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe("launch-time password unlock", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  const run = (unlock: (pw: string) => Promise<string>, password = "remembered-pw", userId = "u1") =>
    runLaunchUnlock({ server: "https://api.example.test/", userId, loadPassword: async () => password, unlock });

  it("wrong_password once: never tried again at launch until a manual password sign-in", async () => {
    const unlock = vi.fn(async () => "wrong-password");
    expect(await run(unlock)).toBe("wrong-password");
    expect(await run(unlock)).toBe("skipped");
    expect(await run(unlock)).toBe("skipped");
    expect(unlock).toHaveBeenCalledTimes(1);
    // Device-local, no secret: only the server|user scope is recorded.
    const stored = storage.m.get(LAUNCH_UNLOCK_OFF_KEY) ?? "";
    expect(stored).not.toContain("remembered-pw");
    expect(stored).toContain("u1");

    // Another account on this device is not affected.
    const other = vi.fn(async () => "wrap-current");
    expect(await run(other, "pw", "u2")).toBe("wrap-current");

    // A successful manual sign-in (same server, trailing slash ignored) re-arms it.
    allowLaunchUnlock("https://api.example.test", "u1");
    const ok = vi.fn(async () => "wrap-written");
    expect(await run(ok)).toBe("wrap-written");
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("other outcomes never switch it off; no remembered password makes no call", async () => {
    for (const r of ["unlocked", "wrap-current", "fallback", "unavailable", "error"]) {
      expect(await run(async () => r)).toBe(r);
    }
    expect(storage.m.has(LAUNCH_UNLOCK_OFF_KEY)).toBe(false);
    const unlock = vi.fn(async () => "unlocked");
    expect(await run(unlock, "")).toBe("no-password");
    expect(unlock).not.toHaveBeenCalled();
  });

  it("storage that throws never blocks the unlock", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(await run(async () => "wrong-password")).toBe("wrong-password");
    expect(await run(async () => "unlocked")).toBe("unlocked");
  });
});
