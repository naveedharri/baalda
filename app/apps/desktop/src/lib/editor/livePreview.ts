// Live-preview inline rendering — inline-rendered markdown while you edit, built
// on CodeMirror decorations only (the buffer stays raw markdown, so files still
// round-trip losslessly and the CRDT is untouched — spec 01 §1).
//
// While the cursor is off a line, that line's markdown *markers* are hidden and
// the content is left styled by the syntax highlighter (theme.ts):
//   #, ##            → hidden; the heading text keeps its heading size
//   **b** *i* ~~s~~  → markers hidden; text stays bold / italic / struck
//   `code`           → backticks hidden; text keeps the mono chip
//   >                → blockquote marker hidden (the bar comes from blocks.ts)
//   - * +            → replaced with a • bullet
//   [text](url)      → shows just `text`, underlined + clickable
// Put the cursor on a line and its raw markers reappear, so editing is direct.
//
// Raw HTML *blocks* embedded in a note render in place (never execute — see
// HtmlEmbedWidget) unless the cursor is inside them, in which case the source
// shows for editing.
//
// GFM tables are the exception to that rule: they are ALWAYS the rendered
// table, because their widget is editable (./table/TableWidget). Clicking a
// cell types into the cell, so there is no source to fall back to.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { openExternal } from "../ipc";
import { previewKind } from "../preview";
import { frontmatterField } from "./frontmatter";
import { TableWidget } from "./table/TableWidget";
import { TASK_RE } from "./tasks";

/** Turns an image `src` into a webview-loadable URL (see CreateEditorOptions). */
type ResolveAsset = (src: string) => string;

const identityAsset: ResolveAsset = (src) => src;

/** The • that stands in for a `-`/`*`/`+` list marker on non-active lines. */
class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

/** Tags that could execute code or leak styles — dropped entirely. */
const BLOCKED_HTML_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "LINK",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "META",
  "BASE",
]);

/**
 * Render an embedded HTML fragment into `target` as real DOM so it flows inline
 * with the surrounding Markdown — a heading, an image, a paragraph, all in the
 * one note. It's a *render, never a run*: `<script>`/`<style>`/frames are
 * dropped, every `on*` handler and `javascript:` URL is stripped, and anchors
 * are rewired to open externally (a raw `<a href>` would otherwise navigate the
 * whole app away). `DOMParser` splits head/body even for a full-document paste,
 * so `<!DOCTYPE html>…<body>…` renders just its body content.
 */
/**
 * Is a URL attribute value dangerous to keep? Browsers ignore ASCII whitespace
 * and control chars inside a scheme, so `java\tscript:` executes — strip those
 * before checking, then block script-y schemes and non-image `data:` (which can
 * carry `data:text/html`). A tab/newline no longer defeats the check.
 */
function isDangerousUrl(raw: string): boolean {
  const v = raw.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (v.startsWith("data:")) return !v.startsWith("data:image/");
  return v.startsWith("javascript:") || v.startsWith("vbscript:");
}

function renderEmbeddedHtml(target: HTMLElement, html: string, resolveAsset: ResolveAsset) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("*").forEach((el) => {
    // Uppercase so a foreign-content (SVG/MathML) <script> — whose tagName is
    // lowercase — is caught by the same blocklist as an HTML one.
    if (BLOCKED_HTML_TAGS.has(el.tagName.toUpperCase())) {
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isUrlAttr = name === "href" || name === "src" || name === "xlink:href";
      if (name.startsWith("on")) {
        // Inline event handlers.
        el.removeAttribute(attr.name);
      } else if (name === "style") {
        // Inline styles enable full-screen fixed overlays / UI spoofing.
        el.removeAttribute(attr.name);
      } else if (isUrlAttr && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    // Point <img> at a loadable URL so vault-local images actually display.
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src");
      if (src) el.setAttribute("src", resolveAsset(src));
    }
    // Rewire links so a click opens externally instead of hijacking the window.
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      el.removeAttribute("href");
      if (/^(https?:|mailto:)/i.test(href)) {
        el.setAttribute("data-href", href);
        el.classList.add("cm-md-link");
      }
    }
  });
  target.innerHTML = parsed.body.innerHTML;
}

