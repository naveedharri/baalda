import { describe, expect, it } from "vitest";
import {
  readTeamAccessCache,
  teamAccessCacheKey,
  writeTeamAccessCache,
  type ModeStore,
} from "../teamAccessCache";

function fakeStore(seed: Record<string, string> = {}): ModeStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const SERVER = "https://api.baalda.com";
const ORG = "org_abc";

describe("teamAccessCacheKey", () => {
  it("namespaces by server AND vault", () => {
    expect(teamAccessCacheKey(SERVER, ORG)).toBe(`context.teamAccess:${SERVER}:${ORG}`);
    // The same vault id on another server is a different vault entirely.
    expect(teamAccessCacheKey("http://localhost:3010", ORG)).not.toBe(
      teamAccessCacheKey(SERVER, ORG),
    );
  });
});

describe("writeTeamAccessCache / readTeamAccessCache", () => {
  it("round-trips every mode", () => {
    const store = fakeStore();
    for (const mode of ["open", "readonly", "private"] as const) {
      writeTeamAccessCache(SERVER, ORG, mode, store);
      expect(readTeamAccessCache(SERVER, ORG, store)).toBe(mode);
    }
  });

  it("does not leak between vaults or servers", () => {
    const store = fakeStore();
    writeTeamAccessCache(SERVER, ORG, "open", store);
    expect(readTeamAccessCache(SERVER, "org_other", store)).toBeNull();
    expect(readTeamAccessCache("http://localhost:3010", ORG, store)).toBeNull();
  });

  it("reads null with nothing stored", () => {
    expect(readTeamAccessCache(SERVER, ORG, fakeStore())).toBeNull();
  });

  it("reads null for a missing org id", () => {
    const store = fakeStore();
    writeTeamAccessCache(SERVER, null, "open", store);
    expect(store.data).toEqual({});
    expect(readTeamAccessCache(SERVER, null, store)).toBeNull();
  });

  it("reads null with no storage at all (a private window, a locked-down webview)", () => {
    expect(readTeamAccessCache(SERVER, ORG, null)).toBeNull();
    expect(() => writeTeamAccessCache(SERVER, ORG, "open", null)).not.toThrow();
  });
});

describe("readTeamAccessCache — junk in storage", () => {
  it("rejects unparseable JSON rather than throwing", () => {
    const store = fakeStore({ [teamAccessCacheKey(SERVER, ORG)]: "not json" });
    expect(readTeamAccessCache(SERVER, ORG, store)).toBeNull();
  });

  it("rejects a value that is not one of the three modes", () => {
    const store = fakeStore({ [teamAccessCacheKey(SERVER, ORG)]: '{"mode":"shared"}' });
    expect(readTeamAccessCache(SERVER, ORG, store)).toBeNull();
  });

  it("rejects a shape with no mode", () => {
    const store = fakeStore({ [teamAccessCacheKey(SERVER, ORG)]: '{"grantId":"x"}' });
    expect(readTeamAccessCache(SERVER, ORG, store)).toBeNull();
  });

  it("survives a null payload", () => {
    const store = fakeStore({ [teamAccessCacheKey(SERVER, ORG)]: "null" });
    expect(readTeamAccessCache(SERVER, ORG, store)).toBeNull();
  });
});

describe("writeTeamAccessCache — a storage that refuses", () => {
  it("swallows a quota error", () => {
    const store: ModeStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeTeamAccessCache(SERVER, ORG, "open", store)).not.toThrow();
  });

  it("swallows a reader that throws", () => {
    const store: ModeStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    };
    expect(readTeamAccessCache(SERVER, ORG, store)).toBeNull();
  });
});
