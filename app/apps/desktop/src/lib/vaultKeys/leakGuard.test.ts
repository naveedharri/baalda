import { describe, expect, it } from "vitest";
import { generateVaultKey, vaultKeyFileText, vaultKeyToWords } from "./crypto";
import { containsVaultKey } from "./leakGuard";

describe("vault key leak guard (red team 3: 'support asked for my key file')", () => {
  const vk = generateVaultKey();
  const words = vaultKeyToWords(vk);

  it("catches the saved key file, the bare words and numbered or re-cased words", () => {
    expect(containsVaultKey(vaultKeyFileText("Team", "v1", vk))).toBe(true);
    expect(containsVaultKey(`hi, here you go: ${words} thanks`)).toBe(true);
    const numbered = words.split(" ").map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join("\n");
    expect(containsVaultKey(numbered)).toBe(true);
  });

  it("catches an invite link secret and a join code with its device secret", () => {
    const s = "0123456789ABCDEFGHJKMNPQRS";
    expect(containsVaultKey(`https://api.test/invite/i1#k=${s}`)).toBe(true);
    expect(containsVaultKey(`baalda://invite/i1?server=x&k=${s}`)).toBe(true);
    expect(containsVaultKey(`my code is ABCD2345-${s}`)).toBe(true);
    expect(containsVaultKey("my code is ABCD2345")).toBe(false);
    expect(containsVaultKey("doc 3f2a9c1e-7b4d-4e2a-9f10-123456789abc")).toBe(false);
  });

  it("does not flag ordinary text, logs, or 24 list words that are not a key", () => {
    expect(containsVaultKey("The sync stopped after I renamed a folder. Steps: open, rename, wait.")).toBe(false);
    expect(containsVaultKey("[vault-sync] applyUpdate failed for doc-1 ".repeat(2000))).toBe(false);
    // 24 BIP39 words with a wrong checksum (all "abandon") are not a key.
    expect(containsVaultKey(Array(24).fill("abandon").join(" "))).toBe(false);
    // 23 words of a real key are not enough to read it.
    expect(containsVaultKey(words.split(" ").slice(0, 23).join(" "))).toBe(false);
  });
});
