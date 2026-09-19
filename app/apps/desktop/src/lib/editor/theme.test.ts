// The editor's colour contract, asserted where it actually lives.
//
// Two halves, and the second is the one that has bitten us:
//  1. `editorThemeSpec` / `markdownHighlightSpec` say WHICH token each part of
//     the editor consumes (jsdom does no layout, so a computed-px or computed-
//     colour assertion is impossible — see editorGeometry.test.ts).
//  2. `tokens.css` must DEFINE those tokens in all three colour blocks —
//     `:root`, `[data-theme="dark"]`, and the `prefers-color-scheme: dark`
//     pre-hydration block. Miss the third and every marker in the editor
//     flashes the light value for a frame on a dark-mode cold start; miss the
//     second and it stays wrong forever.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tags as t } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { hashtagTag, highlightTag } from "./ofm/tags";
import { editorThemeSpec, markdownHighlightSpec } from "./theme";

const tokensCss = readFileSync(
  fileURLToPath(new URL("../../styles/tokens.css", import.meta.url)),
  "utf8",
);
const appCss = readFileSync(fileURLToPath(new URL("../../App.css", import.meta.url)), "utf8");

const explicitDark = tokensCss.match(/\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";
const fallbackDark =
  tokensCss.match(/:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";

const tokenValue = (block: string, name: string) =>
  block.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^;]+);`))?.[1].trim();

const rgb = (hex: string): [number, number, number] => {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
};

const luminance = (color: [number, number, number]) => {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

const composite = (
  foreground: [number, number, number],
  background: [number, number, number],
  alpha: number,
): [number, number, number] =>
  foreground.map((channel, index) =>
    Math.round(channel * alpha + background[index] * (1 - alpha)),
  ) as [number, number, number];

const tagsOf = (s: { tag: unknown }): unknown[] => (Array.isArray(s.tag) ? s.tag : [s.tag]);
const ruleFor = (tag: unknown) => markdownHighlightSpec.find((s) => tagsOf(s).includes(tag));

/** How many of tokens.css's three colour blocks define `name`. */
const definitions = (name: string) =>
  tokensCss.split("\n").filter((l) => l.trim().startsWith(`${name}:`)).length;

describe("editor tokens", () => {
  it("defines --text-faint in all three colour blocks", () => {
    // :root (light), [data-theme="dark"], and the prefers-color-scheme block.
    expect(definitions("--text-faint")).toBe(3);
  });

  it("gives --highlight-bg a light and a dark value", () => {
    // Light + both dark blocks; the light one is the `:root` default.
    expect(definitions("--highlight-bg")).toBe(3);
  });

  it("defines native and editor selection colours in every colour block", () => {
    for (const token of [
      "--selection-bg",
      "--selection-text",
      "--editor-selection-bg",
      "--editor-selection-bg-inactive",
    ]) {
      expect(definitions(token)).toBe(3);
    }
    expect(appCss).toMatch(/::selection\s*\{[^}]*background:\s*var\(--selection-bg\)/s);
    expect(appCss).toMatch(/::selection\s*\{[^}]*color:\s*var\(--selection-text\)/s);
  });

  it("defines the remaining Stage 3 editor surfaces once, theme-independently", () => {
    expect(definitions("--callout-tint")).toBe(1);
    expect(definitions("--editor-fold-gutter")).toBe(1);
    // Indent guides reuse the border tiers rather than minting a third grey.
    expect(tokensCss).toContain("--indent-guide: var(--border);");
    expect(tokensCss).toContain("--indent-guide-active: var(--border-strong);");
  });

});

describe("dark palette contrast", () => {
  const value = (name: string) => tokenValue(explicitDark, name)!;
  const color = (name: string) => rgb(value(name));

  it("keeps the system fallback identical to the explicit dark palette", () => {
    for (const token of [
      "--bg-app",
      "--bg-surface",
      "--bg-subtle",
      "--bg-hover",
      "--bg-active",
      "--text-primary",
      "--text-secondary",
      "--text-tertiary",
      "--text-faint",
      "--accent",
      "--link",
      "--selection-bg",
      "--selection-text",
      "--editor-selection-bg",
      "--editor-selection-bg-inactive",
    ]) {
      expect(tokenValue(fallbackDark, token), token).toBe(tokenValue(explicitDark, token));
    }
  });

  it("uses progressively lighter charcoal layers", () => {
    const layers = ["--bg-app", "--bg-surface", "--bg-subtle", "--bg-hover", "--bg-active"];
    const levels = layers.map((token) => luminance(color(token)));
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(new Set(levels).size).toBe(levels.length);
  });

  it("keeps normal UI text and restrained accents above 4.5:1", () => {
    for (const foreground of ["--text-primary", "--text-secondary", "--text-tertiary"]) {
      expect(contrast(color(foreground), color("--bg-active")), foreground).toBeGreaterThanOrEqual(4.5);
    }
    for (const foreground of ["--text-faint", "--accent", "--link"]) {
      expect(contrast(color(foreground), color("--bg-surface")), foreground).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps native selected text above 4.5:1", () => {
    expect(contrast(color("--selection-text"), color("--selection-bg"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps editor body text and links readable through the raised selection wash", () => {
    const overlay = value("--editor-selection-bg").match(
      /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/,
    );
    expect(overlay).not.toBeNull();
    const overlayRgb = overlay!.slice(1, 4).map(Number) as [number, number, number];
    const alpha = Number(overlay![4]);
    const selectedBackground = composite(overlayRgb, color("--bg-surface"), alpha);
    for (const foreground of ["--text-primary", "--link"]) {
      const selectedText = composite(overlayRgb, color(foreground), alpha);
      expect(contrast(selectedText, selectedBackground), foreground).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("editor theme tiers", () => {
  it("uses distinct active and inactive drawSelection tokens", () => {
    expect(
      editorThemeSpec["& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground"]
        .backgroundColor,
    ).toBe(
      "var(--editor-selection-bg-inactive)",
    );
    expect(
      editorThemeSpec[
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground"
      ].backgroundColor,
    ).toBe("var(--editor-selection-bg)");
    expect(editorThemeSpec[".cm-note-title.is-selected"].backgroundColor).toBe(
      "var(--editor-selection-bg)",
    );
  });

  it("puts the bullet and the gutter on the faint tier", () => {
    expect(editorThemeSpec[".cm-bullet"].color).toBe("var(--text-faint)");
    expect(editorThemeSpec[".cm-gutters"].color).toBe("var(--text-faint)");
  });

  it("styles comments faint and italic so they read as an aside", () => {
    expect(ruleFor(t.comment)?.color).toBe("var(--text-faint)");
    expect(ruleFor(t.comment)?.fontStyle).toBe("italic");
  });

  it("washes ==highlight== rather than recolouring it", () => {
    const rule = ruleFor(highlightTag);
    expect(rule?.background).toBe("var(--highlight-bg)");
    expect(rule?.color).toBeUndefined();
  });

  it("tints #tags with the accent", () => {
    expect(ruleFor(hashtagTag)?.color).toBe("var(--accent)");
  });

  it("maps code tokens onto the existing palette", () => {
    expect(ruleFor(t.keyword)?.color).toBe("var(--accent)");
    expect(ruleFor(t.string)?.color).toBe("var(--success)");
    expect(ruleFor(t.number)?.color).toBe("var(--warning)");
    expect(ruleFor(t.function(t.variableName))?.color).toBe("var(--link)");
  });
});
