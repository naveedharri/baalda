// `==highlight==` — Obsidian-flavoured markdown's one addition to inline
// emphasis.
//
// Written as a mirror of GFM's `Strikethrough` extension (@lezer/markdown), on
// purpose: the flanking rules ("a delimiter can open if it isn't followed by
// whitespace, and either isn't followed by punctuation or is preceded by
// whitespace/punctuation") are the CommonMark emphasis rules, and getting them
// subtly different is how you end up highlighting half a table of equations.
//
// `after: "Emphasis"` puts us behind the built-in `*`/`_` parser, so `*==x==*`
// nests the way a reader expects. A run of three or more `=` is refused, which
// keeps a setext `===` underline (and `a === b` in prose) alone.

import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { highlightTag } from "./tags";

const EQUALS = 61; /* '=' */

/** CommonMark's punctuation class, copied from @lezer/markdown's own. */
const Punctuation = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1\u2010-\u2027]/;

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export const ofmHighlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    // The `==` themselves join the faint marker tier and hide TOKEN-scoped,
    // like every other inline delimiter (livePreview.ts).
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // `==` exactly, and nothing longer: a run of three or more is a setext
        // underline or an equality operator in prose, never a highlight. The
        // check looks BOTH ways, because the inline parser retries at every
        // offset — refusing only at the start of `===` would simply match the
        // `==` one character in.
        if (
          next !== EQUALS ||
          cx.char(pos + 1) !== EQUALS ||
          cx.char(pos + 2) === EQUALS ||
          cx.char(pos - 1) === EQUALS
        ) {
          return -1;
        }
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};
