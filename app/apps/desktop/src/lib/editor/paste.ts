// Smart paste & drop.
//
//   • Paste/drop an image (from the clipboard or a file) → the bytes are saved
//     under the vault's `attachments/` dir and an `![](…)` embed is inserted at
//     the caret. `saveAttachment` (wired in Editor.tsx, which knows the vault +
//     note) does the write and returns the embed `src`.
//   • Paste a URL over a non-empty selection → it becomes `[selection](url)`.
//
// Everything else falls through to CodeMirror's normal paste/drop handling.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { htmlClipboardToMarkdown } from "./htmlToMarkdown";

/** Persist image bytes and return the markdown `src` to embed (e.g. `/attachments/ab12.png`). */
export type SaveAttachment = (bytes: Uint8Array, ext: string) => Promise<string>;

const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

/**
 * Does the pasted *plain text* look like raw HTML source (a document or a
 * fragment), rather than prose? We treat these two paste sources differently:
 *
 *   • HTML *source* the user deliberately copied (from a code editor, View
 *     Source, a snippet) → wrap it in a ```html fence so it renders as a live
 *     preview block and stays editable (a blank line inside can't split it).
 *   • Rich content whose *plain* flavor is prose but which also carries a
 *     `text/html` flavor (Notion, Google Docs, a web selection) → convert that
 *     HTML to Markdown ({@link htmlClipboardToMarkdown}).
 *
 * Must start with a tag (`<tag`, `</tag`, `<!doctype`, `<!--`) and contain a
 * matching `>`, so a sentence that merely mentions `a < b` isn't mistaken for
 * markup.
 */
export function looksLikeHtmlSource(plain: string): boolean {
  const s = plain.trim();
  // Must open with `<!doctype`, `<!--`, or a real (possibly closing) tag whose
  // name is followed by whitespace, `/`, or `>` — and there must be a closing
  // `>` somewhere. A sentence like "a < b" fails the start anchor.
  return /^<(!doctype\b|!--|\/?[a-z][\w-]*[\s/>])/i.test(s) && s.includes(">");
}

/** Wrap raw HTML in a ```html fence, guarding against fences inside the source. */
export function fenceHtml(source: string): string {
  const longest = source.match(/`{3,}/g)?.reduce((a, b) => (b.length > a ? b.length : a), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}html\n${source.replace(/\n$/, "")}\n${fence}`;
}

/** Map an image MIME type to a file extension. */
function extFor(type: string): string {
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
  };
  return known[type] ?? type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
}

/** Save an image File and insert its embed at the current selection. */
async function embedImage(view: EditorView, file: File, save: SaveAttachment) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const src = await save(bytes, extFor(file.type));
    const alt = file.name.replace(/\.[^.]+$/, "");
    view.dispatch(
      view.state.replaceSelection(`![${alt}](${src})`),
      { userEvent: "input.paste" }
    );
  } catch (err) {
    console.error("image embed failed", err);
  }
}

/** First image File found in a clipboard/drag payload, if any. */
function imageFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  for (const f of Array.from(data.files ?? [])) {
    if (f.type.startsWith("image/")) return f;
  }
  return null;
}

export function smartPaste(save: SaveAttachment | undefined) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;

      // 1) An image on the clipboard → save + embed.
      const img = save ? imageFile(data) : null;
      if (img) {
        event.preventDefault();
        void embedImage(view, img, save!);
        return true;
      }

      // 2) A bare URL pasted over a selection → linkify the selection.
      const text = data?.getData("text/plain")?.trim() ?? "";
      const sel = view.state.selection.main;
      if (!sel.empty && URL_RE.test(text)) {
        event.preventDefault();
        const label = view.state.sliceDoc(sel.from, sel.to);
        const insert = `[${label}](${text})`;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert },
          selection: EditorSelection.cursor(sel.from + insert.length),
          userEvent: "input.paste",
        });
        return true;
      }

      // 3) Raw HTML *source* → wrap in a ```html fence so live-preview renders
      //    it as an editable preview block. The fence keeps the whole snippet as
      //    one node even with blank lines inside (unfenced HTML splits at blank
      //    lines into several HTMLBlocks that render piecemeal), and stops the
      //    parser folding `<div>` soup into a caret-trapping block widget.
      if (looksLikeHtmlSource(text)) {
        event.preventDefault();
        const insert = fenceHtml(text);
        view.dispatch(view.state.replaceSelection(insert), {
          userEvent: "input.paste",
        });
        return true;
      }

      // 4) Rich content whose plain flavor is prose but that also carries a
      //    `text/html` flavor (Notion, Google Docs, a web selection) → convert
      //    that HTML to clean Markdown. Only intervene when it actually yields
      //    Markdown that differs from the plain text; otherwise fall through to
      //    CodeMirror's plain-text paste.
      const html = data?.getData("text/html") ?? "";
      if (html.trim()) {
        const md = htmlClipboardToMarkdown(html);
        if (md && md !== text) {
          event.preventDefault();
          view.dispatch(view.state.replaceSelection(md), {
            userEvent: "input.paste",
          });
          return true;
        }
      }
      return false;
    },

    drop(event, view) {
      if (view.state.readOnly || !save) return false;
      const img = imageFile(event.dataTransfer);
      if (!img) return false;
      event.preventDefault();
      // Drop the caret where the file landed before inserting.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) {
        view.dispatch({ selection: EditorSelection.cursor(pos) });
      }
      void embedImage(view, img, save);
      return true;
    },
  });
}
