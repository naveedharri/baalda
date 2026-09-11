// The markdown highlight spec's text tiers. A `HighlightStyle` does not expose
// the specs it was built from, which is why `markdownHighlightSpec` is exported.
import { tags as t } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { markdownHighlightSpec } from "./theme";

const tagsOf = (s: { tag: unknown }): unknown[] => (Array.isArray(s.tag) ? s.tag : [s.tag]);
const ruleFor = (tag: unknown) => markdownHighlightSpec.find((s) => tagsOf(s).includes(tag));

describe("markdownHighlight", () => {
  it("never colours t.list — lezer inherits it to the whole item's text", () => {
    // @lezer/markdown maps `"OrderedList/... BulletList/..."` to tags.list, and
    // the `/...` hands the tag to every descendant. Colouring t.list therefore
    // paints the item TEXT accent-purple, not the marker (the list colour bug).
    // GFM `Task` is tags.list as well, so this covers task items too.
    expect(markdownHighlightSpec.some((s) => tagsOf(s).includes(t.list))).toBe(false);
  });

  it("dims markdown markers to the faint tier", () => {
    // ListMark / HeaderMark / QuoteMark / LinkMark / EmphasisMark / CodeMark.
    expect(ruleFor(t.processingInstruction)?.color).toBe("var(--text-tertiary)");
    expect(ruleFor(t.contentSeparator)?.color).toBe("var(--text-tertiary)");
    expect(ruleFor(t.meta)?.color).toBe("var(--text-tertiary)");
  });

  it("keeps quoted text on the muted tier, so a list inside a quote inherits it", () => {
    expect(ruleFor(t.quote)?.color).toBe("var(--text-secondary)");
  });

  it("keeps body-weight text on the primary tier", () => {
    expect(ruleFor(t.strong)?.color).toBe("var(--text-primary)");
    expect(ruleFor(t.heading1)?.color).toBe("var(--text-primary)");
  });
});
