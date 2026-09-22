// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../ipc";
import { loadRememberedPassword, readRememberPassword, saveRememberedPassword, writeRememberPassword } from "../rememberedPassword";
vi.mock("../ipc", () => ({ keychainGet: vi.fn(), keychainSet: vi.fn(), keychainDelete: vi.fn() }));
const secrets = new Map<string, string>();
const prefs = new Map<string, string>();
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => prefs.get(key) ?? null,
    setItem: (key: string, value: string) => { prefs.set(key, value); },
    removeItem: (key: string) => { prefs.delete(key); },
    clear: () => prefs.clear(),
  });
  vi.mocked(ipc.keychainGet).mockImplementation(async (key) => secrets.get(key) ?? null);
  vi.mocked(ipc.keychainSet).mockImplementation(async (key, value) => { secrets.set(key, value); });
  vi.mocked(ipc.keychainDelete).mockImplementation(async (key) => { secrets.delete(key); });
  await writeRememberPassword(false);
  localStorage.clear();
  secrets.clear();
  vi.clearAllMocks();
});
describe("remembered password", () => {
  it("requires fresh consent, even when remembering email was enabled", async () => {
    localStorage.setItem("context.rememberEmail", "on");
    expect(readRememberPassword()).toBe(false);
    await saveRememberedPassword("https://one.test", "ada@example.com", "secret");
    expect(ipc.keychainSet).not.toHaveBeenCalled();
    expect(await loadRememberedPassword("https://one.test", "ada@example.com")).toBe("");
    expect(ipc.keychainGet).not.toHaveBeenCalled();
  });
  it("stores only in the keychain and only returns it for the matching server and email", async () => {
    await writeRememberPassword(true);
    await saveRememberedPassword("https://one.test/", " Ada@example.com ", "secret");
    expect(await loadRememberedPassword("https://one.test", "ada@example.com")).toBe("secret");
    expect(await loadRememberedPassword("https://two.test", "ada@example.com")).toBe("");
    expect(await loadRememberedPassword("http://one.test", "ada@example.com")).toBe("");
    expect(await loadRememberedPassword("https://one.test", "other@example.com")).toBe("");
    expect(JSON.stringify([...prefs])).not.toContain("secret");
  });
  it("replaces the previous account and forgets it immediately when disabled", async () => {
    await writeRememberPassword(true);
    await saveRememberedPassword("https://one.test", "ada@example.com", "old");
    await saveRememberedPassword("https://two.test", "ada@example.com", "new");
    expect(secrets.size).toBe(1);
    expect(await loadRememberedPassword("https://one.test", "ada@example.com")).toBe("");
    await writeRememberPassword(false);
    expect(secrets.size).toBe(0);
    expect(readRememberPassword()).toBe(false);
  });
  it("deletes after an in-flight save rather than letting it resurrect a forgotten password", async () => {
    await writeRememberPassword(true);
    let finish!: () => void;
    vi.mocked(ipc.keychainSet).mockImplementation((key, value) => new Promise<void>((resolve) => {
      finish = () => { secrets.set(key, value); resolve(); };
    }));
    const save = saveRememberedPassword("https://one.test", "ada@example.com", "secret");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const forget = writeRememberPassword(false);
    expect(readRememberPassword()).toBe(false);
    finish();
    await Promise.all([save, forget]);
    expect(secrets.size).toBe(0);
  });
  it("does not return an in-flight read after consent is withdrawn", async () => {
    await writeRememberPassword(true);
    await saveRememberedPassword("https://one.test", "ada@example.com", "secret");
    const raw = [...secrets.values()][0];
    let finish!: (value: string) => void;
    vi.mocked(ipc.keychainGet).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const read = loadRememberedPassword("https://one.test", "ada@example.com");
    await vi.waitFor(() => expect(finish).toBeDefined());
    const forget = writeRememberPassword(false);
    finish(raw);
    expect(await read).toBe("");
    await forget;
  });
  it("reports keychain failure without falling back to plaintext", async () => {
    await writeRememberPassword(true);
    vi.mocked(ipc.keychainSet).mockRejectedValueOnce(new Error("locked"));
    await expect(saveRememberedPassword("https://one.test", "ada@example.com", "secret")).rejects.toThrow("locked");
    expect(JSON.stringify([...prefs])).not.toContain("secret");
    vi.mocked(ipc.keychainDelete).mockRejectedValueOnce(new Error("locked"));
    await expect(writeRememberPassword(false)).rejects.toThrow("locked");
    expect(readRememberPassword()).toBe(false);
  });
});
