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

  it("defines the remaining Stage 3 editor surfaces once, theme-independently", () => {
    expect(definitions("--callout-tint")).toBe(1);
    expect(definitions("--editor-fold-gutter")).toBe(1);
    // Indent guides reuse the border tiers rather than minting a third grey.
    expect(tokensCss).toContain("--indent-guide: var(--border);");
    expect(tokensCss).toContain("--indent-guide-active: var(--border-strong);");
  });

  it("never hardcodes a colour in the editor theme", () => {
    for (const [selector, rules] of Object.entries(editorThemeSpec)) {
      for (const [prop, value] of Object.entries(rules)) {
        // `backgroundClip` / `backgroundBlendMode` etc. are geometry, not paint.
        if (!/^(color|.*Color|background)$/.test(prop)) continue;
        expect(
          /var\(--|transparent|inherit|color-mix|none/.test(value),
          `${selector} { ${prop}: ${value} } should consume a token`,
        ).toBe(true);
      }
    }
  });
});

describe("editor theme tiers", () => {
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
