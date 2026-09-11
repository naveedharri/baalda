// `#tag` — inline tags, parsed and drawn as pills.
//
// The rule has to agree, character for character, with Rust's `TAG_RE`
// (`src-tauri/src/parse.rs`), because that is what actually fills the index: a
// word the editor pills but the index ignores is a tag that does not exist when
// you search for it. Both sides say:
//
//   • the `#` is not preceded by `[\p{L}\p{N}_/]`  → `foo#bar` is not a tag
//   • the body is `[\p{L}\p{N}_/-]+`               → `#nested/tag`, `#a-b`
//   • the body holds at least one non-digit        → `#2026goals` yes, `#2026` no
//
// (The regex crate has no lookbehind, which is why both sides express the first
// rule as "an optional preceding character that isn't one of those" rather than
// as `(?<!…)`.)
//
// ATX headings are safe by construction: `# Heading`'s `#` is consumed by the
// BLOCK parser as a `HeaderMark` and never reaches inline parsing.

import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { MarkdownConfig } from "@lezer/markdown";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { hashtagTag } from "./tags";

const HASH = 35; /* '#' */

/** A character that may not precede the `#`. */
const BEFORE_BLOCKS = /[\p{L}\p{N}_/]/u;
/** A character the tag body may contain. */
const BODY_CHAR = /[\p{L}\p{N}_/-]/u;
/** The whole body: optional digits, then at least one non-digit, then anything. */
const BODY = /^\d*[\p{L}_/-][\p{L}\p{N}_/-]*$/u;

export const ofmHashtag: MarkdownConfig = {
  defineNodes: [
    { name: "Hashtag", style: { "Hashtag/...": hashtagTag } },
    { name: "HashtagMark", style: hashtagTag },
  ],
  parseInline: [
    {
      name: "Hashtag",
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        const before = cx.slice(pos - 1, pos);
        if (before && BEFORE_BLOCKS.test(before)) return -1;
        let end = pos + 1;
        while (end < cx.end && BODY_CHAR.test(cx.slice(end, end + 1))) end++;
        if (!BODY.test(cx.slice(pos + 1, end))) return -1;
        return cx.addElement(
          cx.elt("Hashtag", pos, end, [cx.elt("HashtagMark", pos, pos + 1)]),
        );
      },
      after: "Emphasis",
    },
  ],
};

// ---- The pill -------------------------------------------------------------

const pill = Decoration.mark({ class: "cm-hashtag" });

/**
 * Always-on: a tag is a thing you click, not a marker that folds away, so this
 * ignores the reveal rules entirely — the `#` stays visible inside the pill.
 *
 * Built from the SYNTAX TREE rather than from a regex over the text, so a
 * `#comment` inside a code fence or a `#fragment` inside a URL is left alone —
 * the parser above already answered "is this a tag?" once, correctly.
 */
function buildPills(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "Hashtag") decos.push(pill.range(node.from, node.to));
      },
    });
  }
  return Decoration.set(decos, true);
}

/**
 * Clicking a tag should run a vault search for it. `SearchPanel` currently owns
 * its own query state and takes no initial query, so wiring that up means
 * lifting the query into the store — a UI change with its own review surface.
 * Until then the pill is presentation only, and the click falls through to
 * ordinary caret placement. Tracked as the Stage 3a follow-up.
 */
export const hashtagPills = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildPills(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildPills(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---- `#` autocomplete ------------------------------------------------------

/** One tag as the completion list sees it (the shape `ipc.listTags` returns). */
export interface TagSuggestion {
  name: string;
  count: number;
}

/**
 * Suggest tags the vault already uses as soon as you type `#`.
 *
 * This is the half of the tag story the pill cannot tell: a tag only pays off
 * when the SAME spelling is reused, and a vault that has drifted into `#idea`,
 * `#ideas` and `#Idea` has three tags and no tag. Ranking by use count (Rust's
 * `list_tags`) puts the spelling you actually settled on first.
 *
 * The match pattern mirrors the parser above — `#` plus body characters — so the
 * completion fires exactly where a tag would parse, and it deliberately allows
 * an EMPTY body: `#` on its own is the moment you most want the list, before
 * you have typed a letter to filter it by.
 */
export function tagCompletions(opts: {
  getTags: () => TagSuggestion[];
}): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const token = ctx.matchBefore(/#[\p{L}\p{N}_\-/]*$/u);
    if (!token) return null;
    // `a#b` is not a tag (see BEFORE_BLOCKS); don't offer one there either.
    const before = ctx.state.sliceDoc(Math.max(0, token.from - 1), token.from);
    if (before && BEFORE_BLOCKS.test(before)) return null;
    const tags = opts.getTags();
    if (!tags.length) return null;
    return {
      from: token.from,
      options: tags.map((t, i) => ({
        label: `#${t.name}`,
        type: "keyword",
        detail: t.count === 1 ? "1 note" : `${t.count} notes`,
        // Preserve the index's ranking (most-used first) rather than letting the
        // default scorer re-sort equally-good prefix matches alphabetically.
        boost: Math.max(-99, 99 - i),
      })),
      validFor: /^#[\p{L}\p{N}_\-/]*$/u,
    };
  };
}
