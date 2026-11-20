import { describe, expect, it } from "vitest";
import {
  ALLOWED_MIME,
  EXT_MIME,
  categoryForMime,
  isAllowedMime,
  mimeMatchesBytes,
} from "../src/blobs/formats.js";

/**
 * normalizeMime case-folds every type it looks up, so every table must be
 * keyed in lowercase. The xlsm type is registered as
 * `application/vnd.ms-excel.sheet.macroEnabled.12`; with a mixed-case key every
 * .xlsm upload was refused with 415 while the desktop listed it as supported.
 */
describe("server MIME tables are case-insensitive", () => {
  const XLSM = "application/vnd.ms-excel.sheet.macroEnabled.12";

  it("accepts an .xlsm upload in its registered spelling", () => {
    expect(isAllowedMime(XLSM)).toBe(true);
    expect(isAllowedMime(XLSM.toLowerCase())).toBe(true);
    expect(categoryForMime(XLSM)).toBe("document");
  });

  it("treats an .xlsm that sniffs as xlsx or zip as consistent", () => {
    expect(mimeMatchesBytes(XLSM, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(mimeMatchesBytes(XLSM, "application/zip")).toBe(true);
  });

  it("accepts every extension's type however it is cased", () => {
    for (const [ext, mime] of Object.entries(EXT_MIME)) {
      expect(isAllowedMime(mime), ext).toBe(true);
      expect(isAllowedMime(mime.toUpperCase()), ext).toBe(true);
    }
    for (const m of ALLOWED_MIME) expect(m, m).toBe(m.toLowerCase());
  });
});
