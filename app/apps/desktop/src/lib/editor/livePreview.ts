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
// Put the caret ON a construct and its raw markers reappear, so editing is
// direct. "On" is measured two different ways, and the difference is the whole
// feel of the editor (see ./reveal.ts):
//   LINE scope   — structure markers (#, >, the task dash) and the block
//                  widgets. Editing a heading is editing the whole line.
//   TOKEN scope  — inline markers (**, *, ~~, ==, %%, `, [](), ![]()). Only
//                  the span the selection touches unfolds, so `# Head **bold**`
//                  with the caret at the end of the line shows its `#` and
//                  keeps the `**` hidden.
// Blur the editor and NOTHING is active: click into the sidebar and the note
// reads as a finished page.
//
// Raw HTML *blocks* embedded in a note render in place (never execute — see
// HtmlEmbedWidget) unless the cursor is inside them, in which case the source
// shows for editing. A ```mermaid fence follows the same rule and draws itself
// as a diagram (./mermaid/MermaidWidget); `fenceRenderKind` is the one place
// that decides which fences render at all.
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
import type { SyntaxNodeRef } from "@lezer/common";
import { formatFor } from "../formats";
import * as ipc from "../ipc";
import { requestOpenFile } from "../openFileRequest";
import { fenceRenderKind } from "./fenceKind";
import { frontmatterField } from "./frontmatter";
import { MermaidWidget } from "./mermaid/MermaidWidget";
import { CALLOUT_RE } from "./ofm/callout";
import {
  activeLineChecker,
  focusMoved,
  lineSpanChecker,
  revealState,
  selectionTouches,
  setFocused,
  tokenOwner,
} from "./reveal";
import { type ResolveAsset, renderEmbeddedHtml } from "./sanitizeHtml";
import { TableWidget } from "./table/TableWidget";
import { TASK_RE } from "./tasks";
import { wikilinkRe } from "./wikilinks";

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

/**
 * `src` as a vault-relative path, for the widgets that have to READ the file
 * (size, CSV rows) or open it, rather than just point a URL at it.
 *
 * Root-relative (`/attachments/x.csv`) is what everything the app writes looks
 * like (`attachments.ts saveAttachment`), and a bare relative path is treated as
 * root-relative too. A path that climbs out of the note's directory (`../`) is
 * refused rather than guessed at: the widget does not know which note it is in
 * (live preview is per-document, not per-path), and a wrong guess would read
 * the wrong file. Those still render — they just show no size and no preview.
 */
