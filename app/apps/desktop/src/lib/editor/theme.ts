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
import { hashtagTag, highlightTag } from "./ofm/tags";

// Exported as a plain object so tests can assert WHERE a value sits (jsdom does
// no layout, so a computed-px assertion is impossible — see
// `__tests__/editorGeometry.test.ts`).
export const editorThemeSpec: Record<string, Record<string, string>> = {
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
  // Vertical padding only. The horizontal inset lives on `.cm-line` (see
  // --editor-pad-x in tokens.css): drawSelection() computes its rects from the
  // first `.cm-line`'s padding and is blind to padding on the content element,
  // so a centring pad here made every full-line selection rect start ~58px left
  // of the text and overrun its right edge. `.cm-content` stays FULL WIDTH so a
  // click *anywhere* in the sheet still lands on it and places the caret
  // (CodeMirror only maps clicks that hit the content element — a centred column
  // via `margin:auto` leaves the side margins as dead `.cm-scroller` zones);
  // the tall bottom pad keeps somewhere to click below the last line.
  // `caretColor` is not set here: drawSelection injects a `Prec.highest`
  // `caret-color: transparent !important` rule, so it would be dead. The visible
  // caret is `.cm-cursor` below.
  ".cm-content": {
    padding: "var(--sp-8) 0 40vh",
    minHeight: "100%",
  },
  // The prose column. Padding, not margin: drawSelection reads padding — and it
  // reads it off the FIRST line only, so this must stay uniform across every
  // line class (that is why `.cm-frontmatter` sets no horizontal padding, and
  // why `.cm-blockquote`'s extra indent skews multi-line rects by its 16px).
  ".cm-line": {
    paddingInline: "var(--editor-pad-x)",
  },
  "&.cm-focused": { outline: "none" },

  // No line-number gutter for a writing surface; keep it invisible if present.
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--text-faint)",
  },

  // No active-line highlight — only the accent caret blinks where you click.
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },

  // Selection: a clearly visible accent wash on the drawSelection() layer.
  // `--accent-soft` was too faint to read as a selection on the white sheet.
  // (No `::selection` clause: drawSelection blanks the native one with a
  // `Prec.highest` rule of its own, so styling it here would be dead CSS.)
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  // drawSelection() paints in a layer BEHIND the content, so opaque line and
  // span backgrounds (the .cm-codeblock well, inline-code chips, rendered
  // tables) swallow the wash and a selection looks like it skips them. Lift the
  // layer ABOVE the content instead and paint it as a plain translucent wash:
  // every pixel in the range — text, chips, markers, widgets — gets the same
  // tint, and 28% accent over dark text still reads. (A `multiply` blend was
  // tried first: it kept text crisper but barely tinted grey chips, so a
  // selection across inline code looked incomplete.)
  ".cm-selectionLayer": {
    zIndex: "1",
    pointerEvents: "none",
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
  // The BulletWidget stands in for a `ListMark`, so it belongs to the faint
  // marker tier, not the accent.
  ".cm-bullet": {
    color: "var(--text-faint)",
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
  // (The inline inset comes from the shared `.cm-block-inset` class below —
  // `paddingBlock` only, so the two do not fight.)
  // Block widget: vertical spacing as PADDING (see `.cm-note-title`).
  ".cm-md-html": {
    paddingBlock: "var(--sp-3)",
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
    paddingBlock: "var(--sp-3)", // padding, not margin — measured height
    overflowX: "auto",
    // Without inline-size containment the table's natural width propagates
    // into `.cm-content`'s intrinsic size (it's a flex item that sizes from
    // its contents), widening the WHOLE sheet past the window — the prose
    // shifts and clips instead of just this wrapper scrolling. Containment
    // keeps the overflow here, where the scrollbar is.
    contain: "inline-size",
  },
  ".cm-md-table table": {
    borderCollapse: "collapse",
    // Natural column widths, uncapped: a wide table overflows into the
    // wrapper's horizontal scroll instead of squeezing its columns to fit.
    // (An earlier `max-width: 100%` here compressed every column toward its
    // minimum before overflowing — the exact crushing this exists to avoid.)
    width: "max-content",
    fontSize: "0.95em",
  },
  // The block inside each cell (see TableWidget). Its max-width is what bounds
  // a column's natural size: long prose wraps at a readable measure, short
  // columns stay as wide as their content — nothing is squeezed below it.
  // `display: block` is load-bearing twice over: `max-width` does nothing on an
  // inline box, and an empty cell needs a box to give a height to.
  ".cm-md-table .cm-md-cell": {
    display: "block",
    maxWidth: "42ch",
    minHeight: "1.6em",
  },
  // A just-added row or column is all empty cells. Without a line box they
  // collapse to a few pixels and the new row looks like a hairline until you
  // click it, so an empty cell carries a zero-width space.
  ".cm-md-table .cm-md-cell-content:empty::before": {
    content: '"\\200B"',
  },
  // A visible (non-overlay) scrollbar, so a table that CAN scroll shows it.
  ".cm-md-table::-webkit-scrollbar": {
    height: "8px",
  },
  ".cm-md-table::-webkit-scrollbar-thumb": {
    backgroundColor: "var(--border)",
    borderRadius: "4px",
  },
  ".cm-md-table::-webkit-scrollbar-track": {
    background: "transparent",
  },
  ".cm-md-table th, .cm-md-table td": {
    border: "1px solid var(--border)",
    padding: "var(--sp-1) var(--sp-3)",
    textAlign: "left",
    // A cell is a click target for editing, and the anchor its column's hover
    // `+` is positioned against.
    position: "relative",
    cursor: "text",
    // Undo the editor's inherited `.cm-lineWrapping` (overflow-wrap: anywhere,
    // word-break: break-word, white-space: break-spaces): those shrink a
    // cell's min-content width to a single character, which is what let the
    // layout crush columns and stack headers letter-by-letter.
    whiteSpace: "normal",
    overflowWrap: "normal",
    wordBreak: "normal",
  },
  ".cm-md-table th": {
    backgroundColor: "var(--bg-subtle)",
    fontWeight: "700",
  },

  // ---- The editable table (./table/TableWidget) ----
  // The widget's own container inside the scrolling `.cm-md-table` host: the
  // table and its column bar in one row, the row bar underneath.
  //
  // `user-select: none` is what makes a document selection ACROSS the table
  // read as one thing. Without it the browser paints its own native
  // `::selection` blue inside every cell, on top of CodeMirror's accent wash —
  // two highlights in two colours over one block. The wash itself still covers
  // the table: `.cm-selectionLayer` sits at `z-index: 1` and nothing here
  // raises the table above it (position: relative with `z-index: auto` paints
  // below it, and `contain: inline-size` on the host is not a stacking
  // context). The cell input opts back in — you must be able to select text you
  // are editing.
  ".cm-md-table-wrap": {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    width: "max-content",
    minWidth: "100%",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".cm-md-table-row": {
    display: "flex",
    alignItems: "stretch",
  },
  // The open cell: a quiet ring drawn INSIDE the cell, so the table's own grid
  // lines never move by a pixel when a cell is being edited.
  ".cm-md-table .cm-md-cell-open": {
    backgroundColor: "var(--bg-subtle)",
    boxShadow: "inset 0 0 0 2px var(--accent)",
  },
  // The input has to read as the cell's text, not as a form control: same font,
  // no chrome, no background. The ring above is the only focus signal.
  ".cm-md-table .cm-md-cell-input": {
    display: "block",
    width: "100%",
    minWidth: "8ch",
    boxSizing: "border-box",
    margin: "0",
    padding: "0",
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--text-primary)",
    font: "inherit",
    textAlign: "inherit",
    userSelect: "text",
    WebkitUserSelect: "text",
  },
  ".cm-md-table .cm-md-cell-content code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    padding: "0.1em 0.3em",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--bg-subtle)",
  },
  ".cm-md-table .cm-md-cell-content .cm-md-link, .cm-md-table .cm-md-cell-content .cm-wikilink":
    {
      cursor: "pointer",
    },
  // The two add bars: one down the RIGHT edge of the table (a new column, the
  // table's exact height), one UNDER it (a new row, the table's exact width —
  // `100%` of the wrap minus the column bar, not the width of the editor). Both
  // are in flow, so they take their own space; a margin here would be invisible
  // to CM6, which measures a block widget with getBoundingClientRect.
  ".cm-md-table .cm-md-add-col, .cm-md-table .cm-md-add-row": {
    padding: "0",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--text-tertiary)",
    fontSize: "var(--fs-md)",
    lineHeight: "1",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity var(--t-fast) var(--ease), background var(--t-fast) var(--ease)",
  },
  ".cm-md-table .cm-md-add-col": {
    width: "22px",
    flex: "0 0 22px",
  },
  ".cm-md-table .cm-md-add-row": {
    height: "22px",
    width: "calc(100% - 22px)",
  },
  // Faint until the pointer is over the table (or the bar itself has focus),
  // then plainly there.
  ".cm-md-table-wrap:hover .cm-md-add-col, .cm-md-table-wrap:hover .cm-md-add-row, .cm-md-table .cm-md-add-col:focus-visible, .cm-md-table .cm-md-add-row:focus-visible":
    {
      opacity: "1",
    },
  ".cm-md-table .cm-md-add-col:hover, .cm-md-table .cm-md-add-row:hover": {
    opacity: "1",
    color: "var(--accent)",
    backgroundColor: "var(--accent-soft)",
  },

  // "Changed by someone else while you were typing." — the same hint the
  // Properties panel shows, in the same voice.
  ".cm-md-table .cm-md-table-note": {
    margin: "var(--sp-1) 0 0",
    fontSize: "var(--fs-xs)",
    color: "var(--text-tertiary)",
  },

  // Block replace widgets (tables, embedded HTML) are direct children of
  // `.cm-content`, siblings of `.cm-line`, so they never get the line inset.
  // This hands them the same one. `margin`, not `padding`: the table wrapper is
  // its own scroll container and padding would scroll away with the content
  // instead of holding the column. See BLOCK_INSET_CLASS in livePreview.ts.
  ".cm-block-inset": {
    marginInline: "var(--editor-pad-x)",
  },

  // Block-level markdown decorations (added by ./blocks): blockquote bar,
  // fenced-code well, horizontal rule. All three are LINE classes, and a line
  // box now spans the full sheet — so a border or a background on the line
  // itself would reach the window edges. Each is re-cut to paint inside the
  // prose column only.
  ".cm-blockquote": {
    position: "relative",
    // The base inset plus the quote's own indent.
    paddingLeft: "calc(var(--editor-pad-x) + var(--sp-4))",
    color: "var(--text-secondary)",
  },
  // The bar, drawn at the prose left edge. `border-left` would sit at the window
  // edge now that the line box is full width. `z-index: -1` keeps it under the
  // text and the selection layer; `.cm-scroller` is the stacking context, so it
  // cannot escape the sheet.
  ".cm-blockquote::before": {
    content: '""',
    position: "absolute",
    zIndex: "-1",
    top: "0",
    bottom: "0",
    left: "var(--editor-pad-x)",
    width: "3px",
    backgroundColor: "var(--accent-soft-hover)",
  },
  // A filled well, clipped to the text column. The side hairlines and corner
  // radii are dropped deliberately: a border on a full-width line box lands at
  // the window edge, and `background-clip` cannot carry borders with it. (The
  // `.cm-codeblock-open/-close` classes blocks.ts still emits now style
  // nothing.)
  ".cm-codeblock": {
    backgroundColor: "var(--bg-subtle)",
    backgroundClip: "content-box",
  },
  ".cm-hr": { position: "relative" },
  // The hairline, inset to the prose column (an `inset` box-shadow would follow
  // the full-width line box).
  ".cm-hr::after": {
    content: '""',
    position: "absolute",
    left: "var(--editor-pad-x)",
    right: "var(--editor-pad-x)",
    bottom: "0",
    height: "1px",
    backgroundColor: "var(--border)",
  },

  // ---- Callouts (see lib/editor/ofm/callout.ts) ---------------------------
  //
  // A callout IS a blockquote, so it inherits `.cm-blockquote`'s indent and its
  // `::before` bar and only re-colours them. `--callout-color` is set per family
  // by the attribute selectors below — one variable, so a new family is one
  // line and can never drift away from the theme's semantic tokens.
  ".cm-blockquote.cm-callout": {
    "--callout-color": "var(--accent)",
    color: "var(--text-primary)",
    background:
      "color-mix(in srgb, var(--callout-color) var(--callout-tint), transparent)",
    backgroundClip: "content-box",
  },
  ".cm-callout::before": { backgroundColor: "var(--callout-color)" },
  '.cm-callout[data-callout="tip"]': { "--callout-color": "var(--success)" },
  '.cm-callout[data-callout="warning"]': { "--callout-color": "var(--warning)" },
  '.cm-callout[data-callout="danger"]': { "--callout-color": "var(--danger)" },
  '.cm-callout[data-callout="quote"]': { "--callout-color": "var(--text-secondary)" },
  // The title line reads as a heading for the block.
  ".cm-callout-title": { fontWeight: "650" },
  ".cm-callout-icon": {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--sp-2)",
    marginRight: "var(--sp-2)",
    color: "var(--callout-color)",
    verticalAlign: "-0.2em",
  },
  ".cm-callout-label": {
    fontWeight: "650",
    color: "var(--callout-color)",
  },

  // ---- #tags (see lib/editor/ofm/hashtag.ts) ------------------------------
  //
  // Always a pill, never folded away: a tag is a thing you read and (soon)
  // click, not a marker that gets out of the way.
  ".cm-hashtag": {
    backgroundColor: "var(--accent-soft)",
    borderRadius: "var(--radius-pill)",
    padding: "0.05em 0.45em",
    // Negative margin so the pill's padding does not push the prose apart.
    margin: "0 -0.1em",
  },

  // The `›` a `[[Note#Heading]]` shows in place of its `#`.
  ".cm-wikilink-sep": {
    color: "var(--text-faint)",
    padding: "0 0.15em",
  },

  // ---- YAML frontmatter (see lib/editor/frontmatter.ts) ----
  //
  // Rendered as compact dimmed source. The descendant selector is load-bearing:
  // with no frontmatter parser, lezer still reads `key: v\n---` as a
  // SetextHeading2, so the syntax highlighter puts a heading class on the spans
  // inside. `.cm-frontmatter span` is one class more specific than a
  // HighlightStyle rule, so it wins deterministically rather than by module
  // order.
  //
  // NOTE: no horizontal padding here, ever. drawSelection derives every
  // selection rect from the FIRST `.cm-line`'s padding, so a line class that
  // changes it shifts the whole document's selection geometry.
  ".cm-frontmatter": {
    backgroundColor: "var(--bg-subtle)",
    backgroundClip: "content-box",
    lineHeight: "1.5",
  },
  ".cm-frontmatter span": {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-sm)",
    fontWeight: "400",
    color: "var(--text-secondary)",
  },
  ".cm-frontmatter-fence span": {
    color: "var(--text-tertiary)",
  },

  // ---- The note header: inline title + Properties panel -------------------
  //
  // Both are block widgets inside `.cm-content`, so they are siblings of
  // `.cm-line` and get the prose column's left edge from `cm-block-inset`
  // (see noteHeader.ts). The title's left edge being pixel-identical to the
  // body's is the single most visible way to get this feature wrong.
  // PADDING, never margin, on every block widget host: CodeMirror measures a
  // block's height with getBoundingClientRect(), which excludes margins, so a
  // margin here left the height map 16px short of the real layout and every
  // click below the title landed one line too low (a same-line drag then
  // "selected" into the next line as well).
  ".cm-note-title": {
    paddingBottom: "var(--inline-title-gap)",
  },
  // Mirrors the selection wash onto the title while a selection reaches the
  // start of the document (see `titleSelectionMirror` in noteHeader.ts). Same
  // colour as `.cm-selectionBackground` above.
  ".cm-note-title.is-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
    borderRadius: "var(--radius-sm)",
  },
  ".inline-title-wrap": {
    display: "flex",
    flexDirection: "column",
    gap: "var(--sp-1)",
  },
  // A real <input>, not a contenteditable: typing into one emits no
  // MutationRecord, so CodeMirror's DOMObserver never flushes the widget out
  // from under the caret. Styled to be indistinguishable from an H1.
  ".inline-title-input": {
    width: "100%",
    border: "0",
    outline: "none",
    padding: "0",
    background: "transparent",
    fontFamily: "var(--inline-title-family)",
    fontSize: "var(--inline-title-size)",
    fontWeight: "var(--inline-title-weight)",
    lineHeight: "var(--lh-tight)",
    color: "var(--inline-title-color)",
  },
  ".inline-title-input::placeholder": {
    color: "var(--inline-title-placeholder)",
  },
  ".inline-title-warning": {
    margin: "0",
    fontSize: "var(--fs-sm)",
    color: "var(--danger)",
  },
  ".inline-title-add": {
    alignSelf: "flex-start",
    border: "0",
    background: "transparent",
    padding: "0",
    cursor: "pointer",
    fontSize: "var(--fs-sm)",
    color: "var(--text-tertiary)",
    opacity: "0",
    transition: "opacity 120ms ease",
  },
  // A note with no properties shows no chrome until you reach for it.
  ".cm-note-title:hover .inline-title-add, .inline-title-add:focus-visible": {
    opacity: "1",
  },

  // Same rule as `.cm-note-title`: padding only, no vertical margin. The gap
  // between the rule and the body comes from the first body line's own box.
  ".cm-note-properties": {
    paddingBottom: "var(--sp-3)",
    borderBottom: "1px solid var(--border)",
  },
  ".prop-row": {
    display: "flex",
    alignItems: "center",
    gap: "var(--sp-2)",
    minHeight: "28px",
  },
  ".prop-type-trigger": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    flex: "0 0 auto",
    border: "0",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--text-tertiary)",
    cursor: "pointer",
  },
  ".prop-type-trigger:hover:not(:disabled)": {
    backgroundColor: "var(--bg-subtle)",
    color: "var(--text-secondary)",
  },
  ".prop-name": {
    flex: "0 0 auto",
    width: "9rem",
    border: "0",
    outline: "none",
    background: "transparent",
    padding: "var(--sp-1)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-body)",
    fontSize: "var(--fs-sm)",
    color: "var(--text-secondary)",
  },
  ".prop-value": {
    flex: "1 1 auto",
    minWidth: "0",
  },
  ".prop-input, .prop-chip-input": {
    width: "100%",
    border: "0",
    outline: "none",
    background: "transparent",
    padding: "var(--sp-1)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-body)",
    fontSize: "var(--fs-sm)",
    color: "var(--text-primary)",
  },
  ".prop-name:hover:not(:read-only), .prop-input:hover:not(:read-only)": {
    backgroundColor: "var(--bg-subtle)",
  },
  ".prop-name:focus, .prop-input:focus, .prop-chip-input:focus": {
    backgroundColor: "var(--bg-subtle)",
  },
  ".prop-chips": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--sp-1)",
  },
  ".prop-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--sp-1)",
    padding: "1px var(--sp-2)",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--accent-soft)",
    fontSize: "var(--fs-sm)",
    color: "var(--text-primary)",
  },
  ".prop-chip button": {
    border: "0",
    background: "transparent",
    padding: "0",
    cursor: "pointer",
    color: "var(--text-tertiary)",
    lineHeight: "1",
  },
  ".prop-chip-input": { width: "6rem", flex: "1 1 6rem" },
  ".prop-remove": {
    flex: "0 0 auto",
    border: "0",
    background: "transparent",
    cursor: "pointer",
    color: "var(--text-tertiary)",
    opacity: "0",
    padding: "0 var(--sp-1)",
  },
  ".prop-row:hover .prop-remove, .prop-remove:focus-visible": { opacity: "1" },
  ".prop-note": {
    margin: "0",
    fontSize: "var(--fs-sm)",
    color: "var(--text-tertiary)",
  },
  ".prop-add": {
    border: "0",
    background: "transparent",
    padding: "var(--sp-1)",
    cursor: "pointer",
    fontSize: "var(--fs-sm)",
    color: "var(--text-tertiary)",
  },
  ".prop-add:hover": { color: "var(--text-secondary)" },

  // YAML we refuse to rewrite: a banner, and the source left editable beneath.
  // A block widget host, so the gap below it is a transparent border (counted
  // by getBoundingClientRect), not a margin (which is not — see `.cm-note-title`).
  ".cm-fm-banner": {
    borderBottom: "var(--sp-2) solid transparent",
    backgroundClip: "padding-box",
    padding: "var(--sp-2) var(--sp-3)",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--bg-subtle)",
    fontSize: "var(--fs-sm)",
    color: "var(--text-secondary)",
  },
  ".cm-fm-invalid": {
    backgroundColor: "var(--bg-subtle)",
    backgroundClip: "content-box",
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
};

