// Obsidian-flavoured markdown, as two lists.
//
// `ofmMarkdown` extends the PARSER (new nodes in the syntax tree, so every
// other decoration source can ask about them by name). `ofmDecorations` are
// view-level layers that need no parser change. Both are wired once, in
// `lib/editor/index.ts`.
//
// Vaults are portable: everything here is the syntax Obsidian already uses, so
// a note written in Baalda opens in Obsidian looking the same, and vice versa.

import type { Extension } from "@codemirror/state";
import type { MarkdownConfig } from "@lezer/markdown";
import { callouts } from "./callout";
import { ofmComment } from "./comment";
import { hashtagPills, ofmHashtag } from "./hashtag";
import { ofmHighlight } from "./highlight";

export const ofmMarkdown: MarkdownConfig[] = [ofmHighlight, ofmComment, ofmHashtag];

export const ofmDecorations: Extension[] = [callouts, hashtagPills];

export { CALLOUT_RE } from "./callout";
export { hashtagTag, highlightTag } from "./tags";
