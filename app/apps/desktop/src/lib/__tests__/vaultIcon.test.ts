import { describe, expect, it } from "vitest";
import {
  defaultVaultIcon,
  isValidVaultIcon,
  parseVaultIcon,
  resolveVaultIcon,
  serializeVaultIcon,
  VAULT_ICON_MAX_CHARS,
  VAULT_ICON_NAMES,
} from "../vaultIcon";

describe("vault icons", () => {
  it("gives every vault a stable default preset", () => {
    const a = defaultVaultIcon("org:abc");
    expect(a).toEqual(defaultVaultIcon("org:abc"));
    expect(VAULT_ICON_NAMES).toContain(a.icon);
    expect(resolveVaultIcon("org:abc", null)).toEqual(a);
  });

  it("round-trips presets and images", () => {
    const preset = { kind: "preset", icon: "book", color: "violet" } as const;
    expect(parseVaultIcon(serializeVaultIcon(preset))).toEqual(preset);
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(parseVaultIcon(src)).toEqual({ kind: "image", src });
  });

  it("falls back to the default for unknown or unsafe values", () => {
    for (const raw of [
      "preset:notAnIcon:violet",
      "preset:book:notAColor",
      "https://example.com/x.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64," + "A".repeat(VAULT_ICON_MAX_CHARS),
    ]) {
      expect(parseVaultIcon(raw)).toBeNull();
      expect(resolveVaultIcon("local:/v", raw)).toEqual(defaultVaultIcon("local:/v"));
    }
    expect(isValidVaultIcon(null)).toBe(true);
  });
});
