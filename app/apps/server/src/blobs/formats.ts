/**
 * The server's view of the file formats Baalda carries as attachments: which
 * MIME types may be stored, how big each kind is allowed to get, which ones are
 * safe to render inline in a browser, and what the bytes say they actually are.
 *
 * This table is the SERVER half of a two-sided contract. The desktop's format
 * registry decides what a user can drop into a note and which `Content-Type` it
 * uploads with (`src/lib/sync/attachments.ts mimeForPath`); this decides what
 * the server accepts. The allow-list is deliberately the union of what that
 * registry emits and `application/octet-stream`, because every client shipped
 * before this validation existed uploads unknown types as octet-stream — a
 * narrower list would start refusing attachments that already sync today.
 *
 * Nothing here is an authorization decision. A type being allow-listed says the
 * server will store the bytes, not that anybody may read them.
 */
import { fileTypeFromBuffer } from "file-type";
import { MAX_BLOB_BYTES } from "./config.js";

export type FormatCategory =
  | "image"
  | "pdf"
  | "document"
  | "text"
  | "audio"
  | "video"
  | "archive"
  | "other";

/**
 * Per-category ceilings, from the format plan. In this build every one of them
 * is clamped to the store's own `maxBytes()` — the Postgres provider cannot
 * hold more than {@link MAX_BLOB_BYTES} whatever the category says — so these
 * only start to bite once a provider that streams (S3) exists. They live here
 * rather than in that future provider so the two halves of the cap are written
 * down in one place.
 */
export const CATEGORY_MAX_BYTES: Record<FormatCategory, number> = {
  image: 25 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  text: 10 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  archive: 200 * 1024 * 1024,
  // Unknown bytes (legacy `application/octet-stream`). Nothing is known about
  // the shape, so it gets the transport's own bound and nothing more.
  other: MAX_BLOB_BYTES,
};

/**
 * Canonical extension → MIME. Mirrors the desktop registry's `mimes[0]`, i.e.
 * the type a client actually uploads with. Used for the allow-list and to give
 * `peek()`-style callers a canonical name; the wire `Content-Type` is what the
 * route validates, never the extension (a file called `.png` full of PDF bytes
 * is a mismatch, and the sniff is what catches it).
 */
export const EXT_MIME: Readonly<Record<string, string>> = {
  // notes / text
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  canvas: "application/json",
  // data / code
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  py: "text/x-python",
  rs: "text/x-rust",
  go: "text/x-go",
  sh: "application/x-sh",
  sql: "application/sql",
  js: "text/javascript",
  ts: "text/x-typescript",
  jsx: "text/javascript",
  tsx: "text/x-typescript",
  css: "text/css",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++src",
  java: "text/x-java-source",
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tiff: "image/tiff",
  tif: "image/tiff",
  // documents
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // audio / video
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/mp4",
  webm: "video/webm",
  // archives
  zip: "application/zip",
};

/** MIME → category, for the size ceiling. */
const MIME_CATEGORY: Readonly<Record<string, FormatCategory>> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "application/zip": "archive",
  "application/json": "text",
  "application/yaml": "text",
  "application/toml": "text",
  "application/xml": "text",
  "application/sql": "text",
  "application/x-sh": "text",
  "application/octet-stream": "other",
};

/**
 * Every MIME the server will store. Union of {@link EXT_MIME}'s values (the
 * desktop registry) and the legacy `application/octet-stream`.
 *
 * `text/plain` etc. are in here because a `.txt` CAN arrive as an attachment
 * (dropped next to a note rather than opened as one); that is separate from
 * whether it syncs as a note.
 */
export const ALLOWED_MIME: ReadonlySet<string> = new Set<string>([
  ...Object.values(EXT_MIME),
  "application/octet-stream",
  // `mimeForPath` emits these two for .ico/.zip-adjacent legacy paths and a few
  // OS pickers produce them; accepted so a real upload is never refused over a
  // spelling.
  "image/vnd.microsoft.icon",
  "application/x-zip-compressed",
]);

/**
 * Types a browser may render INLINE from an untrusted, uploader-controlled
 * blob: passive media only. Everything else the public-link route serves as a
 * download, and `image/svg+xml` / `text/html` are never served at all — both
 * are active documents that would execute in the server's own origin.
 */
export const SAFE_INLINE_MIME: ReadonlySet<string> = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

/** Active documents: never inline, whatever else says about them. */
export const NEVER_INLINE_MIME: ReadonlySet<string> = new Set<string>([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
]);

/** Strip parameters (`; charset=utf-8`) and case-fold. */
export function normalizeMime(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.split(";")[0].trim().toLowerCase();
}