/** A block of raw HTML rendered inline (see {@link renderEmbeddedHtml}). */
class HtmlEmbedWidget extends WidgetType {
  constructor(readonly html: string, readonly resolveAsset: ResolveAsset) {
    super();
  }
  eq(other: HtmlEmbedWidget) {
    return other.html === this.html;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-md-html ${BLOCK_INSET_CLASS}`;
    renderEmbeddedHtml(el, this.html, this.resolveAsset);
    return el;
  }
  // Let clicks through so rewired anchors (cm-md-link) reach the mousedown handler.
  ignoreEvent() {
    return false;
  }
}

/** A Markdown `![alt](src)` image rendered inline. */
class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-md-img";
    img.src = this.src;
    if (this.alt) img.alt = this.alt;
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

/**
 * A `![alt](src.pdf)` embed rendered as an inline preview block: the PDF streams
 * into a framed viewer that flows with the note (the div is display:block, so it
 * reads as a block even though it's an inline widget — sidesteps the whole-line
 * constraint block decorations carry). Interaction (scroll) is left to the frame.
 */
class PdfEmbedWidget extends WidgetType {
  constructor(readonly src: string, readonly name: string) {
    super();
  }
  eq(other: PdfEmbedWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-pdf";
    const frame = document.createElement("iframe");
    frame.className = "cm-md-pdf-frame";
    frame.src = this.src;
    frame.title = this.name || "PDF";
    wrap.appendChild(frame);
    return wrap;
  }
  ignoreEvent() {
    return true; // let the embedded viewer own its clicks/scroll
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const hidden = Decoration.replace({});

/**
 * Block replace widgets are direct children of `.cm-content`, siblings of
 * `.cm-line` — so they miss the `.cm-line` horizontal inset that keeps the prose
 * column centred (see `--editor-pad-x` in tokens.css). This class hands them the
 * same one. INLINE replace widgets (images, PDF embeds) live inside a line and
 * must NOT carry it.
 */
export const BLOCK_INSET_CLASS = "cm-block-inset";

/**
 * Lines touched by any selection stay "raw" so the writer edits real markdown.
 * Shared by the inline plugin and the block-widget field so both agree on what
 * "being edited" means.
 */
function activeLineChecker(state: EditorState): (from: number, to: number) => boolean {
  const doc = state.doc;
  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = doc.lineAt(r.from).number;
    const last = doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }
  return (from: number, to: number) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(Math.max(from, to)).number;
    for (let n = first; n <= last; n++) if (activeLines.has(n)) return true;
    return false;
  };
}

/**
 * "Is this node inside the YAML frontmatter?" — the region decorates itself
 * (frontmatter.ts), so every other source skips it. Containment, not overlap:
 * the syntax tree's root node starts at 0 as well, and skipping that would skip
 * the whole document.
 */
function frontmatterChecker(state: EditorState): (from: number, to: number) => boolean {
  const fm = state.field(frontmatterField, false) ?? null;
  if (!fm) return () => false;
  return (from, to) => from < fm.to && to <= fm.to;
}

/**
 * Block-level widgets (raw HTML blocks, ```html fences, GFM tables). These use
 * `Decoration.replace({block: true})` over multiple lines, which CodeMirror
 * only accepts from a StateField — a view plugin providing them throws
 * `RangeError: Block decorations may not be specified via plugins`. So they
 * live here, computed over the whole document, while the inline marker work
 * stays in the (viewport-scoped) plugin below.
 */
function buildBlockDecorations(
  state: EditorState,
  resolveAsset: ResolveAsset,
  onNavigate?: (target: string) => void,
): DecorationSet {
  const doc = state.doc;
  const decos: ReturnType<Decoration["range"]>[] = [];
  const isActive = activeLineChecker(state);
  const inFrontmatter = frontmatterChecker(state);

  // Force-parse the whole doc if the background parse hasn't caught up yet —
  // notes are small, and a partially-parsed tree would silently drop widgets.
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      // Nothing decorates inside the frontmatter region (see frontmatter.ts).
      if (inFrontmatter(node.from, node.to)) return false;
      if (node.name === "HTMLBlock") {
        if (!isActive(node.from, node.to)) {
          const html = doc.sliceString(node.from, node.to);
          decos.push(
            Decoration.replace({
              widget: new HtmlEmbedWidget(html, resolveAsset),
              block: true,
            }).range(node.from, node.to)
          );
        }
        return false;
      }

      // A ```html fenced block → render its HTML as an inline preview (the
      // same sanitized render as a bare HTML block). The fence is what a
      // pasted HTML snippet lands in (see paste.ts): it survives blank lines
      // inside the markup, and shows raw source for editing when the cursor
      // is inside it.
      if (node.name === "FencedCode") {
        const info = node.node.getChild("CodeInfo");
        const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
        if ((lang === "html" || lang === "htm") && !isActive(node.from, node.to)) {
          const codeNode = node.node.getChild("CodeText");
          const html = codeNode ? doc.sliceString(codeNode.from, codeNode.to) : "";
          if (html.trim()) {
            decos.push(
              Decoration.replace({
                widget: new HtmlEmbedWidget(html, resolveAsset),
                block: true,
              }).range(node.from, node.to)
            );
          }
        }
        return false;
      }

      // GFM table → an EDITABLE rendered table (./table/TableWidget). Alone
      // among the widgets here it is not conditioned on the active line:
      // clicking a table must not flip it to `| a | b |` source, so the cells
      // are the editing surface and the source is never shown in its place.
      if (node.name === "Table") {
        const src = doc.sliceString(node.from, node.to);
        decos.push(
          Decoration.replace({
            widget: new TableWidget(src, { onNavigate, readOnly: state.readOnly }),
            block: true,
          }).range(node.from, node.to)
        );
        return false;
      }
      return undefined;
    },
  });

  return Decoration.set(decos, true);
}

