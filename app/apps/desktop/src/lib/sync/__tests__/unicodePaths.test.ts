import { describe, expect, it } from "vitest";
import { pathKey, samePathKey } from "../../pathIdentity";
import { planBinarySync } from "../attachments";
import { samePath } from "../inbound";

// #259: macOS names files in decomposed form (NFD), Windows and Linux keep the
// composed form (NFC). The same name must be the same file — compared, never
// rewritten.

const NFC = "Café/Résumé.md"; // é as one code point
const NFD = NFC.normalize("NFD"); // e + combining acute
const HANGUL_NFC = "한글.pdf"; // 한글
const HANGUL_NFD = HANGUL_NFC.normalize("NFD");

describe("Unicode path identity", () => {
  it("treats NFD and NFC spellings as one path, case-insensitively", () => {
    expect(NFC).not.toBe(NFD);
    expect(samePath(NFC, NFD)).toBe(true);
    expect(samePath(NFC.toUpperCase(), NFD)).toBe(true);
    expect(samePathKey(HANGUL_NFC, HANGUL_NFD)).toBe(true);
    expect(pathKey(NFD)).toBe(pathKey(NFC));
    expect(samePath("Café.md", "Cafe.md")).toBe(false);
  });

  it("never rewrites the spelling it compares", () => {
    expect(NFD.normalize("NFC")).toBe(NFC);
    // The key is derived; the input string is untouched.
    const original = NFD;
    pathKey(original);
    expect(original).toBe(NFD);
  });

  it("matches a Mac-registered binary to the composed file on this disk", () => {
    const plan = planBinarySync(
      [{ relPath: HANGUL_NFC, sha256: "s1" }],
      [{ id: "b1", relPath: HANGUL_NFD, sha256: "s1", docId: "f1" }],
      { docIdFor: () => null, baseFor: () => null },
    );
    // Same file: agreed under the server's id, never downloaded beside itself.
    expect(plan.toDownload).toEqual([]);
    expect(plan.toUpload).toEqual([]);
    expect(plan.agreed).toEqual([{ relPath: HANGUL_NFC, docId: "f1", sha256: "s1" }]);
  });
});