export function isAllowedMime(mime: string | null | undefined): boolean {
  return ALLOWED_MIME.has(normalizeMime(mime));
}

export function categoryForMime(mime: string | null | undefined): FormatCategory {
  const m = normalizeMime(mime);
  const explicit = MIME_CATEGORY[m];
  if (explicit) return explicit;
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("text/")) return "text";
  return "other";
}

/** Category ceiling for a declared MIME. Callers clamp it to `store.maxBytes()`. */
export function maxBytesForMime(mime: string | null | undefined): number {
  return CATEGORY_MAX_BYTES[categoryForMime(mime)];
}

/**
 * Does this type have a byte signature worth checking?
 *
 * Text formats never do — a `.csv`, a `.json` and a `.md` are all just bytes,
 * and sniffing them yields either nothing or a wrong guess. `svg` is XML, so it
 * is text for this purpose too (it is refused from inline rendering instead).
 * `application/octet-stream` declares nothing, so there is nothing to
 * contradict.
 */
export function hasMagicSignature(mime: string | null | undefined): boolean {
  const m = normalizeMime(mime);
  if (m === "" || m === "application/octet-stream") return false;
  if (m.startsWith("text/")) return false;
  if (NEVER_INLINE_MIME.has(m)) return false;
  return !TEXTUAL_MIME.has(m);
}

const TEXTUAL_MIME: ReadonlySet<string> = new Set<string>([
  "application/json",
  "application/yaml",
  "application/toml",
  "application/xml",
  "application/sql",
  "application/x-sh",
]);

/**
 * Types that are indistinguishable at the byte level, so a sniff that returns
 * one must not be treated as contradicting a declaration of another.
 *
 * The zip family is the reason this exists: docx, xlsx, pptx and a plain zip
 * all start with `PK\x03\x04` and are told apart only by an entry name inside
 * the central directory, which a 4 KB prefix may not reach. `file-type` does
 * look for it, but a truncated peek (or an OOXML file written with the content
 * types entry late) legitimately sniffs as `application/zip`.
 */
const EQUIVALENT_MIME: ReadonlyArray<ReadonlySet<string>> = [
  new Set([
    "application/zip",
    "application/x-zip-compressed",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]),
  // ISO-BMFF `ftyp` containers: m4a, mp4 and mov differ only by brand, and
  // `file-type` reports the brand it sees rather than the one a client guessed.
  new Set(["audio/mp4", "video/mp4", "audio/x-m4a", "video/quicktime", "video/x-m4v"]),
  new Set(["audio/ogg", "video/ogg", "application/ogg"]),
  new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]),
  new Set(["image/x-icon", "image/vnd.microsoft.icon"]),
  new Set(["audio/wav", "audio/x-wav", "audio/vnd.wave"]),
];

/** OOXML entry-name prefixes, for the fallback below. */
const OOXML_MARKERS: ReadonlyArray<[string, string]> = [
  ["word/", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xl/", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt/", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
];

/**
 * What the bytes say they are, or null when nothing recognisable is there.
 *
 * `file-type` needs only a prefix, so callers pass the first few KB rather than
 * the whole blob. The OOXML fallback covers the case it gives up on: a zip
 * whose first local file header names `word/`, `xl/` or `ppt/` (Office writes
 * `[Content_Types].xml` first, but other producers don't) is reported as the
 * matching Office type instead of a bare zip.
 */
export async function sniffMime(buf: Uint8Array): Promise<string | null> {
  const detected = await fileTypeFromBuffer(buf);
  const mime = detected?.mime ? normalizeMime(detected.mime) : null;
  if (mime !== "application/zip") return mime;
  const head = Buffer.from(
    buf.buffer,
    buf.byteOffset,
    Math.min(buf.byteLength, 64 * 1024),
  ).toString("latin1");
  if (!head.includes("[Content_Types].xml")) {
    for (const [marker, ooxml] of OOXML_MARKERS) {
      if (head.includes(marker)) return ooxml;
    }
    return mime;
  }
  for (const [marker, ooxml] of OOXML_MARKERS) {
    if (head.includes(marker)) return ooxml;
  }
  return mime;
}

/**
 * Is a sniffed type consistent with what the uploader declared? Unknown bytes
 * (`sniffed === null`) are always consistent — not recognising a format is not
 * evidence of a lie, and refusing on it would break every legitimate type
 * `file-type` has no signature for.
 */
export function mimeMatchesBytes(declared: string, sniffed: string | null): boolean {
  if (sniffed === null) return true;
  const d = normalizeMime(declared);
  const s = normalizeMime(sniffed);
  if (d === s) return true;
  return EQUIVALENT_MIME.some((group) => group.has(d) && group.has(s));
}
