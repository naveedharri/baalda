// Editor theme + markdown syntax highlighting. This gives the "live-preview
// feel" (heading sizes, bold/italic, links) via CodeMirror's syntax highlighter
// while keeping the buffer as raw markdown — no serialization, files round-trip
// losslessly (spec 01 §1).
//
// Rebuilt on the Atomize design tokens (src/styles/tokens.css). Every value is a
// `var(--…)` so the single theme adapts to light AND dark automatically when the
// theme toggle stamps `data-theme` on the root — no `dark: true` flavor needed.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text-primary)",
    backgroundColor: "var(--bg-surface)",
    fontFamily: "var(--font-body)",
    fontSize: "var(--fs-lg)",
  },
  // The prose column: a calm sheet, generous padding, comfortable measure.
  ".cm-scroller": {
    fontFamily: "var(--font-body)",
    lineHeight: "var(--lh-body)",
    overflowX: "hidden",
  },
  // Full-width content box so a click *anywhere* in the sheet lands on
  // `.cm-content` (CodeMirror only maps clicks/drag-selection that hit the
  // content element — a centred column via `margin:auto` leaves the side
  // margins as dead `.cm-scroller` zones). We centre the 76ch measure with
  // symmetric auto-ish padding instead, and keep the tall bottom pad so there's
  // always somewhere to click below the last line.
  ".cm-content": {
    padding: "var(--sp-8) max(var(--sp-8), calc((100% - 76ch) / 2)) 40vh",
    minHeight: "100%",
    caretColor: "var(--accent)",
  },
  "&.cm-focused": { outline: "none" },

  // No line-number gutter for a writing surface; keep it invisible if present.
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-tertiary)",
  },

  // No active-line highlight — only the accent caret blinks where you click.
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },

  // Selection: a clearly visible accent wash across both the drawSelection()
  // layer and any native ::selection. `--accent-soft` was too faint to read as
  // a selection on the white sheet.
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
    },
  // drawSelection() paints in a layer BEHIND the content, so opaque line
  // backgrounds (the .cm-codeblock well, rendered tables) swallow the wash —
  // selecting inside a code block showed nothing while the layer's full-width
  // rectangles bled into the margins around the well. Lift the layer above the
  // content and blend it so the wash tints every background and text stays
  // readable (multiply darkens on light; dark theme flips to screen via
  // --selection-blend in tokens.css).
  ".cm-selectionLayer": {
    zIndex: "1",
    pointerEvents: "none",
    mixBlendMode: "var(--selection-blend, multiply)",
  },

  // Search / highlight matches in soft warning.
  ".cm-searchMatch": {
    backgroundColor: "var(--warning-soft)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--warning-soft)",
    outline: "1px solid var(--warning)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },

  // Matching-bracket emphasis, kept subtle.
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "none",
  },

  // [[wiki-links]]: accent text that grows a soft rounded chip on hover.
  ".cm-wikilink": {
    color: "var(--accent)",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    padding: "0 2px",
    margin: "0 -2px",
    transition: "background-color var(--t-fast) var(--ease)",
  },
  ".cm-wikilink:hover": {
    backgroundColor: "var(--accent-soft)",
    textDecoration: "none",
  },

  // Live-preview decorations (added by ./livePreview).
  // The • that replaces a `-`/`*`/`+` list marker.
  ".cm-bullet": {
    color: "var(--accent)",
  },
  // Markdown links: the visible text, underlined + clickable (URL is hidden).
  ".cm-md-link": {
    color: "var(--link)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  // Embedded HTML rendered inline (rendered, never run) — flows with the prose
  // rather than sitting in a box, so a note reads as one document.
  ".cm-md-html": {
    margin: "var(--sp-3) 0",
  },
  ".cm-md-html img": {
    maxWidth: "100%",
    height: "auto",
    borderRadius: "var(--radius-sm)",
  },
  // Markdown `![alt](src)` images rendered inline.
  ".cm-md-img": {
    maxWidth: "100%",
    height: "auto",
    borderRadius: "var(--radius-sm)",
    verticalAlign: "bottom",
  },
  // Markdown `![alt](src.pdf)` embeds rendered as an inline preview block.
  ".cm-md-pdf": {
    display: "block",
    margin: "var(--sp-3) 0",
    height: "480px",
    maxWidth: "100%",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    overflow: "hidden",
    background: "var(--bg-subtle)",
  },
  ".cm-md-pdf-frame": {
    width: "100%",
    height: "100%",
    border: "0",
    display: "block",
  },
  ".cm-md-html :first-child": { marginTop: "0" },
  ".cm-md-html :last-child": { marginBottom: "0" },
  // A `<!DOCTYPE>`/comment-only block sanitizes to nothing — don't leave a gap.
  ".cm-md-html:empty": { display: "none" },

  // Clickable task checkboxes (added by ./tasks) for `- [ ]` items.
  ".cm-task-checkbox": {
    cursor: "pointer",
    width: "1em",
    height: "1em",
    margin: "0 0.4em 0 0",
    verticalAlign: "-0.1em",
    accentColor: "var(--accent)",
  },

  // GFM tables rendered off the active line (added by ./livePreview).
  ".cm-md-table": {
    margin: "var(--sp-3) 0",
    overflowX: "auto",
  },
  ".cm-md-table table": {
    borderCollapse: "collapse",
    width: "100%",
    fontSize: "0.95em",
  },
  ".cm-md-table th, .cm-md-table td": {
    border: "1px solid var(--border)",
    padding: "var(--sp-1) var(--sp-3)",
    textAlign: "left",
  },
  ".cm-md-table th": {
    backgroundColor: "var(--bg-subtle)",
    fontWeight: "700",
  },

  // Block-level markdown decorations (added by ./blocks): blockquote bar,
  // fenced-code well, horizontal rule.
  ".cm-blockquote": {
    borderLeft: "3px solid var(--accent-soft-hover)",
    paddingLeft: "var(--sp-4)",
    color: "var(--text-secondary)",
  },
  ".cm-codeblock": {
    backgroundColor: "var(--bg-subtle)",
    borderLeft: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-codeblock-open": {
    borderTop: "1px solid var(--border)",
    borderTopLeftRadius: "var(--radius-sm)",
    borderTopRightRadius: "var(--radius-sm)",
  },
  ".cm-codeblock-close": {
    borderBottom: "1px solid var(--border)",
    borderBottomLeftRadius: "var(--radius-sm)",
    borderBottomRightRadius: "var(--radius-sm)",
  },
  ".cm-hr": {
    // The `---` text is already dimmed; add a hairline through the line.
    boxShadow: "inset 0 -1px 0 var(--border)",
  },

  // Autocomplete: a floating surface card with an accent-soft active row.
  ".cm-tooltip": {
    border: "none",
    backgroundColor: "transparent",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--bg-surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-lg)",
    overflow: "hidden",
    padding: "var(--sp-1)",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-body)",
    fontSize: "var(--fs-md)",
    maxHeight: "18em",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    padding: "var(--sp-1) var(--sp-3)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text-primary)",
    lineHeight: "1.8",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--text-primary)",
  },
  ".cm-completionLabel": { color: "inherit" },
  ".cm-completionDetail": {
    color: "var(--text-tertiary)",
    fontStyle: "normal",
    marginLeft: "var(--sp-2)",
    fontSize: "var(--fs-sm)",
  },
});

