// SPDX-License-Identifier: Apache-2.0

import { EditorView } from "@codemirror/view";
import { marked } from "marked";
import { mimeForPath } from "../formats";
import { clipboardWrite } from "../ipc";
import { toast } from "../toast";

export type ReadCopyAttachment = (path: string) => Promise<Uint8Array>;
let copyGeneration = 0;
const MAX_COPY_BYTES = 32 * 1024 * 1024;

function attachmentPath(src: string, notePath: string): string | null {
  if (/^[a-z][\w+.-]*:/i.test(src) || src.includes("\\")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(src); } catch { return null; }
  if (/^[a-z][\w+.-]*:/i.test(decoded) || decoded.includes("\\")) return null;
  const parts = decoded.startsWith("/") ? [] : notePath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts[0] === "attachments" && parts.length > 1 ? parts.join("/") : null;
}

function parseCopy(markdown: string, notePath: string) {
  const doc = new DOMParser().parseFromString(marked.parser(marked.lexer(markdown)), "text/html");
  const attachments = new Map<string, string>();
  for (const el of doc.body.querySelectorAll("img[src], a[href]")) {
    const src = el.getAttribute(el.tagName === "IMG" ? "src" : "href")!;
    const path = attachmentPath(src, notePath);
    if (path) attachments.set(src, path);
  }
  return { doc, attachments };
}

function finishCopy(doc: Document, embedded: Map<string, string>, markdown: string) {
  for (const el of doc.body.querySelectorAll("img[src], a[href]")) {
    const attr = el.tagName === "IMG" ? "src" : "href";
    const value = embedded.get(el.getAttribute(attr)!);
    if (value) el.setAttribute(attr, value);
  }
  const allowed = new Set(["P", "BR", "DIV", "SPAN", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "EM", "DEL", "BLOCKQUOTE", "PRE", "CODE", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "HR", "IMG", "A"]);
  for (const el of doc.body.querySelectorAll("*")) {
    if (!allowed.has(el.tagName)) { el.remove(); continue; }
    for (const attr of [...el.attributes]) {
      if (!["src", "href", "alt", "title", "colspan", "rowspan"].includes(attr.name)) el.removeAttribute(attr.name);
    }
    for (const attr of ["src", "href"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const isEmbedded = [...embedded.values()].includes(value);
      const safeImage = /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(value);
      const safeExternal = /^(https?:|mailto:)/i.test(value);
      if (!(attr === "src" ? safeImage || /^https?:/i.test(value) : isEmbedded || safeExternal)) el.removeAttribute(attr);
    }
  }
  // Plain-text destinations cannot hold images. Preserve Markdown for them;
  // rich destinations receive self-contained images through text/html.
  return { html: doc.body.innerHTML, text: markdown };
}

/** Rich clipboard HTML owns its bytes: no local paths or expiring bucket URLs. */
export async function portableNoteCopy(markdown: string, notePath: string, read: ReadCopyAttachment) {
  const { doc, attachments } = parseCopy(markdown, notePath);
  const embedded = new Map<string, string>();
  let bytesTotal = 0;
  for (const [src, path] of attachments) {
    const bytes = await read(path);
    bytesTotal += bytes.byteLength;
    if (bytesTotal > MAX_COPY_BYTES) throw new Error("Attachments exceed the 32 MB clipboard limit. Copy a smaller selection.");
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    embedded.set(src, `data:${mimeForPath(path)};base64,${btoa(binary)}`);
  }
  return finishCopy(doc, embedded, markdown);
}

/** The same sanitised copy, synchronously; `null` when attachment bytes must be read first. */
export function plainNoteCopy(markdown: string, notePath: string) {
  const { doc, attachments } = parseCopy(markdown, notePath);
  return attachments.size ? null : finishCopy(doc, new Map(), markdown);
}

export function richNoteCopy(notePath: string, read: ReadCopyAttachment) {
  return EditorView.domEventHandlers({
    copy(event, view) {
      const ranges = view.state.selection.ranges.filter(range => !range.empty);
      if (!ranges.length) return false;
      const text = ranges.map(range => view.state.sliceDoc(range.from, range.to)).join("\n");
      const generation = ++copyGeneration;
      event.preventDefault();
      // No bytes to embed: the copy event's own clipboardData carries both
      // flavours and nothing else touches the pasteboard.
      const plain = plainNoteCopy(text, notePath);
      if (plain && event.clipboardData) {
        event.clipboardData.setData("text/html", plain.html);
        event.clipboardData.setData("text/plain", plain.text);
        return true;
      }
      // Set the synchronous fallback before the native asynchronous rich write.
      event.clipboardData?.setData("text/plain", text);
      void (plain ? Promise.resolve(plain) : portableNoteCopy(text, notePath, read)).then(async content => {
        if (generation !== copyGeneration) return;
        try {
          // Rust writes on the main thread, serialised with WebKit's own
          // pasteboard write above; a worker-thread write raced it and crashed.
          await clipboardWrite(content.text, content.html);
        } catch {
          await navigator.clipboard.write([new ClipboardItem({
            "text/html": new Blob([content.html], { type: "text/html" }),
            "text/plain": new Blob([content.text], { type: "text/plain" }),
          })]);
        }
      }).catch(error => toast(`Could not copy: ${error instanceof Error ? error.message : String(error)}`, "error"));
      return true;
    },
  });
}
