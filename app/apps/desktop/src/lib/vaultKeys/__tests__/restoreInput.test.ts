import { describe, expect, it } from "vitest";
import { generateVaultKey, vaultKeyFileText, vaultKeyToWords } from "../crypto";
import { keyInputStatus, readKeyInput, restoreErrorMessage } from "../restoreInput";

const vk = generateVaultKey();
const words = vaultKeyToWords(vk);

describe("restore input", () => {
  it("reads the 24 words however they were pasted", () => {
    expect(readKeyInput(words).phrase).toBe(words);
    const numbered = words.split(" ").map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join("\n");
    expect(readKeyInput("  " + numbered + "  ").phrase).toBe(words);
  });

  it("finds the key line inside the whole saved key file", () => {
    const fileText = vaultKeyFileText("Team notes", "v-123", vk);
    const r = readKeyInput(fileText);
    expect(r.phrase).toBe(words);
    expect(r.words).toHaveLength(24);
    expect(keyInputStatus(r)).toEqual({ tone: "ok", text: "All 24 words look right." });
  });

  it("counts progress and never flags the word still being typed", () => {
    const first = words.split(" ").slice(0, 5).join(" ");
    expect(keyInputStatus(readKeyInput(first)).text).toBe("5 of 24 words");
    expect(readKeyInput(first + " zz").unknown).toEqual([]);
    const typo = readKeyInput(first + " zzzz ");
    expect(typo.unknown).toEqual([5]);
    expect(keyInputStatus(typo).tone).toBe("error");
    expect(keyInputStatus(readKeyInput("")).tone).toBe("muted");
  });

  it("says when 24 real words do not make a key, and when there are too many", () => {
    const list = words.split(" ");
    const swapped = [list[1], list[0], ...list.slice(2)].join(" ");
    const r = readKeyInput(swapped);
    if (list[0] !== list[1] && !r.phrase) {
      expect(r.checksumFailed).toBe(true);
      expect(keyInputStatus(r).tone).toBe("error");
    }
    expect(keyInputStatus(readKeyInput(words + " " + list[0] + " ")).text).toContain("exactly 24");
  });

  it("explains every refusal in plain words and says nothing changed", () => {
    expect(restoreErrorMessage("restored")).toBeNull();
    for (const r of ["wrong-key", "invalid-words", "cannot-verify", "security-warning", undefined] as const) {
      expect(restoreErrorMessage(r)).toBeTruthy();
    }
    expect(restoreErrorMessage("wrong-key")).toContain("Nothing was changed");
    expect(restoreErrorMessage(undefined)).toContain("Nothing was changed");
  });
});
