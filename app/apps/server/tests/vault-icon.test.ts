import { describe, expect, it } from "vitest";
import { isValidVaultIcon, VAULT_ICON_MAX_CHARS } from "../src/auth/vault-icon.js";

describe("isValidVaultIcon", () => {
  it("accepts clearing, presets and small images", () => {
    expect(isValidVaultIcon(null)).toBe(true);
    expect(isValidVaultIcon(undefined)).toBe(true);
    expect(isValidVaultIcon("preset:book:violet")).toBe(true);
    expect(isValidVaultIcon("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isValidVaultIcon("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isValidVaultIcon("https://example.com/logo.png")).toBe(false);
    expect(isValidVaultIcon("javascript:alert(1)")).toBe(false);
    expect(isValidVaultIcon("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isValidVaultIcon("preset:book")).toBe(false);
    expect(isValidVaultIcon(42)).toBe(false);
    const huge = "data:image/png;base64," + "A".repeat(VAULT_ICON_MAX_CHARS);
    expect(isValidVaultIcon(huge)).toBe(false);
  });
});