export const markdownHighlight = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: t.heading1,
      fontFamily: "var(--font-display)",
      fontSize: "1.75em",
      fontWeight: "700",
      lineHeight: "var(--lh-tight)",
      color: "var(--text-primary)",
    },
    {
      tag: t.heading2,
      fontFamily: "var(--font-display)",
      fontSize: "1.35em",
      fontWeight: "700",
      lineHeight: "var(--lh-tight)",
      color: "var(--text-primary)",
    },
    {
      tag: t.heading3,
      fontFamily: "var(--font-display)",
      fontSize: "1.12em",
      fontWeight: "650",
      color: "var(--text-primary)",
    },
    {
      tag: [t.heading4, t.heading5, t.heading6],
      fontFamily: "var(--font-display)",
      fontWeight: "650",
      color: "var(--text-primary)",
    },
    { tag: t.strong, fontWeight: "700", color: "var(--text-primary)" },
    { tag: t.emphasis, fontStyle: "italic", color: "var(--text-primary)" },
    { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-tertiary)" },
    { tag: [t.link, t.url], color: "var(--link)", textDecoration: "underline", textUnderlineOffset: "2px" },
    {
      tag: t.monospace,
      fontFamily: "var(--font-mono)",
      fontSize: "0.9em",
      color: "var(--text-primary)",
      background: "var(--bg-subtle)",
      padding: "0.1em 0.35em",
      borderRadius: "var(--radius-sm)",
    },
    { tag: t.quote, color: "var(--text-secondary)", fontStyle: "italic" },
    { tag: t.list, color: "var(--accent)" },
    // Markdown token characters (#, *, `, >, -, etc.) dimmed to recede.
    { tag: t.meta, color: "var(--text-tertiary)" },
    {
      tag: [t.processingInstruction, t.contentSeparator],
      color: "var(--text-tertiary)",
    },
  ])
);
