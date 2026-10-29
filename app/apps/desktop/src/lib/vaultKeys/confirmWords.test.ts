import { describe, expect, it } from "vitest";
import { confirmWordsMatch, pickConfirmPositions } from "./confirmWords";
import { generateVaultKey, vaultKeyToWords } from "./crypto";

describe("vault key confirmation", () => {
  it("picks three distinct positions", () => {
    for (let i = 0; i < 50; i++) {
      const p = pickConfirmPositions();
      expect(new Set(p).size).toBe(3);
      expect(p.every((n) => n >= 0 && n < 24)).toBe(true);
    }
  });

  it("accepts only the right words", () => {
    const words = vaultKeyToWords(generateVaultKey());
    const list = words.split(" ");
    const pos = [1, 7, 22];
    expect(confirmWordsMatch(words, pos, [list[1], ` ${list[7].toUpperCase()} `, list[22]])).toBe(true);
    expect(confirmWordsMatch(words, pos, [list[1], list[7], "wrong"])).toBe(false);
    expect(confirmWordsMatch(words, pos, [list[1], list[7]])).toBe(false);
    expect(confirmWordsMatch(words, [], [])).toBe(false);
  });
});
