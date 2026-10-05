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

  it("accepts the None colour", () => {
    expect(parseVaultIcon("preset:book:none")).toEqual({ kind: "preset", icon: "book", color: "none" });
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

describe("personal icon for a synced vault (#291)", () => {
  it("stores on this device under a key no folder path can take, and resets", async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    let fired = 0;
    g.window = { dispatchEvent: () => { fired++; return true; } };
    const { readPersonalVaultIcon, writePersonalVaultIcon, readLocalVaultIcon } = await import("../vaultIcon");
    writePersonalVaultIcon("abc", "preset:book:violet");
    expect(readPersonalVaultIcon("abc")).toBe("preset:book:violet");
    expect(readLocalVaultIcon("abc")).toBeNull();
    expect(fired).toBe(1);
    writePersonalVaultIcon("abc", null);
    expect(readPersonalVaultIcon("abc")).toBeNull();
    delete g.localStorage;
    delete g.window;
  });
});