function buildDecorations(view: EditorView, resolveAsset: ResolveAsset): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const decos: ReturnType<Decoration["range"]>[] = [];
  const isActive = activeLineChecker(state);
  const inFrontmatter = frontmatterChecker(state);

  // `[[wiki-links]]` are owned by the wikilinks plugin; never touch their marks.
  const wikiRanges: Array<[number, number]> = [];
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    const re = /\[\[[^\]\n]+\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      wikiRanges.push([from + m.index, from + m.index + m[0].length]);
    }
  }
  const inWiki = (pos: number) => wikiRanges.some(([a, b]) => pos >= a && pos < b);

  const hide = (from: number, to: number) => {
    if (to > from) decos.push(hidden.range(from, to));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        // Frontmatter owns its own look: without this, lezer's reading of
        // `key: v\n---` as a SetextHeading2 would hide the region's HeaderMark
        // and render the YAML as a giant bold heading (see frontmatter.ts).
        if (inFrontmatter(node.from, node.to)) return false;
        // Block HTML is rendered by the block-widget StateField; never style
        // its children here.
        if (node.name === "HTMLBlock") {
          return false;
        }

        // A non-active ```html fence is replaced by the StateField; skip its
        // children. Non-HTML fences (and the active HTML fence) keep their raw
        // source.
        if (node.name === "FencedCode") {
          const info = node.node.getChild("CodeInfo");
          const lang = info
            ? doc.sliceString(info.from, info.to).trim().toLowerCase()
            : "";
          if ((lang === "html" || lang === "htm") && !isActive(node.from, node.to)) {
            return false;
          }
          return;
        }

        // A table is ALWAYS replaced by the StateField's editable widget, so
        // nothing underneath one is ever on screen — never style its children.
        if (node.name === "Table") return false;

        // On the active line(s) we show raw markers; likewise inside wiki-links.
        if (isActive(node.from, node.to)) return;
        if (inWiki(node.from)) return;

        switch (node.name) {
          case "HeaderMark": {
            // Swallow the single space between the marker and the heading text.
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end += 1;
            hide(node.from, end);
            break;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
          case "QuoteMark":
          case "LinkMark":
            hide(node.from, node.to);
            break;
          case "CodeMark":
            // Only inline-code backticks; leave fenced-code fences visible.
            if (node.node.parent?.name === "InlineCode") hide(node.from, node.to);
            break;
          case "URL":
            // Hide the (url) of a real link; leave bare autolinks as-is.
            if (node.node.parent?.name === "Link") hide(node.from, node.to);
            break;
          case "ListMark":
            if (/^[-*+]$/.test(doc.sliceString(node.from, node.to))) {
              // Task item (`- [ ]`) → hide the dash so the checkbox (rendered by
              // ./tasks) stands alone; a plain bullet becomes a •.
              const line = doc.lineAt(node.from);
              const task = TASK_RE.exec(line.text);
              if (task) {
                const boxFrom = line.from + line.text.indexOf(task[1]);
                hide(node.from, boxFrom);
              } else {
                decos.push(bullet.range(node.from, node.to));
              }
            }
            break;
          case "Image": {
            // Render `![alt](src)` in place; skip its child marks. Images become
            // an inline <img>; PDFs become a framed preview block. (Both embed
            // the same way — the file type picks the widget.)
            const urlNode = node.node.getChild("URL");
            const src = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
            if (src) {
              const raw = doc.sliceString(node.from, node.to);
              const alt = /^!\[([^\]]*)\]/.exec(raw)?.[1] ?? "";
              const widget =
                previewKind(src) === "pdf"
                  ? new PdfEmbedWidget(resolveAsset(src), alt)
                  : new ImageWidget(resolveAsset(src), alt);
              decos.push(
                Decoration.replace({ widget }).range(node.from, node.to)
              );
              return false;
            }
            break;
          }
          case "Link": {
            // Underline + make the visible text clickable; the URL is opened
            // externally on click (see the mousedown handler below).
            const urlNode = node.node.getChild("URL");
            const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
            if (url) {
              decos.push(
                Decoration.mark({
                  class: "cm-md-link",
                  attributes: { "data-href": url },
                }).range(node.from, node.to)
              );
            }
            break;
          }
        }
      },
    });
  }

  return Decoration.set(decos, true);
}