export const editorTheme = EditorView.theme(editorThemeSpec);

// Exported for the same reason as `editorThemeSpec`: a `HighlightStyle` does not
// expose the specs it was built from, and the absence of a `t.list` rule below is
// a regression guard worth asserting.
export const markdownHighlightSpec = [
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
    // NO `t.list` rule, on purpose. @lezer/markdown maps
    // `"OrderedList/... BulletList/..."` to tags.list, and the `/...` inherits
    // the tag to every descendant — so colouring t.list paints the whole item's
    // TEXT, not its marker (that was the accent-purple list bug). Item text
    // inherits: plain text gets --text-primary, and a list inside a blockquote
    // correctly stays --text-secondary. The marker is t.processingInstruction
    // below. GFM `Task` is tags.list too, so task text inherits as well.
    //
    // ---- Code inside fenced blocks -------------------------------------
    //
    // Mapped onto the palette the rest of the app already uses, rather than a
    // new one: a note is prose with code in it, not an IDE. CodeMirror's
    // `defaultHighlightStyle` is deliberately never imported — it ships its own
    // hardcoded colours, which ignore our theme and read wrong in dark mode.
    //
    // These sit before the markdown marker tiers purely for readability: none
    // of these tags is an ancestor of `meta` / `processingInstruction` /
    // `contentSeparator` (in @lezer/highlight `processingInstruction` derives
    // from `meta`, not from `punctuation`), so the two groups cannot shadow
    // one another.
    { tag: t.keyword, color: "var(--accent)" },
    { tag: [t.string, t.special(t.string)], color: "var(--success)" },
    { tag: [t.number, t.bool, t.atom], color: "var(--warning)" },
    { tag: [t.typeName, t.className, t.namespace], color: "var(--text-primary)" },
    { tag: t.variableName, color: "var(--text-primary)" },
    { tag: t.function(t.variableName), color: "var(--link)" },
    { tag: [t.operator, t.punctuation], color: "var(--text-secondary)" },

    // Markdown token characters (#, *, `, >, -, etc.) on the FAINT tier — one
    // step quieter than the secondary text, so prose reads as prose and the
    // syntax recedes until the caret lands on it.
    { tag: t.meta, color: "var(--text-faint)" },
    {
      tag: [t.processingInstruction, t.contentSeparator],
      color: "var(--text-faint)",
    },
    // A fence's language word (CodeInfo) and a link's LinkLabel.
    { tag: t.labelName, color: "var(--text-faint)" },
    // Comments — `%%obsidian ones%%` and code comments alike. Visible, faint
    // and italic: a comment you cannot see is a comment you publish by mistake.
    { tag: t.comment, color: "var(--text-faint)", fontStyle: "italic" },
    // `==highlight==` — ink on the page, not UI chrome (see --highlight-bg).
    {
      tag: highlightTag,
      background: "var(--highlight-bg)",
      borderRadius: "2px",
    },
    // `#tag` — the pill's fill and padding are `.cm-hashtag` in the theme
    // above; this is the text colour inside it.
    { tag: hashtagTag, color: "var(--accent)" },
];

export const markdownHighlight = syntaxHighlighting(
  HighlightStyle.define(markdownHighlightSpec)
);
