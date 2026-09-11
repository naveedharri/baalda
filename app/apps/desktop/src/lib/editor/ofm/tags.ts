// Highlight tags for the Obsidian-flavoured markdown our parser adds.
//
// `@lezer/highlight`'s standard tag set has nothing for `==highlight==` or
// `#tag`, so we mint our own. They are plain `Tag` objects: the parser
// extensions (./highlight, ./hashtag) attach them to their node types, and
// `markdownHighlightSpec` (../theme.ts) is the single place that says what they
// look like — the same contract every built-in tag follows.
//
// Deliberately in their own module: ../theme.ts and ./highlight.ts both need
// them, and importing a parser from the theme would drag a MarkdownConfig into
// every editor test that only wanted a colour.

import { Tag } from "@lezer/highlight";

/** `==marked text==` — the yellow wash (`--highlight-bg`). */
export const highlightTag = Tag.define();

/** `#tag` — the accent-tinted pill. */
export const hashtagTag = Tag.define();
