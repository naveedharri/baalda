// The one answer to "what IS this file?" — extension → how the app surfaces it
// in the sidebar, what opens it, how it embeds into a note, and what
// Content-Type it uploads with.
//
// Before this table the same question was answered in five places that drifted
// apart (Rust `ALLOWED_EXTS`, `preview.ts IMAGE_EXTS`, `FileTree.isOpenablePath`,
// `sync/attachments.ts mimeForPath`, `paste.ts extFor`), so a `.txt` could be
// surfaced in the tree with nothing willing to open it, and a dropped `.docx`
// became a link no viewer had ever heard of.
//
// It is ONE CONTRACT with Rust, exactly like the editor's `#tag` rule ↔
// `parse.rs TAG_RE`: `SURFACED_EXTS` here and `ALLOWED_EXTS` in
// `src-tauri/src/vault.rs` are the same set, and `NOTE_EXTS` here matches the
// literals in `vault.rs`, `sync/registry.ts` and `sync/inbound.ts`. Change one,
// change them all — `__tests__/formatsLockstep.test.ts` reads those source files
// and fails on any divergence.
//
// Two rules the table itself enforces:
//   surface ⇒ openable   a type in the sidebar must open into SOMETHING (a
//                        viewer, or at worst the card) — dead clicks were the
//                        original bug (`txt`/`markdown`/`mdx`/`canvas`).
//   syncAs: "note"       is the CRDT family and nothing else. Viewer choice is
//                        display-only and never promotes a file into the bridge.

import type { Extension } from "@codemirror/state";

/** Family a format belongs to — drives icons, caps and (later) text extraction. */
export type FormatCategory =
  | "note"
  | "text"
  | "image"
  | "pdf"
  | "office-doc"
  | "spreadsheet"
  | "presentation"
  | "data"
  | "audio"
  | "video"
  | "archive";

/** Which component opens the file in the main pane. `card` is the honest
 *  fallback: name, size, "Open externally". */
export type ViewerKind =
  | "editor"
  | "html"
  | "code"
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "csv"
  | "docx"
  | "xlsx"
  | "card";

/** How a drop/paste writes the file into the note:
 *  `image`/`block` use the `![]()` embed form (rendered in place by live
 *  preview), `chip` the plain `[]()` link form. */
export type EmbedKind = "image" | "block" | "chip";

export interface FormatDef {
  /** Lowercase, no dot. The first entry is the canonical spelling. */
  readonly exts: readonly string[];
  /** `mimes[0]` is the canonical upload Content-Type for every ext here. */
  readonly mimes: readonly string[];
  readonly category: FormatCategory;
  readonly viewer: ViewerKind;
  readonly embed: EmbedKind;
  /** Mirrors Rust `ALLOWED_EXTS`: does the tree walk surface this at all? */
  readonly surface: boolean;
  /** Invariant: `surface` ⇒ `openable`. */
  readonly openable: boolean;
  /** `note` is the CRDT family (bridge + `notes` registry); everything else
   *  rides the blob store. */
  readonly syncAs: "note" | "attachment";
  /** Drop/paste ceiling. PR2 raises this per storage provider. */
  readonly maxBytes: number;
  /** How PR3 will pull searchable text out. Unread in PR1. */
  readonly textExtract: "none" | "utf8" | "docx" | "xlsx" | "csv" | "pdf";
  /** Formats no webview decodes everywhere — re-encoded on import. */
  readonly transcodeTo?: "png";
  /** Grammar for the read-only code viewer. ALWAYS a dynamic import: nothing
   *  here may land in the startup bundle (see `editor/codeLanguages.ts`). */
  readonly cmLang?: () => Promise<Extension>;
}

/** The drop/paste gate, mirroring the server's `MAX_BLOB_BYTES`. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** The note ceiling the sync layer already enforces (`MAX_NOTE_BYTES`). */
const MAX_NOTE_BYTES = 10 * 1024 * 1024;

// ---- CodeMirror grammars (dynamic; see the `cmLang` docstring) -------------

