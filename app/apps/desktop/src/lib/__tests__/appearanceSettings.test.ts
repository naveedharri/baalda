import { beforeEach, describe, expect, it } from "vitest";
import {
  APPEARANCE_DEFAULTS,
  appearanceSource,
  effectiveAppearance,
  migrateStoredAppearance,
  parseAppearanceSettings,
  withAppearance,
} from "../appearanceSettings";
import { readAppearanceOverrides, writeAppearanceOverrides } from "../prefs";

describe("effectiveAppearance", () => {
  it("is the app default when nobody set anything", () => {
    expect(effectiveAppearance({}, null)).toEqual(APPEARANCE_DEFAULTS);
  });

  it("uses the vault value where the person inherits", () => {
    const eff = effectiveAppearance({}, { theme: "dark", textSize: 18, lineNumbers: true });
    expect(eff.theme).toBe("dark");
    expect(eff.textSize).toBe(18);
    expect(eff.lineNumbers).toBe(true);
    expect(eff.properties).toBe("visible");
  });

  it("lets a personal override win over the vault, including one equal to the default", () => {
    const eff = effectiveAppearance(
      { theme: "system", contentWidth: 72, autoColors: true },
      { theme: "dark", contentWidth: "full", autoColors: false },
    );
    expect(eff.theme).toBe("system");
    expect(eff.contentWidth).toBe(72);
    expect(eff.autoColors).toBe(true);
  });

  it("applies a vault theme only while that vault is open", () => {
    const vaults = { a: { theme: "dark" as const } };
    const open = (orgId: string | null) =>
      effectiveAppearance({}, orgId ? (vaults as Record<string, { theme: "dark" }>)[orgId] : null);
    expect(open("a").theme).toBe("dark");
    expect(open(null).theme).toBe("system"); // a local vault
    expect(open("b").theme).toBe("system"); // another team
  });

  it("reports where each value comes from", () => {
    expect(appearanceSource("theme", {}, { theme: "dark" })).toBe("vault");
    expect(appearanceSource("theme", { theme: "light" }, { theme: "dark" })).toBe("personal");
    expect(appearanceSource("theme", {}, {})).toBe("default");
  });
});

describe("migrateStoredAppearance", () => {
  it("keeps a real choice as an override and turns a default-equal value into inherit", () => {
    expect(
      migrateStoredAppearance({
        theme: "dark",
        autoColors: true, // default → inherit
        contentWidth: "full", // default → inherit
        textSize: 18,
        lineNumbers: false, // default → inherit
        properties: "source",
      }),
    ).toEqual({ theme: "dark", textSize: 18, properties: "source" });
  });

  it("treats absent and invalid values as inherit", () => {
    expect(migrateStoredAppearance({ theme: "neon", textSize: undefined })).toEqual({});
  });
});

describe("parseAppearanceSettings", () => {
  it("drops unknown keys and bad values and clamps numbers", () => {
    expect(
      parseAppearanceSettings({ theme: "dark", textSize: 99, contentWidth: "wide", extra: 1, lineNumbers: "yes" }),
    ).toEqual({ theme: "dark", textSize: 24 });
    expect(parseAppearanceSettings(null)).toEqual({});
  });

  it("withAppearance sets and clears one key", () => {
    expect(withAppearance({ theme: "dark" }, "theme", undefined)).toEqual({});
    expect(withAppearance({}, "lineNumbers", true)).toEqual({ lineNumbers: true });
  });
});

describe("readAppearanceOverrides (stored values)", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  });

  it("migrates the legacy per-setting keys once", () => {
    store.set("cbk-theme", "dark");
    store.set("context.editorFontSize", "16"); // equals the default → inherit
    store.set("context.lineNumbers", "on");
    store.set("context.propertiesMode", "visible"); // default → inherit
    store.set("context.automaticItemColors:u1", "off");
    expect(readAppearanceOverrides(null)).toEqual({
      theme: "dark",
      lineNumbers: true,
      autoColors: false,
    });
    // Written once; later reads come from the new key, not the legacy ones.
    store.set("cbk-theme", "light");
    expect(readAppearanceOverrides(null).theme).toBe("dark");
  });

  it("round-trips written overrides", () => {
    writeAppearanceOverrides({ textSize: 20 });
    expect(readAppearanceOverrides(null)).toEqual({ textSize: 20 });
  });
});
