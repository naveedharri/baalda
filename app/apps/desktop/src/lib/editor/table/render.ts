/**
 * Inline markdown, rendered into a table cell as real DOM.
 *
 * NEVER `innerHTML` — every node here is `createElement` + `textContent`, so a
 * cell containing `<script>alert(1)</script>` is a cell containing that text.
 * That is the same posture as the HTML embed widget's sanitizer, arrived at
 * from the other side: this one has no HTML parser to defend against at all.
 *
 * Parsing uses `@lezer/markdown`'s parser configured with GFM — the app's own
 * markdown config (see `editor/index.ts`) — rather than a second regex dialect,
 * so a cell's bold/italic/code agree with the body's. Marks (`**`, backticks)
 * are dropped from the rendered form; the raw text is what the cell's input
 * shows when you click into it.
 */

import { GFM, parser as markdownParser } from "@lezer/markdown";

const CELL_PARSER = markdownParser.configure(GFM);

// `@lezer/common` is a transitive dependency, never a declared one (pnpm keeps
// undeclared packages unreachable on purpose), so the two tree types are derived
// from the parser we already import rather than imported from it.
type CellTree = ReturnType<typeof CELL_PARSER.parse>;
type SyntaxNode = ReturnType<CellTree["resolve"]>;

/** Marker tokens the rendered form hides. */
const MARKS = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
  "HeaderMark",
  "QuoteMark",
]);

/** `\|` is a literal pipe inside a table cell — display it as one. */
export function unescapeCell(raw: string): string {
  return raw.replace(/\\\|/g, "|");
}

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

/**
 * Blank out `[[wikilinks]]` for the PARSER only, preserving every offset.
 *
 * CommonMark reads `[[Note|Alias]]` as a bracketed shortcut reference link, so
 * without this the tree walk claims the text before the wikilink scanner ever
 * sees it. Masking to a run of the same length keeps each node's `from`/`to`
 * valid against the ORIGINAL string, which is what every slice below uses — so
 * `**[[A]]**` still renders bold, with a live link inside it.
 */
function maskWikilinks(text: string): string {
  return text.replace(WIKILINK_RE, (m) => "a".repeat(m.length));
}

/** What a `[[target|alias]]` / `[[target#heading]]` shows, and where it goes. */
export function wikilinkParts(inner: string): { label: string; target: string } {
  const pipe = inner.indexOf("|");
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0]!.trim();
  if (pipe >= 0) return { label: inner.slice(pipe + 1).trim(), target };
  const hash = inner.indexOf("#");
  const label = hash >= 0 ? `${inner.slice(0, hash).trim()} > ${inner.slice(hash + 1).trim()}` : inner.trim();
  return { label, target };
}

/** Plain text, except for the `[[wikilinks]]` hiding in it. */
function appendPlain(parent: Node, text: string): void {
  WIKILINK_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const { label, target } = wikilinkParts(m[1]!);
    const span = document.createElement("span");
    span.className = "cm-wikilink";
    span.textContent = label;
    span.dataset.target = target;
    parent.appendChild(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function renderChildren(parent: Node, node: SyntaxNode, text: string): void {
  let pos = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) appendPlain(parent, text.slice(pos, child.from));
    renderNode(parent, child, text);
    pos = child.to;
  }
  if (pos < node.to) appendPlain(parent, text.slice(pos, node.to));
}

/** The text of an `InlineCode` without its backticks. */
function codeText(node: SyntaxNode, text: string): string {
  let from = node.from;
  let to = node.to;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "CodeMark") continue;
    if (child.from === node.from) from = child.to;
    if (child.to === node.to) to = child.from;
  }
  return text.slice(from, Math.max(from, to));
}

function renderNode(parent: Node, node: SyntaxNode, text: string): void {
  const name = node.name;
  if (MARKS.has(name)) return;
  // A link's URL and title are the link's plumbing, not its label. Outside a
  // link the same node name is a bare autolink, which stays visible.
  if ((name === "URL" || name === "LinkTitle") && node.parent?.name === "Link") return;

  switch (name) {
    case "Document":
    case "Paragraph":
      renderChildren(parent, node, text);
      return;
    case "StrongEmphasis":
    case "Emphasis":
    case "Strikethrough": {
      const el = document.createElement(
        name === "StrongEmphasis" ? "strong" : name === "Emphasis" ? "em" : "del",
      );
      renderChildren(el, node, text);
      parent.appendChild(el);
      return;
    }
    case "InlineCode": {
      const el = document.createElement("code");
      el.textContent = codeText(node, text);
      parent.appendChild(el);
      return;
    }
    case "Link": {
      const el = document.createElement("span");
      el.className = "cm-md-link";
      const url = node.getChild("URL");
      const href = url ? text.slice(url.from, url.to) : "";
      // Only web links are followable; anything else renders as inert text so a
      // cell can never smuggle a `javascript:` target into the click handler.
      if (/^(https?:|mailto:)/i.test(href)) el.dataset.href = href;
      renderChildren(el, node, text);
      parent.appendChild(el);
      return;
    }
    case "Escape":
      // `\*` shows the star, not the backslash.
      parent.appendChild(document.createTextNode(text.slice(node.from + 1, node.to)));
      return;
    default:
      appendPlain(parent, text.slice(node.from, node.to));
  }
}

/**
 * Render one cell's markdown into `target`, replacing whatever was there.
 * `raw` is the cell's source, escapes and all.
 */
export function renderCellInto(target: HTMLElement, raw: string): void {
  target.textContent = "";
  const text = unescapeCell(raw);
  if (text === "") return;
  const tree = CELL_PARSER.parse(maskWikilinks(text));
  renderChildren(target, tree.topNode, text);
}
