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
  // archives (#407). `foo.tar.gz` reaches here as "gz": the desktop takes the
  // extension after the last dot.
  zip: "application/zip",
  tar: "application/x-tar",
  tgz: "application/gzip",
  gz: "application/gzip",
  "7z": "application/x-7z-compressed",
  // The optional "Code and text files" group (#401, desktop `CODE_TABLE`):
  // all `text/*`, so none is byte-sniffed and all share the text ceiling.
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  mts: "text/x-typescript",
  cts: "text/x-typescript",
  css: "text/css",
  scss: "text/x-scss",
  sass: "text/x-sass",
  less: "text/x-less",
  styl: "text/x-stylus",
  vue: "text/x-vue",
  svelte: "text/x-svelte",
  astro: "text/x-astro",
  hbs: "text/x-template",
  handlebars: "text/x-template",
  mustache: "text/x-template",
  ejs: "text/x-template",
  erb: "text/x-template",
  liquid: "text/x-template",
  pug: "text/x-pug",
  jade: "text/x-pug",
  j2: "text/x-jinja",
  jinja: "text/x-jinja",
  jinja2: "text/x-jinja",
  njk: "text/x-jinja",
  coffee: "text/x-coffeescript",
  php: "text/x-php",
  graphql: "text/x-graphql",
  gql: "text/x-graphql",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++src",
  cc: "text/x-c++src",
  cxx: "text/x-c++src",
  hpp: "text/x-c++src",
  hh: "text/x-c++src",
  hxx: "text/x-c++src",
  cs: "text/x-csharp",
  java: "text/x-java-source",
  kt: "text/x-kotlin",
  kts: "text/x-kotlin",
  scala: "text/x-scala",
  groovy: "text/x-groovy",
  gradle: "text/x-groovy",
  dart: "text/x-dart",
  swift: "text/x-swift",
  pyi: "text/x-python-stub",
  pyw: "text/x-python-stub",
  rb: "text/x-ruby",
  rake: "text/x-ruby",
  gemspec: "text/x-ruby",
  pl: "text/x-perl",
  pm: "text/x-perl",
  lua: "text/x-lua",
  r: "text/x-r",
  jl: "text/x-julia",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  ksh: "text/x-shellscript",
  fish: "text/x-shellscript",
  ps1: "text/x-powershell",
  psm1: "text/x-powershell",
  psd1: "text/x-powershell",
  bat: "text/x-bat",
  cmd: "text/x-bat",
  tcl: "text/x-tcl",
  hs: "text/x-haskell",
  erl: "text/x-erlang",
  hrl: "text/x-erlang",
  ex: "text/x-elixir",
  exs: "text/x-elixir",
  clj: "text/x-clojure",
  cljs: "text/x-clojure",
  cljc: "text/x-clojure",
  edn: "text/x-clojure",
  elm: "text/x-elm",
  ml: "text/x-ocaml",
  mli: "text/x-ocaml",
  fs: "text/x-fsharp",
  fsi: "text/x-fsharp",
  fsx: "text/x-fsharp",
  lisp: "text/x-common-lisp",
  cl: "text/x-common-lisp",
  el: "text/x-common-lisp",
  scm: "text/x-scheme",
  ss: "text/x-scheme",
  rkt: "text/x-scheme",
  cr: "text/x-crystal",
  vb: "text/x-vb",
  pas: "text/x-pascal",
  f90: "text/x-fortran",
  f95: "text/x-fortran",
  f03: "text/x-fortran",
  f08: "text/x-fortran",
  zig: "text/x-zig",
  nim: "text/x-nim",
  sol: "text/x-solidity",
  v: "text/x-verilog",
  sv: "text/x-verilog",
  svh: "text/x-verilog",
  vhd: "text/x-vhdl",
  vhdl: "text/x-vhdl",
  asm: "text/x-asm",
  s: "text/x-asm",
  proto: "text/x-protobuf",
  cmake: "text/x-cmake",
  mk: "text/x-makefile",
  mak: "text/x-makefile",
  dockerfile: "text/x-dockerfile",
  ini: "text/x-ini",
  cfg: "text/x-ini",
  conf: "text/x-ini",
  properties: "text/x-ini",
  tf: "text/x-hcl",
  tfvars: "text/x-hcl",
  hcl: "text/x-hcl",
  prisma: "text/x-prisma",
  lock: "text/x-lockfile",
  jsonc: "text/x-json5",
  json5: "text/x-json5",
  jsonl: "text/x-ndjson",
  ndjson: "text/x-ndjson",
  ipynb: "text/x-ipynb",
  xsd: "text/xml",
  xsl: "text/xml",
  xslt: "text/xml",
  kml: "text/xml",
  gpx: "text/xml",
  csproj: "text/xml",
  fsproj: "text/xml",
  vbproj: "text/xml",
  props: "text/xml",
  targets: "text/xml",
  xaml: "text/xml",
  resx: "text/xml",
  log: "text/x-log",
  diff: "text/x-diff",
  patch: "text/x-diff",
  tex: "text/x-tex",
  sty: "text/x-tex",
  cls: "text/x-tex",
  ltx: "text/x-tex",
  bib: "text/x-bibtex",
  rst: "text/x-rst",
  adoc: "text/x-asciidoc",
  asciidoc: "text/x-asciidoc",
  org: "text/x-org",
  ics: "text/calendar",
  vcf: "text/vcard",
  srt: "text/x-subrip",
  vtt: "text/vtt",
  // The optional "More file types" group (desktop `EXTRA_TABLE`). Each MIME
  // is what `file-type` reports for those bytes, or shares an equivalence
  // group below with what it reports.
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  psd: "image/vnd.adobe.photoshop",
  ai: "application/illustrator",
  eps: "application/eps",
  sketch: "application/x-sketch",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  mkv: "video/matroska",
  avi: "video/vnd.avi",
  opus: "audio/opus",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  rar: "application/x-rar-compressed",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
};