const jsLang = () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }));
const tsLang = () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true }));
const jsonLang = () => import("@codemirror/lang-json").then((m) => m.json());
const yamlLang = () => import("@codemirror/lang-yaml").then((m) => m.yaml());
const pythonLang = () => import("@codemirror/lang-python").then((m) => m.python());
const rustLang = () => import("@codemirror/lang-rust").then((m) => m.rust());
const goLang = () => import("@codemirror/lang-go").then((m) => m.go());
const sqlLang = () => import("@codemirror/lang-sql").then((m) => m.sql());
const cssLang = () => import("@codemirror/lang-css").then((m) => m.css());
const cppLang = () => import("@codemirror/lang-cpp").then((m) => m.cpp());
const javaLang = () => import("@codemirror/lang-java").then((m) => m.java());
const htmlLang = () => import("@codemirror/lang-html").then((m) => m.html());

/** toml/xml/shell have no Lezer parser — wrap the stream grammar, as
 *  `codeLanguages.ts` does for `bash`. */
const tomlLang = () =>
  Promise.all([
    import("@codemirror/language"),
    import("@codemirror/legacy-modes/mode/toml"),
  ]).then(([cm, m]) => new cm.LanguageSupport(cm.StreamLanguage.define(m.toml)));
const xmlLang = () =>
  Promise.all([
    import("@codemirror/language"),
    import("@codemirror/legacy-modes/mode/xml"),
  ]).then(([cm, m]) => new cm.LanguageSupport(cm.StreamLanguage.define(m.xml)));
const shellLang = () =>
  Promise.all([
    import("@codemirror/language"),
    import("@codemirror/legacy-modes/mode/shell"),
  ]).then(([cm, m]) => new cm.LanguageSupport(cm.StreamLanguage.define(m.shell)));

// ---- The table -------------------------------------------------------------
//
// Grouped by family, and within a family one entry per canonical MIME so
// `extForMime` has exactly one ext to answer with (the first in `exts`).

