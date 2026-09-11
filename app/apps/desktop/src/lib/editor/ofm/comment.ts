// `%%obsidian comments%%` — text that lives in the note and never reaches a
// reader. Two shapes, both from Obsidian:
//
//   inline   …a sentence %%with an aside%% in it.
//   block    a line of exactly `%%`, everything until the next such line.
//
// NODE NAMES ARE LOAD-BEARING. `@lezer/markdown` already defines `Comment` and
// `CommentBlock` for HTML `<!-- … -->`, and `MarkdownParser.configure()`
// SILENTLY SKIPS a node whose name is taken — so calling ours `Comment` would
// not fail, it would just quietly do nothing while `<!-- -->` kept working and
// `%%…%%` never parsed. Hence `OfmComment` / `OfmCommentMark` /
// `OfmCommentBlock`, and a regression test that `<!-- -->` still yields
// `CommentBlock`.
//
// Rendering: comments stay VISIBLE — faint and italic (`tags.comment` in
// theme.ts). Only the `%%` delimiters hide, TOKEN-scoped like any other inline
// marker. A comment you cannot see is a comment you publish by mistake.
//
// Known gap, deliberate: the server's `render/note-html.ts` (public links) and
// its indexer do not strip `%%…%%` yet, so a comment does reach a public page.
// That is a server change, tracked as a follow-up rather than smuggled in here.

import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

const PERCENT = 37; /* '%' */

/** A line that is nothing but `%%` (plus optional surrounding space). */
const FENCE = /^\s*%%\s*$/;

const CommentDelim = { resolve: "OfmComment", mark: "OfmCommentMark" };

export const ofmComment: MarkdownConfig = {
  defineNodes: [
    { name: "OfmComment", style: { "OfmComment/...": tags.comment } },
    { name: "OfmCommentMark", style: tags.processingInstruction },
    { name: "OfmCommentBlock", style: { "OfmCommentBlock/...": tags.comment } },
  ],
  parseBlock: [
    {
      name: "OfmCommentBlock",
      // An eager leaf parser: recognisable from its first line, consumes lines
      // until the closing fence (or the end of the note, matching Obsidian —
      // an unclosed `%%` comments out the rest of the file).
      parse(cx, line) {
        if (!FENCE.test(line.text)) return false;
        const from = cx.lineStart;
        let to = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          to = cx.lineStart + line.text.length;
          if (FENCE.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("OfmCommentBlock", from, to));
        return true;
      },
      // `%%` on the line after a paragraph ends that paragraph, the way a code
      // fence does — otherwise the opener is swallowed as paragraph text.
      endLeaf: (_cx, line) => FENCE.test(line.text),
      before: "HorizontalRule",
    },
  ],
  parseInline: [
    {
      name: "OfmComment",
      parse(cx, next, pos) {
        if (next !== PERCENT || cx.char(pos + 1) !== PERCENT) return -1;
        // No flanking rules: `%%` is not emphasis, and Obsidian pairs the
        // delimiters positionally. Both open and close, nearest pair wins.
        return cx.addDelimiter(CommentDelim, pos, pos + 2, true, true);
      },
      after: "Emphasis",
    },
  ],
};
