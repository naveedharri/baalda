import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  vaultSecretGet: vi.fn(),
  vaultSecretSet: vi.fn(),
  vaultSecretDelete: vi.fn(),
}));

import { generateVaultKey } from "./crypto";
import {
  clearVaultKeyCache,
  deleteVaultKey,
  getAccountPrivateKey,
  getVaultKey,
  setAccountPrivateKey,
  setSecretIoForTests,
  setVaultKey,
  type SecretIo,
} from "./store";

function memIo() {
  const map = new Map<string, string>();
  const io: SecretIo = {
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void map.set(k, v)),
    delete: vi.fn(async (k: string) => void map.delete(k)),
  };
  return { map, io };
}

afterEach(() => setSecretIoForTests());

describe("vault key store", () => {
  it("stores under the scoped names and caches reads", async () => {
    const { map, io } = memIo();
    setSecretIoForTests(io);
    const vk = generateVaultKey();
    await setVaultKey("https://s", "v1", vk);
    await setAccountPrivateKey("https://s", "u1", new Uint8Array(32).fill(3));
    expect([...map.keys()].sort()).toEqual(["baalda.keys:https://s|u1", "vk:https://s:v1"]);

    clearVaultKeyCache();
    expect(await getVaultKey("https://s", "v1")).toEqual(vk);
    expect(await getVaultKey("https://s", "v1")).toEqual(vk);
    expect(io.get).toHaveBeenCalledTimes(1);
    expect(await getAccountPrivateKey("https://s", "u1")).toEqual(new Uint8Array(32).fill(3));

    await deleteVaultKey("https://s", "v1");
    expect(await getVaultKey("https://s", "v1")).toBeNull();
  });

  it("refuses a vault key of the wrong size", async () => {
    setSecretIoForTests(memIo().io);
    await expect(setVaultKey("https://s", "v1", new Uint8Array(16))).rejects.toThrow();
  });
});
