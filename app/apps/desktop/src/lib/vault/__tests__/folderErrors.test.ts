import { describe, expect, it } from "vitest";
import { DOCUMENTS_DENIED_PREFIX, folderErrorText, isDocumentsDenied } from "../folderErrors";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("folderErrors", () => {
  const denied = `${DOCUMENTS_DENIED_PREFIX}macOS blocked Baalda from using your Documents folder, so it couldn't create /Users/x/Documents/Baalda Vaults.`;

  it("recognises the documents_denied prefix on a string or an Error", () => {
    expect(isDocumentsDenied(denied)).toBe(true);
    expect(isDocumentsDenied(new Error(denied))).toBe(true);
    expect(isDocumentsDenied("Couldn't create the vaults folder /x: os error 2")).toBe(false);
    expect(isDocumentsDenied(null)).toBe(false);
  });

  it("strips the code prefix and leaves other messages alone", () => {
    expect(folderErrorText(denied)).toMatch(/^macOS blocked Baalda/);
    const refusal = "Baalda cannot use your home folder as a vault. Choose a folder inside it, or let Baalda create one in Documents/Baalda Vaults.";
    expect(folderErrorText(new Error(refusal))).toBe(refusal);
  });

  it("matches the prefix Rust emits", () => {
    const rust = readFileSync(resolve(__dirname, "../../../../src-tauri/src/folder_safety.rs"), "utf8");
    expect(rust).toContain(`pub const DOCUMENTS_DENIED: &str = "${DOCUMENTS_DENIED_PREFIX}";`);
  });
});