export const FORMATS: readonly FormatDef[] = [
  // --- notes: the CRDT family. These and only these become server `notes`. ---
  {
    exts: ["md", "markdown", "mdx"],
    mimes: ["text/markdown"],
    category: "note",
    viewer: "editor",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "note",
    maxBytes: MAX_NOTE_BYTES,
    textExtract: "utf8",
  },
  {
    exts: ["txt"],
    mimes: ["text/plain"],
    category: "note",
    viewer: "editor",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "note",
    maxBytes: MAX_NOTE_BYTES,
    textExtract: "utf8",
  },
  {
    // Pages keep `HtmlView` (plain read/write, no CRDT editor) even though they
    // already sync as notes — promoting them into the bridge is its own change.
    exts: ["html", "htm"],
    mimes: ["text/html"],
    category: "text",
    viewer: "html",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "note",
    maxBytes: MAX_NOTE_BYTES,
    textExtract: "utf8",
    cmLang: htmlLang,
  },
  {
    // JSON Canvas. Read-only source view until there is a canvas editor.
    exts: ["canvas"],
    mimes: ["application/json"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "note",
    maxBytes: MAX_NOTE_BYTES,
    textExtract: "utf8",
    cmLang: jsonLang,
  },

  // --- images ---------------------------------------------------------------
  {
    exts: ["png"],
    mimes: ["image/png"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["jpg", "jpeg", "jfif"],
    mimes: ["image/jpeg"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["gif"],
    mimes: ["image/gif"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["webp"],
    mimes: ["image/webp"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["svg"],
    mimes: ["image/svg+xml"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["bmp"],
    mimes: ["image/bmp"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["ico"],
    mimes: ["image/vnd.microsoft.icon"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["avif"],
    mimes: ["image/avif"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  // Apple/legacy formats: the importing machine's webview can decode them, but
  // Linux WebKitGTK cannot — so they are re-encoded to PNG on the way in and
  // every teammate gets something that renders.
  {
    exts: ["heic"],
    mimes: ["image/heic"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
    transcodeTo: "png",
  },
  {
    exts: ["heif"],
    mimes: ["image/heif"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
    transcodeTo: "png",
  },
  {
    exts: ["tiff", "tif"],
    mimes: ["image/tiff"],
    category: "image",
    viewer: "image",
    embed: "image",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
    transcodeTo: "png",
  },

  // --- documents ------------------------------------------------------------
  {
    exts: ["pdf"],
    mimes: ["application/pdf"],
    category: "pdf",
    viewer: "pdf",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "pdf",
  },
  {
    exts: ["docx"],
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    category: "office-doc",
    viewer: "docx",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "docx",
  },
  {
    exts: ["xlsx"],
    mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    category: "spreadsheet",
    viewer: "xlsx",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "xlsx",
  },
  {
    exts: ["xlsm"],
    mimes: ["application/vnd.ms-excel.sheet.macroEnabled.12"],
    category: "spreadsheet",
    viewer: "xlsx",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "xlsx",
  },
  {
    // No OSS pptx renderer is mature enough to trust with untrusted input, so
    // this stays a card + "Open externally"; PR3 gives it a searchable outline.
    exts: ["pptx"],
    mimes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    category: "presentation",
    viewer: "card",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },

  // --- video / audio --------------------------------------------------------
  {
    exts: ["mp4", "m4v"],
    mimes: ["video/mp4"],
    category: "video",
    viewer: "video",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["mov"],
    mimes: ["video/quicktime"],
    category: "video",
    viewer: "video",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["webm"],
    mimes: ["video/webm"],
    category: "video",
    viewer: "video",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["mp3"],
    mimes: ["audio/mpeg"],
    category: "audio",
    viewer: "audio",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["wav"],
    mimes: ["audio/wav"],
    category: "audio",
    viewer: "audio",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["m4a"],
    mimes: ["audio/mp4"],
    category: "audio",
    viewer: "audio",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["ogg"],
    mimes: ["audio/ogg"],
    category: "audio",
    viewer: "audio",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["aac"],
    mimes: ["audio/aac"],
    category: "audio",
    viewer: "audio",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
  {
    exts: ["flac"],
    mimes: ["audio/flac"],
    category: "audio",
    viewer: "audio",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },

  // --- tabular / structured data -------------------------------------------
  {
    exts: ["csv"],
    mimes: ["text/csv"],
    category: "data",
    viewer: "csv",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "csv",
  },
  {
    exts: ["tsv"],
    mimes: ["text/tab-separated-values"],
    category: "data",
    viewer: "csv",
    embed: "block",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "csv",
  },
  {
    exts: ["json"],
    mimes: ["application/json"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: jsonLang,
  },
  {
    exts: ["yaml", "yml"],
    mimes: ["application/yaml"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: yamlLang,
  },
  {
    exts: ["toml"],
    mimes: ["application/toml"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: tomlLang,
  },
  {
    exts: ["xml"],
    mimes: ["application/xml"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: xmlLang,
  },
  {
    exts: ["py"],
    mimes: ["text/x-python"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: pythonLang,
  },
  {
    exts: ["rs"],
    mimes: ["text/x-rust"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: rustLang,
  },
  {
    exts: ["go"],
    mimes: ["text/x-go"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: goLang,
  },
  {
    exts: ["sh"],
    mimes: ["application/x-sh"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: shellLang,
  },
  {
    exts: ["sql"],
    mimes: ["application/sql"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: sqlLang,
  },

  // --- source code: openable, NEVER surfaced --------------------------------
  // Importing a real project directory would otherwise flood the sidebar with
  // thousands of files (the same flood guard as `vault.rs DENIED_DIRS`). They
  // still open — and embed — if something points at one.
  {
    exts: ["js", "jsx"],
    mimes: ["text/javascript"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: false,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: jsLang,
  },
  {
    exts: ["ts", "tsx"],
    mimes: ["text/typescript"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: false,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: tsLang,
  },
  {
    exts: ["css"],
    mimes: ["text/css"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: false,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: cssLang,
  },
  {
    exts: ["c", "h"],
    mimes: ["text/x-c"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: false,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: cppLang,
  },
  {
    exts: ["cpp"],
    mimes: ["text/x-c++src"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: false,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: cppLang,
  },
  {
    exts: ["java"],
    mimes: ["text/x-java"],
    category: "data",
    viewer: "code",
    embed: "chip",
    surface: false,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "utf8",
    cmLang: javaLang,
  },

  // --- archives -------------------------------------------------------------
  {
    exts: ["zip"],
    mimes: ["application/zip"],
    category: "archive",
    viewer: "card",
    embed: "chip",
    surface: true,
    openable: true,
    syncAs: "attachment",
    maxBytes: MAX_ATTACHMENT_BYTES,
    textExtract: "none",
  },
];

// ---- Lookups ---------------------------------------------------------------

const BY_EXT = new Map<string, FormatDef>();
for (const def of FORMATS) {
  for (const ext of def.exts) BY_EXT.set(ext, def);
}

/**
 * mime → the canonical ext that uploads with it (the first `exts` entry of the
 * format claiming it).
 *
 * Attachment formats are registered first on purpose: the only question this
 * map answers is "what should a downloaded blob be called?", and notes never
 * ride the blob store. Without that, `.canvas` (a note, also `application/json`)
 * would claim the type a `.json` attachment uploads with.
 */
const EXT_BY_MIME = new Map<string, string>();
for (const def of [...FORMATS].sort((a, b) => Number(a.syncAs === "note") - Number(b.syncAs === "note"))) {
  for (const mime of def.mimes) {
    // Keyed lowercase: MIME types are case-insensitive, and the registered
    // spelling of the xlsm type is `…sheet.macroEnabled.12`.
    const key = mime.toLowerCase();
    if (!EXT_BY_MIME.has(key)) EXT_BY_MIME.set(key, def.exts[0]);
  }
}

/** The fallback Content-Type for anything the table does not know. */
export const OCTET_STREAM = "application/octet-stream";

/**
 * The lowercase extension of a path, or "" when there is none.
 *
 * Mirrors Rust `is_allowed_file`: the split is at the LAST dot of the file
 * name, and both halves must be non-empty — so `.gitignore` is a dotfile with
 * no extension, not an `.gitignore`-typed file, and a dot in a *directory*
 * (`a.b/c.png`) never leaks into the answer.
 */
function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** The format for a path, or `undefined` if the app knows nothing about it. */
export function formatFor(path: string): FormatDef | undefined {
  const ext = extOf(path);
  return ext ? BY_EXT.get(ext) : undefined;
}

/** Can this path be opened into a pane at all? (The sidebar's activate gate.) */
export function isOpenable(path: string): boolean {
  return formatFor(path)?.openable ?? false;
}

/** Which viewer opens this path. Unknown types get the card, never a dead click. */
export function viewerFor(path: string): ViewerKind {
  return formatFor(path)?.viewer ?? "card";
}

/** Canonical upload Content-Type for a path. */
export function mimeForPath(path: string): string {
  return formatFor(path)?.mimes[0] ?? OCTET_STREAM;
}

/** The extension a given MIME uploads as, or `undefined` for an unknown one. */
export function extForMime(mime: string): string | undefined {
  return EXT_BY_MIME.get(mime.toLowerCase().split(";")[0].trim());
}

/**
 * The markdown that embeds `src` (a vault-root path) into a note under `name`.
 *
 * `image`/`block` formats use the `![]()` form — live preview renders those in
 * place — with the file's STEM as the label, the way a pasted image has always
 * read. Everything else is a plain `[name](src)` link, keeping the extension
 * visible because the name is all the reader gets.
 */
export function embedMarkdown(name: string, src: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  const label = dot > 0 ? base.slice(0, dot) : base;
  const embed = formatFor(base)?.embed ?? "chip";
  return embed === "chip" ? `[${base}](${src})` : `![${label}](${src})`;
}

/** The drop/paste size ceiling for an extension (dot-less, any case). */
export function maxBytesFor(ext: string): number {
  return BY_EXT.get(ext.replace(/^\./, "").toLowerCase())?.maxBytes ?? MAX_ATTACHMENT_BYTES;
}

/** Every surfaced extension, sorted — the same set as Rust `ALLOWED_EXTS`. */
export const SURFACED_EXTS: readonly string[] = FORMATS.filter((f) => f.surface)
  .flatMap((f) => f.exts)
  .sort();

/** The CRDT note family. Same list as `vault.rs`, `sync/registry.ts` and
 *  `sync/inbound.ts` — see the lockstep test. */
export const NOTE_EXTS: readonly string[] = [
  "md",
  "markdown",
  "mdx",
  "txt",
  "html",
  "htm",
  "canvas",
];

const NOTE_EXT_SET = new Set(NOTE_EXTS);

/** Is this path part of the CRDT note family? */
export function isNoteExt(path: string): boolean {
  const ext = extOf(path);
  return ext !== "" && NOTE_EXT_SET.has(ext);
}
