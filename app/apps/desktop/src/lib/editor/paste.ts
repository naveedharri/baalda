// Smart paste & drop.
//
//   • Paste/drop a FILE the format registry knows (an image, a PDF, a video, a
//     spreadsheet…) → the bytes are saved under the vault's `attachments/` dir
//     and the registry's embed form for that format is inserted at the caret:
//     `![](…)` for anything live preview renders in place, `[](…)` otherwise.
//     `saveAttachment` (wired in Editor.tsx, which knows the vault + note) does
//     the write and returns the embed `src`; it also owns the size gate, so an
//     oversize file raises its own toast and inserts nothing.
//   • Paste a URL over a non-empty selection → it becomes `[selection](url)`.
//
// Everything else falls through to CodeMirror's normal paste/drop handling.

import { toast } from "../toast";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { embedMarkdown, extForMime, formatFor } from "../formats";
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

/** The name part of a file's extension, lowercase and dot-less, or "". */
function extOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The extension to store a dropped File under.
 *
 * The MIME is asked FIRST (`extForMime`), because a browser-supplied type is
 * the authoritative statement of what the bytes are, and it canonicalises
 * spellings the file name might not (`.jfif` → `jpg`). The file name is the
 * fallback, and it is the one that answers for a Finder drag, where `type` is
 * routinely `""`. Only if both fail do we invent one from the MIME's subtype.
 */
export function extForFile(file: File): string {
  return (
    extForMime(file.type) ||
    extOfName(file.name) ||
    file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ||
    "bin"
  );
}

/** Save a File and insert the registry's embed form at the current selection. */
async function embedFile(view: EditorView, file: File, save: SaveAttachment) {
  try {
    const ext = extForFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const src = await save(bytes, ext);
    // A clipboard image often arrives nameless; `embedMarkdown` reads the
    // extension off this name, so it has to carry the one we stored under.
    const name = file.name || `pasted.${ext}`;
    view.dispatch(view.state.replaceSelection(embedMarkdown(name, src)), {
      userEvent: "input.paste",
    });
  } catch (err) {
    // Includes the size refusal, which has already told the user itself.
    console.error("file embed failed", err);
  }
}

/** Does the app know what this dropped File is — by its MIME or by its name? */
function isAttachable(file: File): boolean {
  if (file.type && extForMime(file.type)) return true;
  return formatFor(file.name) !== undefined;
}

/**
 * First File in a clipboard/drag payload that the format registry recognises.
 *
 * Both halves matter: a clipboard image carries a real `image/png` and no
 * useful name, while a Finder drag routinely carries `type: ""` and a real
 * name. Asking only about `image/` (as this did) is what made every non-image
 * drop fall through to CodeMirror, which pastes the file's *name* as text.
 */
function attachableFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f && isAttachable(f)) return f;
  }
  for (const f of Array.from(data.files ?? [])) {
    if (isAttachable(f)) return f;
  }
  return null;
}

/** Re-home embedded clipboard bytes so pasted notes own portable vault attachments. */
export async function importClipboardAttachments(html: string, save: SaveAttachment): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const saved = new Map<string, string>();
  let total = 0;
  for (const el of doc.querySelectorAll("img[src], a[href]")) {
    const attr = el.tagName === "IMG" ? "src" : "href";
    const src = el.getAttribute(attr) ?? "";
    if (!src.startsWith("data:")) continue;
    const cached = saved.get(src);
    if (cached) { el.setAttribute(attr, cached); continue; }
    const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(src);
    const ext = match ? extForMime(match[1]) : null;
    if (!match || !ext) throw new Error("This embedded clipboard file type is not supported.");
    if (match[2].length > 45 * 1024 * 1024) throw new Error("Clipboard attachments are too large.");
    const binary = atob(match[2]);
    total += binary.length;
    if (total > 32 * 1024 * 1024) throw new Error("Clipboard attachments exceed 32 MB. Paste a smaller selection.");
    const path = await save(Uint8Array.from(binary, c => c.charCodeAt(0)), ext);
    saved.set(src, path);
    el.setAttribute(attr, path);
  }
  return htmlClipboardToMarkdown(doc.body.innerHTML);
}

export function smartPaste(save: SaveAttachment | undefined) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;

      // Rich note copies can include both HTML and an image File. Preserve the
      // entire note instead of letting the image-only branch discard its text.
      const rich = data?.getData("text/html") ?? "";
      if (save && /(?:src|href)=["']data:/i.test(rich)) {
        event.preventDefault();
        const before = view.state.doc;
        const selection = view.state.selection;
        void importClipboardAttachments(rich, save).then(insert => {
          if (!view.dom.isConnected || view.state.doc !== before || !view.state.selection.eq(selection)) {
            toast("The note changed while preparing the paste. Paste again at the desired position.", "neutral");
            return;
          }
          view.dispatch(view.state.replaceSelection(insert), { userEvent: "input.paste" });
        }).catch(error => toast(`Could not paste attachments: ${error instanceof Error ? error.message : String(error)}`, "error"));
        return true;
      }

      // 1) A file the registry knows on the clipboard → save + embed.
      const file = save ? attachableFile(data) : null;
      if (file) {
        event.preventDefault();
        void embedFile(view, file, save!);
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
      const file = attachableFile(event.dataTransfer);
      if (!file) return false;
      event.preventDefault();
      // Drop the caret where the file landed before inserting.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) {
        view.dispatch({ selection: EditorSelection.cursor(pos) });
      }
      void embedFile(view, file, save);
      return true;
    },
  });
}