/**
 * Every lookup below is keyed in lowercase, because {@link normalizeMime}
 * case-folds what it looks up: a mixed-case registered spelling (the xlsm type
 * is `…sheet.macroEnabled.12`) would otherwise never match and its uploads
 * were refused with 415.
 */
const lowerKeys = <T,>(o: Readonly<Record<string, T>>): Readonly<Record<string, T>> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
const lowerSet = (xs: Iterable<string>): ReadonlySet<string> =>
  new Set([...xs].map((x) => x.toLowerCase()));

/** MIME → category, for the size ceiling. */
const MIME_CATEGORY: Readonly<Record<string, FormatCategory>> = lowerKeys({
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "application/zip": "archive",
  "application/x-zip-compressed": "archive",
  "application/x-tar": "archive",
  "application/gzip": "archive",
  "application/x-gzip": "archive",
  "application/x-7z-compressed": "archive",
  "application/x-rar-compressed": "archive",
  "application/x-bzip2": "archive",
  "application/x-xz": "archive",
  // Design and older/open office files: often larger than a photo.
  "image/vnd.adobe.photoshop": "document",
  "application/illustrator": "document",
  "application/eps": "document",
  "application/x-sketch": "document",
  "application/msword": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/vnd.oasis.opendocument.spreadsheet": "document",
  "application/vnd.oasis.opendocument.presentation": "document",
  "application/rtf": "document",
  "application/epub+zip": "document",
  "application/json": "text",
  "application/yaml": "text",
  "application/toml": "text",
  "application/xml": "text",
  "application/sql": "text",
  "application/x-sh": "text",
  "application/octet-stream": "other",
});

/**
 * Every MIME the server will store. Union of {@link EXT_MIME}'s values (the
 * desktop registry) and the legacy `application/octet-stream`.
 *
 * `text/plain` etc. are in here because a `.txt` CAN arrive as an attachment
 * (dropped next to a note rather than opened as one); that is separate from
 * whether it syncs as a note.
 */
export const ALLOWED_MIME: ReadonlySet<string> = lowerSet([
  ...Object.values(EXT_MIME),
  "application/octet-stream",
  // `mimeForPath` emits these two for .ico/.zip-adjacent legacy paths and a few
  // OS pickers produce them; accepted so a real upload is never refused over a
  // spelling.
  "image/vnd.microsoft.icon",
  "application/x-zip-compressed",
  "application/x-gzip",
  // Desktops before 0.1.1xx sent this spelling for .ts/.tsx.
  "text/typescript",
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
  lowerSet([
    "application/zip",
    "application/x-zip-compressed",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // Zip containers too (#401 "More file types").
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/epub+zip",
    "application/x-sketch",
  ]),
  // Older Office files are Compound File Binary; `file-type` names the container.
  new Set([
    "application/x-cfb",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
  ]),
  // Illustrator files are PDFs inside; EPS is PostScript.
  new Set(["application/pdf", "application/illustrator"]),
  new Set(["application/eps", "application/postscript"]),
  // ISO-BMFF `ftyp` containers: m4a, mp4 and mov differ only by brand, and
  // `file-type` reports the brand it sees rather than the one a client guessed.
  new Set(["audio/mp4", "video/mp4", "audio/x-m4a", "video/quicktime", "video/x-m4v"]),
  new Set(["audio/ogg", "video/ogg", "application/ogg", "audio/opus"]),
  new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]),
  new Set(["image/x-icon", "image/vnd.microsoft.icon"]),
  new Set(["application/gzip", "application/x-gzip"]),
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