/**
 * Live preview = two cooperating extensions:
 *  - a StateField for the block widgets (HTML blocks, ```html fences, tables) —
 *    the only place CodeMirror accepts block/multi-line replace decorations;
 *  - a view plugin for the inline marker work, rebuilt on edits, scroll, and
 *    cursor moves.
 */
export function livePreview(
  opts: { resolveAsset?: ResolveAsset; onNavigate?: (target: string) => void } = {}
) {
  const resolveAsset = opts.resolveAsset ?? identityAsset;
  const onNavigate = opts.onNavigate;

  const blockWidgets = StateField.define<DecorationSet>({
    create: (state) => buildBlockDecorations(state, resolveAsset, onNavigate),
    update: (deco, tr) =>
      tr.docChanged || tr.selection || tr.startState.readOnly !== tr.state.readOnly
        ? buildBlockDecorations(tr.state, resolveAsset, onNavigate)
        : deco,
    provide: (f) => EditorView.decorations.from(f),
  });

  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, resolveAsset);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = buildDecorations(u.view, resolveAsset);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event) {
          const el = (event.target as HTMLElement).closest(".cm-md-link");
          const href = el?.getAttribute("data-href");
          if (!href) return false;
          event.preventDefault();
          void openExternal(href);
          return true;
        },
      },
    }
  );

  return [blockWidgets, inlinePlugin];
}
