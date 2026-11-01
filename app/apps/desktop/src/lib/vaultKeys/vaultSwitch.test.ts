// Vault switching and the key runtime: A (encrypted) → B (plain) → A keeps A's
// verified key and header, a conversion interrupted by a switch resumes (never
// a second claim run in parallel), "waiting for the key" belongs to the vault
// that waits, background re-share keeps covering A while B is open, a late
// result for A never touches B, and account-wide state survives every switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultKeyState } from "./session";

// localStorage shim: the org → vault map (`forget.ts`) lives there.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const READY: VaultKeyState = { state: "ready", generation: 1 };
const fake = {
  states: new Map<string, VaultKeyState | Deferred<VaultKeyState>>(),
  verified: new Map<string, string>(),
  convert: vi.fn(async (_v: string) => "waiting-ready" as string),
  serviced: [] as string[],
  dispose: vi.fn(),
  created: 0,
};

vi.mock("./session", () => ({
  createVaultKeySession: () => {
    fake.created++;
    return {
      dispose: fake.dispose,
      headerFor: (v: string) => fake.verified.get(v) ?? null,
      ensureAccountKeys: async () => ({ state: "ready", isNew: false }),
      accountKeyCode: async () => "CODE",
      pendingDevices: async () => [],
      adoptFromSecret: async () => "none",
      holdsVaultKey: async (v: string) => fake.verified.has(v),
      ensureVaultKey: async (v: string) => {
        const s = fake.states.get(v) ?? { state: "unkeyed" };
        return "promise" in s ? s.promise : s;
      },
      convertVault: (v: string) => fake.convert(v),
      serviceKeyRequests: async (v: string) => {
        fake.serviced.push(v);
        return { sealed: [], refused: [], keyChanged: [] };
      },
      // The runtime runs requests back to back through this one.
      serviceAllKeyRequests: async (v: string) => {
        fake.serviced.push(v);
        return { sealed: [], refused: [], keyChanged: [] };
      },
      gateVaultOpen: async () => "proceed",
      unlockWithPassword: async () => "unlocked",
    };
  },
}));
vi.mock("./store", () => ({
  keychainVaultKeyStore: () => ({}),
  keychainPinStore: () => ({}),
  getKeychainString: async () => null,
  setKeychainString: async () => {},
  joinSecretName: (s: string) => s,
}));

const rt = await import("./runtime");
const { api } = await import("../auth/authManager");

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("vault switching", () => {
  beforeEach(() => {
    vi.spyOn(api, "getBaseUrl").mockReturnValue("http://switch.test");
    vi.spyOn(api, "getHealth").mockResolvedValue({ ok: true, version: "x", features: ["vault-keys"] } as never);
    vi.spyOn(api, "getMembersOverview").mockResolvedValue({ members: [] } as never);
    fake.states.clear();
    fake.verified.clear();
    fake.serviced.length = 0;
    fake.convert.mockReset().mockResolvedValue("waiting-ready");
    fake.dispose.mockReset();
  });
  afterEach(() => {
    rt.vaultKeysClosed();
    vi.restoreAllMocks();
  });

  it("A (keyed) → B (plain) → A: A's key and header stay, one session, account untouched", async () => {
    fake.states.set("vA", READY);
    fake.verified.set("vA", "S0VZ");
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vA", orgId: "oA" });
    await flush();
    const sessions = fake.created;
    expect(api.vaultKeyFor("vA")).toBe("S0VZ");
    expect(rt.accountKeyStateNow()?.state).toBe("ready");

    rt.vaultKeysClosed();
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vB", orgId: "oB" });
    await flush();
    expect(rt.vaultKeyStateFor("vB")?.state).toBe("unkeyed");
    expect(api.vaultKeyFor("vA")).toBe("S0VZ"); // still sent for A's requests
    expect(api.vaultKeyFor("vB")).toBeNull();
    expect(rt.accountKeyStateNow()?.state).toBe("ready");

    rt.vaultKeysClosed();
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vA", orgId: "oA" });
    await flush();
    expect(rt.vaultKeyStateFor("vA")?.state).toBe("ready");
    expect(api.vaultKeyFor("vA")).toBe("S0VZ");
    expect(fake.created).toBe(sessions); // no new session: no re-prompt
    expect(fake.dispose).not.toHaveBeenCalled();
  });

  it("waiting for a teammate belongs to that vault: leaving it clears the block and says so", async () => {
    const heard: Array<[string, boolean]> = [];
    const off = rt.onVaultKeyBlockChange((v, b) => heard.push([v, b]));
    fake.states.set("vA", { state: "waiting-for-teammate" });
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vA", orgId: "oA" });
    await flush();
    expect(rt.openVaultKeyView("vA")).toEqual({ blocked: true, state: "waiting-for-teammate" });

    rt.vaultKeysClosed();
    expect(heard).toEqual([
      ["vA", true],
      ["vA", false],
    ]);
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vB", orgId: "oB" });
    await flush();
    expect(rt.openVaultKeyView("vB")).toEqual({ blocked: false, state: "unkeyed" });
    expect(rt.isVaultKeyBlocked("vB")).toBe(false);
    off();
  });

  it("a late answer for A after switching to B never blocks B or names B", async () => {
    const lateA = deferred<VaultKeyState>();
    fake.states.set("vA", lateA);
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vA", orgId: "oA" });
    await flush();
    rt.vaultKeysClosed();
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vB", orgId: "oB" });
    const events: string[] = [];
    const off = rt.onVaultKeyEvent((e) => e.kind === "vault" && events.push(`${e.vaultId}:${e.state.state}`));
    lateA.resolve({ state: "waiting-for-teammate" });
    await flush();
    expect(rt.isVaultKeyBlocked("vB")).toBe(false);
    expect(rt.openVaultKeyView("vB").state).toBe("unkeyed");
    // The run queued behind A's still ran for B.
    expect(events).toContain("vB:unkeyed");
    expect(events.filter((e) => e.startsWith("vB")).every((e) => e === "vB:unkeyed")).toBe(true);
    off();
  });

  it("a conversion interrupted by a switch resumes when A reopens, never two runs at once", async () => {
    fake.states.set("vA", { state: "unkeyed", conversionAllowed: true } as VaultKeyState);
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = deferred<string>();
    fake.convert.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const r = await gate.promise;
      inFlight--;
      return r;
    });
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vA", orgId: "oA" });
    await flush();
    expect(fake.convert).toHaveBeenCalledTimes(1);
    rt.vaultKeysClosed();
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vB", orgId: "oB" });
    rt.vaultKeysClosed();
    rt.vaultKeysOpened({ userId: "u1", vaultId: "vA", orgId: "oA" });
    await flush();
    expect(maxInFlight).toBe(1); // the reopen waited for the first run
    gate.resolve("waiting-ready");
    await flush();
    // Reopened A asked again (resume), still one at a time.
    expect(fake.convert.mock.calls.filter(([v]) => v === "vA").length).toBe(2);
    expect(maxInFlight).toBe(1);
  });

  it("background re-share keeps covering A while B is open", async () => {
    fake.states.set("vA", READY);
    fake.verified.set("vA", "S0VZ");
    rt.vaultKeysOpened({ userId: "u2", vaultId: "vA", orgId: "oA" });
    await flush();
    rt.vaultKeysClosed();
    fake.serviced.length = 0;
    rt.vaultKeysOpened({ userId: "u2", vaultId: "vB", orgId: "oB" });
    await flush();
    expect(fake.serviced).toContain("vA");
    expect(rt.isVaultKeyBlocked("vB")).toBe(false);
  });
});