function vaultRelFromSrc(src: string): string | null {
  if (!src || /^(https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(src)) return null;
  const rel = src.replace(/^\/+/, "").replace(/^\.\//, "");
  if (!rel || rel.split("/").includes("..")) return null;
  return rel;
}

/** "4.2 MB" — the file card voice, in one line. */
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * A `![alt](src.mp4|src.mp3)` embed rendered as a player, inline like the PDF
 * embed (`display:block` on the element itself, so it reads as a block without
 * being a block decoration). `preload="metadata"` so a note full of clips costs
 * a few headers, not a few hundred megabytes — the asset protocol serves range
 * requests, so seeking still works.
 */
class MediaEmbedWidget extends WidgetType {
  constructor(
    readonly kind: "video" | "audio",
    readonly src: string,
    readonly name: string,
  ) {
    super();
  }
  eq(other: MediaEmbedWidget) {
    return other.src === this.src && other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement(this.kind);
    el.className = this.kind === "video" ? "cm-md-video" : "cm-md-audio";
    el.controls = true;
    if (this.kind === "video") (el as HTMLVideoElement).preload = "metadata";
    el.src = this.src;
    if (this.name) el.title = this.name;
    return el;
  }
  ignoreEvent() {
    return true; // the player owns its clicks, drags and keyboard
  }
}

/** Rows × columns a CSV shows INSIDE a note. The pane viewer is where a big
 *  table belongs; here it is a glance, and a 40k-row table in the middle of a
 *  document would cost more layout than the note it is in. */
const CSV_EMBED_ROWS = 200;
const CSV_EMBED_COLS = 50;

/**
 * Split RFC-4180 CSV/TSV far enough for a preview: quoted fields, `""` escapes
 * and embedded newlines/delimiters, CRLF or LF.
 *
 * Deliberately local and minimal. The pane viewer has the real parser
 * (`lib/csv.ts`); duplicating ~30 lines here keeps the editor's startup chunk
 * free of a module it only needs when a note happens to embed a table, and the
 * two answer the same shapes. PR review can point this at `lib/csv.ts` once
 * both have shipped.
 */
function splitDelimited(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A `![alt](src.csv)` embed rendered as a small table.
 *
 * The bytes are read asynchronously (`ipc.readBinaryFile`, epoch-pinned like
 * every vault read) and dropped into a placeholder, the same shape the mermaid
 * widget uses: `toDOM` must return synchronously, and CodeMirror measures what
 * it returns.
 */
class CsvEmbedWidget extends WidgetType {
  constructor(readonly rel: string, readonly delimiter: string) {
    super();
  }
  eq(other: CsvEmbedWidget) {
    return other.rel === this.rel;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-csv";
    const note = document.createElement("div");
    note.className = "cm-md-csv-note";
    note.textContent = this.rel.split("/").pop() ?? this.rel;
    wrap.appendChild(note);
    void this.fill(wrap, note);
    return wrap;
  }
  private async fill(wrap: HTMLElement, note: HTMLElement): Promise<void> {
    let rows: string[][];
    try {
      const bytes = await ipc.readBinaryFile(this.rel);
      rows = splitDelimited(
        new TextDecoder().decode(bytes),
        this.delimiter,
        CSV_EMBED_ROWS + 1,
      );
    } catch {
      note.textContent = `Can't read ${this.rel}`;
      return;
    }
    if (rows.length === 0) {
      note.textContent = "Empty file";
      return;
    }
    const truncatedRows = rows.length > CSV_EMBED_ROWS;
    const body = rows.slice(0, CSV_EMBED_ROWS);
    const table = document.createElement("table");
    let truncatedCols = false;
    body.forEach((cells, r) => {
      if (cells.length > CSV_EMBED_COLS) truncatedCols = true;
      const tr = document.createElement("tr");
      for (const cell of cells.slice(0, CSV_EMBED_COLS)) {
        // textContent only — a CSV is untrusted content from a teammate's disk.
        const td = document.createElement(r === 0 ? "th" : "td");
        td.textContent = cell;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });
    wrap.replaceChildren(table);
    if (truncatedRows || truncatedCols) {
      const footer = document.createElement("div");
      footer.className = "cm-md-csv-note";
      footer.textContent = `Showing the first ${body.length} rows — open the file for the rest`;
      wrap.appendChild(footer);
    }
  }
  ignoreEvent() {
    return true;
  }
}

/**
 * The honest fallback for an `![…](file.docx)`: a chip with the file's name and
 * size that opens the pane viewer on click. Before this, an `![]()` pointing at
 * anything live preview could not draw rendered as a broken `<img>` — the note
 * said a file was there and showed a torn-page icon.
 */
class FileChipWidget extends WidgetType {
  constructor(readonly rel: string | null, readonly name: string) {
    super();
  }
  eq(other: FileChipWidget) {
    return other.rel === this.rel && other.name === this.name;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-file-chip";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    const label = document.createElement("span");
    label.className = "cm-md-file-chip-name";
    label.textContent = this.name;
    el.appendChild(label);
    const size = document.createElement("span");
    size.className = "cm-md-file-chip-size";
    el.appendChild(size);
    if (this.rel) {
      // The card never reads the file to print its size (`file_stat`).
      void ipc
        .fileStat(this.rel)
        .then((stat) => {
          size.textContent = humanSize(stat.size);
        })
        .catch(() => {
          size.textContent = "missing";
          el.classList.add("is-missing");
        });
      const open = () => requestOpenFile(this.rel!);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    }
    return el;
  }
  ignoreEvent() {
    return false; // the chip's own listeners handle the click
  }
}

/**
 * The widget an `![alt](src)` gets, by what the registry says `src` IS.
 *
 * One switch, so the answer cannot drift from the pane viewer's
 * (`viewerFor` drives both). `![[…]]` embeds stay unhandled — out of scope.
 */
function embedWidget(src: string, resolved: string, alt: string): WidgetType {
  const format = formatFor(src);
  const rel = vaultRelFromSrc(src);
  const name = (src.split(/[\\/]/).pop() || alt || "file").split("?")[0];
  switch (format?.viewer) {
    case "image":
      return new ImageWidget(resolved, alt);
    case "pdf":
      return new PdfEmbedWidget(resolved, alt);
    case "video":
      return new MediaEmbedWidget("video", resolved, name);
    case "audio":
      return new MediaEmbedWidget("audio", resolved, name);
    case "csv":
      // No vault path (a remote URL, or a `../` climb) → the chip, which at
      // least names the file, rather than a table we cannot fill.
      return rel
        ? new CsvEmbedWidget(rel, name.toLowerCase().endsWith(".tsv") ? "\t" : ",")
        : new FileChipWidget(null, name);
    default:
      // Unknown types included: a format the table has never heard of is a file
      // with a name, and that is exactly what the chip shows.
      return new FileChipWidget(rel, name);
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
 * Block-level widgets (raw HTML blocks, ```html / ```mermaid fences, GFM
 * tables). These use
 * `Decoration.replace({block: true})` over multiple lines, which CodeMirror
 * only accepts from a StateField — a view plugin providing them throws
 * `RangeError: Block decorations may not be specified via plugins`. So they
 * live here, computed over the whole document, while the inline marker work
 * stays in the (viewport-scoped) plugin below.
 */
/**
 * The block field's value: the decorations, plus every block whose rendering
 * DEPENDS ON THE SELECTION — an HTML block or a fenced block, which show source
 * while you edit them. (A table is not among them: it is always the editable
 * widget, so no caret move can change its decoration.)
 *
 * Those ranges are what makes the memoisation below safe. On a selection-only
 * transaction the only thing that can change is whether one of them is being
 * edited, so when no caret is near one on EITHER side of the move, the previous
 * set is still correct. Without this, every arrow key re-parsed the whole
 * document (`ensureSyntaxTree` over `doc.length`) before the cursor moved.
 */
interface BlockDecorations {
  deco: DecorationSet;
  blocks: Array<[number, number]>;
}

function buildBlockDecorations(
  state: EditorState,
  resolveAsset: ResolveAsset,
  onNavigate?: (target: string) => void,
): BlockDecorations {
  const doc = state.doc;
  const decos: ReturnType<Decoration["range"]>[] = [];
  const blocks: Array<[number, number]> = [];
  const isActive = activeLineChecker(state);
  const inFrontmatter = frontmatterChecker(state);

  // Force-parse the whole doc if the background parse hasn't caught up yet —
  // notes are small, and a partially-parsed tree would silently drop widgets.
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      // Nothing decorates inside the frontmatter region (see frontmatter.ts).
      if (inFrontmatter(node.from, node.to)) return false;
      // Record the selection-dependent candidates for the memo before the
      // branches decide anything, so the bookkeeping stays out of the rendering
      // logic. Over-recording (a non-html fence) only costs a rebuild.
      if (node.name === "HTMLBlock" || node.name === "FencedCode") {
        blocks.push([node.from, node.to]);
      }
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

      // A RENDERED fenced block (see ./fenceKind — the single authority):
      //   ```html    → its HTML as an inline preview, the same sanitized
      //                render as a bare HTML block. The fence is what a pasted
      //                HTML snippet lands in (see paste.ts): it survives blank
      //                lines inside the markup.
      //   ```mermaid → the diagram it describes (./mermaid/MermaidWidget).
      // Both show raw source for editing when the cursor is inside them, and
      // both are ONE decoration over the whole node — two block replaces over
      // the same range would throw.
      if (node.name === "FencedCode") {
        const info = node.node.getChild("CodeInfo");
        const kind = fenceRenderKind(info ? doc.sliceString(info.from, info.to) : "");
        if (kind && !isActive(node.from, node.to)) {
          const codeNode = node.node.getChild("CodeText");
          const body = codeNode ? doc.sliceString(codeNode.from, codeNode.to) : "";
          if (body.trim()) {
            decos.push(
              Decoration.replace({
                widget:
                  kind === "mermaid"
                    ? new MermaidWidget(body)
                    : new HtmlEmbedWidget(body, resolveAsset),
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

  return { deco: Decoration.set(decos, true), blocks };
}

/** Is any selection-dependent block on a line this state's selection touches? */
function blocksTouched(blocks: Array<[number, number]>, state: EditorState): boolean {
  if (blocks.length === 0) return false;
  const onLine = lineSpanChecker(state);
  return blocks.some(([from, to]) => onLine(from, to));
}

function buildDecorations(view: EditorView, resolveAsset: ResolveAsset): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const decos: ReturnType<Decoration["range"]>[] = [];
  const isActive = activeLineChecker(state);
  const touches = selectionTouches(state);
  const inFrontmatter = frontmatterChecker(state);

  /**
   * TOKEN scope: is the inline construct this marker belongs to being edited?
   * A marker with no inline owner answers for itself.
   */
  const isActiveToken = (node: SyntaxNodeRef): boolean => {
    const owner = tokenOwner(node.node);
    return owner ? touches(owner.from, owner.to) : touches(node.from, node.to);
  };

  /**
   * The `[!type]` head of a callout marker, if `pos` sits inside one.
   *
   * lezer reads `[!warning]` as a shortcut-reference Link, so its `[` and `]`
   * would otherwise fold away TOKEN-scoped and leave `> !warning Careful` on
   * screen the moment you tried to edit the marker. The marker is STRUCTURE:
   * ofm/callout.ts replaces the whole span with an icon off the line, and on the
   * line it must read exactly as it was typed.
   */
  const inCalloutMarker = (pos: number): boolean => {
    const line = doc.lineAt(pos);
    if (!CALLOUT_RE.test(line.text)) return false;
    const open = line.text.indexOf("[!");
    const close = line.text.indexOf("]", open);
    return open >= 0 && close > open && pos >= line.from + open && pos <= line.from + close;
  };

  // `[[wiki-links]]` are owned by the wikilinks plugin; never touch their marks.
  // (`wikilinkRe()` mints a fresh regex per call — the `g` flag carries
  // `lastIndex` state, so one shared instance silently skips matches.)
  const wikiRanges: Array<[number, number]> = [];
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to);
    const re = wikilinkRe();
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

        // A non-active RENDERED fence (```html, ```mermaid) is replaced by the
        // StateField; skip its children. Plain fences — and a rendered one with
        // the caret in it — keep their raw source.
        if (node.name === "FencedCode") {
          const info = node.node.getChild("CodeInfo");
          const kind = fenceRenderKind(info ? doc.sliceString(info.from, info.to) : "");
          if (kind && !isActive(node.from, node.to)) {
            return false;
          }
          return;
        }

        // A table is ALWAYS replaced by the StateField's editable widget, so
        // nothing underneath one is ever on screen — never style its children.
        if (node.name === "Table") return false;

        // Wiki-links are the wikilinks plugin's territory, marks and all.
        if (inWiki(node.from)) return;
        // …and so is a callout's `[!type]`, which belongs to ofm/callout.ts.
        if (inCalloutMarker(node.from)) return false;

        switch (node.name) {
          // ---- LINE scope: the markers that give a LINE its shape ----------
          case "HeaderMark": {
            if (isActive(node.from, node.to)) break;
            // Swallow the single space between the marker and the heading text.
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end += 1;
            hide(node.from, end);
            break;
          }
          case "QuoteMark":
            if (!isActive(node.from, node.to)) hide(node.from, node.to);
            break;
          case "Escape":
            // `\*` — hide the backslash, keep the character it protects. Put
            // the caret on the line and the backslash returns for editing.
            if (!isActive(node.from, node.to)) hide(node.from, node.from + 1);
            break;
          case "ListMark": {
            if (!/^[-*+]$/.test(doc.sliceString(node.from, node.to))) break;
            const line = doc.lineAt(node.from);
            const task = TASK_RE.exec(line.text);
            if (task) {
              // Task item (`- [ ]`) → hide the dash so the checkbox (rendered
              // by ./tasks) stands alone. LINE-scoped, because the raw `- [ ]`
              // has to come back for editing and ./tasks drops the checkbox on
              // exactly the same rule.
              if (isActive(node.from, node.to)) break;
              const boxFrom = line.from + line.text.indexOf(task[1]);
              hide(node.from, boxFrom);
            } else {
              // A plain bullet is a • even while you type on the line: a marker
              // that changes shape under the caret is the flicker this stage
              // exists to remove. Backspace still deletes the real `-`
              // (deleteMarkupBackward) — the decoration never touches the doc.
              decos.push(bullet.range(node.from, node.to));
            }
            break;
          }
          // ---- TOKEN scope: inline markers unfold one span at a time -------
          case "EmphasisMark":
          case "StrikethroughMark":
          case "HighlightMark":
          case "OfmCommentMark":
          case "LinkMark":
            if (!isActiveToken(node)) hide(node.from, node.to);
            break;
          case "CodeMark":
            // Only inline-code backticks; leave fenced-code fences visible.
            if (node.node.parent?.name === "InlineCode" && !isActiveToken(node)) {
              hide(node.from, node.to);
            }
            break;
          case "URL":
          case "LinkTitle":
            // Hide the (url "title") of a real link; leave autolinks as-is.
            if (node.node.parent?.name === "Link" && !isActiveToken(node)) {
              hide(node.from, node.to);
            }
            break;
          case "Image": {
            if (isActiveToken(node)) break;
            // Render `![alt](src)` in place; skip its child marks. WHICH
            // rendering is the format registry's call (see `embedWidget`): an
            // image inline, a PDF/video/audio/CSV as a preview block, anything
            // else as a named chip that opens the pane.
            const urlNode = node.node.getChild("URL");
            const src = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
            if (src) {
              const raw = doc.sliceString(node.from, node.to);
              const alt = /^!\[([^\]]*)\]/.exec(raw)?.[1] ?? "";
              decos.push(
                Decoration.replace({
                  widget: embedWidget(src, resolveAsset(src), alt),
                }).range(node.from, node.to)
              );
              return false;
            }
            break;
          }
          case "Link": {
            // Underline + make the visible text clickable; the URL is opened
            // externally on click (see the mousedown handler below). Dropped
            // while the link is being edited, or a click meant to place the
            // caret in the link text would navigate away instead.
            if (isActiveToken(node)) break;
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
 *  - a StateField for the block widgets (HTML blocks, ```html and ```mermaid
 *    fences, tables) —
 *    the only place CodeMirror accepts block/multi-line replace decorations;
 *  - a view plugin for the inline marker work, rebuilt on edits, scroll, and
 *    cursor moves.
 */
export function livePreview(
  opts: { resolveAsset?: ResolveAsset; onNavigate?: (target: string) => void } = {}
) {
  const resolveAsset = opts.resolveAsset ?? identityAsset;
  const onNavigate = opts.onNavigate;

  const blockWidgets = StateField.define<BlockDecorations>({
    create: (state) => buildBlockDecorations(state, resolveAsset, onNavigate),
    update(value, tr) {
      if (tr.docChanged || tr.startState.readOnly !== tr.state.readOnly) {
        return buildBlockDecorations(tr.state, resolveAsset, onNavigate);
      }
      const selectionMoved = !tr.startState.selection.eq(tr.state.selection);
      const focusMovedHere = tr.effects.some((e) => e.is(setFocused));
      if (!selectionMoved && !focusMovedHere) return value;
      // Nothing near a selection-dependent block changed hands → the previous
      // set still holds. (The table widget is selection-independent, so it is
      // never a reason to rebuild.)
      if (
        !blocksTouched(value.blocks, tr.startState) &&
        !blocksTouched(value.blocks, tr.state)
      ) {
        return value;
      }
      return buildBlockDecorations(tr.state, resolveAsset, onNavigate);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, resolveAsset);
      }
      update(u: ViewUpdate) {
        // `focusMoved`: blurring hides every marker, so the set goes stale the
        // moment focus moves even though neither doc nor selection did.
        if (u.docChanged || u.viewportChanged || u.selectionSet || focusMoved(u)) {
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
          void ipc.openExternal(href);
          return true;
        },
      },
    }
  );

  return [...revealState, blockWidgets, inlinePlugin];
}
