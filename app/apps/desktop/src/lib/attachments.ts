// Shared attachment persistence. Pasted images (Editor) and files dropped onto
// an open note (FileTree) both land here so they behave identically: bytes are
// written under `attachments/<hash>.<ext>` (content-hashed so identical files
// de-dupe) and referenced from the note by a vault-root markdown `src`.
//
// What each format DOES here — the PNG transcode, the size ceiling, the embed
// form — is read from `lib/formats.ts`, the single format authority. Before
// that table this file carried its own copy of two of those three answers, and
// a `.docx` dropped on a note became a link nothing could open.

import { embedMarkdown, formatFor, maxBytesFor } from "./formats";
import * as ipc from "./ipc";
import { toast } from "./toast";

/** Raised (after the toast) when a file is over its format's ceiling. */
export class AttachmentTooLargeError extends Error {
  constructor(readonly ext: string, readonly bytes: number, readonly limit: number) {
    super(`attachment is ${bytes} bytes, over the ${limit}-byte limit for .${ext}`);
    this.name = "AttachmentTooLargeError";
  }
}

/** "41 MB", "980 KB" — the sizes a person recognises from Finder. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Load bytes of `mime` into an <img> via a blob URL (webview-native decode). */
function decodeImage(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

/** Re-encode already-decoded image bytes as PNG through a canvas. */
async function transcodeToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const img = await decodeImage(bytes, mime);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.width || !canvas.height) throw new Error("cannot draw image");
  ctx.drawImage(img, 0, 0);
  const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!png) throw new Error("PNG encode failed");
  return new Uint8Array(await png.arrayBuffer());
}

/**
 * Persist bytes under `attachments/<hash>.<ext>` and return the vault-root
 * markdown `src` (e.g. `/attachments/ab12cd34.png`). `makeResolveAsset` turns
 * that back into a loadable `asset:` URL for rendering.
 *
 * Refuses anything over its format's `maxBytes` — BEFORE the hash and the
 * write, because the point is that the bytes never land. A file the server will
 * not take (`MAX_BLOB_BYTES`, 25 MB) used to be written happily and then fail
 * every upload pass forever, leaving a note that referenced a file no teammate
 * would ever receive. The refusal is a sticky error toast (see `toast.ts`: they
 * do not auto-dismiss) plus an {@link AttachmentTooLargeError}, so a caller
 * attaching several files can skip this one and keep the rest.
 */
export async function saveAttachment(bytes: Uint8Array, ext: string): Promise<string> {
  // Non-portable image formats (HEIC/TIFF) → PNG so they render everywhere. If
  // the decode fails, fall back to storing the original untouched.
  const sourceMime = formatFor(`x.${ext}`)?.transcodeTo === "png"
    ? (formatFor(`x.${ext}`)?.mimes[0] ?? null)
    : null;
  if (sourceMime) {
    try {
      bytes = await transcodeToPng(bytes, sourceMime);
      ext = "png";
    } catch (e) {
      console.warn(`transcode ${ext}→png failed; keeping original`, e);
    }
  }
  // After the transcode: a 30 MB HEIC that becomes a 6 MB PNG is fine, and the
  // limit that matters is the one on what we actually store.
  const limit = maxBytesFor(ext);
  if (bytes.byteLength > limit) {
    toast(
      `That file is ${humanBytes(bytes.byteLength)} — attachments up to ${humanBytes(limit)} sync.`,
      "error",
    );
    throw new AttachmentTooLargeError(ext, bytes.byteLength, limit);
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rel = `attachments/${hash}.${ext}`;
  await ipc.writeBinaryFile(rel, bytes);
  return `/${rel}`;
}

/**
 * Copy a dropped host file into `attachments/` and return the markdown to embed
 * it in a note. Which form that is — `![]()` for anything live preview renders
 * in place (images, PDF, video, audio, CSV) or `[]()` for everything else — is
 * the registry's call (`embedMarkdown`). Hash-named, so the note never carries
 * an unwieldy source path.
 */
export async function embedDroppedFile(path: string): Promise<string> {
  const name = path.split(/[\\/]/).pop() ?? "file";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "bin";
  const bytes = await ipc.readExternalFile(path);
  const src = await saveAttachment(bytes, ext);
  return embedMarkdown(name, src);
}
