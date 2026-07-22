// HTML → Markdown, for paste.
//
// When you copy from Notion, Google Docs, a webpage, etc., the clipboard carries
// a rich `text/html` flavor. Pasting that verbatim would dump `<div>`/`<table>`
// soup into the buffer, which the Markdown parser turns into a document-spanning
// `HTMLBlock` — and the live-preview renders that as one un-editable block
// widget, trapping the caret (arrows / select-all / mouse selection all die).
//
// So on paste we convert the HTML to clean Markdown ourselves and insert *that*.
// The buffer stays real Markdown, round-trips losslessly, and Notion formatting
// (headings, bold, lists, links, tables) survives as its Markdown equivalent.
// It's a *convert, never embed*: we only read text + known structural tags and
// emit Markdown, so no raw HTML (and no script) ever reaches the document.

/** Block-level tags that break the inline flow and start their own line/para. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIV", "DL", "DD", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
  "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "TABLE", "UL",
]);

function isElement(n: Node): n is Element {
  return n.nodeType === 1;
}
function isText(n: Node): n is Text {
  return n.nodeType === 3;
}

/** Collapse HTML whitespace runs to single spaces, the way rendering would. */
function collapse(s: string): string {
  return s.replace(/[\t\r\n ]+/g, " ");
}

/** Wrap inline text in `marker` (e.g. `**`), keeping surrounding spaces outside
 *  the markers so we never emit invalid `** bold **`. Empty content → "". */
function emphasize(inner: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m || !m[2]) return inner;
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

/** Render the inline (character-level) content of a node to Markdown. */
function inline(node: Node): string {
  if (isText(node)) return collapse(node.data);
  if (!isElement(node)) return "";

  const tag = node.tagName;
  const kids = childrenInline(node);

  switch (tag) {
    case "STRONG":
    case "B":
      return emphasize(kids, "**");
    case "EM":
    case "I":
      return emphasize(kids, "*");
    case "S":
    case "DEL":
    case "STRIKE":
      return emphasize(kids, "~~");
    case "CODE":
    case "KBD":
    case "SAMP":
      // Inline code: raw text, never re-processed (so `**` inside stays literal).
      return `\`${(node.textContent ?? "").replace(/\s+/g, " ").trim()}\``;
    case "BR":
      return "  \n";
    case "A": {
      const href = (node.getAttribute("href") ?? "").trim();
      const text = kids.trim() || href;
      return href && !href.startsWith("javascript:") ? `[${text}](${href})` : text;
    }
    case "IMG": {
      const src = (node.getAttribute("src") ?? "").trim();
      const alt = (node.getAttribute("alt") ?? "").trim();
      return src ? `![${alt}](${src})` : "";
    }
    default:
      return kids;
  }
}

/** Concatenate the inline rendering of a node's children. */
function childrenInline(el: Element): string {
  let out = "";
  el.childNodes.forEach((c) => {
    out += inline(c);
  });
  return out;
}

/** Are any of this node's children block-level? (drives para grouping). */
function hasBlockChild(el: Element): boolean {
  return Array.from(el.childNodes).some((c) => isElement(c) && BLOCK_TAGS.has(c.tagName));
}

/** Prefix every line of `text` with `prefix` (first line included). */
function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

/** Render a `<ul>`/`<ol>` (recursing for nested lists) into Markdown list lines. */
function renderList(list: Element, depth: number): string {
  const ordered = list.tagName === "OL";
  const indent = "  ".repeat(depth);
  const items: string[] = [];
  let n = Number(list.getAttribute("start") ?? "1") || 1;

  Array.from(list.children).forEach((li) => {
    if (li.tagName !== "LI") return;
    const marker = ordered ? `${n++}. ` : "- ";

    // An <li> mixes its own inline text with nested lists / block children.
    // Pull nested lists out so they indent under the item; the rest is the
    // item's own content.
    const nested: string[] = [];
    const ownParts: string[] = [];
    Array.from(li.childNodes).forEach((c) => {
      if (isElement(c) && (c.tagName === "UL" || c.tagName === "OL")) {
        nested.push(renderList(c, depth + 1));
      } else if (isElement(c) && BLOCK_TAGS.has(c.tagName)) {
        ownParts.push(...renderBlock(c, depth));
      } else {
        ownParts.push(inline(c));
      }
    });

    const own = ownParts.join("").replace(/\n{2,}/g, "\n").trim();
    const pad = "  ".repeat(depth + 1);
    // First line carries the marker; wrapped continuation lines align under it.
    const body = own
      .split("\n")
      .map((l, i) => (i === 0 ? `${indent}${marker}${l}` : `${pad}${l}`))
      .join("\n");
    items.push(body + (nested.length ? "\n" + nested.join("\n") : ""));
  });

  return items.join("\n");
}

