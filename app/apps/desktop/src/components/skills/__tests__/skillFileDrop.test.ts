import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

import { isSkillFile } from "../useSkillFileDrop";

describe("isSkillFile", () => {
  it("takes a .zip or a .skill, any case, on either path separator", () => {
    expect(isSkillFile("/Users/a/Downloads/pdf-tools.zip")).toBe(true);
    expect(isSkillFile("/Users/a/Downloads/pdf-tools.SKILL")).toBe(true);
    expect(isSkillFile("C:\\Users\\a\\pdf.skill")).toBe(true);
  });
  it("refuses anything else, including a folder with a dot in its name", () => {
    expect(isSkillFile("/Users/a/notes.md")).toBe(false);
    expect(isSkillFile("/Users/a/my.zip.d/file")).toBe(false);
    expect(isSkillFile("/Users/a/skill")).toBe(false);
  });
});