/** Render a `<table>` as a GFM pipe table (best-effort; falls back to rows). */
function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return "";
  const cellsOf = (tr: Element) =>
    Array.from(tr.querySelectorAll("th,td")).map((c) =>
      childrenInline(c).replace(/\|/g, "\\|").replace(/\n/g, " ").trim()
    );

  const grid = rows.map(cellsOf).filter((r) => r.length);
  if (!grid.length) return "";
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (r: string[]) => r.concat(Array(width - r.length).fill(""));

  const header = pad(grid[0]);
  const bodyRows = grid.slice(1).map(pad);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...bodyRows.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** Render one block-level element to zero or more Markdown blocks. */
function renderBlock(el: Element, depth: number): string[] {
  const tag = el.tagName;

  switch (tag) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const level = Number(tag[1]);
      const text = childrenInline(el).trim();
      return text ? [`${"#".repeat(level)} ${text}`] : [];
    }
    case "HR":
      return ["---"];
    case "PRE": {
      // Preserve code verbatim inside a fence; keep the language if tagged.
      const code = el.querySelector("code");
      const lang = code
        ? (code.className.match(/language-([\w-]+)/)?.[1] ?? "")
        : "";
      const text = (el.textContent ?? "").replace(/\n$/, "");
      return ["```" + lang + "\n" + text + "\n```"];
    }
    case "BLOCKQUOTE": {
      const inner = renderChildren(el, depth).join("\n\n");
      return inner ? [prefixLines(inner, "> ")] : [];
    }
    case "UL":
    case "OL": {
      const list = renderList(el, depth);
      return list ? [list] : [];
    }
    case "TABLE": {
      const t = renderTable(el);
      return t ? [t] : [];
    }
    case "P":
    case "FIGCAPTION": {
      const text = childrenInline(el).trim();
      return text ? [text] : [];
    }
    case "FIGURE":
    case "DIV":
    case "SECTION":
    case "ARTICLE":
    case "HEADER":
    case "FOOTER":
    case "MAIN":
    case "ASIDE":
    case "NAV":
    case "DETAILS":
    case "DL":
    case "DD":
    case "DT":
    case "ADDRESS":
    case "FIELDSET":
    case "FORM":
      // Structural wrapper: flatten to whatever its children render to.
      return renderChildren(el, depth);
    default:
      return renderChildren(el, depth);
  }
}

/** Walk a container's children, grouping runs of inline nodes into paragraphs
 *  and rendering block children on their own. Returns a list of Markdown blocks. */
function renderChildren(parent: Element, depth: number): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    const s = buf.trim();
    if (s) out.push(s);
    buf = "";
  };
  parent.childNodes.forEach((c) => {
    if (isElement(c) && BLOCK_TAGS.has(c.tagName)) {
      flush();
      out.push(...renderBlock(c, depth));
    } else {
      buf += inline(c);
    }
  });
  flush();
  return out;
}

/**
 * Convert a parsed HTML body (or any container element) to Markdown. Exposed for
 * unit tests; the paste path uses {@link htmlClipboardToMarkdown}.
 */
export function htmlElementToMarkdown(root: Element): string {
  const blocks = hasBlockChild(root)
    ? renderChildren(root, 0)
    : [childrenInline(root).trim()].filter(Boolean);
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Convert an HTML clipboard string to Markdown. Returns "" when the input has no
 * usable content (caller then falls back to plain-text paste). Never returns raw
 * HTML. Uses DOMParser, so it runs in the webview (and jsdom under test).
 */
export function htmlClipboardToMarkdown(html: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return "";
  }
  // Drop anything that could carry script/style noise before walking.
  doc.querySelectorAll("script,style,noscript,head").forEach((n) => n.remove());
  return htmlElementToMarkdown(doc.body);
}
